// E2B owns provisioning and final evidence; the participant runner only uses the ready port. The
// lane's steps live in e2b-desktop-prepare.ts, e2b-desktop-start.ts and e2b-desktop-teardown.ts,
// and fill the state record in e2b-desktop-state.ts in the order below.
import { defaultSubjectPhaseSink, type SubjectPhaseEvent } from "../../subject/steps.js";
import { createE2BDesktopExecutor } from "../../substrates/e2b/desktop-executor.js";
import type { CuaDesktopLane, ReadyCuaDesktop } from "./desktop-lane.js";
import { laneInbox, planLaneComms } from "./e2b-desktop-comms.js";
import { laneBrowserStateObserver } from "./e2b-desktop-fidelity.js";
import {
  acquireLaneDesktop,
  provisionLaneSubject,
  verifyLaneScreen,
} from "./e2b-desktop-prepare.js";
import { openLaneSurface, startLaneMedia, startLaneStream } from "./e2b-desktop-start.js";
import { laneEvidence, newLaneState, type E2BLaneContext } from "./e2b-desktop-state.js";
import { finishLane } from "./e2b-desktop-teardown.js";
import type { CuaLaneDeps, DesktopParticipantRun } from "./types.js";

export function createE2BCuaDesktopLane(
  spec: DesktopParticipantRun,
  deps: CuaLaneDeps,
  warnings: string[],
): CuaDesktopLane {
  const targetUrl = spec.planned.targetUrl ?? deps.appUrl;
  const state = newLaneState(spec);
  const ctx: E2BLaneContext = {
    spec,
    deps,
    warnings,
    targetUrl,
    desktopCliRoute: deps.desktopCliRoute === true,
    // Off-app comms (#297): gated entirely on config.comms; no comms declared, no change.
    comms: planLaneComms(deps.config, targetUrl, deps.cloneRoute || deps.localTreeRoute === true),
    // The default or injected sink sees every event, started and completed alike, so an operator
    // watching stderr sees both halves of each phase; the state keeps only completed ones.
    onSubjectPhase: (event: SubjectPhaseEvent): void => {
      if (event.ok !== undefined) state.phaseRecords.push(event);
      (deps.hooks.onPhase ?? defaultSubjectPhaseSink)(event, {
        laneId: spec.planned.id,
        laneIndex: spec.planned.index,
        laneCount: deps.laneCount,
      });
    },
  };
  let preparationStarted = false;
  let prepared = false;
  let opened = false;
  let finalization: Promise<void> | undefined;

  async function prepare(): Promise<void> {
    if (preparationStarted || finalization)
      throw new Error("Desktop lane preparation can only start once, before finalization.");
    preparationStarted = true;
    const desktop = await acquireLaneDesktop(ctx, state);
    // The device claim is verified in the sandbox, and fails closed.
    await verifyLaneScreen(ctx, state, desktop);
    await provisionLaneSubject(ctx, state, desktop);
    await startLaneMedia(ctx, state, desktop);
    await openLaneSurface(ctx, state, desktop);
    prepared = true;
  }

  async function openSession(): Promise<ReadyCuaDesktop> {
    const { desktop, allocation } = state;
    if (!prepared || !desktop || !allocation || opened || finalization)
      throw new Error(
        "Desktop lane must be prepared and may only be opened once, before finalization.",
      );
    opened = true;
    await startLaneStream(ctx, state, desktop);
    const inbox = laneInbox({
      spec,
      deps,
      receivingInboxUrl: state.receivingInboxUrl,
      comms: ctx.comms,
      catchReady: state.commsCatch?.deployed.ready === true,
    });
    const executor = createE2BDesktopExecutor(
      desktop,
      state.launchedBrowserFamily === "chromium"
        ? {
            observeBrowserState: laneBrowserStateObserver({
              desktop,
              spec,
              deps,
              targetUrl,
              launchIdentity: state.browserLaunchIdentity,
              targetId: state.browserTargetId,
              fidelity: state.fidelity,
              warnings,
            }),
          }
        : {},
    );
    return {
      executor: allocation.open(state.speech?.wrap(executor) ?? executor).executor,
      ...(inbox === undefined ? {} : { inbox }),
    };
  }

  return {
    prepare,
    openSession,
    snapshot: () => laneEvidence(state),
    finalize({ failed }) {
      return (finalization ??= finishLane(ctx, state, failed));
    },
  };
}
