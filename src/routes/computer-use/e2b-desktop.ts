// E2B owns provisioning and final evidence; the participant runner only uses the ready port.
import type { RunDesktopRecording } from "../../evidence/desktop-recording-types.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import { type RunSubjectStateStepRecord } from "../../run/bundle.js";
import { type RunDesktopGeometry } from "../../run/streams.js";
import { provisionCloneSubject } from "../../subject/clone.js";
import { provisionDesktopCli } from "../../subject/desktop-cli.js";
import { provisionLocalTreeSubject } from "../../subject/local-tree.js";
import { defaultSubjectPhaseSink, type SubjectPhaseEvent } from "../../subject/steps.js";
import type { OwnedDesktopAllocation } from "../../substrates/desktop-session.js";
import {
  DESKTOP_SETTLE_MS,
  openDesktopBrowserTarget,
  openDesktopTerminal,
  startDesktopStream,
  type DesktopBrowserEvidence,
  type DesktopBrowserFamily,
  type DesktopBrowserLaunchIdentity,
} from "../../substrates/e2b/desktop-browser.js";
import { createE2BDesktopExecutor } from "../../substrates/e2b/desktop-executor.js";
import {
  captureDesktopBrowserGeometry,
  declaredScreenForRender,
  inspectDesktopScreenGeometry,
} from "../../substrates/e2b/desktop-geometry.js";
import { prepareDesktopMedia, startE2BDesktopMedia } from "../../substrates/e2b/desktop-media.js";
import { startE2BDesktopRecording } from "../../substrates/e2b/desktop-recording.js";
import {
  observeDesktopResources,
  type DesktopResourceObservation,
} from "../../substrates/e2b/desktop-resources.js";
import { acquireE2BDesktopSandbox, e2bDesktopTemplate } from "../../substrates/e2b/sandbox.js";
import { loadE2BDesktopModule, type E2BDesktopSandbox } from "../../substrates/e2b/sdk.js";
import { e2bShell } from "../../substrates/e2b/shell.js";
import type { CuaDesktopLane, DesktopLaneEvidence, ReadyCuaDesktop } from "./desktop-lane.js";
import {
  attachReceivingInbox,
  drainCommsEvidence,
  laneCommsEnv,
  laneInbox,
  planLaneComms,
  startCommsCatch,
  type RunningCommsCatch,
} from "./e2b-desktop-comms.js";
import {
  applyLaneMobileFidelity,
  finalLaneGeometry,
  laneBrowserStateObserver,
  mobileLaunchFlags,
  type LaneFidelity,
} from "./e2b-desktop-fidelity.js";
import { laneKeepReason, releaseLaneDesktop, stopLaneMedia } from "./e2b-desktop-teardown.js";
import type { CuaActorLabErrorCode, CuaLaneDeps, CuaLaneSpec } from "./types.js";

export const CUA_ACTOR_LAB_PROVIDER_METADATA = {
  mode: "cua-actor-lab",
  tool: "humanish",
} as const;

export function createE2BCuaDesktopLane(
  spec: CuaLaneSpec,
  deps: CuaLaneDeps,
  warnings: string[],
): CuaDesktopLane {
  const { config, appUrl, cloneRoute, localTreeRoute, serve, subjectRepo, subjectEnvNames } = deps;
  const desktopCliRoute = deps.desktopCliRoute === true;
  const subjectEnvValues = config.subject.envValues ?? {};
  const targetUrl = spec.targetUrl ?? appUrl;
  const env = deps.env;
  // Off-app comms (#297): gated ENTIRELY on config.comms — no comms declared → zero change. The
  // base-URL env is injected at sandbox-create (below, so the app reads it at boot); the catch is
  // started right after create.
  const comms = planLaneComms(config, targetUrl, cloneRoute || localTreeRoute === true);
  const commsEnv = laneCommsEnv(comms);
  // Hoisted so the finally can drain the catch before teardown; `commsArtifactPath` is the written
  // evidence path folded into the lane outcome.
  let commsCatch: RunningCommsCatch | undefined;
  let commsArtifactPath: string | undefined;
  let receivingInboxUrl: string | undefined;
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  // Completed-only trail (durationMs/ok are set on completed events, never on started ones):
  // this is what survives into bundle.events. The default/injected sink below sees EVERY event,
  // started and completed alike, so an operator watching stderr sees both halves of each phase.
  const phaseRecords: SubjectPhaseEvent[] = [];
  const onSubjectPhase = (event: SubjectPhaseEvent): void => {
    if (event.ok !== undefined) {
      phaseRecords.push(event);
    }
    (deps.hooks.onPhase ?? defaultSubjectPhaseSink)(event, {
      laneId: spec.laneId,
      laneIndex: spec.laneIndex,
      laneCount: deps.laneCount,
    });
  };
  let failureCode: CuaActorLabErrorCode | undefined;
  let sandboxId: string | undefined;
  // Host-side E2B desktop billed-span endpoints, measured via the injected clock. Captured right
  // after create() succeeds and again in the finally after teardown resolves (both the killed and
  // kept-for-debug paths). This measured span excludes allocation before the acquired handle;
  // a kept/unconfirmed allocation gets an extra unknown lifetime cost line.
  let sandboxCreatedAtMs: number | undefined;
  let sandboxTornDownAtMs: number | undefined;
  let desktopResources: DesktopResourceObservation | undefined;
  let killed = false;
  let streamUrl: string | undefined;
  let subjectCommit: string | undefined;
  let desktopBrowser: DesktopBrowserEvidence | undefined;
  let launchedBrowserFamily: DesktopBrowserFamily = "unknown";
  let browserLaunchIdentity: DesktopBrowserLaunchIdentity | undefined;
  let browserLaunched = false;
  let initialBrowserGeometry: Awaited<ReturnType<typeof captureDesktopBrowserGeometry>> | undefined;
  let fidelity: LaneFidelity = {
    applied: undefined,
    emulatedTargetId: undefined,
    holderName: undefined,
  };
  let browserWindowId: string | undefined;
  let browserTargetId: string | undefined;
  const declaredScreen = declaredScreenForRender(
    spec.devicePreset,
    spec.deviceName,
    spec.resolution,
  );
  let desktopGeometry: RunDesktopGeometry = {
    screen: {
      requested: { width: spec.resolution[0], height: spec.resolution[1] },
      ...(declaredScreen ? { declared: declaredScreen } : {}),
    },
  };

  let allocation: OwnedDesktopAllocation | undefined;
  let desktop: E2BDesktopSandbox | undefined;
  let speech: Awaited<ReturnType<typeof startE2BDesktopMedia>> | undefined;
  let recording: Awaited<ReturnType<typeof startE2BDesktopRecording>> | undefined;
  let recordingEvidence: RunDesktopRecording | undefined;
  const mediaStop = new AbortController();
  let preparationStarted = false;
  let prepared = false;
  let opened = false;
  let finalization: Promise<void> | undefined;

  async function prepare(): Promise<void> {
    if (preparationStarted || finalization)
      throw new Error("Desktop lane preparation can only start once, before finalization.");
    preparationStarted = true;
    const desktopModule = await (deps.hooks.loadDesktopModule ?? loadE2BDesktopModule)();
    // An explicit template wins. Speech gets the versioned media image; ordinary
    // browser studies retain the SDK default desktop.
    const acquired = await acquireE2BDesktopSandbox({
      module: desktopModule,
      options: {
        apiKey: deps.e2bApiKey,
        requestTimeoutMs: deps.requestTimeoutMs,
        timeoutMs: deps.perLaneSandboxMs,
        metadata: {
          ...CUA_ACTOR_LAB_PROVIDER_METADATA,
          labId: config.id,
          simId: spec.simId,
          laneId: spec.laneId,
          laneIndex: String(spec.laneIndex),
          laneCount: String(deps.laneCount),
        },
        // The participant's model key never enters the sandbox (the model drives from outside).
        // The subject's declared env names are provisioned here on the clone route.
        // Three sources, in precedence order: committed non-secret config (subject.envValues), then
        // secret values forwarded from the caller's environment (subject.env), then the harness's own
        // comms wiring, which must win because only it knows the catch's address.
        ...(subjectEnvNames.length > 0 ||
        Object.keys(subjectEnvValues).length > 0 ||
        Object.keys(commsEnv).length > 0
          ? {
              envs: {
                ...subjectEnvValues,
                ...Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])),
                ...commsEnv,
              },
            }
          : {}),
        resolution: spec.resolution,
        dpi: 96,
        lifecycle: { onTimeout: "kill" },
      },
      template: e2bDesktopTemplate(config),
      retry: {
        // The default loader reclaims an acquired handle before retrying failed desktop startup.
        // Its error names the cleanup outcome; pre-construction allocation failures remain unowned.
        onRetry: (reason) => {
          const named = redactText(deps.scrubKnownValues(reason));
          warnings.push(
            `Sandbox create for lane ${spec.laneId} retried once after a transient provider error (${named}).`,
          );
          onSubjectPhase({
            at: new Date(deps.now()).toISOString(),
            type: "cua-lab.sandbox.create.retry",
            message: `sandbox create retried once (${named})`,
          });
        },
      },
      // The receipt is on disk before any work, so `humanish reclaim` can kill this lane's
      // sandbox by exact id after an interrupt.
      receipt: { root: deps.artifactRoot, laneId: spec.laneId, now: deps.now },
    });
    desktop = acquired.sandbox;
    const shell = e2bShell(desktop);
    allocation = acquired.allocation;
    sandboxId = allocation.resourceId;
    // The billed span starts the instant the sandbox exists.
    sandboxCreatedAtMs = deps.now();
    desktopResources = await observeDesktopResources(desktop);
    if ("reason" in desktopResources) {
      warnings.push(
        `Desktop resource size unavailable (${desktopResources.reason}); compute cost remains unpriced.`,
      );
    }

    if (deps.hooks.prepareDesktop) {
      await deps.hooks.prepareDesktop(desktop, {
        laneId: spec.laneId,
        laneIndex: spec.laneIndex,
        laneCount: deps.laneCount,
      });
    }

    if (deps.receiving) {
      receivingInboxUrl = await attachReceivingInbox(
        shell,
        spec,
        { ...deps, receiving: deps.receiving },
        targetUrl,
      );
      commsArtifactPath = "comms/receiving.json";
    }
    if (comms) commsCatch = await startCommsCatch(shell, comms, deps.requestTimeoutMs);

    // Per-lane geometry assertion (fail-closed) — the device claim is verified in-sandbox.
    const screenGeometry = await inspectDesktopScreenGeometry({
      desktop,
      laneId: spec.laneId,
      requestedScreen: spec.resolution,
      requestTimeoutMs: deps.requestTimeoutMs,
    });
    if (screenGeometry.verified) {
      desktopGeometry = {
        ...desktopGeometry,
        screen: { ...desktopGeometry.screen, verified: screenGeometry.verified },
      };
    }
    if (screenGeometry.warning) {
      warnings.push(screenGeometry.warning);
      desktopGeometry = { ...desktopGeometry, warnings: [screenGeometry.warning] };
    }
    if (screenGeometry.error && deps.screenMismatchPolicy !== "record-evidence") {
      failureCode = "HUMANISH_CUA_LAB_DEVICE_GEOMETRY";
      throw new Error(screenGeometry.error);
    }
    if (screenGeometry.error && screenGeometry.verified) {
      // record-evidence policy: the bundle keeps requested vs verified as separate facts and
      // discloses the divergence instead of failing this lane's world mid-flight.
      const mismatchWarning = deps.scrubKnownValues(
        `Lane ${spec.laneId} requested a ${spec.resolution[0]}x${spec.resolution[1]} screen but xdpyinfo reports ${screenGeometry.verified.width}x${screenGeometry.verified.height}; recording requested vs verified separately instead of failing the lane closed.`,
      );
      warnings.push(mismatchWarning);
      desktopGeometry = {
        ...desktopGeometry,
        warnings: [...(desktopGeometry.warnings ?? []), mismatchWarning],
      };
    }
    if (desktopCliRoute) {
      // Prepare the runtime and any declared product install, UNKEYED. With install omitted,
      // the participant discovers and installs the product from its public surfaces.
      await provisionDesktopCli(shell, {
        product: config.subject.product?.name ?? "",
        ...(config.subject.product?.install === undefined
          ? {}
          : { install: config.subject.product.install }),
        requestTimeoutMs: deps.requestTimeoutMs,
        scrub: deps.scrubKnownValues,
        onPhase: onSubjectPhase,
      });
    }
    if (cloneRoute && serve && subjectRepo) {
      subjectCommit = await provisionCloneSubject(shell, {
        repo: subjectRepo,
        depth: config.subject.clone?.depth ?? 1,
        serve,
        ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
        hasGithubToken: deps.hasGithubToken,
        requestTimeoutMs: deps.requestTimeoutMs,
        scrub: deps.scrubKnownValues,
        onCommit: (commit) => {
          subjectCommit = commit;
        },
        onStateStep: (record) => {
          stateStepRecords.push(record);
        },
        onPhase: onSubjectPhase,
        ...deps.hooks.detachedTimers,
      });
    } else if (localTreeRoute && serve && deps.localTreeArchiveBuffer) {
      await provisionLocalTreeSubject(shell, {
        archiveBuffer: deps.localTreeArchiveBuffer,
        serve,
        ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
        requestTimeoutMs: deps.requestTimeoutMs,
        scrub: deps.scrubKnownValues,
        onStateStep: (record) => {
          stateStepRecords.push(record);
        },
        onPhase: onSubjectPhase,
        ...deps.hooks.detachedTimers,
      });
    }

    const requestedMedia = config.execution?.desktop?.media;
    if (!desktopCliRoute && requestedMedia?.microphone?.source === "speech") {
      speech = await startE2BDesktopMedia({
        desktop,
        media: requestedMedia,
        signal: mediaStop.signal,
        onTerminal: () => mediaStop.abort(),
        requestTimeoutMs: deps.requestTimeoutMs,
      });
    }
    const requestedRecording = config.execution?.desktop?.recording;
    if (requestedRecording) {
      try {
        recording = await startE2BDesktopRecording({
          desktop,
          width: spec.resolution[0],
          height: spec.resolution[1],
          audio: requestedRecording.audio,
          ...(speech === undefined ? {} : { pulseEnv: speech.env }),
          requestTimeoutMs: deps.requestTimeoutMs,
        });
      } catch (error) {
        warnings.push(
          `Desktop recording startup failed; the study continues without video: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`,
        );
      }
    }

    if (!desktopCliRoute) {
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
        speech?.env ?? recording?.env,
      );
      desktopBrowser =
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
      launchedBrowserFamily = browserLaunch.family;
      browserLaunchIdentity = browserLaunch.identity;
      browserLaunched = true;
      await desktop.wait(DESKTOP_SETTLE_MS).catch(() => undefined);
      // Mobile fidelity (#221) is applied OUTSIDE the stream/geometry try in openSession (whose
      // catch degrades to a warning), so a request that cannot be applied fails the lane closed.
      fidelity = await applyLaneMobileFidelity({
        desktop,
        spec,
        deps,
        targetUrl,
        browserFamily: launchedBrowserFamily,
        launchIdentity: browserLaunchIdentity,
        targetId: browserTargetId,
        warnings,
      });
    } else {
      // A terminal window, opened the way the browser is opened on every other route: the
      // participant arrives at a desktop with the thing they were asked to use already in front
      // of them. They can still open another from the dock — that is the point of a desktop.
      await openDesktopTerminal(desktop, deps.requestTimeoutMs, config.subject.product?.workdir);
      await desktop.wait(DESKTOP_SETTLE_MS).catch(() => undefined);
    }
    prepared = true;
  }

  async function openSession(): Promise<ReadyCuaDesktop> {
    if (!prepared || !desktop || !allocation || opened || finalization)
      throw new Error(
        "Desktop lane must be prepared and may only be opened once, before finalization.",
      );
    opened = true;
    try {
      // No browser means no browser geometry, and none is invented: the CSS-viewport facts a
      // browser reports have no counterpart in a terminal window, and an empty record shaped like
      // a measurement would read as one. The screen geometry above is still verified.
      if (!desktopCliRoute) {
        const browserGeometry = await captureDesktopBrowserGeometry({
          desktop,
          browserFamily: launchedBrowserFamily,
          ...(browserLaunchIdentity === undefined ? {} : { launchIdentity: browserLaunchIdentity }),
          laneId: spec.laneId,
          targetUrl,
          requestedScreen: spec.resolution,
          requestTimeoutMs: deps.requestTimeoutMs,
        });
        initialBrowserGeometry = browserGeometry;
        browserWindowId = browserGeometry.browserWindowId;
        browserTargetId = browserGeometry.browserTargetId;
      }
      // A browser lane streams its browser window when one was found. A CLI lane has no window id
      // and streams the whole desktop: a person studying a terminal app opens other windows, and
      // a stream bound to the first one would quietly stop being evidence.
      await startDesktopStream(desktop, browserWindowId);
      const candidateStreamUrl: unknown = desktop.stream.getUrl({
        authKey: desktop.stream.getAuthKey(),
        autoConnect: true,
        viewOnly: true,
        resize: "scale",
      });
      if (typeof candidateStreamUrl === "string" && candidateStreamUrl.trim().length > 0) {
        streamUrl = candidateStreamUrl;
        await deps.hooks.onRuntimeStreamReady?.({
          laneId: spec.laneId,
          sandboxId: desktop.sandboxId,
          simId: spec.simId,
          streamId: spec.streamId,
          url: streamUrl,
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
    if (initialBrowserGeometry?.unusable !== undefined) {
      failureCode = "HUMANISH_CUA_LAB_DEVICE_GEOMETRY";
      throw new Error(
        `${failureCode}: ${initialBrowserGeometry.unusable} Participant actions were not started.`,
      );
    }

    const inbox = laneInbox({
      spec,
      deps,
      receivingInboxUrl,
      comms,
      catchReady: commsCatch?.deployed.ready === true,
    });
    const executor = createE2BDesktopExecutor(
      desktop,
      launchedBrowserFamily === "chromium"
        ? {
            observeBrowserState: laneBrowserStateObserver({
              desktop,
              spec,
              deps,
              targetUrl,
              launchIdentity: browserLaunchIdentity,
              targetId: browserTargetId,
              fidelity,
              warnings,
            }),
          }
        : {},
    );
    return {
      executor: allocation.open(speech?.wrap(executor) ?? executor).executor,
      ...(inbox === undefined ? {} : { inbox }),
    };
  }

  async function finish(failed: boolean): Promise<void> {
    // Stop the mid-run inbox-surface loop FIRST — before the teardown evidence drain below — so the two
    // `cat`s never overlap and the final surface state is deterministic. A surface failure can never
    // block teardown (the loop body is fully try/caught and this await is on its already-caught promise).
    await commsCatch?.stopSurface();
    if (desktop && allocation) {
      try {
        if (browserLaunched) {
          desktopGeometry = await finalLaneGeometry({
            desktop,
            spec,
            deps,
            targetUrl,
            browserFamily: launchedBrowserFamily,
            launchIdentity: browserLaunchIdentity,
            windowId: browserWindowId,
            targetId: browserTargetId,
            initial: initialBrowserGeometry,
            geometry: desktopGeometry,
            fidelity,
            warnings,
          });
        }
        if (deps.receiving) {
          try {
            await deps.receiving.finishParticipant(spec.laneId);
          } catch {
            warnings.push(
              "Real email finalization is incomplete. Inspect communication cleanup with humanish comms recover.",
            );
          }
        }
        if (comms && commsCatch?.deployed.ready) {
          const drained = await drainCommsEvidence({
            shell: e2bShell(desktop),
            comms,
            deployed: commsCatch.deployed,
            spec,
            deps,
            warnings,
          });
          if (drained !== undefined) commsArtifactPath = drained;
        }
      } catch (error) {
        warnings.push(
          `Desktop final evidence collection failed: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`,
        );
      } finally {
        recordingEvidence = await stopLaneMedia({
          spec,
          deps,
          recording,
          speech,
          mediaStop,
          warnings,
        });
        killed = await releaseLaneDesktop({
          allocation,
          keepReason: laneKeepReason(deps),
          failed,
          deps,
          warnings,
        });
        // Close the observed span. A kept or unconfirmed sandbox can still accrue compute cost;
        // the summary records that remaining lifetime as unknown instead of calling this complete.
        sandboxTornDownAtMs = deps.now();
        // The lane's live stream is now a dead page whichever teardown path ran (killed, kept, or
        // kill-failed-awaiting-TTL) — tell the watch overlay so the tile falls back to recorded
        // evidence instead of "sandbox not found" (#357). Guarded: a viewer callback must never
        // break teardown.
        if (streamUrl !== undefined) {
          try {
            await deps.hooks.onRuntimeStreamEnded?.({
              laneId: spec.laneId,
              simId: spec.simId,
              streamId: spec.streamId,
            });
          } catch {
            // viewer-side only; nothing to record
          }
        }
      }
    }
  }

  function snapshot(): DesktopLaneEvidence {
    // Host-side approximation of the E2B desktop's billed lifetime; feeds the desktop-minute cost
    // estimate. Never negative.
    const desktopDurationMs =
      sandboxCreatedAtMs !== undefined && sandboxTornDownAtMs !== undefined
        ? Math.max(0, sandboxTornDownAtMs - sandboxCreatedAtMs)
        : undefined;

    return {
      ...(sandboxId === undefined ? {} : { sandboxId }),
      ...(desktopDurationMs === undefined ? {} : { desktopDurationMs }),
      ...(desktopResources === undefined ? {} : { desktopResources }),
      killed,
      streamUrlPresent: streamUrl !== undefined,
      ...(subjectCommit === undefined ? {} : { subjectCommit }),
      ...(desktopBrowser === undefined ? {} : { desktopBrowser }),
      ...(recordingEvidence === undefined ? {} : { recording: recordingEvidence }),
      desktopGeometry,
      stateStepRecords,
      phaseRecords,

      ...(failureCode === undefined ? {} : { failureCode }),
      ...(commsArtifactPath === undefined ? {} : { commsArtifactPath }),
    };
  }

  return {
    prepare,
    openSession,
    snapshot,
    finalize({ failed }) {
      return (finalization ??= finish(failed));
    },
  };
}
