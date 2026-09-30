// Teardown for one E2B desktop lane: the recording and speech worker are collected first, then the
// sandbox is released by id (or kept for debugging), with a warning for every outcome that is not
// a confirmed release.

import { collectDesktopRecording } from "../../evidence/desktop-recording-artifact.js";
import type { RunDesktopRecording } from "../../evidence/desktop-recording-types.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { OwnedDesktopAllocation } from "../../substrates/desktop-session.js";
import type { startE2BDesktopMedia } from "../../substrates/e2b/desktop-media.js";
import type { startE2BDesktopRecording } from "../../substrates/e2b/desktop-recording.js";
import type { CuaLaneDeps, CuaLaneSpec } from "./types.js";

/**
 * Each route's own keep flag gates its own lane only: a clone.keep can never leak into a local-tree
 * lane's teardown decision, and vice versa.
 */
export function laneKeepReason(deps: CuaLaneDeps): string | undefined {
  const { config, cloneRoute, localTreeRoute } = deps;
  if (cloneRoute && config.subject.clone?.keep === true) return "subject.clone.keep";
  if (localTreeRoute && config.subject.localTree?.keep === true) return "subject.localTree.keep";
  return undefined;
}

/** Collect the recording and stop the speech worker; failures are warnings. */
export async function stopLaneMedia(args: {
  spec: CuaLaneSpec;
  deps: CuaLaneDeps;
  recording: Awaited<ReturnType<typeof startE2BDesktopRecording>> | undefined;
  speech: Awaited<ReturnType<typeof startE2BDesktopMedia>> | undefined;
  mediaStop: AbortController;
  warnings: string[];
}): Promise<RunDesktopRecording | undefined> {
  const { deps, warnings, recording } = args;
  let evidence: RunDesktopRecording | undefined;
  if (recording) {
    try {
      evidence = await collectDesktopRecording(deps.artifactRoot, args.spec.laneId, (destination) =>
        recording.finish(destination),
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
export async function releaseLaneDesktop(args: {
  allocation: OwnedDesktopAllocation;
  keepReason: string | undefined;
  failed: boolean;
  deps: CuaLaneDeps;
  warnings: string[];
}): Promise<boolean> {
  const { allocation, keepReason, deps, warnings } = args;
  const keepForDebug = keepReason !== undefined && args.failed;
  const released = await allocation.close({ retainForDebug: keepForDebug });
  if (released.status === "released" && released.reason === "already_gone") {
    warnings.push(
      "Sandbox was already absent when cleanup ran; its exact termination time is unknown. Desktop cost uses the observed acquisition-to-cleanup span.",
    );
  } else if (released.status === "retained") {
    warnings.push(
      `Sandbox ${allocation.resourceId} kept for debugging (${keepReason} on failure); reclaim it via E2B or it will be killed on its server-side timeout.`,
    );
  } else if (released.status === "unconfirmed") {
    if (released.reason === "release_unavailable") {
      warnings.push(
        "Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox.",
      );
    } else if (released.reason === "release_failed") {
      warnings.push(
        `Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(deps.scrubKnownValues(toErrorMessage(released.error)))}`,
      );
    } else {
      warnings.push(
        "Sandbox teardown returned an unexpected result; release is unconfirmed and server-side kill-on-timeout remains the backstop.",
      );
    }
  }
  return released.status === "released";
}
