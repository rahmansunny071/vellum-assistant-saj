/** Declarative help for the `assistant mlflow` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const mlflowHelp: CliCommandHelp = {
  name: "mlflow",
  description: "Inspect local MLflow tracing and record feedback on turns",
  helpText: `
When mlflowTracing.enabled is true, every conversation turn is exported as an
MLflow trace (model calls, tool results and memory-v3 retrieval as child
spans) to a local MLflow server, and background memory jobs that call a model
get traces of their own.

Enable it:
  $ assistant config set mlflowTracing.enabled true
  $ assistant config set mlflowTracing.endpoint http://127.0.0.1:5055

Examples:
  $ assistant mlflow status
  $ assistant mlflow feedback down --note "forgot my old budget"
  $ assistant mlflow feedback up --trace tr-0123abcd...`,
  subcommands: [
    {
      name: "status",
      description: "Show tracing config, server health and recent turn traces",
      options: [
        {
          flags: "--json",
          description: "Output result as machine-readable JSON.",
        },
      ],
      helpText: `
Prints whether tracing is enabled, the endpoint and experiment, whether the
MLflow server answers, and the most recent turn traces.`,
    },
    {
      name: "feedback",
      args: "<rating>",
      description: "Record thumbs up/down on a turn as an MLflow assessment",
      options: [
        {
          flags: "--trace <id>",
          description:
            "Trace id (tr-…). Defaults to the most recent turn trace.",
        },
        {
          flags: "--note <text>",
          description: "Optional note explaining the rating.",
        },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON.",
        },
      ],
      helpText: `
Arguments:
  rating   "up" or "down".

Stores a user_feedback assessment (HUMAN source, value true/false, note as
rationale) on the trace, where the Vellum-RSI tuning loop reads it.`,
    },
  ],
};
