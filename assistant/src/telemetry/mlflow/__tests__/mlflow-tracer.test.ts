import { describe, expect, test } from "bun:test";

import type { MlflowTracingConfig } from "../../../config/schemas/mlflow-tracing.js";
import { MlflowTracingConfigSchema } from "../../../config/schemas/mlflow-tracing.js";
import type { ProviderResponse } from "../../../providers/types.js";
import { type FetchLike, MlflowExporter } from "../exporter.js";
import { logFeedback, recentTurnTraces } from "../feedback.js";
import { toOtlpRequest } from "../otlp.js";
import { MlflowTracer, PENDING_ADOPT_MS } from "../tracer.js";

const CFG: MlflowTracingConfig = MlflowTracingConfigSchema.parse({
  enabled: true,
});

type Sent = { url: string; headers?: Record<string, string>; body?: unknown };

function fakeFetch(): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    sent.push({
      url,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const json = url.includes("get-by-name")
      ? { experiment: { experiment_id: "7" } }
      : url.includes("/assessments")
        ? { assessment: { assessment_id: "a-1" } }
        : url.includes("/traces/search")
          ? {
              traces: [
                {
                  trace_id: "tr-abc",
                  request_time: "t",
                  tags: { "vellum.conversation_id": "c1" },
                },
              ],
            }
          : {};
    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => "",
    };
  };
  return { fetch: fetchImpl, sent };
}

function setup(cfg: MlflowTracingConfig | null = CFG) {
  const { fetch, sent } = fakeFetch();
  let now = 1_000_000;
  const exporter = new MlflowExporter(fetch, "test", 0);
  const tracer = new MlflowTracer(
    exporter,
    () => cfg,
    () => now,
  );
  const spans = async () => {
    await exporter.flush();
    return sent
      .filter((s) => s.url.endsWith("/v1/traces"))
      .flatMap(
        (s) => (s.body as any).resourceSpans[0].scopeSpans[0].spans as any[],
      );
  };
  return {
    tracer,
    exporter,
    sent,
    spans,
    advance: (ms: number) => (now += ms),
  };
}

const attr = (span: any, key: string) =>
  span.attributes.find((a: any) => a.key === key)?.value;

const response = (text: string): ProviderResponse => ({
  content: [{ type: "text", text }],
  model: "opus",
  actualProvider: "claude-code",
  usage: { inputTokens: 10, outputTokens: 3 },
  stopReason: "end_turn",
});

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

describe("MlflowTracer", () => {
  test("a turn adopts the selector span that ran before it opened", async () => {
    const { tracer, spans, sent } = setup();
    await tracer.traceModelCall(
      "claude-code",
      [user("pool")],
      {
        config: { callSite: "memoryV3SelectL2", conversationId: "c1" } as never,
      },
      async () => response('{"selected":[]}'),
    );
    tracer.beginTurn({
      conversationId: "c1",
      userMessageId: "u1",
      requestId: "r1",
      prompt: "What is my budget?",
      profile: "qwen-local",
    });
    tracer.recordMemoryRetrieval({
      conversationId: "c1",
      turn: 0,
      poolSize: 3,
      selectedCount: 1,
      selectorRan: true,
      laneCounts: { needle: 2, fresh: 1 },
      chosen: [
        { slug: "finances/grocery-budget", section: "Budget", lane: "needle" },
      ],
    });
    await tracer.traceModelCall(
      "ollama",
      [user("What is my budget?")],
      {
        systemPrompt: "You are Vellum.",
        config: { callSite: "mainAgent", conversationId: "c1" } as never,
      },
      async () => response("640 dollars"),
    );
    tracer.recordToolResult({
      conversationId: "c1",
      toolName: "remember",
      input: { fact: "x" },
      output: "ok",
      isError: false,
    });
    tracer.endTurn({
      conversationId: "c1",
      messages: [
        user("q"),
        { role: "assistant", content: [{ type: "text", text: "640 dollars" }] },
      ],
      exitReason: "complete",
    });

    const all = await spans();
    expect(all.map((s) => s.name).sort()).toEqual(
      [
        "llm.mainAgent",
        "llm.memoryV3SelectL2",
        "memory.v3.retrieve",
        "tool.remember",
        "turn",
      ].sort(),
    );
    const root = all.find((s) => s.name === "turn");
    expect(new Set(all.map((s) => s.traceId)).size).toBe(1);
    for (const s of all.filter((x) => x !== root)) {
      expect(s.parentSpanId).toBe(root.spanId);
    }
    expect(attr(root, "session.id")).toEqual({ stringValue: "c1" });
    expect(attr(root, "mlflow.traceTag.vellum.kind")).toEqual({
      stringValue: "turn",
    });
    expect(attr(root, "mlflow.traceTag.vellum.user_message_id")).toEqual({
      stringValue: "u1",
    });
    expect(JSON.parse(attr(root, "mlflow.spanOutputs").stringValue)).toEqual({
      reply: "640 dollars",
    });
    // The adopted selector span moved the turn's start back to cover it.
    const selector = all.find((s) => s.name === "llm.memoryV3SelectL2");
    expect(
      BigInt(root.startTimeUnixNano) <= BigInt(selector.startTimeUnixNano),
    ).toBe(true);
    const llm = all.find((s) => s.name === "llm.mainAgent");
    expect(attr(llm, "mlflow.spanType")).toEqual({ stringValue: "LLM" });
    expect(
      JSON.parse(attr(llm, "mlflow.chat.tokenUsage").stringValue),
    ).toMatchObject({
      input_tokens: 10,
      output_tokens: 3,
      total_tokens: 13,
    });
    expect(attr(llm, "vellum.provider")).toEqual({
      stringValue: "claude-code",
    });
    expect(
      JSON.parse(attr(llm, "mlflow.spanInputs").stringValue).system_prompt,
    ).toBe("You are Vellum.");
    // Export goes to the named experiment.
    const post = sent.find((s) => s.url.endsWith("/v1/traces"))!;
    expect(post.headers?.["x-mlflow-experiment-id"]).toBe("7");
  });

  test("unadopted spans become standalone call traces after the window", async () => {
    const { tracer, spans, advance } = setup();
    await tracer.traceModelCall(
      "claude-code",
      [user("x")],
      {
        config: {
          callSite: "conversationTitle",
          conversationId: "c2",
        } as never,
      },
      async () => response("A title"),
    );
    expect(await spans()).toEqual([]); // still waiting for a turn
    advance(PENDING_ADOPT_MS);
    tracer.sweep();
    const [span] = await spans();
    expect(span.name).toBe("llm.conversationTitle");
    expect(span.parentSpanId).toBeUndefined();
    expect(attr(span, "mlflow.traceTag.vellum.kind")).toEqual({
      stringValue: "call",
    });
    expect(attr(span, "session.id")).toEqual({ stringValue: "c2" });
  });

  test("a failing model call is an error span and still throws", async () => {
    const { tracer, spans } = setup();
    tracer.beginTurn({
      conversationId: "c3",
      userMessageId: "u",
      requestId: "r",
      prompt: "p",
      profile: "x",
    });
    await expect(
      tracer.traceModelCall(
        "ollama",
        [user("x")],
        { config: { callSite: "mainAgent", conversationId: "c3" } as never },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    tracer.endTurn({
      conversationId: "c3",
      messages: [],
      exitReason: "error",
      error: new Error("boom"),
    });
    const all = await spans();
    expect(all.find((s) => s.name === "llm.mainAgent").status).toEqual({
      code: 2,
      message: "Error: boom",
    });
    expect(all.find((s) => s.name === "turn").status.code).toBe(2);
  });

  test("job traces nest their model calls and skip jobs that made none", async () => {
    const { tracer, spans } = setup();
    await tracer.traceJob(
      { id: "j0", type: "embed_segment", attempts: 1 },
      async () => 1,
    );
    await tracer.traceJob(
      {
        id: "j1",
        type: "memory_v2_consolidate",
        attempts: 1,
        payload: { conversationId: "c9" },
      },
      async () => {
        await tracer.traceModelCall(
          "claude-code",
          [user("buffer")],
          {
            config: { callSite: "memoryV2Consolidation" } as never,
          },
          async () => response("filed"),
        );
      },
    );
    const all = await spans();
    expect(all.map((s) => s.name).sort()).toEqual([
      "llm.memoryV2Consolidation",
      "memory_job.memory_v2_consolidate",
    ]);
    const root = all.find((s) => s.name.startsWith("memory_job."));
    expect(all.find((s) => s.name.startsWith("llm.")).parentSpanId).toBe(
      root.spanId,
    );
    expect(attr(root, "mlflow.traceTag.vellum.kind")).toEqual({
      stringValue: "job",
    });
    expect(attr(root, "session.id")).toEqual({ stringValue: "c9" });
  });

  test("metadata mode records sizes, and secrets are redacted in full mode", async () => {
    const meta = setup({ ...CFG, captureContent: "metadata" });
    meta.tracer.beginTurn({
      conversationId: "c4",
      userMessageId: "u",
      requestId: "r",
      prompt: "a secret plan",
      profile: "x",
    });
    meta.tracer.endTurn({
      conversationId: "c4",
      messages: [],
      exitReason: "complete",
    });
    const [root] = await meta.spans();
    expect(JSON.parse(attr(root, "mlflow.spanInputs").stringValue)).toEqual({
      prompt: { chars: 13 },
    });

    const full = setup();
    const key = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0".repeat(4);
    full.tracer.beginTurn({
      conversationId: "c5",
      userMessageId: "u",
      requestId: "r",
      prompt: `my key is ${key}`,
      profile: "x",
    });
    full.tracer.endTurn({
      conversationId: "c5",
      messages: [],
      exitReason: "complete",
    });
    const [r2] = await full.spans();
    const prompt = JSON.parse(attr(r2, "mlflow.spanInputs").stringValue)
      .prompt as string;
    expect(prompt).not.toContain(key);
    expect(prompt).toContain("redacted");
  });

  test("everything is a pass-through when tracing is disabled", async () => {
    const { tracer, sent } = setup(null);
    const res = await tracer.traceModelCall(
      "ollama",
      [user("x")],
      { config: { callSite: "mainAgent", conversationId: "c" } as never },
      async () => response("ok"),
    );
    tracer.beginTurn({
      conversationId: "c",
      userMessageId: "u",
      requestId: "r",
      prompt: "p",
      profile: "x",
    });
    tracer.endTurn({
      conversationId: "c",
      messages: [],
      exitReason: "complete",
    });
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    await tracer.shutdown();
    expect(sent).toEqual([]);
  });
});

describe("OTLP and feedback", () => {
  test("ids, kinds and attribute encodings", () => {
    const req = toOtlpRequest(
      [
        {
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          name: "llm.x",
          type: "LLM",
          startNs: 5n,
          endNs: 3n,
          attributes: { n: 2, f: 0.5, b: true, s: "v" },
        },
      ],
      "1.0",
    ) as any;
    const span = req.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.kind).toBe(3);
    expect(span.endTimeUnixNano).toBe("5"); // end clamped to start
    expect(attr(span, "n")).toEqual({ intValue: "2" });
    expect(attr(span, "f")).toEqual({ doubleValue: 0.5 });
    expect(attr(span, "b")).toEqual({ boolValue: true });
  });

  test("feedback finds the latest turn and posts a HUMAN assessment", async () => {
    const { fetch, sent } = fakeFetch();
    const [latest] = await recentTurnTraces(CFG, 1, fetch);
    expect(latest.traceId).toBe("tr-abc");
    const search = sent.find((s) => s.url.endsWith("/traces/search"))!
      .body as any;
    expect(search.filter).toBe("tags.`vellum.kind` = 'turn'");
    const id = await logFeedback(
      CFG,
      { traceId: "tr-abc", positive: false, note: "forgot" },
      fetch,
    );
    expect(id).toBe("a-1");
    const body = sent.find((s) => s.url.includes("/assessments"))!.body as any;
    expect(body.assessment).toMatchObject({
      assessment_name: "user_feedback",
      source: { source_type: "HUMAN" },
      feedback: { value: false },
      rationale: "forgot",
    });
  });

  test("the config only accepts loopback endpoints", () => {
    expect(() =>
      MlflowTracingConfigSchema.parse({
        endpoint: "https://mlflow.example.com",
      }),
    ).toThrow();
    expect(
      MlflowTracingConfigSchema.parse({ endpoint: "http://localhost:5055" })
        .endpoint,
    ).toBe("http://localhost:5055");
  });
});
