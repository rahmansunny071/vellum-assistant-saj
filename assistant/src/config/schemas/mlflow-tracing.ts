/**
 * Configuration for exporting traces to a local MLflow tracking server
 * (Vellum-RSI milestone M2).
 *
 * When `enabled`, the daemon (and the memory worker) record one trace per
 * conversation turn: model calls, tool calls and memory-v3 retrieval as child
 * spans, plus one trace per background memory job. Traces are exported as
 * OTLP/JSON to `<endpoint>/v1/traces` into the MLflow experiment named
 * `experimentName`. Export is best-effort and never blocks a turn.
 *
 * The endpoint must be a loopback address: conversation content goes there,
 * so it may only reach a server on this machine.
 */
import { z } from "zod";

const LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;

export const MlflowTracingConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "mlflowTracing.enabled must be a boolean" })
      .default(false)
      .describe("Export turn and memory-job traces to a local MLflow server"),
    endpoint: z
      .string({ error: "mlflowTracing.endpoint must be a string" })
      .regex(
        LOOPBACK_URL,
        "mlflowTracing.endpoint must be a loopback URL (127.0.0.1, localhost or [::1])",
      )
      .default("http://127.0.0.1:5055")
      .describe("Base URL of the local MLflow tracking server"),
    experimentName: z
      .string({ error: "mlflowTracing.experimentName must be a string" })
      .min(1, "mlflowTracing.experimentName cannot be empty")
      .default("vellum-rsi")
      .describe(
        "MLflow experiment that receives the traces (created if missing)",
      ),
    captureContent: z
      .enum(["full", "metadata"], {
        error: 'mlflowTracing.captureContent must be "full" or "metadata"',
      })
      .default("full")
      .describe(
        'What span inputs/outputs carry: "full" (secret-redacted text) or ' +
          '"metadata" (sizes and counts only)',
      ),
    maxContentChars: z
      .number({ error: "mlflowTracing.maxContentChars must be a number" })
      .int()
      .min(200)
      .max(1_000_000)
      .default(20_000)
      .describe("Per-field cap on captured text; longer values are truncated"),
  })
  .describe("Local MLflow trace export (Vellum-RSI)");

export type MlflowTracingConfig = z.infer<typeof MlflowTracingConfigSchema>;
