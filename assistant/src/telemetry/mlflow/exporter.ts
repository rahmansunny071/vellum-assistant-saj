/**
 * Best-effort OTLP/JSON export to a local MLflow server.
 *
 * Finished traces are queued and sent in batches to `<endpoint>/v1/traces`
 * with the experiment chosen by the `x-mlflow-experiment-id` header (the
 * experiment is looked up by name and created when missing). Nothing here can
 * fail or slow a turn: sends happen off the caller's path, the queue is
 * bounded, and failures are logged (throttled) and dropped after a few retries.
 */

import { getLogger } from "../../util/logger.js";
import { type FinishedSpan, toOtlpRequest } from "./otlp.js";

const log = getLogger("mlflow-tracing");

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ExporterTarget {
  endpoint: string;
  experimentName: string;
}

const MAX_QUEUED_TRACES = 500;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 5_000;

export class MlflowExporter {
  private queue: {
    spans: FinishedSpan[];
    target: ExporterTarget;
    attempts: number;
  }[] = [];
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private experimentIds = new Map<string, string>();
  private lastWarnAt = 0;
  exported = 0;
  dropped = 0;

  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly serviceVersion = "unknown",
    private readonly debounceMs = 1_000,
  ) {}

  enqueue(spans: FinishedSpan[], target: ExporterTarget): void {
    if (spans.length === 0) {
      return;
    }
    this.queue.push({ spans, target, attempts: 0 });
    while (this.queue.length > MAX_QUEUED_TRACES) {
      this.queue.shift();
      this.dropped += 1;
      this.warn(
        { maxQueued: MAX_QUEUED_TRACES },
        "MLflow export queue full; dropped oldest trace",
      );
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Send everything queued now. Resolves when the attempt finishes. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      // One request per target (endpoint + experiment).
      const groups = new Map<string, typeof batch>();
      for (const item of batch) {
        const key = `${item.target.endpoint}\0${item.target.experimentName}`;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      for (const items of groups.values()) {
        const target = items[0].target;
        try {
          await this.send(
            target,
            items.flatMap((i) => i.spans),
          );
          this.exported += items.length;
        } catch (err) {
          const retry = items.filter((i) => ++i.attempts < MAX_ATTEMPTS);
          this.dropped += items.length - retry.length;
          this.warn(
            { err: String(err), traces: items.length, retrying: retry.length },
            "MLflow trace export failed",
          );
          if (retry.length > 0) {
            this.queue.unshift(...retry);
            return; // back off until the next enqueue/flush
          }
        }
      }
    }
  }

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async experimentId(target: ExporterTarget): Promise<string> {
    const key = `${target.endpoint}\0${target.experimentName}`;
    const cached = this.experimentIds.get(key);
    if (cached) {
      return cached;
    }
    const base = target.endpoint.replace(/\/$/, "");
    const name = encodeURIComponent(target.experimentName);
    const got = await this.request(
      `${base}/api/2.0/mlflow/experiments/get-by-name?experiment_name=${name}`,
      { method: "GET" },
    );
    let id: string | undefined;
    if (got.ok) {
      id = ((await got.json()) as { experiment?: { experiment_id?: string } })
        .experiment?.experiment_id;
    } else {
      const created = await this.request(
        `${base}/api/2.0/mlflow/experiments/create`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: target.experimentName }),
        },
      );
      if (!created.ok) {
        throw new Error(`create experiment failed: HTTP ${created.status}`);
      }
      id = ((await created.json()) as { experiment_id?: string }).experiment_id;
    }
    if (!id) {
      throw new Error("MLflow returned no experiment id");
    }
    this.experimentIds.set(key, id);
    return id;
  }

  private async send(
    target: ExporterTarget,
    spans: FinishedSpan[],
  ): Promise<void> {
    const experimentId = await this.experimentId(target);
    const res = await this.request(
      `${target.endpoint.replace(/\/$/, "")}/v1/traces`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-mlflow-experiment-id": experimentId,
        },
        body: JSON.stringify(toOtlpRequest(spans, this.serviceVersion)),
      },
    );
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
  }

  private warn(obj: Record<string, unknown>, msg: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) {
      return;
    }
    this.lastWarnAt = now;
    log.warn(obj, msg);
  }
}
