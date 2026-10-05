// A library caller's config, written as a humanish.study.v3 manifest. StudyConfig has the keys a v3
// file has, so a caller that skips parseStudy passes the manifest itself: the semantic checks and
// planners read it unparsed, with no defaults filled and no participant group expanded.
import type { StudyConfig } from "../../src/study/types.js";

/** The config a library caller passes for a v3 manifest: a copy of the manifest. */
export function libraryConfig(raw: Record<string, unknown>): StudyConfig {
  return structuredClone(raw) as unknown as StudyConfig;
}
