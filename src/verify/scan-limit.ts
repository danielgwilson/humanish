// How many files and folders the public-safety scan visits in one run, and bundle export counts
// before it copies one. It lives apart from the scan so the planner can check a study's estimated
// file count against it without loading the scanner.

import { EVIDENCE_LIMITS } from "../analysis/analysis-limits.js";

/** The entries any run may hold, whatever its participants. */
const MAX_RUN_ENTRIES = 10_000;

/**
 * The entries each participant adds to the limit. Measured on 2026-10-12: a participant writes a
 * screenshot a model turn, live participants that worked 5 minutes or more took a turn every 10
 * s (median of 42 sessions), and its trace file, screenshot folder and first frame add 3 more. A
 * participant working an 8-hour window then holds about 2,900 entries; 5,000 leaves room for a
 * dwell window's frames or a faster pace.
 */
const ENTRIES_PER_PARTICIPANT = 5_000;

/**
 * The most entries the scan visits in a run of `participants` participants. run.json states the
 * count, so it is clamped to the most participants a run's analysis covers, which keeps a forged
 * count from making the scan unbounded.
 */
export function runEntryLimit(participants: number): number {
  const counted = Number.isFinite(participants)
    ? Math.min(Math.max(0, Math.floor(participants)), EVIDENCE_LIMITS.participants)
    : 0;
  return MAX_RUN_ENTRIES + ENTRIES_PER_PARTICIPANT * counted;
}
