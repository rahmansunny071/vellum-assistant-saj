import { describe, expect, test } from "bun:test";

import type {
  PromptResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";

import { buildProviderAdapter } from "../../inference/adapter-factory.js";
import type { ProviderEvent } from "../../types.js";
import {
  ClaudeCodeProvider,
  ClaudeCodeToolsUnsupportedError,
  parseJsonObject,
  renderMessages,
} from "../client.js";
import {
  type AcpProcessLike,
  ClaudeCodeAcpRuntime,
  sessionMeta,
  type TurnRouter,
} from "../runtime.js";

const MODEL_OPTION: SessionConfigOption = {
  id: "model",
  name: "Model",
  type: "select",
  currentValue: "sonnet",
  options: [
    { value: "sonnet", name: "Sonnet" },
    { value: "opus", name: "Opus" },
  ],
} as SessionConfigOption;

const EFFORT_OPTION: SessionConfigOption = {
  id: "effort",
  name: "Effort",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
} as SessionConfigOption;

/** Fake adapter: replies with `reply` as text chunks through the router. */
class FakeProcess implements AcpProcessLike {
  isAlive = true;
  calls: { method: string; args: unknown[] }[] = [];
  private next = 0;
  constructor(
    private readonly router: TurnRouter,
    private readonly reply: string | (() => Promise<string>),
    private readonly options: SessionConfigOption[] = [
      MODEL_OPTION,
      EFFORT_OPTION,
    ],
  ) {}

  async initialize() {
    return {};
  }
  async createSession(cwd: string, meta?: Record<string, unknown>) {
    this.calls.push({ method: "createSession", args: [cwd, meta] });
    this.next += 1;
    return { sessionId: `s${this.next}`, configOptions: this.options };
  }
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ) {
    this.calls.push({
      method: "setConfigOption",
      args: [sessionId, configId, value],
    });
    return this.options.map((o) =>
      o.id === configId
        ? ({ ...o, currentValue: value } as SessionConfigOption)
        : o,
    );
  }
  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    this.calls.push({ method: "prompt", args: [sessionId, text] });
    const reply =
      typeof this.reply === "string" ? this.reply : await this.reply();
    for (const piece of [reply.slice(0, 3), reply.slice(3)]) {
      if (!piece) {
        continue;
      }
      await this.router.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: piece },
        },
      } as never);
    }
    return {
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        cachedReadTokens: 3,
      },
    } as PromptResponse;
  }
  async cancel(sessionId: string) {
    this.calls.push({ method: "cancel", args: [sessionId] });
  }
  async closeSession(sessionId: string) {
    this.calls.push({ method: "closeSession", args: [sessionId] });
  }
  kill() {
    this.isAlive = false;
  }
  methods() {
    return this.calls.map((c) => c.method);
  }
}

function setup(reply: string | (() => Promise<string>), maxConcurrent = 2) {
  let fake: FakeProcess | null = null;
  let starts = 0;
  const runtime = new ClaudeCodeAcpRuntime(
    async (router) => {
      starts += 1;
      fake = new FakeProcess(router, reply);
      return fake;
    },
    maxConcurrent,
    () => "/tmp/cc-test",
  );
  const provider = new ClaudeCodeProvider("opus", { runtime: () => runtime });
  return { provider, runtime, fake: () => fake!, starts: () => starts };
}

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

describe("ClaudeCodeProvider (text-only)", () => {
  test("plain completion: system prompt in session meta, streamed text, usage, session closed", async () => {
    const { provider, fake } = setup("Hello there");
    const events: ProviderEvent[] = [];
    const res = await provider.sendMessage([user("hi")], {
      systemPrompt: "You are Vellum.",
      config: { effort: "high" } as never,
      onEvent: (e) => events.push(e),
    });

    expect(res.content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.actualProvider).toBe("claude-code");
    expect(res.usage).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cacheReadInputTokens: 3,
    });
    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo there" },
    ]);

    const [cwd, meta] = fake().calls[0].args;
    expect(cwd).toBe("/tmp/cc-test");
    expect(meta).toEqual(sessionMeta("You are Vellum.", "opus"));
    expect(meta).toMatchObject({
      disableBuiltInTools: true,
      claudeCode: { options: { settingSources: [] } },
    });
    await Bun.sleep(0);
    expect(fake().methods()).toEqual([
      "createSession",
      "setConfigOption", // model sonnet → opus
      "setConfigOption", // effort medium → high
      "prompt",
      "closeSession",
    ]);
    expect(fake().calls[1].args).toEqual(["s1", "model", "opus"]);
    expect(fake().calls[2].args).toEqual(["s1", "effort", "high"]);
  });

  test("forced single-tool call returns a tool_use block parsed from JSON", async () => {
    const { provider, fake } = setup('```json\n{"selected": ["a", "b"]}\n```');
    const events: ProviderEvent[] = [];
    const res = await provider.sendMessage([user("pick pages")], {
      tools: [
        {
          name: "select_pages",
          description: "pick",
          input_schema: { type: "object" },
        },
      ],
      config: { tool_choice: { type: "tool", name: "select_pages" } } as never,
      onEvent: (e) => events.push(e),
    });
    expect(res.stopReason).toBe("tool_use");
    expect(res.content).toHaveLength(1);
    const block = res.content[0] as {
      type: string;
      name: string;
      input: unknown;
    };
    expect(block.type).toBe("tool_use");
    expect(block.name).toBe("select_pages");
    expect(block.input).toEqual({ selected: ["a", "b"] });
    expect(events).toEqual([]); // tool JSON is not streamed as user-facing text
    const promptText = String(
      fake().calls.find((c) => c.method === "prompt")!.args[1],
    );
    expect(promptText).toContain("pick pages");
    expect(promptText).toContain('"select_pages"');
  });

  test("forced tool with unparseable reply comes back as text for the caller's retry", async () => {
    const { provider } = setup("sorry, no JSON here");
    const res = await provider.sendMessage([user("x")], {
      tools: [{ name: "t", description: "d", input_schema: {} }],
      config: { tool_choice: { type: "tool", name: "t" } } as never,
    });
    expect(res.content).toEqual([
      { type: "text", text: "sorry, no JSON here" },
    ]);
    expect(res.stopReason).toBe("end_turn");
  });

  test("open tool use is refused before any session starts", async () => {
    const { provider, starts } = setup("unused");
    await expect(
      provider.sendMessage([user("x")], {
        tools: [{ name: "bash", description: "run", input_schema: {} }],
      }),
    ).rejects.toBeInstanceOf(ClaudeCodeToolsUnsupportedError);
    expect(starts()).toBe(0);
  });

  test("one adapter process is reused across calls", async () => {
    const { provider, starts, fake } = setup("ok");
    await provider.sendMessage([user("1")]);
    await provider.sendMessage([user("2")]);
    expect(starts()).toBe(1);
    expect(
      fake()
        .methods()
        .filter((m) => m === "createSession"),
    ).toHaveLength(2);
  });

  test("concurrency is bounded", async () => {
    let inFlight = 0;
    let peak = 0;
    const { provider } = setup(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight -= 1;
      return "ok";
    }, 2);
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => provider.sendMessage([user(String(n))])),
    );
    expect(peak).toBe(2);
  });

  test("abort cancels the in-flight prompt and still closes the session", async () => {
    const controller = new AbortController();
    const { provider, fake } = setup(async () => {
      controller.abort();
      await Bun.sleep(1);
      return "late";
    });
    await provider.sendMessage([user("x")], { signal: controller.signal });
    await Bun.sleep(0);
    expect(fake().methods()).toContain("cancel");
    expect(fake().methods()).toContain("closeSession");
  });

  test("the adapter factory builds this provider for the claude-code catalog id", () => {
    const adapter = buildProviderAdapter("claude-code", {
      apiKey: "",
      model: "opus",
      streamTimeoutMs: 1000,
      useNativeWebSearch: false,
    });
    expect(adapter).toBeInstanceOf(ClaudeCodeProvider);
    expect(adapter?.defaultModel).toBe("opus");
  });
});

describe("helpers", () => {
  test("renderMessages passes a single user message through and lays out history", () => {
    expect(renderMessages([user("just this")])).toBe("just this");
    const text = renderMessages([
      user("q1"),
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      user("q2"),
    ]);
    expect(text).toContain("User: q1\n\nAssistant: a1\n\nUser: q2");
  });

  test("parseJsonObject tolerates fences and prose", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('Here you go:\n```json\n{"a": [1]}\n```')).toEqual({
      a: [1],
    });
    expect(parseJsonObject("[1,2]")).toBeNull();
    expect(parseJsonObject("nope")).toBeNull();
  });
});
