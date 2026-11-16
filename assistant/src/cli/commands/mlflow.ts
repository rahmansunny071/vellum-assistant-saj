/**
 * `assistant mlflow` CLI namespace (Vellum-RSI M2).
 *
 * Subcommands: status, feedback. Local transport: both talk to the MLflow
 * server named in `mlflowTracing` directly, never through the daemon.
 */

import type { Command } from "commander";

import type { TurnTraceSummary } from "../../telemetry/mlflow/feedback.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { mlflowHelp } from "./mlflow.help.js";

/** Daemon-internal modules, loaded lazily so they stay out of the CLI's static graph. */
async function loadDeps() {
  const [{ getConfig }, feedback] = await Promise.all([
    import("../../config/loader.js"),
    import("../../telemetry/mlflow/feedback.js"),
  ]);
  return { cfg: getConfig().mlflowTracing, ...feedback };
}

function fail(msg: string, json?: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  } else {
    log.error(msg);
  }
  process.exitCode = 1;
}

export function registerMlflowCommand(program: Command): void {
  registerCommand(program, {
    name: mlflowHelp.name,
    transport: "local",
    description: mlflowHelp.description,
    build: (mlflow) => {
      applyCommandHelp(mlflow, mlflowHelp);

      subcommand(mlflow, "status").action(async (opts: { json?: boolean }) => {
        const { cfg, mlflowHealthy, recentTurnTraces } = await loadDeps();
        const healthy = await mlflowHealthy(cfg);
        let recent: TurnTraceSummary[] = [];
        let recentError: string | null = null;
        if (healthy) {
          try {
            recent = await recentTurnTraces(cfg, 5);
          } catch (err) {
            recentError = err instanceof Error ? err.message : String(err);
          }
        }
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              enabled: cfg.enabled,
              endpoint: cfg.endpoint,
              experiment: cfg.experimentName,
              captureContent: cfg.captureContent,
              serverHealthy: healthy,
              recentTurns: recent,
              ...(recentError ? { recentError } : {}),
            }) + "\n",
          );
          return;
        }
        log.info(`Tracing:     ${cfg.enabled ? "enabled" : "disabled"}`);
        log.info(
          `Endpoint:    ${cfg.endpoint} (${healthy ? "healthy" : "not reachable"})`,
        );
        log.info(`Experiment:  ${cfg.experimentName}`);
        log.info(`Content:     ${cfg.captureContent}`);
        if (recentError) {
          log.info(`Recent turns: ${recentError}`);
        }
        for (const t of recent) {
          log.info(
            `  ${t.traceId}  ${t.requestTime ?? ""}  ${(t.preview ?? "").slice(0, 60)}`,
          );
        }
      });

      subcommand(mlflow, "feedback").action(
        async (
          rating: string,
          opts: { trace?: string; note?: string; json?: boolean },
        ) => {
          const value = rating.trim().toLowerCase();
          if (value !== "up" && value !== "down") {
            fail(`Rating must be "up" or "down", got "${rating}".`, opts.json);
            return;
          }
          const { cfg, logFeedback, recentTurnTraces } = await loadDeps();
          try {
            let traceId = opts.trace;
            if (!traceId) {
              const [latest] = await recentTurnTraces(cfg, 1);
              if (!latest) {
                fail(
                  "No turn traces found. Is mlflowTracing.enabled set?",
                  opts.json,
                );
                return;
              }
              traceId = latest.traceId;
            }
            const assessmentId = await logFeedback(cfg, {
              traceId,
              positive: value === "up",
              ...(opts.note ? { note: opts.note } : {}),
            });
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({ ok: true, traceId, assessmentId }) + "\n",
              );
            } else {
              log.info(
                `Recorded thumbs-${value} on ${traceId} (${assessmentId})`,
              );
            }
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err), opts.json);
          }
        },
      );
    },
  });
}
