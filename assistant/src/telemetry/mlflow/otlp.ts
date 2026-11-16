/**
 * Finished spans → OTLP/JSON `ExportTraceServiceRequest`, with the attribute
 * keys MLflow's OTLP ingestion maps onto its own trace model
 * (`mlflow.spanType`, `mlflow.spanInputs`/`Outputs`, `mlflow.chat.tokenUsage`,
 * `session.id`, and `mlflow.traceTag.<key>` for searchable trace tags).
 */

export type MlflowSpanType = "AGENT" | "LLM" | "TOOL" | "RETRIEVER" | "CHAIN";

export type AttrValue = string | number | boolean;

export interface FinishedSpan {
  traceId: string; // 32 hex chars
  spanId: string; // 16 hex chars
  parentSpanId?: string;
  name: string;
  type: MlflowSpanType;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, AttrValue>;
  inputs?: unknown;
  outputs?: unknown;
  error?: string;
}

/** A trace tag (searchable in MLflow) carried as a root-span attribute. */
export function traceTag(key: string): string {
  return `mlflow.traceTag.${key}`;
}

function otlpValue(v: AttrValue): Record<string, unknown> {
  if (typeof v === "boolean") {
    return { boolValue: v };
  }
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: v };
}

function attributesOf(span: FinishedSpan): { key: string; value: unknown }[] {
  const attrs: Record<string, AttrValue> = {
    ...span.attributes,
    "mlflow.spanType": span.type,
  };
  if (span.inputs !== undefined) {
    attrs["mlflow.spanInputs"] = JSON.stringify(span.inputs);
  }
  if (span.outputs !== undefined) {
    attrs["mlflow.spanOutputs"] = JSON.stringify(span.outputs);
  }
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: otlpValue(value),
  }));
}

export function toOtlpRequest(
  spans: FinishedSpan[],
  serviceVersion: string,
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "vellum-assistant" } },
            { key: "service.version", value: { stringValue: serviceVersion } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "vellum-rsi" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.type === "LLM" ? 3 : 1, // CLIENT for model calls, INTERNAL otherwise
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: (s.endNs < s.startNs
                ? s.startNs
                : s.endNs
              ).toString(),
              attributes: attributesOf(s),
              status: s.error
                ? { code: 2, message: s.error.slice(0, 2000) }
                : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}
