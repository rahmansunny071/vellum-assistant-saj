/**
 * Default `shutdown` hook: exports any still-open MLflow traces (marked
 * incomplete) and flushes the export queue, so a daemon restart does not lose
 * the turn in flight.
 */

import type { HookFunction, ShutdownContext } from "@vellumai/plugin-api";

import { getMlflowTracer } from "../../../../telemetry/mlflow/tracer.js";

const shutdown: HookFunction<ShutdownContext> = async () => {
  await getMlflowTracer().shutdown();
};

export default shutdown;
