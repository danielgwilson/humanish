// The scripted-browser study's schema constant, options and result types.

import type { ActorCompletionReason, ActorStatus } from "../../actors/contract.js";
import type { StudyEvent } from "../../study/run-study-events.js";
import type { AutomaticAnalysisResult } from "../../analysis/automatic-completion.js";
import type { ObserverResult } from "../../observer/render.js";
import type { RunSubjectProvenance } from "../../run/bundle.js";
import type { StudyDeps } from "../../study/study-deps.js";
import type { RunStudyHomes } from "../../study/run-study-homes.js";
import { type StudyResultIdentity } from "../../run/study-result.js";

/** What a scripted run takes besides its plan. The plan carries the config, dry run and study. */
export interface ScriptedRunInput {
  /** Cancels post-run analysis only. */
  analysisSignal?: AbortSignal;
  /** Reports the analysis window to onEvent; built by normalizeRunStudyOptions. */
  emit?: (event: StudyEvent) => void;
  cwd: string;
  open?: boolean;
  runId?: string;
  /** Keys and subject env for the run. Defaults to process.env. Values are scrubbed; names persist. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Runs after a clone subject's sandbox exists and before provisioning. */
  prepareDesktop?: NonNullable<RunStudyHomes["prepareDesktop"]>;
  /** Test seams: the browser, the session, the E2B module, timers, the renderer and the clock. */
  deps?: StudyDeps;
}

interface ScriptedBrowserStudySession {
  surface: string;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  screenshots: number;
}

export interface ScriptedBrowserStudyResult
  extends AutomaticAnalysisResult, StudyResultIdentity<"scripted"> {
  /** True when the bundle verified and (dry-run, or every session reached a terminal verdict
   * without a harness error). The subject failing the script is successful evidence, and the run
   * does not fail for it. */
  ok: boolean;
  cwd: string;
  /** The registry-resolved actor id that ran (or would run) the sessions. */
  actor: string;
  appUrl: string;
  dryRun: boolean;
  runId: string;
  subject?: RunSubjectProvenance;
  subjectSandbox?: { sandboxId: string; sandboxIdDigest?: string; killed: boolean };
  hostDigest?: string;
  /** The consumed `scenario`: digest-pinned provenance of the executable steps. */
  scenario?: {
    id: string;
    source: string;
    sourceDigest: string;
    steps: number;
  };
  sessions: ScriptedBrowserStudySession[];
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "HUMANISH_STUDY_ANALYSIS_INVALID"
      | "HUMANISH_STUDY_TASKS_UNSUPPORTED"
      | "HUMANISH_STUDY_OPTION_UNSUPPORTED"
      | "HUMANISH_STUDY_V2_UNSUPPORTED"
      | "HUMANISH_STUDY_INVALID"
      | "HUMANISH_SCRIPTED_FAILED"
      | "HUMANISH_SCRIPTED_ACTOR_UNSUPPORTED"
      | "HUMANISH_SCRIPTED_SCENARIO_INVALID"
      | "HUMANISH_SCRIPTED_SUBJECT_UNSAFE"
      | "HUMANISH_SCRIPTED_BROWSER_MISSING"
      | "HUMANISH_SCRIPTED_KEYS_MISSING"
      | "HUMANISH_SCRIPTED_SUBJECT_ENV_MISSING"
      | "HUMANISH_SCRIPTED_GETHOST_UNAVAILABLE"
      | "HUMANISH_RUN_ID_IN_USE";
    message: string;
  };
}
