// E2B owns provisioning and final evidence; the participant runner only uses the ready port. The
// participant's steps live in prepare.ts, start.ts and teardown.ts beside this file, and fill the state
// record in state.ts. Steps with no dependency on each other run at the same time.
import type { SubjectPhaseEvent } from "../../../subject/steps.js";
import { externalHandoffReader } from "../../../substrates/e2b/desktop-handoff.js";
import { createE2BDesktopExecutor } from "../../../substrates/e2b/desktop-executor.js";
import { e2bShell } from "../../../substrates/e2b/shell.js";
import type { E2BDesktopSandbox } from "../../../substrates/e2b/sdk.js";
import type { ParticipantDesktop, ReadyParticipantDesktop } from "../participant-desktop.js";
import { participantInbox, planParticipantComms } from "./comms.js";
import { participantBrowserStateObserver } from "./fidelity.js";
import { networkHooks, planParticipantNetwork } from "./network.js";
import {
  acquireParticipantDesktop,
  placeParticipantFiles,
  provisionParticipantSubject,
  verifyParticipantScreen,
} from "./prepare.js";
import {
  keepParticipantScreenOn,
  openParticipantSurface,
  recordsSound,
  startParticipantRecording,
  startParticipantSpeech,
  startParticipantStream,
} from "./start.js";
import { desktopEvidenceOf, newParticipantState, type E2BParticipantContext } from "./state.js";
import { finishE2BDesktop } from "./teardown.js";
import { participantServeUrl, type E2BDesktopDeps, type DesktopParticipantRun } from "../types.js";

/**
 * Wait for every step, then throw the first failure in list order. No step is still running when
 * preparation fails and teardown starts, and the failure named is the one the serial order named.
 */
async function settleInOrder(steps: ReadonlyArray<Promise<void>>): Promise<void> {
  const settled = await Promise.allSettled(steps);
  const failed = settled.find((step) => step.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

export function createE2BParticipantDesktop(
  spec: DesktopParticipantRun,
  deps: E2BDesktopDeps,
  warnings: string[],
): ParticipantDesktop {
  const targetUrl = spec.planned.targetUrl ?? deps.appUrl;
  const state = newParticipantState(spec);
  state.network = planParticipantNetwork(deps, targetUrl);
  const ctx: E2BParticipantContext = {
    spec,
    deps,
    warnings,
    targetUrl,
    desktopCliRoute: deps.subject.kind === "desktop-cli",
    // Off-app comms: gated entirely on config.comms; no comms declared, no change.
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
        id: spec.planned.id,
        index: spec.planned.index,
        count: deps.participantCount,
      });
    },
  };
  let preparationStarted = false;
  let prepared = false;
  let opened = false;
  let finalization: Promise<void> | undefined;

  async function prepare(): Promise<void> {
    if (preparationStarted || finalization)
      throw new Error(
        "Participant desktop preparation can only start once, before the desktop is released.",
      );
    preparationStarted = true;
    const desktop = await acquireParticipantDesktop(ctx, state);
    const { kind } = ctx.deps.subject;
    if (kind === "clone" || kind === "local-tree" || kind === "desktop-cli") {
      // A subject provisioned in the sandbox takes minutes and may read the participant's files
      // as it starts, so these steps run in order. The device claim is verified in the sandbox,
      // and fails closed.
      await verifyParticipantScreen(ctx, state, desktop);
      await placeParticipantFiles(ctx, state, desktop);
      await provisionParticipantSubject(ctx, state, desktop);
      await startParticipantSurface(desktop);
    } else {
      // An app that is only opened: Chrome takes seconds to start, so the screen check and the
      // file copy run beside it. The files only need to land before the session.
      await settleInOrder([
        verifyParticipantScreen(ctx, state, desktop),
        placeParticipantFiles(ctx, state, desktop),
        startParticipantSurface(desktop),
      ]);
    }
    await keepParticipantScreenOn(ctx, desktop);
    prepared = true;
  }

  /**
   * Start speech and the recording, and open the browser or terminal. Chrome is launched in the
   * sound env of speech or an audible recording, so those start before it; a silent recording
   * starts beside it. Either way the recording is running before the session starts.
   */
  async function startParticipantSurface(desktop: E2BDesktopSandbox): Promise<void> {
    await startParticipantSpeech(ctx, state, desktop);
    if (recordsSound(ctx)) {
      await startParticipantRecording(ctx, state, desktop);
      await openParticipantSurface(ctx, state, desktop);
      return;
    }
    await settleInOrder([
      openParticipantSurface(ctx, state, desktop),
      startParticipantRecording(ctx, state, desktop),
    ]);
  }

  async function openSession(): Promise<ReadyParticipantDesktop> {
    const { desktop, allocation } = state;
    if (!prepared || !desktop || !allocation || opened || finalization)
      throw new Error(
        "The participant desktop must be prepared and may only be opened once, before the desktop is released.",
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
    // Capture that started pairs each checkpoint with the time of the read before it.
    const network = networkHooks(state.network);
    // A web target's browser launch installs the stand-ins that write handed-off links down
    // (desktop-handoff.ts). Without them the log is absent and every read is empty.
    const readExternalHandoffs = state.browserLaunched
      ? externalHandoffReader(e2bShell(desktop), { requestTimeoutMs: deps.requestTimeoutMs })
      : undefined;
    const executor = createE2BDesktopExecutor(desktop, {
      ...(readExternalHandoffs === undefined ? {} : { readExternalHandoffs }),
      ...(state.launchedBrowserFamily === "chromium"
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
              ...(network === undefined ? {} : { onClock: network.onClock }),
            }),
          }
        : {}),
    });
    return {
      executor: allocation.open(state.speech?.wrap(executor) ?? executor).executor,
      ...(inbox === undefined ? {} : { inbox }),
      ...(network === undefined ? {} : { onCheckpoint: network.onCheckpoint }),
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
