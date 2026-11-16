/**
 * Default `user-prompt-submit` hook: opens the turn's MLflow trace.
 *
 * Spans recorded for this conversation in the moments before (the memory-v3
 * selector runs ahead of this hook) are adopted into the turn. A no-op unless
 * `mlflowTracing.enabled`.
 */

import type {
  HookFunction,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { getMlflowTracer } from "../../../../telemetry/mlflow/tracer.js";

const userPromptSubmit: HookFunction<UserPromptSubmitContext> = async (ctx) => {
  if (ctx.isHiddenPrompt) {
    return;
  }
  getMlflowTracer().beginTurn({
    conversationId: ctx.conversationId,
    userMessageId: ctx.userMessageId,
    requestId: ctx.requestId,
    prompt: ctx.prompt,
    profile: ctx.modelProfileKey,
  });
};

export default userPromptSubmit;
