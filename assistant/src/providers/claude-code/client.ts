/**
 * `claude-code` LLM provider: Claude Code (over ACP) as a Vellum `Provider`.
 *
 * Text-only (Vellum-RSI milestone M1). What it serves:
 *
 * - **Plain completions:** Vellum's system prompt and messages go to Claude
 *   Code with its built-in tools and settings switched off (see `runtime.ts`).
 * - **Forced single-tool calls** (`config.tool_choice = {type: "tool", name}`
 *   with that tool in `tools`): the structured-output pattern several call
 *   sites use (e.g. the memory v3 selector). The model is asked for JSON
 *   matching the tool's input schema, and the reply is returned as a
 *   `tool_use` block, so callers need no changes.
 *
 * What it refuses: requests that *offer* tools without forcing one, i.e.
 * agentic tool use. That needs Vellum's tools exposed to Claude Code over MCP
 * (plan milestone M5); until then such calls fail loudly instead of silently
 * dropping the tools.
 */

import { randomUUID } from "node:crypto";

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";
import { type ClaudeCodeAcpRuntime, getClaudeCodeRuntime } from "./runtime.js";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

export class ClaudeCodeToolsUnsupportedError extends Error {
  constructor(toolNames: string[]) {
    super(
      `The claude-code provider is text-only for now: it serves plain ` +
        `completions and forced single-tool calls, not open tool use ` +
        `(offered: ${toolNames.join(", ")}). Route this call site to another ` +
        `provider until Vellum tools are exposed to Claude Code over MCP.`,
    );
    this.name = "ClaudeCodeToolsUnsupportedError";
  }
}

export interface ClaudeCodeProviderOptions {
  /** Effort used when the call's config doesn't set one. */
  defaultEffort?: string;
  runtime?: () => ClaudeCodeAcpRuntime;
}

type ForcedTool = { name: string; description: string; input_schema: object };

function blockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use":
      return `[tool call ${block.name}: ${JSON.stringify(block.input)}]`;
    case "tool_result": {
      const content = (block as { content?: unknown }).content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((c) =>
                  c && typeof c === "object" && "text" in c
                    ? String(c.text)
                    : "",
                )
                .join("")
            : "";
      return `[tool result: ${text}]`;
    }
    case "image":
      return "[image omitted]";
    case "file":
      return "[file omitted]";
    default:
      return "";
  }
}

function messageText(message: Message): string {
  return message.content.map(blockToText).filter(Boolean).join("\n");
}

/**
 * One prompt from Vellum's message list. A single user message passes through
 * as is; a longer history is laid out as a transcript ending on the latest
 * message, since each call is a fresh, stateless session.
 */
export function renderMessages(messages: Message[]): string {
  if (messages.length === 1 && messages[0].role === "user") {
    return messageText(messages[0]);
  }
  const lines = messages.map(
    (m) => `${m.role === "user" ? "User" : "Assistant"}: ${messageText(m)}`,
  );
  return (
    "The conversation so far is below. Write the Assistant's next reply.\n\n" +
    lines.join("\n\n")
  );
}

export function forcedToolInstruction(tool: ForcedTool): string {
  return (
    `\n\nRespond with ONLY a JSON object, with no prose and no code fences. The ` +
    `object is the input to the tool "${tool.name}" (${tool.description}) and ` +
    `must match this JSON Schema:\n${JSON.stringify(tool.input_schema)}`
  );
}

/** The first JSON object in a reply, tolerating code fences and stray prose. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  for (const candidate of [
    unfenced,
    unfenced.slice(unfenced.indexOf("{"), unfenced.lastIndexOf("}") + 1),
  ]) {
    if (!candidate) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function forcedTool(options?: SendMessageOptions): ForcedTool | null {
  const tools = options?.tools ?? [];
  if (tools.length === 0) {
    return null;
  }
  const choice = (options?.config as { tool_choice?: unknown } | undefined)
    ?.tool_choice as { type?: string; name?: string } | undefined;
  const named =
    choice?.type === "tool"
      ? tools.find((t) => t.name === choice.name)
      : undefined;
  if (!named) {
    throw new ClaudeCodeToolsUnsupportedError(tools.map((t) => t.name));
  }
  return named;
}

const STOP_REASONS: Record<string, string> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  max_turn_requests: "max_tokens",
  refusal: "refusal",
  cancelled: "cancelled",
};

export class ClaudeCodeProvider implements Provider {
  readonly name = CLAUDE_CODE_PROVIDER_ID;
  // Claude models: let the local estimator use Anthropic's rules.
  readonly tokenEstimationProvider = "anthropic";
  private readonly runtime: () => ClaudeCodeAcpRuntime;

  constructor(
    readonly defaultModel: string,
    private readonly options: ClaudeCodeProviderOptions = {},
  ) {
    this.runtime = options.runtime ?? getClaudeCodeRuntime;
  }

  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const tool = forcedTool(options);
    const config = (options?.config ?? {}) as {
      model?: string;
      effort?: string;
    };
    const model = config.model || this.defaultModel;
    const effort =
      config.effort && config.effort !== "none"
        ? config.effort
        : this.options.defaultEffort;
    const prompt =
      renderMessages(messages) + (tool ? forcedToolInstruction(tool) : "");

    const result = await this.runtime().runTurn({
      systemPrompt: options?.systemPrompt,
      prompt,
      model,
      effort,
      signal: options?.signal,
      // Forced-tool JSON is not user-facing text, so it isn't streamed.
      onText: tool
        ? undefined
        : (text) => options?.onEvent?.({ type: "text_delta", text }),
      onThinking: (thinking) =>
        options?.onEvent?.({ type: "thinking_delta", thinking }),
    });

    let content: ContentBlock[];
    let stopReason = STOP_REASONS[result.stopReason] ?? result.stopReason;
    if (tool) {
      const input = parseJsonObject(result.text);
      // Unparseable JSON returns as text, so the caller's own "no tool_use"
      // handling (retry, fallback) applies.
      content = input
        ? [
            {
              type: "tool_use",
              id: `toolu_cc_${randomUUID()}`,
              name: tool.name,
              input,
            },
          ]
        : [{ type: "text", text: result.text }];
      if (input) {
        stopReason = "tool_use";
      }
    } else {
      content = [{ type: "text", text: result.text }];
    }

    return {
      content,
      model: result.model ?? model,
      actualProvider: CLAUDE_CODE_PROVIDER_ID,
      usage: result.usage,
      stopReason,
      rawRequest: {
        transport: "acp",
        model,
        effort: effort ?? null,
        forcedTool: tool?.name ?? null,
        systemPromptChars: options?.systemPrompt?.length ?? 0,
        promptChars: prompt.length,
      },
      rawResponse: {
        stopReason: result.stopReason,
        timings: result.timings,
        usage: result.usage,
      },
    };
  }
}
