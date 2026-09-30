// The scripted-browser lab's schema constant, library hooks, options and result types.

import type { ActorCompletionReason, ActorStatus } from "../../actors/contract.js";
import type {
  ScriptedBrowserSessionOptions,
  ScriptedBrowserSessionResult,
} from "../../actors/scripted-browser/actor.js";
import type {
  ScriptedBrowserLaunchArgs,
  ScriptedBrowserLike,
} from "../../actors/scripted-browser/types.js";
import type {
  AutomaticAnalysisHooks,
  AutomaticAnalysisResult,
} from "../../analysis/automatic-completion.js";
import type { LabConfig } from "../../lab/types.js";
import { renderObserver, type ObserverResult } from "../../observer/render.js";
import type { RunSubjectProvenance } from "../../run/bundle.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { DetachedTimers } from "../../substrates/detached.js";
import type { E2BDesktopModule, E2BDesktopSandbox } from "../../substrates/e2b/sdk.js";

export const SCRIPTED_BROWSER_LAB_SCHEMA = "humanish.scripted-lab-result.v1";

/**
 * Library-level hooks: DI seams so CI drives the full path (real engine, real projection)
 * with a fake browser at zero spend, plus the production browser resolution override.
 */
export interface ScriptedBrowserLabHooks {
  runSession?: (options: ScriptedBrowserSessionOptions) => Promise<ScriptedBrowserSessionResult>;
  /** Injected browser factory — forwarded to every session; skips browser-binary resolution. */
  launchBrowser?: (args: ScriptedBrowserLaunchArgs) => Promise<ScriptedBrowserLike>;
  /** Test/library env seam; CLI passes process.env. Values are scrubbed, names only persist. */
  env?: Record<string, string | undefined>;
  /** E2B DI seam for clone × e2b-desktop × scripted-browser. */
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  /** Optional adopter hook after subject sandbox creation, before clone provisioning. */
  prepareDesktop?: (desktop: E2BDesktopSandbox) => Promise<void>;
  /** Detached-step timers for deterministic tests around clone/seed/start provisioning. */
  detachedTimers?: DetachedTimers;
  /** Override the resolved browser binary (tests; operators use HUMANISH_BROWSER_COMMAND). */
  browserCommand?: string;
  renderObserverFn?: typeof renderObserver;
  now?: () => number;
}

export interface RunScriptedBrowserLabOptions {
  automaticAnalysis?: AutomaticAnalysisHooks;
  /** Which manifest produced this run (#455); threaded into the status record + bundle. */
  lab?: RunLabProvenance;
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  hooks?: ScriptedBrowserLabHooks;
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
  /** True when the bundle verified AND (dry-run, or every session reached a terminal verdict
   * without a harness error). The subject failing the script is successful EVIDENCE, not a lab
   * failure. */
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
      | "HUMANISH_LAB_OPTION_CONFLICT"
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
