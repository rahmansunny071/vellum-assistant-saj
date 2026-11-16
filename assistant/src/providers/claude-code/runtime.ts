/**
 * Claude Code over ACP as an LLM backend: process lifecycle and one-shot turns.
 *
 * One `claude-agent-acp` adapter process is shared by every request and
 * started lazily. Each request is one *turn* on a fresh ACP session:
 *
 *   session/new (custom system prompt, built-in tools off, user/project
 *   settings off) → model pinned → session/prompt → streamed text collected
 *   → session/close (always, so the adapter's per-session Claude Code process
 *   is released).
 *
 * This is the text-only (M1) path of the Vellum-RSI plan: no tools reach the
 * model, so Claude Code acts as a plain completion backend while Vellum keeps
 * owning the prompt, including its memory injection.
 *
 * Credentials follow the existing ACP spawn path (`prepareAgentEnv`): the
 * adapter gets `CLAUDE_CODE_OAUTH_TOKEN` from the assistant's credential vault.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type {
  Client,
  PromptResponse,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import { AcpAgentProcess } from "../../acp/agent-process.js";
import { resolveAgentWithAutoInstall } from "../../acp/auto-install.js";
import { deriveModelInfo } from "../../acp/model-config.js";
import { prepareAgentEnv } from "../../acp/prepare-agent-env.js";
import { formatResolveFailure } from "../../acp/resolve-agent.js";
import { getLogger } from "../../util/logger.js";
import { getDataDir } from "../../util/platform.js";

const log = getLogger("claude-code-provider");

/** The subset of `AcpAgentProcess` this runtime uses (a seam for tests). */
export interface AcpProcessLike {
  initialize(): Promise<unknown>;
  createSession(
    cwd: string,
    meta?: Record<string, unknown>,
  ): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<SessionConfigOption[]>;
  prompt(sessionId: string, text: string): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  kill(): void;
  readonly isAlive: boolean;
}

export interface TurnRequest {
  systemPrompt?: string;
  prompt: string;
  /** Adapter model alias, e.g. `opus`. */
  model?: string;
  /** Value for the adapter's effort option, when it reports one (e.g. `high`). */
  effort?: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
}

export interface TurnResult {
  text: string;
  stopReason: string;
  model?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
  };
  timings: { sessionMs: number; firstTextMs: number | null; totalMs: number };
}

interface TurnSink {
  text: string[];
  firstTextAt: number | null;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
}

/**
 * The ACP client side: routes `session/update` notifications to the turn that
 * owns the session, and refuses every permission request (no tools are offered,
 * so a request means something unexpected is trying to act).
 */
export class TurnRouter implements Client {
  readonly sinks = new Map<string, TurnSink>();

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const sink = this.sinks.get(params.sessionId);
    if (!sink) {
      return;
    }
    const update = params.update as {
      sessionUpdate: string;
      content?: { type?: string; text?: string };
    };
    const text =
      update.content?.type === "text" ? (update.content.text ?? "") : "";
    if (!text) {
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      sink.firstTextAt ??= Date.now();
      sink.text.push(text);
      sink.onText?.(text);
    } else if (update.sessionUpdate === "agent_thought_chunk") {
      sink.onThinking?.(text);
    }
  }

  async requestPermission(): Promise<RequestPermissionResponse> {
    log.warn("Refusing an ACP permission request on the text-only provider");
    return { outcome: { outcome: "cancelled" } };
  }
}

/** A counting semaphore, so concurrent calls queue instead of piling sessions up. */
class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private available: number) {}

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.available += 1;
      }
    };
  }
}

export type StartProcess = (router: TurnRouter) => Promise<AcpProcessLike>;

/** Empty, private working directory: keeps project files and CLAUDE.md out. */
export function providerCwd(): string {
  const dir = join(getDataDir(), "claude-code-provider");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const defaultStartProcess: StartProcess = async (router) => {
  const { resolved, failureMessage } =
    await resolveAgentWithAutoInstall("claude");
  if (!resolved.ok) {
    throw new Error(failureMessage ?? formatResolveFailure("claude", resolved));
  }
  const config = await prepareAgentEnv(resolved.agent);
  const proc = new AcpAgentProcess("claude", config, () => router);
  proc.spawn(providerCwd());
  await proc.initialize();
  return proc;
};

/**
 * `_meta` for `session/new`: Vellum's system prompt replaces Claude Code's, no
 * built-in tools, and no user/project/local settings, so Claude Code's own
 * CLAUDE.md and memory never mix into what Vellum's memory is measured on.
 */
export function sessionMeta(systemPrompt: string | undefined, model?: string) {
  return {
    systemPrompt: systemPrompt ?? "",
    disableBuiltInTools: true,
    claudeCode: {
      options: {
        settingSources: [],
        ...(model ? { model } : {}),
      },
    },
  };
}

function findSelect(
  options: SessionConfigOption[],
  match: (o: SessionConfigOption) => boolean,
): Extract<SessionConfigOption, { type: "select" }> | undefined {
  return options.find(
    (o): o is Extract<SessionConfigOption, { type: "select" }> =>
      o.type === "select" && match(o),
  );
}

function selectValues(
  option: Extract<SessionConfigOption, { type: "select" }>,
) {
  const values: string[] = [];
  for (const entry of option.options) {
    if ("group" in entry) {
      values.push(...entry.options.map((o) => o.value));
    } else {
      values.push(entry.value);
    }
  }
  return values;
}

export class ClaudeCodeAcpRuntime {
  private proc: AcpProcessLike | null = null;
  private starting: Promise<AcpProcessLike> | null = null;
  private readonly router = new TurnRouter();
  private readonly gate: Semaphore;

  constructor(
    private readonly startProcess: StartProcess = defaultStartProcess,
    maxConcurrent = 2,
    private readonly cwd: () => string = providerCwd,
  ) {
    this.gate = new Semaphore(maxConcurrent);
  }

  private async process(): Promise<AcpProcessLike> {
    if (this.proc?.isAlive) {
      return this.proc;
    }
    this.proc = null;
    this.starting ??= this.startProcess(this.router).finally(() => {
      this.starting = null;
    });
    this.proc = await this.starting;
    return this.proc;
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    req.signal?.throwIfAborted();
    const release = await this.gate.acquire();
    const started = Date.now();
    let sessionId: string | null = null;
    let proc: AcpProcessLike | null = null;
    const onAbort = () => {
      if (proc && sessionId) {
        void proc.cancel(sessionId).catch(() => {});
      }
    };
    try {
      proc = await this.process();
      const created = await proc.createSession(
        this.cwd(),
        sessionMeta(req.systemPrompt, req.model),
      );
      sessionId = created.sessionId;
      let configOptions = created.configOptions;

      // Pin the model when the adapter didn't already start on it.
      const info = deriveModelInfo(configOptions);
      if (
        req.model &&
        info.modelConfigId &&
        info.model !== req.model &&
        info.availableModels.some((m) => m.value === req.model)
      ) {
        configOptions = await proc.setConfigOption(
          sessionId,
          info.modelConfigId,
          req.model,
        );
      }
      // Effort, when the adapter exposes it as a select option.
      const effort = req.effort
        ? findSelect(
            configOptions,
            (o) =>
              o.id === "effort" || /effort/i.test(String(o.category ?? "")),
          )
        : undefined;
      if (effort && req.effort && effort.currentValue !== req.effort) {
        if (selectValues(effort).includes(req.effort)) {
          configOptions = await proc.setConfigOption(
            sessionId,
            effort.id,
            req.effort,
          );
        }
      }
      const sessionMs = Date.now() - started;

      const sink: TurnSink = {
        text: [],
        firstTextAt: null,
        onText: req.onText,
        onThinking: req.onThinking,
      };
      this.router.sinks.set(sessionId, sink);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const response = await proc.prompt(sessionId, req.prompt);
      const u = response.usage;
      return {
        text: sink.text.join(""),
        stopReason: response.stopReason,
        model: deriveModelInfo(configOptions).model ?? req.model,
        usage: {
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          ...(u?.cachedReadTokens != null
            ? { cacheReadInputTokens: u.cachedReadTokens }
            : {}),
          ...(u?.cachedWriteTokens != null
            ? { cacheCreationInputTokens: u.cachedWriteTokens }
            : {}),
          ...(u?.thoughtTokens != null
            ? { reasoningTokens: u.thoughtTokens }
            : {}),
        },
        timings: {
          sessionMs,
          firstTextMs: sink.firstTextAt ? sink.firstTextAt - started : null,
          totalMs: Date.now() - started,
        },
      };
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      if (sessionId) {
        this.router.sinks.delete(sessionId);
        const sid = sessionId;
        // Close in the background: the result doesn't depend on it.
        void proc
          ?.closeSession(sid)
          .catch((err) =>
            log.warn({ err, sessionId: sid }, "Failed to close ACP session"),
          );
      }
      release();
    }
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

let shared: ClaudeCodeAcpRuntime | null = null;

/** The daemon-wide runtime (one adapter process for all `claude-code` calls). */
export function getClaudeCodeRuntime(): ClaudeCodeAcpRuntime {
  shared ??= new ClaudeCodeAcpRuntime();
  return shared;
}

/** @internal tests only */
export function _setClaudeCodeRuntimeForTests(
  runtime: ClaudeCodeAcpRuntime | null,
): void {
  shared = runtime;
}
