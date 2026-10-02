// The in-process route's desktop: the caller's own executor behind the four-method contract the
// hosted and local-VM desktops implement. It acquires no sandbox, stream, subject or recording, so
// its evidence claims none of them.

import type { ParticipantDesktop, ReadyParticipantDesktop } from "./participant-desktop.js";
import type { CuaParticipantDeps } from "./types.js";

/** What an in-process desktop reads: the caller's executor and the app it drives. */
type InProcessDesktopDeps = Pick<CuaParticipantDeps, "appUrl" | "inProcessExecutor">;

/**
 * The caller's executor as a participant desktop. prepare acquires nothing; openSession builds the
 * executor once; finalize is idempotent and has nothing to release; snapshot records no sandbox.
 */
export function createInProcessDesktop(deps: InProcessDesktopDeps): ParticipantDesktop {
  let preparationStarted = false;
  let opened = false;
  let finalization: Promise<void> | undefined;
  return {
    async prepare() {
      if (preparationStarted || finalization)
        throw new Error(
          "Participant desktop preparation can only start once, before finalization.",
        );
      preparationStarted = true;
    },
    async openSession(): Promise<ReadyParticipantDesktop> {
      if (!preparationStarted || opened || finalization)
        throw new Error(
          "The participant desktop must be prepared and may only be opened once, before finalization.",
        );
      opened = true;
      if (deps.inProcessExecutor === undefined)
        throw new Error("The in-process route needs RunLabOptions.inProcess.");
      return { executor: await deps.inProcessExecutor(deps.appUrl) };
    },
    finalize() {
      return (finalization ??= Promise.resolve());
    },
    snapshot() {
      // Nothing was acquired, so nothing is released and no sandbox fact is recorded.
      return { released: false, streamUrlPresent: false, stateStepRecords: [], phaseRecords: [] };
    },
  };
}
