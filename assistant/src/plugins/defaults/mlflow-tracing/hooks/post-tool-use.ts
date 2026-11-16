/**
 * Default `post-tool-use` hook: records each tool result as a `tool.<name>`
 * span on the turn's MLflow trace. The tool's name and input come from the
 * matching `tool_use` block in the conversation. Observes only: it never
 * edits the result. A no-op unless `mlflowTracing.enabled`.
 */

import type { HookFunction, PostToolUseContext } from "@vellumai/plugin-api";

import { getMlflowTracer } from "../../../../telemetry/mlflow/tracer.js";

const postToolUse: HookFunction<PostToolUseContext> = async (ctx) => {
  const id = ctx.toolResponse.tool_use_id;
  let name = "unknown";
  let input: unknown = {};
  for (let i = ctx.messages.length - 1; i >= 0 && name === "unknown"; i -= 1) {
    for (const block of ctx.messages[i].content) {
      if (block.type === "tool_use" && block.id === id) {
        name = block.name;
        input = block.input;
        break;
      }
    }
  }
  getMlflowTracer().recordToolResult({
    conversationId: ctx.conversationId,
    toolName: name,
    input,
    output: ctx.toolResponse.content,
    isError: ctx.toolResponse.is_error === true,
  });
};

export default postToolUse;
