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
import type { renderObserver } from "../observer/render.js";
import type { TerminalCostProbe } from "../routes/terminal/types.js";
import type { DetachedTimers } from "../substrates/detached.js";
import type { E2BDesktopModule } from "../substrates/e2b/sdk.js";

export interface LabDeps {
  /** Loads the E2B SDK. Defaults to loadE2BDesktopModule. */
  readonly desktopModule?: () => Promise<E2BDesktopModule>;
  /** Renders the Observer. Defaults to renderObserver. */
  readonly renderObserver?: typeof renderObserver;
  /** The clock, in epoch milliseconds. Defaults to Date.now. */
  readonly now?: () => number;
  /** Clock and sleep for detached provisioning steps. */
  readonly detachedTimers?: DetachedTimers;
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
