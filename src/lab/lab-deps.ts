// Test seams: the implementations a test puts in place of the real ones. The internal runLab takes
// them as its third argument and each route runner as `deps`; the package's runLab takes none.
// Each field defaults to the real implementation.

import type {
  ScriptedBrowserSessionOptions,
  ScriptedBrowserSessionResult,
} from "../actors/scripted-browser/actor.js";
import type {
  ScriptedBrowserLaunchArgs,
  ScriptedBrowserLike,
} from "../actors/scripted-browser/types.js";
import type { CuaActorSessionOptions } from "../actors/computer-use/actor.js";
import type { AutomaticAnalysisDeps, runAutomaticAnalysis } from "../analysis/automatic.js";
import type { CuaLoopResult } from "../actors/computer-use/loop.js";
import type { renderObserver } from "../observer/render.js";
import type { TerminalCostProbe } from "../routes/terminal/types.js";
import type { DetachedTimers } from "../substrates/detached.js";
import type { E2BDesktopModule } from "../substrates/e2b/sdk.js";
import type { LocalTreeArchive } from "../subject/local-tree-archive.js";
import type { SubjectPhaseEvent } from "../subject/steps.js";

/** The participant a computer-use subject phase belongs to, with the route's field names. */
export interface PhaseParticipant {
  readonly laneId: string;
  readonly laneIndex: number;
  readonly laneCount: number;
}

export interface LabDeps {
  /** Loads the E2B SDK. Defaults to loadE2BDesktopModule. */
  readonly desktopModule?: () => Promise<E2BDesktopModule>;
  /** Renders the Observer. Defaults to renderObserver. */
  readonly renderObserver?: typeof renderObserver;
  /** The clock, in epoch milliseconds. Defaults to Date.now. */
  readonly now?: () => number;
  /** Clock and sleep for detached provisioning steps. */
  readonly detachedTimers?: DetachedTimers;
  /**
   * Computer use and shared world: where subject-provisioning phases go in place of stderr. A
   * computer-use phase names its participant; a shared-world plane's names none. onEvent still
   * receives every phase.
   */
  readonly subjectPhaseSink?: (event: SubjectPhaseEvent, participant?: PhaseParticipant) => void;
  /**
   * Shared world: runs each seat's computer-use session in place of the actor's own. The planner
   * reads whether it is set: a custom runner cannot enforce actors[0].maxOutputTokens.
   */
  readonly runSession?: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  /**
   * Shared world: packs a local-tree subject on the host. Defaults to createLocalTreeArchive and a
   * read of the archive it writes. Called once per run, before the subject sandbox exists.
   */
  readonly packLocalTree?: (args: {
    root: string;
    extraExclude?: string[];
    maxArchiveBytes?: number;
  }) => Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }>;
  /** Shared world: the background stateSeries prober's cadence in milliseconds. Defaults to 1000. */
  readonly proberCadenceMs?: number;
  /**
   * Shared world, external-public plane: how long the host seat has to surface a /lobby/CODE URL
   * before the run fails closed. Defaults to 120000, capped by execution.timeoutMs.
   */
  readonly handoffDeadlineMs?: number;
  /**
   * Shared world, external-public plane: reads a /lobby/CODE off a seat's screenshot. Defaults to
   * the single-frame OpenAI read.
   */
  readonly readLobbyCodeFromFrame?: (frame: Buffer, apiKey: string) => Promise<string | undefined>;
  /**
   * Every route: post-run analysis in place of the real one. `run` replaces
   * the real analysis runner, and `deps` (provider fetch, keys, clock) reach the analysis only,
   * never a participant.
   */
  readonly analysis?: {
    readonly run?: typeof runAutomaticAnalysis;
    readonly deps?: AutomaticAnalysisDeps;
  };
  /** Scripted: runs one surface's session in place of the scripted-browser actor. */
  readonly runScriptedSession?: (
    options: ScriptedBrowserSessionOptions,
  ) => Promise<ScriptedBrowserSessionResult>;
  /**
   * Scripted: launches the browser each session drives, so no browser binary is resolved. The
   * planner reads whether it, or browserCommand, is set: a live run then needs no host browser.
   */
  readonly launchBrowser?: (args: ScriptedBrowserLaunchArgs) => Promise<ScriptedBrowserLike>;
  /** Scripted: the browser binary to launch; operators use HUMANISH_BROWSER_COMMAND. */
  readonly browserCommand?: string;
  /**
   * Terminal: known spend lines for the cost ledger. The planner reads whether it is set, since
   * only a measured line can trip a positive maxUsd.
   */
  readonly costProbe?: TerminalCostProbe;
}
