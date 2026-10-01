// What one E2B desktop lane records as it runs. The prepare, start and teardown steps fill one
// record in order, and desktopEvidenceOf reads it for the lane's outcome.

import type { RunDesktopRecording } from "../../../evidence/desktop-recording-types.js";
import type { RunSubjectStateStepRecord } from "../../../run/bundle.js";
import type { RunDesktopGeometry } from "../../../run/streams.js";
import type { SubjectPhaseEvent } from "../../../subject/steps.js";
import type { OwnedDesktopAllocation } from "../../../substrates/desktop-session.js";
import type {
  DesktopBrowserEvidence,
  DesktopBrowserFamily,
  DesktopBrowserLaunchIdentity,
} from "../../../substrates/e2b/desktop-browser.js";
import {
  declaredScreenForRender,
  type captureDesktopBrowserGeometry,
} from "../../../substrates/e2b/desktop-geometry.js";
import type { startE2BDesktopMedia } from "../../../substrates/e2b/desktop-media.js";
import type { startE2BDesktopRecording } from "../../../substrates/e2b/desktop-recording.js";
import type { DesktopResourceObservation } from "../../../substrates/e2b/desktop-resources.js";
import type { E2BDesktopSandbox } from "../../../substrates/e2b/sdk.js";
import type { ParticipantDesktopEvidence } from "../participant-desktop.js";
import type { ParticipantComms, RunningCommsCatch } from "./comms.js";
import type { ParticipantFidelity } from "./fidelity.js";
import type { CuaActorLabErrorCode, CuaParticipantDeps, DesktopParticipantRun } from "../types.js";

/** What every step of one lane reads: its spec, the run's dependencies and where it points. */
export interface E2BParticipantContext {
  readonly spec: DesktopParticipantRun;
  readonly deps: CuaParticipantDeps;
  readonly warnings: string[];
  readonly targetUrl: string;
  readonly desktopCliRoute: boolean;
  readonly comms: ParticipantComms | undefined;
  /** Records a completed phase and passes every phase to the operator's sink. */
  readonly onSubjectPhase: (event: SubjectPhaseEvent) => void;
}

export interface E2BParticipantState {
  desktop: E2BDesktopSandbox | undefined;
  allocation: OwnedDesktopAllocation | undefined;
  sandboxId: string | undefined;
  /**
   * Host-side ends of the desktop's billed span, from the injected clock: right after the sandbox
   * exists, and after teardown on both the released and kept paths. Allocation before the handle
   * is outside the span; a kept or unconfirmed sandbox gets an extra unknown lifetime cost line.
   */
  sandboxCreatedAtMs: number | undefined;
  sandboxTornDownAtMs: number | undefined;
  desktopResources: DesktopResourceObservation | undefined;
  released: boolean;
  failureCode: CuaActorLabErrorCode | undefined;
  commsCatch: RunningCommsCatch | undefined;
  commsArtifactPath: string | undefined;
  receivingInboxUrl: string | undefined;
  readonly stateStepRecords: RunSubjectStateStepRecord[];
  /** Completed phases only (durationMs and ok are set on completed events); bundle.events keeps these. */
  readonly phaseRecords: SubjectPhaseEvent[];
  subjectCommit: string | undefined;
  speech: Awaited<ReturnType<typeof startE2BDesktopMedia>> | undefined;
  recording: Awaited<ReturnType<typeof startE2BDesktopRecording>> | undefined;
  recordingEvidence: RunDesktopRecording | undefined;
  readonly mediaStop: AbortController;
  desktopBrowser: DesktopBrowserEvidence | undefined;
  launchedBrowserFamily: DesktopBrowserFamily;
  browserLaunchIdentity: DesktopBrowserLaunchIdentity | undefined;
  browserLaunched: boolean;
  fidelity: ParticipantFidelity;
  initialBrowserGeometry: Awaited<ReturnType<typeof captureDesktopBrowserGeometry>> | undefined;
  browserWindowId: string | undefined;
  browserTargetId: string | undefined;
  desktopGeometry: RunDesktopGeometry;
  streamUrl: string | undefined;
}

export function newParticipantState(spec: DesktopParticipantRun): E2BParticipantState {
  const declaredScreen = declaredScreenForRender(
    spec.planned.device.preset,
    spec.planned.device.name,
    spec.planned.device.resolution,
  );
  return {
    desktop: undefined,
    allocation: undefined,
    sandboxId: undefined,
    sandboxCreatedAtMs: undefined,
    sandboxTornDownAtMs: undefined,
    desktopResources: undefined,
    released: false,
    failureCode: undefined,
    commsCatch: undefined,
    commsArtifactPath: undefined,
    receivingInboxUrl: undefined,
    stateStepRecords: [],
    phaseRecords: [],
    subjectCommit: undefined,
    speech: undefined,
    recording: undefined,
    recordingEvidence: undefined,
    mediaStop: new AbortController(),
    desktopBrowser: undefined,
    launchedBrowserFamily: "unknown",
    browserLaunchIdentity: undefined,
    browserLaunched: false,
    fidelity: { applied: undefined, emulatedTargetId: undefined, holderName: undefined },
    initialBrowserGeometry: undefined,
    browserWindowId: undefined,
    browserTargetId: undefined,
    desktopGeometry: {
      screen: {
        requested: {
          width: spec.planned.device.resolution[0],
          height: spec.planned.device.resolution[1],
        },
        ...(declaredScreen ? { declared: declaredScreen } : {}),
      },
    },
    streamUrl: undefined,
  };
}

/** The lane's outcome evidence, read from its state. */
export function desktopEvidenceOf(state: E2BParticipantState): ParticipantDesktopEvidence {
  // Host-side approximation of the E2B desktop's billed lifetime; feeds the desktop-minute cost
  // estimate. Never negative.
  const desktopDurationMs =
    state.sandboxCreatedAtMs !== undefined && state.sandboxTornDownAtMs !== undefined
      ? Math.max(0, state.sandboxTornDownAtMs - state.sandboxCreatedAtMs)
      : undefined;

  return {
    ...(state.sandboxId === undefined ? {} : { sandboxId: state.sandboxId }),
    ...(desktopDurationMs === undefined ? {} : { desktopDurationMs }),
    ...(state.desktopResources === undefined ? {} : { desktopResources: state.desktopResources }),
    released: state.released,
    streamUrlPresent: state.streamUrl !== undefined,
    ...(state.subjectCommit === undefined ? {} : { subjectCommit: state.subjectCommit }),
    ...(state.desktopBrowser === undefined ? {} : { desktopBrowser: state.desktopBrowser }),
    ...(state.recordingEvidence === undefined ? {} : { recording: state.recordingEvidence }),
    desktopGeometry: state.desktopGeometry,
    stateStepRecords: state.stateStepRecords,
    phaseRecords: state.phaseRecords,
    ...(state.failureCode === undefined ? {} : { failureCode: state.failureCode }),
    ...(state.commsArtifactPath === undefined
      ? {}
      : { commsArtifactPath: state.commsArtifactPath }),
  };
}
