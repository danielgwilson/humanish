// A library caller's config, written as a humanish.study.v3 manifest. StudyConfig keeps the
// humanish.lab.v2 shape until PLAN.md PR 8 (handoffs/2026-10-05-studyconfig-v3), so until then a
// caller that skips parseStudy passes the v2 record parseStudy reads a v3 file as. studyToV2 writes
// that record; the semantic checks and planners read it unparsed, with no defaults filled.
import { studyToV2 } from "../../src/study/parse/study-v3.js";
import type { StudyConfig } from "../../src/study/types.js";

/**
 * The config a library caller passes for a v3 manifest. Throws for a manifest the v3 front refuses
 * (an unknown key, `participants` on a route that takes none), which has no such record.
 */
export function libraryConfig(raw: Record<string, unknown>): StudyConfig {
  const document = studyToV2(raw);
  if (!document.ok)
    throw new Error(`No library config for this manifest: ${document.error.message}`);
  return document.value.v2 as unknown as StudyConfig;
}
