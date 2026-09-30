// The in-process route's desktop: the caller's own executor behind the four-method contract the
// hosted and local-VM desktops implement. It acquires no sandbox, stream, subject or recording, so
// its evidence claims none of them.

import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { LabConfig } from "../../lab/types.js";
import type { CuaDesktopLane, ReadyCuaDesktop } from "./desktop-lane.js";
import type { CuaActorLabHooks } from "./types.js";

/** What an in-process desktop reads: the caller's executor hook and the arguments it receives. */
interface InProcessDesktopDeps {
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  hooks: Pick<CuaActorLabHooks, "buildExecutor">;
}

/**
 * The caller's executor as a participant desktop. prepare acquires nothing; openSession builds the
 * executor once; finalize is idempotent and has nothing to release; snapshot records no sandbox.
 */
export function createInProcessDesktop(deps: InProcessDesktopDeps): CuaDesktopLane {
  let preparationStarted = false;
  let opened = false;
  let finalization: Promise<void> | undefined;
  return {
    async prepare() {
      if (preparationStarted || finalization)
        throw new Error("Desktop lane preparation can only start once, before finalization.");
      preparationStarted = true;
    },
    async openSession(): Promise<ReadyCuaDesktop> {
      if (!preparationStarted || opened || finalization)
        throw new Error(
          "Desktop lane must be prepared and may only be opened once, before finalization.",
        );
      opened = true;
      const buildExecutor = deps.hooks.buildExecutor;
      if (buildExecutor === undefined)
        throw new Error("The in-process route needs hooks.buildExecutor.");
      const executor = await buildExecutor({
        config: deps.config,
        actor: deps.descriptor,
        appUrl: deps.appUrl,
      });
      return { executor };
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
