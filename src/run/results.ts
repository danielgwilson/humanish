// The run command's options and result, the cleanup result (cleanup.json) and the latest-run
// pointer (latest.json). None of them are stored in run.json.

import type { ObserverResult } from "../observer/render.js";
import type { RunProviderResource } from "./bundle.js";
import type { RunLabProvenance } from "./status.js";

export const CLEANUP_SCHEMA = "humanish.cleanup-result.v1";

export interface RunOptions {
  /** Which manifest produced this run (#455). */
  lab?: RunLabProvenance;
  cwd: string;
  dryRun?: boolean;
  runId?: string;
  simCount?: number;
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
      | "HUMANISH_LAB_ANALYSIS_INVALID"
      | "HUMANISH_LAB_ANALYSIS_UNSUPPORTED"
      | "HUMANISH_LAB_TASKS_UNSUPPORTED"
      | "HUMANISH_LAB_OPTION_CONFLICT"
      | "HUMANISH_LAB_OPTION_UNSUPPORTED"
      | "HUMANISH_LAB_COMMS_UNSUPPORTED"
      | "HUMANISH_LIVE_RUN_UNIMPLEMENTED"
      | "HUMANISH_INVALID_CWD"
      | "HUMANISH_RUN_ID_IN_USE"
      | "HUMANISH_INVALID_SIM_COUNT"
      | "HUMANISH_INVALID_PORT"
      | "HUMANISH_UNSUPPORTED_RERUN_FLAGS"
      | "HUMANISH_WATCH_OPTION_CONFLICT"
      | "HUMANISH_APP_URL_REMOVED"
      // #316 CLI-loadable adopter scorer — fail-closed at load, pre-spend.
      | "HUMANISH_LAB_SCORER_BAD_REF"
      | "HUMANISH_LAB_SCORER_NOT_FOUND"
      | "HUMANISH_LAB_SCORER_LOAD_FAILED"
      | "HUMANISH_LAB_SCORER_NO_HOOKS"
      | "HUMANISH_LAB_SCORER_UNSUPPORTED_BACKEND";
    message: string;
  };
}

export interface CleanupResourceResult {
  provider: RunProviderResource["provider"];
  kind: RunProviderResource["kind"];
  id: string;
  status: "killed" | "already_clean" | "failed" | "skipped";
  message: string;
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

export interface RunPointer {
  schema: "humanish.latest-run.v1";
  runId: string;
  path: string;
  updatedAt: string;
}
