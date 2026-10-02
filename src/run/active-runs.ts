// The runs this process has started and not yet closed, for the CLI's signal handler
// (src/cli/commands/run-signals.ts). Internal: src/index.ts does not export it, so a library
// caller never gets process signal handling it did not ask for.
import type { RunStatusHandle } from "./status.js";

export interface ActiveRun {
  cwd: string;
  runId: string;
  status: Pick<RunStatusHandle, "interrupt">;
}

const active = new Set<ActiveRun>();

/** Register a started run; the returned function removes it. */
export function registerActiveRun(run: ActiveRun): () => void {
  active.add(run);
  return () => {
    active.delete(run);
  };
}

/** The runs started in this process that have not closed, oldest first. */
export function activeRuns(): ActiveRun[] {
  return [...active];
}
