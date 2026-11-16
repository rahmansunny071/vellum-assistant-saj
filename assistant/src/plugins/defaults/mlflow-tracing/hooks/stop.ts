/**
 * Default `stop` hook: closes and exports the turn's MLflow trace with the
 * final reply and exit reason. A no-op unless `mlflowTracing.enabled`.
 */

import type { HookFunction, StopContext } from "@vellumai/plugin-api";

import { getMlflowTracer } from "../../../../telemetry/mlflow/tracer.js";

const stop: HookFunction<StopContext> = async (ctx) => {
  getMlflowTracer().endTurn({
    conversationId: ctx.conversationId,
    messages: ctx.messages,
    exitReason: String(ctx.exitReason),
    ...(ctx.error ? { error: ctx.error } : {}),
  });
};

export default stop;
