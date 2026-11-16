/**
 * Feedback on traced turns, stored as MLflow assessments.
 *
 * A thumbs up/down (and optional note) becomes a `user_feedback` assessment
 * on the turn's trace, with `source_type: HUMAN`. This is the signal the
 * Vellum-RSI tuning loop reads alongside ConvoMem scores. Turn traces carry
 * the `vellum.kind = turn` tag, so "the latest turn" is a tag search, with no
 * local id mapping.
 */

import type { MlflowTracingConfig } from "../../config/schemas/mlflow-tracing.js";
import { type FetchLike, MlflowExporter } from "./exporter.js";

export interface TurnTraceSummary {
  traceId: string;
  requestTime: string | null;
  conversationId: string | null;
  preview: string | null;
}

async function call(
  fetchImpl: FetchLike,
  url: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(
      `MLflow ${method} ${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  return res.json();
}

/** Most recent turn traces in the configured experiment, newest first. */
export async function recentTurnTraces(
  cfg: MlflowTracingConfig,
  limit = 5,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<TurnTraceSummary[]> {
  const base = cfg.endpoint.replace(/\/$/, "");
  const experimentId = await new MlflowExporter(fetchImpl).experimentId({
    endpoint: cfg.endpoint,
    experimentName: cfg.experimentName,
  });
  const result = (await call(
    fetchImpl,
    `${base}/api/3.0/mlflow/traces/search`,
    "POST",
    {
      locations: [
        {
          type: "MLFLOW_EXPERIMENT",
          mlflow_experiment: { experiment_id: experimentId },
        },
      ],
      filter: "tags.`vellum.kind` = 'turn'",
      order_by: ["timestamp_ms DESC"],
      max_results: limit,
    },
  )) as {
    traces?: {
      trace_id: string;
      request_time?: string;
      request_preview?: string;
      tags?: Record<string, string>;
    }[];
  };
  return (result.traces ?? []).map((t) => ({
    traceId: t.trace_id,
    requestTime: t.request_time ?? null,
    conversationId: t.tags?.["vellum.conversation_id"] ?? null,
    preview: t.request_preview ?? null,
  }));
}

/** Attach a human `user_feedback` assessment to a trace. Returns its id. */
export async function logFeedback(
  cfg: MlflowTracingConfig,
  args: { traceId: string; positive: boolean; note?: string; source?: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const base = cfg.endpoint.replace(/\/$/, "");
  const result = (await call(
    fetchImpl,
    `${base}/api/3.0/mlflow/traces/${encodeURIComponent(args.traceId)}/assessments`,
    "POST",
    {
      assessment: {
        assessment_name: "user_feedback",
        trace_id: args.traceId,
        source: {
          source_type: "HUMAN",
          source_id: args.source ?? "assistant-cli",
        },
        feedback: { value: args.positive },
        ...(args.note ? { rationale: args.note } : {}),
      },
    },
  )) as { assessment?: { assessment_id?: string } };
  const id = result.assessment?.assessment_id;
  if (!id) {
    throw new Error("MLflow returned no assessment id");
  }
  return id;
}

/** Server health: true when `<endpoint>/health` answers 200. */
export async function mlflowHealthy(
  cfg: MlflowTracingConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${cfg.endpoint.replace(/\/$/, "")}/health`, {
      method: "GET",
    });
    return res.ok;
  } catch {
    return false;
  }
}
