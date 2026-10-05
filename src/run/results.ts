// The run command's options and result, the cleanup.json shape releases through 0.110.0 wrote, and
// the latest-run pointer (latest.json). None of them are stored in run.json.

import type { ObserverResult } from "../observer/render.js";
import type { RunProviderResource } from "./bundle.js";
import type { RunStudyProvenance } from "./study-provenance.js";

export const CLEANUP_SCHEMA = "humanish.cleanup-result.v1";

export interface RunOptions {
  /** Which manifest produced this run. */
  study?: RunStudyProvenance;
  /** Warnings about the study's own fields, recorded in the bundle as warn events. */
  warnings?: readonly string[];
  cwd: string;
  dryRun?: boolean;
  runId?: string;
  participantCount?: number;
  /** Render the run's Observer through the finished run, opening the page when `open` is true.
   *  Without it the preview writes no observer/index.html. */
  observer?: { open: boolean };
}

export interface RunResult {
  schema: "humanish.run-result.v1";
  ok: boolean;
  runId?: string;
  mode?: "dry-run" | "live";
  simCount?: number;
  cwd: string;
  artifactRoot?: string;
  bundlePath?: string;
  reviewPath?: string;
  latestPath?: string;
  /** The Observer rendered for this run, when `RunOptions.observer` asked for one. */
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "HUMANISH_STUDY_ANALYSIS_INVALID"
      | "HUMANISH_STUDY_ANALYSIS_UNSUPPORTED"
      | "HUMANISH_STUDY_TASKS_UNSUPPORTED"
      | "HUMANISH_STUDY_OPTION_UNSUPPORTED"
      | "HUMANISH_STUDY_V2_UNSUPPORTED"
      | "HUMANISH_STUDY_INVALID"
      | "HUMANISH_STUDY_COMMS_UNSUPPORTED"
      | "HUMANISH_LIVE_RUN_UNIMPLEMENTED"
      | "HUMANISH_INVALID_CWD"
      | "HUMANISH_RUN_ID_IN_USE"
      | "HUMANISH_INVALID_PARTICIPANT_COUNT"
      | "HUMANISH_INVALID_PORT"
      | "HUMANISH_UNSUPPORTED_RERUN_FLAGS"
      | "HUMANISH_WATCH_OPTION_CONFLICT"
      | "HUMANISH_WATCH_SAFE_NOT_APPLICABLE"
      | "HUMANISH_RUN_OPTION_CONFLICT"
      | "HUMANISH_OBSERVE_OPTION_CONFLICT"
      // CLI-loadable adopter scorer: fail-closed at load, pre-spend.
      | "HUMANISH_STUDY_SCORER_BAD_REF"
      | "HUMANISH_STUDY_SCORER_NOT_FOUND"
      | "HUMANISH_STUDY_SCORER_LOAD_FAILED"
      | "HUMANISH_STUDY_SCORER_NO_HOOKS"
      | "HUMANISH_STUDY_SCORER_UNSUPPORTED_BACKEND";
    message: string;
  };
}

/**
 * A resource line of cleanup.json. `humanish cleanup` wrote the file through 0.110.0, and verify
 * still reads one a run kept. v0.12.23 through v0.15.0 killed sandboxes and wrote `killed`.
 */
export interface StoredCleanupResourceResult {
  provider: RunProviderResource["provider"];
  kind: RunProviderResource["kind"];
  /** "[redacted-sandbox-id]" from 0.110; earlier files hold the raw id. */
  id: string;
  idDigest?: string;
  status: "already_clean" | "failed" | "skipped" | "killed";
  message: string;
}

export interface CleanupAdapterResult {
  id: string;
  ok: boolean;
  message: string;
}

/** cleanup.json as any release through 0.110.0 wrote it. */
export interface StoredCleanupResult {
  schema: typeof CLEANUP_SCHEMA;
  ok: boolean;
  cwd: string;
  run: string;
  runId?: string;
  bundlePath?: string;
  cleanupPath?: string;
  checkedAt: string;
  summary: {
    resources: number;
    killed: number;
    alreadyClean: number;
    failed: number;
    skipped: number;
  };
  resources: StoredCleanupResourceResult[];
  adapterResults: CleanupAdapterResult[];
  warnings: string[];
}

export interface RunPointer {
  schema: "humanish.latest-run.v1";
  runId: string;
  path: string;
  updatedAt: string;
}
