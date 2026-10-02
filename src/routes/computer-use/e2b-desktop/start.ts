// The second half of an E2B desktop participant's preparation, and the start of its session: speech and
// recording, then the browser or terminal the participant sees, then the live stream. Each step
// fills the participant's state.

import { redactText, toErrorMessage } from "../../../evidence/redaction.js";
import {
  CHROME_DEVTOOLS_PORT,
  DESKTOP_SETTLE_MS,
  openDesktopBrowserTarget,
  openDesktopTerminal,
  startDesktopStream,
  type ChromeDevToolsReadiness,
} from "../../../substrates/e2b/desktop-browser.js";
import { captureDesktopBrowserGeometry } from "../../../substrates/e2b/desktop-geometry.js";
import {
  prepareDesktopMedia,
  startE2BDesktopMedia,
} from "../../../substrates/e2b/desktop-media.js";
import { startE2BDesktopRecording } from "../../../substrates/e2b/desktop-recording.js";
import type { E2BDesktopSandbox } from "../../../substrates/e2b/sdk.js";
import { applyParticipantMobileFidelity, mobileLaunchFlags } from "./fidelity.js";
import type { E2BParticipantContext, E2BParticipantState } from "./state.js";

/** Start the declared speech worker and screen recording. A recording that cannot start is a warning. */
export async function startParticipantMedia(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const { spec, deps, warnings } = ctx;
  const requestedMedia = deps.residual.execution?.desktop?.media;
  if (!ctx.desktopCliRoute && requestedMedia?.microphone?.source === "speech") {
    state.speech = await startE2BDesktopMedia({
      desktop,
      media: requestedMedia,
      signal: state.mediaStop.signal,
      onTerminal: () => state.mediaStop.abort(),
      requestTimeoutMs: deps.requestTimeoutMs,
    });
  }
  const requestedRecording = deps.residual.execution?.desktop?.recording;
  if (requestedRecording) {
    try {
      state.recording = await startE2BDesktopRecording({
        desktop,
        width: spec.planned.device.resolution[0],
        height: spec.planned.device.resolution[1],
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
export async function openParticipantSurface(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const { spec, deps, warnings, targetUrl } = ctx;
  const { residual, subject } = deps;
  if (subject.kind === "desktop-cli") {
    // A terminal window, opened the way the browser is opened on every other route: the
    // participant arrives at a desktop with the thing they were asked to use already in front
    // of them. They can still open another from the dock; that is the point of a desktop.
    await openDesktopTerminal(desktop, deps.requestTimeoutMs, subject.product.workdir);
    await desktop.wait(DESKTOP_SETTLE_MS).catch(() => undefined);
    return;
  }
  const requestedMedia = residual.execution?.desktop?.media;
  // A declared camera is in place before the browser starts: the feed is generated or
  // uploaded first, and a feed that cannot be produced fails the participant closed here.
  const mediaEvidence =
    requestedMedia === undefined
      ? undefined
      : await prepareDesktopMedia(
          desktop,
          requestedMedia,
          residual.policies?.mediaPermission ?? "prompt",
          deps.labCwd,
          deps.requestTimeoutMs,
        );
  const emulationFlags = mobileLaunchFlags(residual, spec);
  const browserLaunch = await openDesktopBrowserTarget(
    desktop,
    targetUrl,
    deps.requestTimeoutMs,
    residual.execution?.desktop?.browser,
    [...emulationFlags, ...(mediaEvidence?.flags ?? [])],
    state.speech?.env ?? state.recording?.env,
  );
  state.desktopBrowser =
    mediaEvidence === undefined
      ? browserLaunch.evidence
      : {
          requested: residual.execution?.desktop?.browser ?? "default",
          ...browserLaunch.evidence,
          media: mediaEvidence,
        };
  if (mediaEvidence !== undefined && browserLaunch.family !== "chromium") {
    throw new Error(
      `execution.desktop.media needs Chrome or Chromium for participant ${spec.planned.id} (the fake-device flags are Chromium's); the launched browser family is ${browserLaunch.family}. Set execution.desktop.browser: chrome.`,
    );
  }
  state.launchedBrowserFamily = browserLaunch.family;
  state.browserLaunchIdentity = browserLaunch.identity;
  state.browserLaunched = true;
  noteDevToolsReadiness(ctx, browserLaunch.devTools, emulationFlags.length > 0);
  await desktop.wait(DESKTOP_SETTLE_MS).catch(() => undefined);
  // Mobile fidelity is applied outside startParticipantStream's best-effort catch, so a request
  // that cannot be applied fails the participant closed.
  state.fidelity = await applyParticipantMobileFidelity({
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
 * DevTools answering later than this after launch is recorded as a warning on the participant. Six live
 * launches answered in 4.8-7.7 s; the reads this wait now guards used to give up at about 11 s.
 */
const SLOW_DEVTOOLS_MS = 10_000;

/**
 * Records how Chrome's DevTools port answered after launch, as a timed phase in the bundle. A
 * device-emulated participant fails closed when the port never answered, because emulation is applied
 * over DevTools. Other participants continue with a warning: their DevTools reads already degrade to
 * warnings of their own.
 */
function noteDevToolsReadiness(
  ctx: E2BParticipantContext,
  devTools: ChromeDevToolsReadiness | undefined,
  emulated: boolean,
): void {
  if (devTools === undefined) return;
  const { spec, deps, warnings } = ctx;
  const endpoint = `127.0.0.1:${CHROME_DEVTOOLS_PORT}`;
  ctx.onSubjectPhase({
    at: new Date(deps.now()).toISOString(),
    type: "cua-lab.browser.devtools.completed",
    ok: devTools.state === "ready",
    durationMs: devTools.waitedMs,
    message:
      devTools.state === "ready"
        ? `Chrome DevTools answered on ${endpoint}`
        : `Chrome DevTools did not answer on ${endpoint}`,
  });
  if (devTools.state === "ready") {
    if (devTools.waitedMs > SLOW_DEVTOOLS_MS) {
      warnings.push(
        `Chrome DevTools for participant ${spec.planned.id} answered ${devTools.waitedMs} ms after launch; the browser started slowly.`,
      );
    }
    return;
  }
  const log =
    devTools.logTail === ""
      ? "the browser log was empty"
      : `browser log: ${redactText(deps.scrubKnownValues(devTools.logTail))}`;
  const reason =
    devTools.state === "exited"
      ? `Chrome exited ${devTools.waitedMs} ms after launch, before DevTools answered on ${endpoint} (${log})`
      : `Chrome DevTools did not answer on ${endpoint} within ${devTools.waitedMs} ms of launch while the browser process was still running (${log})`;
  if (emulated) throw new Error(`mobile emulation could not be applied: ${reason}`);
  warnings.push(
    `${reason}. Browser geometry and URL/text observation for participant ${spec.planned.id} read DevTools and may be unavailable.`,
  );
}

/**
 * Measure the browser window and start the live stream. A stream that cannot start is a warning;
 * unusable browser geometry fails the participant before any action.
 */
export async function startParticipantStream(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
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
        participantId: spec.planned.id,
        targetUrl: ctx.targetUrl,
        requestedScreen: spec.planned.device.resolution,
        requestTimeoutMs: deps.requestTimeoutMs,
      });
      state.initialBrowserGeometry = browserGeometry;
      state.browserWindowId = browserGeometry.browserWindowId;
      state.browserTargetId = browserGeometry.browserTargetId;
    }
    // A browser participant streams its browser window when one was found. A CLI participant has
    // no window id and streams the whole desktop: a person studying a terminal app opens other windows, and
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
      await deps.onStream({
        type: "ready",
        participantId: spec.planned.id,
        sandboxId: desktop.sandboxId,
        simId: spec.recordId,
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
  // never a participant finding about missing controls. Both computer-use and shared-world participants
  // use this route.
  if (state.initialBrowserGeometry?.unusable !== undefined) {
    state.failureCode = "HUMANISH_CUA_LAB_DEVICE_GEOMETRY";
    throw new Error(
      `${state.failureCode}: ${state.initialBrowserGeometry.unusable} Participant actions were not started.`,
    );
  }
}
