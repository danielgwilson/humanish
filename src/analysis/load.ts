// Loads a run's study analysis together with the automatic analysis job's view of it. The store
// and the job module each stay importable without the other.

import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { readAutomaticStudyAnalysisPrepared } from "./job.js";
import { loadAnalysisRecord } from "./store.js";
import type { LoadedAnalysis } from "./types.js";

export async function loadAnalysis(
  prepared: PreparedRunArtifactPaths,
  id?: string,
): Promise<LoadedAnalysis> {
  const [loaded, automatic] = await Promise.all([
    loadAnalysisRecord(prepared, id),
    readAutomaticStudyAnalysisPrepared(prepared),
  ]);
  return automatic === undefined ? loaded : { ...loaded, automatic };
}
