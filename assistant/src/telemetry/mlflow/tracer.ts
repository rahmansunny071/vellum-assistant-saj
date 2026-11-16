/**
 * Vellum-RSI M2: turn and memory-job traces for a local MLflow server.
 *
 * Trace shapes:
 *
 * - **Turn** (`vellum.kind = turn`): root span `turn` (AGENT), opened by the
 *   `user-prompt-submit` hook and closed by `stop`. Children: every model call
 *   made for that conversation meanwhile (`llm.<callSite>`), tool results
 *   (`tool.<name>`), and the memory-v3 retrieval record (`memory.v3.retrieve`).
 *   The memory selector runs *before* `user-prompt-submit`, so spans for a
 *   conversation with no open turn are held for {@link PENDING_ADOPT_MS}; a turn
 *   that opens in that window adopts them.
 * - **Job** (`vellum.kind = job`): root span `memory_job.<type>` (CHAIN) around a
 *   background memory job; model calls made inside it nest under it through
 *   AsyncLocalStorage, whichever process runs the job.
 * - **Call** (`vellum.kind = call`): a model call outside both (a late title
 *   regeneration, a summary): exported on its own, tagged with its
 *   conversation.
 *
 * `session.id` = conversation id on turn and call roots, so MLflow groups a
 * conversation's traces as one session. Everything is best-effort and a no-op
 * while `mlflowTracing.enabled` is false.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { getConfig } from "../../config/loader.js";
import type { MlflowTracingConfig } from "../../config/schemas/mlflow-tracing.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../../providers/types.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";
import { APP_VERSION } from "../../version.js";
import { type FetchLike, MlflowExporter } from "./exporter.js";
import {
  type AttrValue,
  type FinishedSpan,
  type MlflowSpanType,
  traceTag,
} from "./otlp.js";

const log = getLogger("mlflow-tracing");

/** How long spans for a conversation with no open turn wait to be adopted. */
export const PENDING_ADOPT_MS = 60_000;
/** A turn that never sees `stop` is exported as incomplete after this. */
export const TURN_TIMEOUT_MS = 30 * 60_000;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const nowNs = () => BigInt(Date.now()) * 1_000_000n;

/** MLflow's trace id for an OTLP trace id. */
export function mlflowTraceId(otlpTraceId: string): string {
  return `tr-${otlpTraceId}`;
}

interface OpenTrace {
  traceId: string;
  rootSpanId: string;
  startNs: number | bigint;
  spans: FinishedSpan[];
}

interface OpenTurn extends OpenTrace {
  conversationId: string;
  userMessageId: string;
  requestId: string;
  prompt: string;
  profile: string;
}

interface PendingSpan {
  span: Omit<FinishedSpan, "traceId" | "parentSpanId">;
  conversationId: string;
  at: number;
}

// ---------------------------------------------------------------- content

function settings(): MlflowTracingConfig | null {
  try {
    const cfg = getConfig().mlflowTracing;
    return cfg?.enabled ? cfg : null;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}… [${text.length - max} more chars]`
    : text;
}

/** Secret-redacted, length-capped text, or just its size in metadata mode. */
export function captureText(
  text: string,
  cfg: MlflowTracingConfig,
): string | { chars: number } {
  if (cfg.captureContent === "metadata") {
    return { chars: text.length };
  }
  return clip(redactSecrets(text), cfg.maxContentChars);
}

function blockSummary(block: ContentBlock, cfg: MlflowTracingConfig): unknown {
  switch (block.type) {
    case "text":
      return { type: "text", text: captureText(block.text, cfg) };
    case "tool_use":
      return {
        type: "tool_use",
        name: block.name,
        input: captureText(JSON.stringify(block.input ?? {}), cfg),
      };
    case "tool_result": {
      const content = (block as { content?: unknown }).content;
      return {
        type: "tool_result",
        content: captureText(
          typeof content === "string" ? content : JSON.stringify(content ?? ""),
          cfg,
        ),
      };
    }
    default:
      return { type: block.type };
  }
}

/** The last few messages of a request: enough to read a call, bounded in size. */
function messagesSummary(
  messages: Message[],
  cfg: MlflowTracingConfig,
): unknown {
  const tail = messages.slice(-6);
  return {
    total_messages: messages.length,
    last_messages: tail.map((m) => ({
      role: m.role,
      content: m.content.map((b) => blockSummary(b, cfg)),
    })),
  };
}

function lastAssistantText(messages: ReadonlyArray<Message>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "assistant") {
      continue;
    }
    const text = m.content
      .filter(
        (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("\n");
    if (text) {
      return text;
    }
  }
  return "";
}

// ------------------------------------------------------------------ tracer

export class MlflowTracer {
  private readonly turns = new Map<string, OpenTurn>();
  private readonly pending = new Map<string, PendingSpan[]>();
  private readonly jobScope = new AsyncLocalStorage<OpenTrace>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly exporter: MlflowExporter,
    private readonly config: () => MlflowTracingConfig | null = settings,
    private readonly clock: () => number = Date.now,
  ) {}

  private ensureSweep(): void {
    if (this.sweepTimer) {
      return;
    }
    this.sweepTimer = setInterval(() => this.sweep(), 10_000);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  private export(spans: FinishedSpan[], cfg: MlflowTracingConfig): void {
    this.exporter.enqueue(spans, {
      endpoint: cfg.endpoint,
      experimentName: cfg.experimentName,
    });
  }

  // ---- turns

  beginTurn(args: {
    conversationId: string;
    userMessageId: string;
    requestId: string;
    prompt: string;
    profile: string;
  }): void {
    const cfg = this.config();
    if (!cfg) {
      return;
    }
    const stale = this.turns.get(args.conversationId);
    if (stale) {
      this.finishTurn(
        stale,
        { exitReason: "superseded", incomplete: true },
        cfg,
      );
    }
    const turn: OpenTurn = {
      ...args,
      traceId: hex(16),
      rootSpanId: hex(8),
      startNs: nowNs(),
      spans: [],
    };
    // Adopt the spans that ran just before the turn opened (the selector).
    const waiting = this.pending.get(args.conversationId) ?? [];
    this.pending.delete(args.conversationId);
    for (const p of waiting) {
      if (p.span.startNs < BigInt(turn.startNs)) {
        turn.startNs = p.span.startNs;
      }
      turn.spans.push({
        ...p.span,
        traceId: turn.traceId,
        parentSpanId: turn.rootSpanId,
      });
    }
    this.turns.set(args.conversationId, turn);
    this.ensureSweep();
  }

  endTurn(args: {
    conversationId: string;
    messages: ReadonlyArray<Message>;
    exitReason: string;
    error?: Error;
  }): void {
    const cfg = this.config();
    const turn = this.turns.get(args.conversationId);
    if (!turn) {
      return;
    }
    this.turns.delete(args.conversationId);
    if (!cfg) {
      return;
    }
    this.finishTurn(
      turn,
      {
        exitReason: args.exitReason,
        error: args.error?.message,
        reply: lastAssistantText(args.messages),
      },
      cfg,
    );
  }

  private finishTurn(
    turn: OpenTurn,
    end: {
      exitReason: string;
      error?: string;
      reply?: string;
      incomplete?: boolean;
    },
    cfg: MlflowTracingConfig,
  ): void {
    const attributes: Record<string, AttrValue> = {
      "session.id": turn.conversationId,
      [traceTag("vellum.kind")]: "turn",
      [traceTag("vellum.conversation_id")]: turn.conversationId,
      [traceTag("vellum.user_message_id")]: turn.userMessageId,
      "vellum.request_id": turn.requestId,
      "vellum.profile": turn.profile,
      "vellum.exit_reason": end.exitReason,
      "vellum.assistant_version": APP_VERSION,
      ...(end.incomplete ? { "vellum.incomplete": true } : {}),
    };
    const root: FinishedSpan = {
      traceId: turn.traceId,
      spanId: turn.rootSpanId,
      name: "turn",
      type: "AGENT",
      startNs: BigInt(turn.startNs),
      endNs: nowNs(),
      attributes,
      inputs: { prompt: captureText(turn.prompt, cfg) },
      outputs: { reply: captureText(end.reply ?? "", cfg) },
      ...(end.error ? { error: end.error } : {}),
    };
    this.export([root, ...turn.spans], cfg);
  }

  // ---- spans

  /**
   * Attach a finished span: to the job trace it runs inside, else to its
   * conversation's open turn, else hold it for adoption by a turn about to
   * open (then export it on its own).
   */
  addSpan(
    span: Omit<FinishedSpan, "traceId" | "parentSpanId" | "spanId"> & {
      spanId?: string;
    },
    conversationId: string | undefined,
  ): void {
    const cfg = this.config();
    if (!cfg) {
      return;
    }
    const full = { ...span, spanId: span.spanId ?? hex(8) };
    const job = this.jobScope.getStore();
    if (job) {
      job.spans.push({
        ...full,
        traceId: job.traceId,
        parentSpanId: job.rootSpanId,
      });
      return;
    }
    const turn = conversationId ? this.turns.get(conversationId) : undefined;
    if (turn) {
      turn.spans.push({
        ...full,
        traceId: turn.traceId,
        parentSpanId: turn.rootSpanId,
      });
      return;
    }
    if (conversationId) {
      const list = this.pending.get(conversationId) ?? [];
      list.push({ span: full, conversationId, at: this.clock() });
      this.pending.set(conversationId, list);
      this.ensureSweep();
      return;
    }
    this.exportStandalone(full, undefined, cfg);
  }

  private exportStandalone(
    span: Omit<FinishedSpan, "traceId" | "parentSpanId">,
    conversationId: string | undefined,
    cfg: MlflowTracingConfig,
  ): void {
    this.export(
      [
        {
          ...span,
          traceId: hex(16),
          attributes: {
            ...span.attributes,
            [traceTag("vellum.kind")]: "call",
            ...(conversationId
              ? {
                  "session.id": conversationId,
                  [traceTag("vellum.conversation_id")]: conversationId,
                }
              : {}),
          },
        },
      ],
      cfg,
    );
  }

  /** Flush spans whose adoption window passed, and turns that never ended. */
  sweep(): void {
    const cfg = this.config();
    if (!cfg) {
      return;
    }
    const now = this.clock();
    for (const [conversationId, list] of this.pending) {
      const keep = list.filter((p) => now - p.at < PENDING_ADOPT_MS);
      for (const p of list) {
        if (now - p.at >= PENDING_ADOPT_MS) {
          this.exportStandalone(p.span, conversationId, cfg);
        }
      }
      if (keep.length > 0) {
        this.pending.set(conversationId, keep);
      } else {
        this.pending.delete(conversationId);
      }
    }
    for (const [conversationId, turn] of this.turns) {
      if (now - Number(BigInt(turn.startNs) / 1_000_000n) >= TURN_TIMEOUT_MS) {
        this.turns.delete(conversationId);
        this.finishTurn(turn, { exitReason: "timeout", incomplete: true }, cfg);
      }
    }
  }

  // ---- model calls

  /** Wrap one provider call in an `llm.<callSite>` span. */
  async traceModelCall(
    providerName: string,
    messages: Message[],
    options: SendMessageOptions | undefined,
    call: () => Promise<ProviderResponse>,
  ): Promise<ProviderResponse> {
    const cfg = this.config();
    if (!cfg) {
      return call();
    }
    const startNs = nowNs();
    const conf = (options?.config ?? {}) as {
      callSite?: string;
      conversationId?: string;
      overrideProfile?: string;
      model?: string;
      effort?: string;
    };
    const attributes: Record<string, AttrValue> = {
      "vellum.call_site": conf.callSite ?? "unknown",
      "vellum.provider": providerName,
      ...(conf.overrideProfile
        ? { "vellum.profile": conf.overrideProfile }
        : {}),
      ...(conf.effort ? { "vellum.effort": conf.effort } : {}),
      "vellum.tools_offered": options?.tools?.length ?? 0,
    };
    const inputs = {
      ...(options?.systemPrompt
        ? { system_prompt: captureText(options.systemPrompt, cfg) }
        : {}),
      messages: messagesSummary(messages, cfg),
    };
    const name = `llm.${conf.callSite ?? "unknown"}`;
    try {
      const response = await call();
      const usage = response.usage;
      this.addSpan(
        {
          name,
          type: "LLM",
          startNs,
          endNs: nowNs(),
          attributes: {
            ...attributes,
            "vellum.provider": response.actualProvider ?? providerName,
            "vellum.model": response.model,
            "vellum.stop_reason": response.stopReason,
            "mlflow.chat.tokenUsage": JSON.stringify({
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
              ...(usage.cacheReadInputTokens != null
                ? { cache_read_input_tokens: usage.cacheReadInputTokens }
                : {}),
              ...(usage.cacheCreationInputTokens != null
                ? {
                    cache_creation_input_tokens: usage.cacheCreationInputTokens,
                  }
                : {}),
            }),
          },
          inputs,
          outputs: {
            content: response.content.map((b) => blockSummary(b, cfg)),
          },
        },
        conf.conversationId,
      );
      return response;
    } catch (err) {
      this.addSpan(
        {
          name,
          type: "LLM",
          startNs,
          endNs: nowNs(),
          attributes,
          inputs,
          error:
            err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
        conf.conversationId,
      );
      throw err;
    }
  }

  // ---- tools and memory

  /** A tool result, timed from the turn's previous span (tools carry no start). */
  recordToolResult(args: {
    conversationId: string;
    toolName: string;
    input: unknown;
    output: string;
    isError: boolean;
  }): void {
    const cfg = this.config();
    if (!cfg) {
      return;
    }
    const turn = this.turns.get(args.conversationId);
    const prevEnd = turn?.spans.reduce<bigint>(
      (max, s) => (s.endNs > max ? s.endNs : max),
      BigInt(turn.startNs),
    );
    this.addSpan(
      {
        name: `tool.${args.toolName}`,
        type: "TOOL",
        startNs: prevEnd ?? nowNs(),
        endNs: nowNs(),
        attributes: {
          "vellum.tool": args.toolName,
          "vellum.timing": "approximate",
        },
        inputs: { input: captureText(JSON.stringify(args.input ?? {}), cfg) },
        outputs: { output: captureText(args.output, cfg) },
        ...(args.isError ? { error: "tool returned an error" } : {}),
      },
      args.conversationId,
    );
  }

  /** The memory-v3 retrieval record for a turn: pool, lanes, selection. */
  recordMemoryRetrieval(args: {
    conversationId: string;
    turn: number;
    poolSize: number;
    selectedCount: number;
    selectorRan: boolean;
    laneCounts: Record<string, number>;
    chosen: { slug: string; section: string | null; lane: string }[];
  }): void {
    const cfg = this.config();
    if (!cfg) {
      return;
    }
    const at = nowNs();
    this.addSpan(
      {
        name: "memory.v3.retrieve",
        type: "RETRIEVER",
        startNs: at,
        endNs: at,
        attributes: {
          "vellum.memory.turn": args.turn,
          "vellum.memory.pool_size": args.poolSize,
          "vellum.memory.selected_count": args.selectedCount,
          "vellum.memory.selector_ran": args.selectorRan,
          "vellum.memory.lane_counts": JSON.stringify(args.laneCounts),
          "vellum.timing": "point-in-time",
        },
        outputs: { chosen: args.chosen },
      },
      args.conversationId,
    );
  }

  // ---- background jobs

  /** Run a background job inside its own trace; nested model calls join it. */
  async traceJob<T>(
    job: {
      id: string;
      type: string;
      attempts: number;
      payload?: Record<string, unknown>;
    },
    run: () => Promise<T>,
  ): Promise<T> {
    const cfg = this.config();
    if (!cfg || this.jobScope.getStore()) {
      return run();
    }
    const scope: OpenTrace = {
      traceId: hex(16),
      rootSpanId: hex(8),
      startNs: nowNs(),
      spans: [],
    };
    const conversationId =
      typeof job.payload?.conversationId === "string"
        ? job.payload.conversationId
        : undefined;
    let error: string | undefined;
    try {
      return await this.jobScope.run(scope, run);
    } catch (err) {
      error =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw err;
    } finally {
      const root: FinishedSpan = {
        traceId: scope.traceId,
        spanId: scope.rootSpanId,
        name: `memory_job.${job.type}`,
        type: "CHAIN",
        startNs: BigInt(scope.startNs),
        endNs: nowNs(),
        attributes: {
          [traceTag("vellum.kind")]: "job",
          [traceTag("vellum.job_type")]: job.type,
          "vellum.job_id": job.id,
          "vellum.job_attempt": job.attempts,
          ...(conversationId
            ? {
                "session.id": conversationId,
                [traceTag("vellum.conversation_id")]: conversationId,
              }
            : {}),
        },
        ...(error ? { error } : {}),
      };
      // Only jobs that did model work are worth a trace; embedding and
      // indexing jobs would otherwise flood the experiment.
      if (scope.spans.length > 0 || error) {
        this.export([root, ...scope.spans], cfg);
      }
    }
  }

  /** Export everything still open (daemon shutdown). */
  async shutdown(): Promise<void> {
    const cfg = this.config();
    if (cfg) {
      for (const turn of this.turns.values()) {
        this.finishTurn(
          turn,
          { exitReason: "shutdown", incomplete: true },
          cfg,
        );
      }
      for (const [conversationId, list] of this.pending) {
        for (const p of list) {
          this.exportStandalone(p.span, conversationId, cfg);
        }
      }
    }
    this.turns.clear();
    this.pending.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    this.sweepTimer = null;
    try {
      await this.exporter.flush();
    } catch (err) {
      log.warn({ err }, "MLflow flush on shutdown failed");
    }
  }
}

let shared: MlflowTracer | null = null;

export function getMlflowTracer(): MlflowTracer {
  shared ??= new MlflowTracer(new MlflowExporter(undefined, APP_VERSION));
  return shared;
}

/** @internal tests only */
export function _setMlflowTracerForTests(tracer: MlflowTracer | null): void {
  shared = tracer;
}

export type { FetchLike };
export type { MlflowSpanType };
