// Test seams: the implementations a test puts in place of the real ones. The internal runLab takes
// them as its third argument and each route runner as `deps`; the package's runLab takes none.
// Each field defaults to the real implementation.

import type { renderObserver } from "../observer/render.js";
import type { TerminalCostProbe } from "../routes/terminal/types.js";
import type { E2BDesktopModule } from "../substrates/e2b/sdk.js";

export interface LabDeps {
  /** Loads the E2B SDK. Defaults to loadE2BDesktopModule. */
  readonly desktopModule?: () => Promise<E2BDesktopModule>;
  /** Renders the Observer. Defaults to renderObserver. */
  readonly renderObserver?: typeof renderObserver;
  /** The clock, in epoch milliseconds. Defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Terminal: known spend lines for the cost ledger. The planner reads whether it is set, since
   * only a measured line can trip a positive maxUsd.
   */
  readonly costProbe?: TerminalCostProbe;
}
