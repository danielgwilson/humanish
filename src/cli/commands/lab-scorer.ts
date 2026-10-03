import { loadAdapterScorer, type AdapterScorerModule } from "../../study/adapter-scorer-loader.js";
import type { LabRoute } from "../../study/plan.js";
import type { RunScorerProvenance } from "../../run/bundle.js";
import type { LabConfig } from "../../study/types.js";
import type { RunResult } from "../../run/results.js";

/** A config-declared scorer that resolved + loaded fail-closed, ready to thread into a backend. */
export interface LoadedAdapterScorer {
  hooks: AdapterScorerModule;
  provenance: RunScorerProvenance;
}

/**
 * Resolve `review.scorer.ref` (or the `--scorer` override) to a loaded adopter scorer, fail-closed
 * (typed error) pre-spend. Precedence: CLI `--scorer` overrides the manifest; `source` records which
 * won. No scorer declared → `{ ok: true }` with no scorer. A declared scorer on an unsupported
 * backend, or a bad/unreadable/broken ref, → `{ ok: false }` so the caller aborts with exit 2.
 */
export async function maybeLoadAdapterScorer(args: {
  cwd: string;
  config: LabConfig;
  route: LabRoute;
  flag: string | undefined;
}): Promise<
  { ok: true; scorer?: LoadedAdapterScorer } | { ok: false; error: NonNullable<RunResult["error"]> }
> {
  const ref = args.flag ?? args.config.review?.scorer?.ref;
  if (ref === undefined) return { ok: true };
  const source = args.flag !== undefined ? "cli-flag" : "manifest";
  const loaded = await loadAdapterScorer({ cwd: args.cwd, ref, route: args.route, source });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, scorer: { hooks: loaded.hooks, provenance: loaded.provenance } };
}
