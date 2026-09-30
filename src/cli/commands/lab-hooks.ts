import { type AutomaticAnalysisHooks } from "../../analysis/automatic-completion.js";
import type { RunLabProvenance } from "../../run/status.js";
import { loadAdapterScorer, type AdapterScorerModule } from "../../lab/adapter-scorer-loader.js";
import type { LabBackend } from "../../lab/engine.js";
import type { RunScorerProvenance } from "../../run/bundle.js";
import type { TerminalProductLabHooks } from "../../routes/terminal/lab.js";
import type { BrowserLabAdapterHooks } from "../../lab/adapter-extension.js";
import type { LabConfig } from "../../lab/config.js";
import type { RunResult } from "../../run/bundle.js";
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

/** Terminal route hooks bag from a loaded scorer (deriveArtifacts is browser-only, dropped here). */
export function terminalScorerHooks(scorer: LoadedAdapterScorer): TerminalProductLabHooks {
  const { hooks } = scorer;
  return {
    ...(hooks.score ? { score: hooks.score } : {}),
    ...(hooks.deriveFeedback ? { deriveFeedback: hooks.deriveFeedback } : {}),
  };
}

/** Browser route hooks bag from a loaded scorer (score + deriveFeedback + deriveArtifacts). */
export function browserScorerHooks(scorer: LoadedAdapterScorer): BrowserLabAdapterHooks {
  const { hooks } = scorer;
  return {
    ...(hooks.score ? { score: hooks.score } : {}),
    ...(hooks.deriveFeedback ? { deriveFeedback: hooks.deriveFeedback } : {}),
    ...(hooks.deriveArtifacts ? { deriveArtifacts: hooks.deriveArtifacts } : {}),
  };
}

/** Listeners exist only while post-run analysis is active; actor signal behavior is unchanged. */
export function cliAutomaticAnalysisHooks(io: Pick<CliIo, "writeErr">): AutomaticAnalysisHooks {
  const controller = new AbortController();
  return {
    deps: { signal: controller.signal },
    onStart: () => {
      const cancel = (): void => {
        controller.abort();
      };
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      io.writeErr("Participants finished; preparing analysis…\n");
      for (const signal of signals) process.on(signal, cancel);
      return () => {
        for (const signal of signals) process.off(signal, cancel);
      };
    },
  };
}
