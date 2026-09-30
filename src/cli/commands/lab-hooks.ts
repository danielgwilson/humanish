import type { RunLabProvenance } from "../../run/status.js";
import { loadAdapterScorer, type AdapterScorerModule } from "../../lab/adapter-scorer-loader.js";
import type { LabBackend, RunLabOptions } from "../../lab/engine.js";
import type { RunScorerProvenance } from "../../run/bundle.js";
import type { LabConfig } from "../../lab/types.js";
import type { RunResult } from "../../run/results.js";
import type { CliIo } from "../io.js";

/** A CONFIG-DECLARED scorer that resolved + loaded fail-closed, ready to thread into a backend. */
export interface LoadedAdapterScorer {
  hooks: AdapterScorerModule;
  provenance: RunScorerProvenance;
}

/**
 * Resolve `review.scorer.ref` (or the `--scorer` override) to a loaded adopter scorer, fail-closed
 * (typed error) PRE-SPEND. Precedence: CLI `--scorer` overrides the manifest; `source` records which
 * won. No scorer declared → `{ ok: true }` with no scorer. A declared scorer on an unsupported
 * backend, or a bad/unreadable/broken ref, → `{ ok: false }` so the caller aborts with exit 2.
 */
export async function maybeLoadAdapterScorer(args: {
  cwd: string;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  backend: LabBackend;
  flag: string | undefined;
}): Promise<
  { ok: true; scorer?: LoadedAdapterScorer } | { ok: false; error: NonNullable<RunResult["error"]> }
> {
  const ref = args.flag ?? args.config.review?.scorer?.ref;
  if (ref === undefined) return { ok: true };
  const source = args.flag !== undefined ? "cli-flag" : "manifest";
  const loaded = await loadAdapterScorer({ cwd: args.cwd, ref, backend: args.backend, source });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, scorer: { hooks: loaded.hooks, provenance: loaded.provenance } };
}

/**
 * Post-run analysis cancellation for the CLI: while analysis runs, SIGINT, SIGTERM and SIGHUP abort
 * it. The listeners exist only during analysis, so actor signal behavior is unchanged.
 */
export function cliAnalysisOptions(
  io: Pick<CliIo, "writeErr">,
): Pick<RunLabOptions, "onEvent" | "analysisSignal"> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  return {
    analysisSignal: controller.signal,
    onEvent: (event) => {
      if (event.type === "analysis-started") {
        io.writeErr("Participants finished; preparing analysis…\n");
        for (const signal of signals) process.on(signal, cancel);
      } else if (event.type === "analysis-finished") {
        for (const signal of signals) process.off(signal, cancel);
      }
    },
  };
}
