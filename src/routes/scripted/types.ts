// The scripted-browser lab's schema constant, options and result types.

import type { ActorCompletionReason, ActorStatus } from "../../actors/contract.js";
import type { LabEvent } from "../../lab/run-lab-events.js";
import type { AutomaticAnalysisResult } from "../../analysis/automatic-completion.js";
import type { LabConfig } from "../../lab/types.js";
import type { ObserverResult } from "../../observer/render.js";
import type { RunSubjectProvenance } from "../../run/bundle.js";
import type { LabDeps } from "../../lab/lab-deps.js";
import type { RunLabHomes } from "../../lab/run-lab-homes.js";

export const SCRIPTED_BROWSER_LAB_SCHEMA = "humanish.scripted-lab-result.v1";

/** What a scripted run takes besides its plan. The plan carries the config, dry run and lab. */
export type ScriptedRunInput = Omit<RunScriptedBrowserLabOptions, "config" | "dryRun" | "lab">;

export interface RunScriptedBrowserLabOptions {
  /** Cancels post-run analysis only. */
  analysisSignal?: AbortSignal;
  /** Reports the analysis window to onEvent; built by normalizeRunLabOptions. */
  emit?: (event: LabEvent) => void;
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  /** Keys and subject env for the run. Defaults to process.env. Values are scrubbed; names persist. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Runs after a clone subject's sandbox exists and before provisioning. */
  prepareDesktop?: NonNullable<RunLabHomes["prepareDesktop"]>;
  /** Test seams: the browser, the session, the E2B module, timers, the renderer and the clock. */
  deps?: LabDeps;
}

interface ScriptedBrowserLabSession {
  surface: string;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  screenshots: number;
}

export interface ScriptedBrowserLabResult extends AutomaticAnalysisResult {
  schema: typeof SCRIPTED_BROWSER_LAB_SCHEMA;
  /** True when the bundle verified and (dry-run, or every session reached a terminal verdict
   * without a harness error). The subject failing the script is successful evidence, and the lab
   * does not fail for it. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the sessions. */
  actor: string;
  appUrl: string;
  dryRun: boolean;
  runId: string;
  subject?: RunSubjectProvenance;
  subjectSandbox?: { sandboxId: string; killed: boolean };
  hostDigest?: string;
  /** The consumed scenario.ref: digest-pinned provenance of the executable steps. */
  scenario?: {
    id: string;
    source: string;
    sourceDigest: string;
    steps: number;
  };
  sessions: ScriptedBrowserLabSession[];
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "HUMANISH_LAB_ANALYSIS_INVALID"
      | "HUMANISH_LAB_TASKS_UNSUPPORTED"
      | "HUMANISH_LAB_OPTION_UNSUPPORTED"
      | "HUMANISH_SCRIPTED_LAB_FAILED"
      | "HUMANISH_SCRIPTED_LAB_ACTOR_UNSUPPORTED"
      | "HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID"
      | "HUMANISH_SCRIPTED_LAB_SUBJECT_UNSAFE"
      | "HUMANISH_SCRIPTED_LAB_BROWSER_MISSING"
      | "HUMANISH_SCRIPTED_LAB_KEYS_MISSING"
      | "HUMANISH_SCRIPTED_LAB_SUBJECT_ENV_MISSING"
      | "HUMANISH_SCRIPTED_LAB_GETHOST_UNAVAILABLE"
      | "HUMANISH_RUN_ID_IN_USE";
    message: string;
  };
}
