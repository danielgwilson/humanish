// E2B owns provisioning and final evidence; the participant runner only uses the ready port. The
// participant's steps live in prepare.ts, start.ts and teardown.ts beside this file, and fill the state
// record in state.ts in the order below.
import type { SubjectPhaseEvent } from "../../../subject/steps.js";
import { createE2BDesktopExecutor } from "../../../substrates/e2b/desktop-executor.js";
import type { ParticipantDesktop, ReadyParticipantDesktop } from "../participant-desktop.js";
import { participantInbox, planParticipantComms } from "./comms.js";
import { participantBrowserStateObserver } from "./fidelity.js";
import {
  acquireParticipantDesktop,
  provisionParticipantSubject,
  verifyParticipantScreen,
} from "./prepare.js";
import { openParticipantSurface, startParticipantMedia, startParticipantStream } from "./start.js";
import { desktopEvidenceOf, newParticipantState, type E2BParticipantContext } from "./state.js";
import { finishE2BDesktop } from "./teardown.js";
import { participantServeUrl, type E2BDesktopDeps, type DesktopParticipantRun } from "../types.js";

export function createE2BParticipantDesktop(
  spec: DesktopParticipantRun,
  deps: E2BDesktopDeps,
  warnings: string[],
): ParticipantDesktop {
  const targetUrl = spec.planned.targetUrl ?? deps.appUrl;
  const state = newParticipantState(spec);
  const ctx: E2BParticipantContext = {
    spec,
    deps,
    warnings,
    targetUrl,
    desktopCliRoute: deps.subject.kind === "desktop-cli",
    // Off-app comms (#297): gated entirely on config.comms; no comms declared, no change.
    comms: planParticipantComms(
      deps.residual.comms,
      participantServeUrl(deps.subject),
      targetUrl,
      deps.subject.kind === "clone" || deps.subject.kind === "local-tree",
    ),
    // The default or injected sink sees every event, started and completed alike, so an operator
    // watching stderr sees both halves of each phase; the state keeps only completed ones.
    onSubjectPhase: (event: SubjectPhaseEvent): void => {
      if (event.ok !== undefined) state.phaseRecords.push(event);
      deps.reportSubjectPhase(event, {
        laneId: spec.planned.id,
        laneIndex: spec.planned.index,
        laneCount: deps.participantCount,
      });
    },
  };
  let preparationStarted = false;
  let prepared = false;
  let opened = false;
  let finalization: Promise<void> | undefined;

  async function prepare(): Promise<void> {
    if (preparationStarted || finalization)
      throw new Error("Participant desktop preparation can only start once, before finalization.");
    preparationStarted = true;
    const desktop = await acquireParticipantDesktop(ctx, state);
    // The device claim is verified in the sandbox, and fails closed.
    await verifyParticipantScreen(ctx, state, desktop);
    await provisionParticipantSubject(ctx, state, desktop);
    await startParticipantMedia(ctx, state, desktop);
    await openParticipantSurface(ctx, state, desktop);
    prepared = true;
  }

  async function openSession(): Promise<ReadyParticipantDesktop> {
    const { desktop, allocation } = state;
    if (!prepared || !desktop || !allocation || opened || finalization)
      throw new Error(
        "The participant desktop must be prepared and may only be opened once, before finalization.",
      );
    opened = true;
    await startParticipantStream(ctx, state, desktop);
    const inbox = participantInbox({
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
            observeBrowserState: participantBrowserStateObserver({
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
    snapshot: () => desktopEvidenceOf(state),
    finalize({ failed }) {
      return (finalization ??= finishE2BDesktop(ctx, state, failed));
    },
  };
}
