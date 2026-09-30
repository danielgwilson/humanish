// The second half of an E2B desktop lane's preparation, and the start of its session: speech and
// recording, then the browser or terminal the participant sees, then the live stream. Each step
// fills the lane's state.

import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import {
  DESKTOP_SETTLE_MS,
  openDesktopBrowserTarget,
  openDesktopTerminal,
  startDesktopStream,
} from "../../substrates/e2b/desktop-browser.js";
import { captureDesktopBrowserGeometry } from "../../substrates/e2b/desktop-geometry.js";
import { prepareDesktopMedia, startE2BDesktopMedia } from "../../substrates/e2b/desktop-media.js";
import { startE2BDesktopRecording } from "../../substrates/e2b/desktop-recording.js";
import type { E2BDesktopSandbox } from "../../substrates/e2b/sdk.js";
import { applyLaneMobileFidelity, mobileLaunchFlags } from "./e2b-desktop-fidelity.js";
import type { E2BLaneContext, E2BLaneState } from "./e2b-desktop-state.js";

/** Start the declared speech worker and screen recording. A recording that cannot start is a warning. */
export async function startLaneMedia(
  ctx: E2BLaneContext,
  state: E2BLaneState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const { spec, deps, warnings } = ctx;
  const requestedMedia = deps.config.execution?.desktop?.media;
  if (!ctx.desktopCliRoute && requestedMedia?.microphone?.source === "speech") {
    state.speech = await startE2BDesktopMedia({
      desktop,
      media: requestedMedia,
      signal: state.mediaStop.signal,
      onTerminal: () => state.mediaStop.abort(),
      requestTimeoutMs: deps.requestTimeoutMs,
    });
  }
  const requestedRecording = deps.config.execution?.desktop?.recording;
  if (requestedRecording) {
    try {
      state.recording = await startE2BDesktopRecording({
        desktop,
        width: spec.resolution[0],
        height: spec.resolution[1],
        audio: requestedRecording.audio,
        ...(state.speech === undefined ? {} : { pulseEnv: state.speech.env }),
        requestTimeoutMs: deps.requestTimeoutMs,
      });
    } catch (error) {
      warnings.push(
        `Desktop recording startup failed; the study continues without video: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`,
      );
    }
  }
}

/**
 * Open what the participant sees: the browser at the target, with any declared camera and mobile
 * fidelity, or a terminal window on the desktop-cli route.
 */
export async function openLaneSurface(
  ctx: E2BLaneContext,
  state: E2BLaneState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const { spec, deps, warnings, targetUrl } = ctx;
  const { config } = deps;
  if (ctx.desktopCliRoute) {
    // A terminal window, opened the way the browser is opened on every other route: the
    // participant arrives at a desktop with the thing they were asked to use already in front
    // of them. They can still open another from the dock — that is the point of a desktop.
    await openDesktopTerminal(desktop, deps.requestTimeoutMs, config.subject.product?.workdir);
    await desktop.wait(DESKTOP_SETTLE_MS).catch(() => undefined);
    return;
  }
  const requestedMedia = config.execution?.desktop?.media;
  // A declared camera (#509) is in place before the browser starts: the feed is generated or
  // uploaded first, and a feed that cannot be produced fails the lane closed here.
  const mediaEvidence =
    requestedMedia === undefined
      ? undefined
      : await prepareDesktopMedia(
          desktop,
          requestedMedia,
          config.policies?.mediaPermission ?? "prompt",
          deps.labCwd,
          deps.requestTimeoutMs,
        );
  const browserLaunch = await openDesktopBrowserTarget(
    desktop,
    targetUrl,
    deps.requestTimeoutMs,
    config.execution?.desktop?.browser,
    [...mobileLaunchFlags(config, spec), ...(mediaEvidence?.flags ?? [])],
    state.speech?.env ?? state.recording?.env,
  );
  state.desktopBrowser =
    mediaEvidence === undefined
      ? browserLaunch.evidence
      : {
          requested: config.execution?.desktop?.browser ?? "default",
          ...browserLaunch.evidence,
          media: mediaEvidence,
        };
  if (mediaEvidence !== undefined && browserLaunch.family !== "chromium") {
    throw new Error(
      `execution.desktop.media needs Chrome or Chromium on lane ${spec.laneId} (the fake-device flags are Chromium's); the launched browser family is ${browserLaunch.family}. Set execution.desktop.browser: chrome.`,
    );
  }
  state.launchedBrowserFamily = browserLaunch.family;
  state.browserLaunchIdentity = browserLaunch.identity;
  state.browserLaunched = true;
  await desktop.wait(DESKTOP_SETTLE_MS).catch(() => undefined);
  // Mobile fidelity (#221) is applied outside startLaneStream's best-effort catch, so a request
  // that cannot be applied fails the lane closed.
  state.fidelity = await applyLaneMobileFidelity({
    desktop,
    spec,
    deps,
    targetUrl,
    browserFamily: state.launchedBrowserFamily,
    launchIdentity: state.browserLaunchIdentity,
    targetId: state.browserTargetId,
    warnings,
  });
}

/**
 * Measure the browser window and start the live stream. A stream that cannot start is a warning;
 * unusable browser geometry fails the lane before any participant action.
 */
export async function startLaneStream(
  ctx: E2BLaneContext,
  state: E2BLaneState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const { spec, deps, warnings } = ctx;
  try {
    // No browser means no browser geometry, and none is invented: the CSS-viewport facts a
    // browser reports have no counterpart in a terminal window, and an empty record shaped like
    // a measurement would read as one. The screen geometry is still verified.
    if (!ctx.desktopCliRoute) {
      const browserGeometry = await captureDesktopBrowserGeometry({
        desktop,
        browserFamily: state.launchedBrowserFamily,
        ...(state.browserLaunchIdentity === undefined
          ? {}
          : { launchIdentity: state.browserLaunchIdentity }),
        laneId: spec.laneId,
        targetUrl: ctx.targetUrl,
        requestedScreen: spec.resolution,
        requestTimeoutMs: deps.requestTimeoutMs,
      });
      state.initialBrowserGeometry = browserGeometry;
      state.browserWindowId = browserGeometry.browserWindowId;
      state.browserTargetId = browserGeometry.browserTargetId;
    }
    // A browser lane streams its browser window when one was found. A CLI lane has no window id
    // and streams the whole desktop: a person studying a terminal app opens other windows, and
    // a stream bound to the first one would quietly stop being evidence.
    await startDesktopStream(desktop, state.browserWindowId);
    const candidateStreamUrl: unknown = desktop.stream.getUrl({
      authKey: desktop.stream.getAuthKey(),
      autoConnect: true,
      viewOnly: true,
      resize: "scale",
    });
    if (typeof candidateStreamUrl === "string" && candidateStreamUrl.trim().length > 0) {
      state.streamUrl = candidateStreamUrl;
      await deps.hooks.onRuntimeStreamReady?.({
        laneId: spec.laneId,
        sandboxId: desktop.sandboxId,
        simId: spec.simId,
        streamId: spec.streamId,
        url: candidateStreamUrl,
      });
    } else {
      warnings.push(
        "Live desktop stream started but did not return a usable watch URL; Observer will fall back to screenshots.",
      );
    }
  } catch (error) {
    warnings.push(
      `Live desktop stream unavailable (run continues; evidence still captured): ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`,
    );
  }

  // This is outside the stream's best-effort catch: unusable geometry is a harness failure,
  // never a participant finding about missing controls. Both per-lane and shared-world seats
  // use this route.
  if (state.initialBrowserGeometry?.unusable !== undefined) {
    state.failureCode = "HUMANISH_CUA_LAB_DEVICE_GEOMETRY";
    throw new Error(
      `${state.failureCode}: ${state.initialBrowserGeometry.unusable} Participant actions were not started.`,
    );
  }
}
