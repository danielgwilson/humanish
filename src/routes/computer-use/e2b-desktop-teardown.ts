// Teardown for one E2B desktop lane: its final geometry and comms evidence are collected, then the
// recording and speech worker, then the sandbox is released by id (or kept for debugging), with a
// warning for every outcome that is not a confirmed release.

import { collectDesktopRecording } from "../../evidence/desktop-recording-artifact.js";
import type { RunDesktopRecording } from "../../evidence/desktop-recording-types.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { OwnedDesktopAllocation } from "../../substrates/desktop-session.js";
import type { startE2BDesktopMedia } from "../../substrates/e2b/desktop-media.js";
import type { startE2BDesktopRecording } from "../../substrates/e2b/desktop-recording.js";
import { readE2BRelease } from "../../substrates/e2b/sandbox.js";
import { e2bShell } from "../../substrates/e2b/shell.js";
import { drainCommsEvidence } from "./e2b-desktop-comms.js";
import { finalLaneGeometry } from "./e2b-desktop-fidelity.js";
import type { E2BLaneContext, E2BLaneState } from "./e2b-desktop-state.js";
import type { CuaParticipantDeps, DesktopParticipantRun } from "./types.js";

/**
 * Each route's own keep flag gates its own lane only: a clone.keep can never leak into a local-tree
 * lane's teardown decision, and vice versa.
 */
function laneKeepReason(deps: CuaParticipantDeps): string | undefined {
  const { config, cloneRoute, localTreeRoute } = deps;
  if (cloneRoute && config.subject.clone?.keep === true) return "subject.clone.keep";
  if (localTreeRoute && config.subject.localTree?.keep === true) return "subject.localTree.keep";
  return undefined;
}

/** Collect the recording and stop the speech worker; failures are warnings. */
async function stopLaneMedia(args: {
  spec: DesktopParticipantRun;
  deps: CuaParticipantDeps;
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
 * Release the lane's sandbox, or keep it when a keep flag is set and the lane failed. Returns true
 * only when the release is confirmed. A kept or unconfirmed sandbox can still accrue compute cost,
 * which the warnings say.
 */
async function releaseLaneDesktop(args: {
  allocation: OwnedDesktopAllocation;
  keepReason: string | undefined;
  failed: boolean;
  deps: CuaParticipantDeps;
  warnings: string[];
}): Promise<boolean> {
  const { allocation, keepReason, deps, warnings } = args;
  const keepForDebug = keepReason !== undefined && args.failed;
  const released = await allocation.close({ retainForDebug: keepForDebug });
  if (released.status === "retained") {
    warnings.push(
      `Sandbox ${allocation.resourceId} kept for debugging (${keepReason} on failure); reclaim it via E2B or it will be killed on its server-side timeout.`,
    );
    return false;
  }
  const reading = readE2BRelease(released, {
    label: "Sandbox",
    scrub: deps.scrubKnownValues,
    costSpan: true,
  });
  if (reading.warning) warnings.push(reading.warning);
  return reading.released;
}

/**
 * Finish a lane: collect its final geometry and comms evidence, then stop its media and release
 * its sandbox. Evidence failures are warnings; the release always runs.
 */
export async function finishLane(
  ctx: E2BLaneContext,
  state: E2BLaneState,
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
      state.desktopGeometry = await finalLaneGeometry({
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
    state.recordingEvidence = await stopLaneMedia({
      spec,
      deps,
      recording: state.recording,
      speech: state.speech,
      mediaStop: state.mediaStop,
      warnings,
    });
    state.released = await releaseLaneDesktop({
      allocation,
      keepReason: laneKeepReason(deps),
      failed,
      deps,
      warnings,
    });
    // Close the observed span. A kept or unconfirmed sandbox can still accrue compute cost; the
    // summary records that remaining lifetime as unknown instead of calling this complete.
    state.sandboxTornDownAtMs = deps.now();
    // The lane's live stream is now a dead page whichever teardown path ran (released, kept, or
    // release-failed-awaiting-TTL); tell the watch overlay so the tile falls back to recorded
    // evidence instead of "sandbox not found" (#357). Guarded: a viewer callback must never
    // break teardown.
    if (state.streamUrl !== undefined) {
      try {
        await deps.hooks.onRuntimeStreamEnded?.({
          laneId: spec.planned.id,
          simId: spec.simId,
          streamId: spec.streamId,
        });
      } catch {
        // viewer-side only; nothing to record
      }
    }
  }
}
