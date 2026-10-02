// Teardown for one E2B desktop participant: its final geometry and comms evidence are collected, then the
// recording and speech worker, then the sandbox is released by id (or kept for debugging), with a
// warning for every outcome that is not a confirmed release.

import { collectDesktopRecording } from "../../../evidence/desktop-recording-artifact.js";
import type { RunDesktopRecording } from "../../../evidence/desktop-recording-types.js";
import { redactText, toErrorMessage } from "../../../evidence/redaction.js";
import type { OwnedDesktopAllocation } from "../../../substrates/desktop-session.js";
import type { startE2BDesktopMedia } from "../../../substrates/e2b/desktop-media.js";
import type { startE2BDesktopRecording } from "../../../substrates/e2b/desktop-recording.js";
import { readE2BRelease } from "../../../substrates/e2b/sandbox.js";
import { e2bShell } from "../../../substrates/e2b/shell.js";
import { drainCommsEvidence } from "./comms.js";
import { finalParticipantGeometry } from "./fidelity.js";
import type { E2BParticipantContext, E2BParticipantState } from "./state.js";
import type { E2BDesktopDeps, DesktopParticipantRun, SandboxReleaseFact } from "../types.js";
import { streamEvent } from "../../../lab/run-lab-homes.js";

/**
 * Each route's own keep flag gates its own participants only: a clone.keep can never leak into a
 * local-tree participant's teardown decision, and vice versa.
 */
function participantKeepReason(deps: E2BDesktopDeps): string | undefined {
  const { residual, subject } = deps;
  if (subject.kind === "clone" && residual.subject.clone?.keep === true)
    return "subject.clone.keep";
  if (subject.kind === "local-tree" && residual.subject.localTree?.keep === true)
    return "subject.localTree.keep";
  return undefined;
}

/** Collect the recording and stop the speech worker; failures are warnings. */
async function stopParticipantMedia(args: {
  spec: DesktopParticipantRun;
  deps: E2BDesktopDeps;
  recording: Awaited<ReturnType<typeof startE2BDesktopRecording>> | undefined;
  speech: Awaited<ReturnType<typeof startE2BDesktopMedia>> | undefined;
  mediaStop: AbortController;
  warnings: string[];
}): Promise<RunDesktopRecording | undefined> {
  const { deps, warnings, recording } = args;
  let evidence: RunDesktopRecording | undefined;
  if (recording) {
    try {
      evidence = await collectDesktopRecording(
        deps.artifactRoot,
        args.spec.planned.id,
        (destination) => recording.finish(destination),
      );
    } catch (error) {
      warnings.push(
        `Desktop recording collection failed: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`,
      );
    }
  }
  args.mediaStop.abort();
  await args.speech?.close().catch(() => {
    warnings.push("Speech worker cleanup was interrupted; desktop teardown will reclaim it.");
  });
  return evidence;
}

/**
 * Release the participant's sandbox, or keep it when a keep flag is set and the participant failed. `released`
 * is true only when the release is confirmed; otherwise `sandboxRelease` says why. A kept or
 * unconfirmed sandbox can still accrue compute cost, which the warnings say.
 */
async function releaseParticipantDesktop(args: {
  allocation: OwnedDesktopAllocation;
  keepReason: string | undefined;
  failed: boolean;
  deps: E2BDesktopDeps;
  warnings: string[];
}): Promise<{ released: boolean; sandboxRelease?: SandboxReleaseFact }> {
  const { allocation, keepReason, deps, warnings } = args;
  const keepForDebug = keepReason !== undefined && args.failed;
  const released = await allocation.close({ retainForDebug: keepForDebug });
  if (released.status === "retained") {
    const warning = `Sandbox ${allocation.resourceId} kept for debugging (${keepReason} on failure); reclaim it via E2B or it will be killed on its server-side timeout.`;
    warnings.push(warning);
    return { released: false, sandboxRelease: { state: "retained", warning } };
  }
  const reading = readE2BRelease(released, {
    label: "Sandbox",
    scrub: deps.scrubKnownValues,
    costSpan: true,
  });
  if (reading.warning) warnings.push(reading.warning);
  if (reading.released) return { released: true };
  return {
    released: false,
    sandboxRelease: {
      state: "unconfirmed",
      warning: reading.warning ?? "Sandbox release is unconfirmed.",
    },
  };
}

/**
 * Finish a participant: collect its final geometry and comms evidence, then stop its media and release
 * its sandbox. Evidence failures are warnings; the release always runs.
 */
export async function finishE2BDesktop(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
  failed: boolean,
): Promise<void> {
  const { spec, deps, warnings } = ctx;
  // Stop the mid-run inbox-surface loop first, before the evidence drain below, so the two `cat`s
  // never overlap and the final surface state is deterministic. A surface failure can never block
  // teardown (the loop body is fully try/caught and this await is on its already-caught promise).
  await state.commsCatch?.stopSurface();
  const { desktop, allocation } = state;
  if (!desktop || !allocation) return;
  try {
    if (state.browserLaunched) {
      state.desktopGeometry = await finalParticipantGeometry({
        desktop,
        spec,
        deps,
        targetUrl: ctx.targetUrl,
        browserFamily: state.launchedBrowserFamily,
        launchIdentity: state.browserLaunchIdentity,
        windowId: state.browserWindowId,
        targetId: state.browserTargetId,
        initial: state.initialBrowserGeometry,
        geometry: state.desktopGeometry,
        fidelity: state.fidelity,
        warnings,
      });
    }
    if (deps.receiving) {
      try {
        await deps.receiving.finishParticipant(spec.planned.id);
      } catch {
        warnings.push(
          "Real email finalization is incomplete. Inspect communication cleanup with humanish comms recover.",
        );
      }
    }
    if (ctx.comms && state.commsCatch?.deployed.ready) {
      const drained = await drainCommsEvidence({
        shell: e2bShell(desktop),
        comms: ctx.comms,
        deployed: state.commsCatch.deployed,
        spec,
        deps,
        warnings,
      });
      if (drained !== undefined) state.commsArtifactPath = drained;
    }
  } catch (error) {
    warnings.push(
      `Desktop final evidence collection failed: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`,
    );
  } finally {
    state.recordingEvidence = await stopParticipantMedia({
      spec,
      deps,
      recording: state.recording,
      speech: state.speech,
      mediaStop: state.mediaStop,
      warnings,
    });
    const release = await releaseParticipantDesktop({
      allocation,
      keepReason: participantKeepReason(deps),
      failed,
      deps,
      warnings,
    });
    state.released = release.released;
    state.sandboxRelease = release.sandboxRelease;
    // Close the observed span. A kept or unconfirmed sandbox can still accrue compute cost; the
    // summary records that remaining lifetime as unknown instead of calling this complete.
    state.sandboxTornDownAtMs = deps.now();
    // The participant's live stream is now a dead page whichever teardown path ran (released, kept, or
    // release-failed-awaiting-TTL); tell the watch overlay so the tile falls back to recorded
    // evidence instead of "sandbox not found". Guarded: a viewer callback must never
    // break teardown.
    if (state.streamUrl !== undefined) {
      try {
        await deps.onStream(
          streamEvent({
            type: "ended",
            participantId: spec.planned.id,
            recordId: spec.recordId,
            streamId: spec.streamId,
          }),
        );
      } catch {
        // viewer-side only; nothing to record
      }
    }
  }
}
