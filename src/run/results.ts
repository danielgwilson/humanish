// The run command's options and result, the cleanup result (cleanup.json) and the latest-run
// pointer (latest.json). None of them are stored in run.json.

import type { ObserverResult } from "../observer/render.js";
import type { RunProviderResource } from "./bundle.js";
import type { RunLabProvenance } from "./status.js";

export const CLEANUP_SCHEMA = "humanish.cleanup-result.v1";

export interface RunOptions {
  /** Which manifest produced this run. */
  lab?: RunLabProvenance;
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

export interface CleanupResourceResult {
  provider: RunProviderResource["provider"];
  kind: RunProviderResource["kind"];
  id: string;
  /** Cleanup reads recorded evidence and never kills a sandbox, so it never writes `killed`. */
  status: "already_clean" | "failed" | "skipped";
  message: string;
}

/** A resource line as a stored cleanup.json holds it. v0.12.23 through v0.15.0 killed sandboxes. */
export interface StoredCleanupResourceResult extends Omit<CleanupResourceResult, "status"> {
  status: CleanupResourceResult["status"] | "killed";
}

export interface CleanupAdapterResult {
  id: string;
  ok: boolean;
  message: string;
}

export interface CleanupResult {
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
    /** Always 0 now; written so readers from earlier releases still accept the file. */
    killed: number;
    alreadyClean: number;
    failed: number;
    skipped: number;
  };
  resources: CleanupResourceResult[];
  adapterResults: CleanupAdapterResult[];
  warnings: string[];
  error?: {
    code: "HUMANISH_RUN_NOT_FOUND" | "HUMANISH_INVALID_RUN_BUNDLE";
    message: string;
  };
}

/** cleanup.json as any release wrote it; see StoredCleanupResourceResult. */
export interface StoredCleanupResult extends Omit<CleanupResult, "resources"> {
  resources: StoredCleanupResourceResult[];
}

export interface RunPointer {
  schema: "humanish.latest-run.v1";
  runId: string;
  path: string;
  updatedAt: string;
}
