// E2B owns provisioning and final evidence; the participant runner only uses the ready port.
import { toErrorMessage } from "./command-failure.js";
import { FakeInbox } from "./comms-fake-inbox.js";
import { buildOriginMap } from "./comms-inbox.js";
import { deployReceivingInbox } from "./comms-receiving-inbox.js";
import {
  DEFAULT_SANDBOX_CATCH_PORT,
  collectCommsThread,
  deployCommsCatch,
  refreshInboxSurface,
  writeInboxSurface,
  type DeployedCommsCatch
} from "./comms-sandbox-catch.js";
import type { CommsAddress } from "./comms-types.js";
import type { CuaActorLabErrorCode, CuaLaneDeps, CuaLaneSpec } from "./cua-actor-lab.js";
import type { CuaDesktopLane, DesktopLaneEvidence, ReadyCuaDesktop } from "./cua-desktop-lane.js";
import { inboxRecipientFor, laneHasInboxRecipient } from "./cua-desktop-lane.js";
import type { OwnedDesktopAllocation } from "./desktop-session.js";
import {
  BROWSER_SETTLE_MS,
  CUA_ACTOR_LAB_PROVIDER_METADATA,
  DEFAULT_MOBILE_USER_AGENT,
  INBOX_SURFACE_CADENCE_MS,
  applyMobileEmulation,
  captureDesktopBrowserGeometry,
  declaredScreenForRender,
  defaultSubjectPhaseSink,
  inspectDesktopScreenGeometry,
  makeChromeBrowserStateObserver,
  openDesktopBrowserTarget,
  openDesktopTerminal,
  prepareDesktopMedia,
  provisionCloneSubject,
  provisionDesktopCli,
  provisionLocalTreeSubject,
  startDesktopStream,
  type DesktopBrowserEvidence,
  type DesktopBrowserFamily,
  type DesktopBrowserLaunchIdentity,
  type SubjectPhaseEvent
} from "./e2b-cua-provisioning.js";
import { createE2BDesktopExecutor, type E2BDesktopLike } from "./e2b-desktop-executor.js";
import { e2bDesktopTemplate, startE2BDesktopMedia } from "./e2b-desktop-media.js";
import {
  loadE2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import { observeDesktopResources, type DesktopResourceObservation } from "./e2b-desktop-resources.js";
import { allocateE2BDesktopSession } from "./e2b-desktop-session.js";
import {
  readDetachedLog
} from "./e2b-detached.js";
import { redactText } from "./redaction.js";
import {
  type RunDesktopGeometry,
  type RunSubjectStateStepRecord
} from "./run.js";
import { appendSandboxReceipt } from "./sandbox-receipts.js";
import {
  writeContainedOutputFile
} from "./selected-output-paths.js";

function optionalAddress(address: string | undefined): { address?: string; } {
  return address === undefined ? {} : { address };
}

export function createE2BCuaDesktopLane(spec: CuaLaneSpec, deps: CuaLaneDeps, warnings: string[]): CuaDesktopLane {
  const { config, appUrl, cloneRoute, localTreeRoute, serve, subjectRepo, subjectEnvNames } = deps;
  const desktopCliRoute = deps.desktopCliRoute === true;
  const subjectEnvValues = config.subject.envValues ?? {};
  const targetUrl = spec.targetUrl ?? appUrl;
  const env = deps.env;
  // Off-app comms (#297): on an in-sandbox subject route, redirect the app's email-API sends into an
  // in-sandbox catch (loopback) so its verification mail is CAPTURED, not sent to the internet. Gated
  // ENTIRELY on config.comms — no comms declared → zero change. The base-URL env is injected at
  // sandbox-create (below, so the app reads it at boot); the catch is started right after create.
  const commsEmail = (cloneRoute || localTreeRoute) && config.comms?.email?.kind === "fake" ? config.comms.email : undefined;
  const commsPort = commsEmail ? (commsEmail.port ?? DEFAULT_SANDBOX_CATCH_PORT) : undefined;
  // Hoisted so the finally can drain the catch before teardown; `commsArtifactPath` is the written
  // evidence path folded into the lane outcome.
  let deployedComms: DeployedCommsCatch | undefined;
  let commsArtifactPath: string | undefined;
  let receivingInboxUrl: string | undefined;
  // injectEnv is absent on an adopter-hosted plane (#328): there is no subject env to inject
  // because the operator points their own app at their own catch.
  const commsEnv: Record<string, string> = commsEmail?.injectEnv !== undefined && commsPort !== undefined
    ? { [commsEmail.injectEnv]: `http://127.0.0.1:${commsPort}` }
    : {};
  // SMTP transport: the same idea as injectEnv, but an app that speaks SMTP needs a host and a port
  // rather than a base URL. The catch accepts any credentials (loopback only), yet many apps refuse
  // to boot unless the user/password vars exist at all, so those are injected when declared.
  const commsSmtpPort = commsEmail?.smtp?.port;
  if (commsEmail?.smtp && commsSmtpPort !== undefined) {
    commsEnv[commsEmail.smtp.hostEnv] = "127.0.0.1";
    commsEnv[commsEmail.smtp.portEnv] = String(commsSmtpPort);
    if (commsEmail.smtp.userEnv) commsEnv[commsEmail.smtp.userEnv] = commsEmail.smtp.user ?? "humanish";
    if (commsEmail.smtp.passwordEnv) commsEnv[commsEmail.smtp.passwordEnv] = commsEmail.smtp.password ?? "humanish";
  }
  // Persona inbox SURFACE (#297 slice B): the loopback URL the persona opens to read captured mail; the
  // origin-rewrite map (identity on this same-sandbox route, but covers localhost/0.0.0.0 alias skew + an
  // operator-declared linkOrigin); and a disposable background loop that renders the surface DURING the
  // session so the inbox is live when the persona checks. The surface uses its OWN FakeInbox + cursor,
  // independent of the teardown evidence drain (two readers of the append-only NDJSON — no double-count).
  const commsInboxUrl = commsEmail && commsPort !== undefined ? `http://127.0.0.1:${commsPort}/inbox` : undefined;
  const commsOriginMap = commsEmail
    ? buildOriginMap({
      ...(config.subject.serve?.url === undefined ? {} : { internalServeUrl: config.subject.serve.url }),
      reachableBaseUrl: targetUrl,
      ...(commsEmail.linkOrigin === undefined ? {} : { linkOrigin: commsEmail.linkOrigin })
    })
    : [];
  const surfaceRecipients = (commsEmail?.recipients ?? [])
    .filter((recipient): recipient is { lane: string; address: string; } => recipient.address !== undefined)
    .map((recipient) => ({ lane: recipient.lane, address: recipient.address }));
  let surfaceRenderedCount = 0;
  let surfaceDisposed = false;
  let releaseSurface: () => void = () => { };
  const surfaceDispose = new Promise<void>((resolve) => { releaseSurface = resolve; });
  let surfaceLoop: Promise<void> | undefined;
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  // Completed-only trail (durationMs/ok are set on completed events, never on started ones):
  // this is what survives into bundle.events. The default/injected sink below sees EVERY event,
  // started and completed alike, so an operator watching stderr sees both halves of each phase.
  const phaseRecords: SubjectPhaseEvent[] = [];
  const onSubjectPhase = (event: SubjectPhaseEvent): void => {
    if (event.ok !== undefined) {
      phaseRecords.push(event);
    }
    (deps.hooks.onPhase ?? defaultSubjectPhaseSink)(event, { laneId: spec.laneId, laneCount: deps.laneCount });
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
  let appliedFidelity: RunDesktopGeometry["fidelity"] | undefined;
  let emulatedTargetId: string | undefined;
  let emulationHolderName: string | undefined;
  let browserWindowId: string | undefined;
  let browserTargetId: string | undefined;
  const declaredScreen = declaredScreenForRender(spec.devicePreset, spec.deviceName, spec.resolution);
  let desktopGeometry: RunDesktopGeometry = {
    screen: {
      requested: { width: spec.resolution[0], height: spec.resolution[1] },
      ...(declaredScreen ? { declared: declaredScreen } : {})
    }
  };

  let allocation: OwnedDesktopAllocation | undefined;
  let desktop: E2BDesktopSandbox | undefined;
  let speech: Awaited<ReturnType<typeof startE2BDesktopMedia>> | undefined;
  const mediaStop = new AbortController();
  let preparationStarted = false;
  let prepared = false;
  let opened = false;
  let finalization: Promise<void> | undefined;

  async function prepare(): Promise<void> {
    if (preparationStarted || finalization) throw new Error('Desktop lane preparation can only start once, before finalization.');
    preparationStarted = true;
    const desktopModule = await (deps.hooks.loadDesktopModule ?? loadE2BDesktopModule)();
    // An explicit template wins. Speech gets the versioned media image; ordinary
    // browser studies retain the SDK default desktop.
    const acquired = await allocateE2BDesktopSession(desktopModule, {
      apiKey: deps.e2bApiKey,
      requestTimeoutMs: deps.requestTimeoutMs,
      timeoutMs: deps.perLaneSandboxMs,
      metadata: {
        ...CUA_ACTOR_LAB_PROVIDER_METADATA,
        labId: config.id,
        simId: spec.simId,
        laneId: spec.laneId,
        laneIndex: String(spec.laneIndex),
        laneCount: String(deps.laneCount)
      },
      // Env placement per the doctrine: the ACTOR's key never enters the sandbox (the model drives
      // from outside). The SUBJECT's declared env NAMES are provisioned here on the clone route.
      // Three sources, in precedence order: committed non-secret config (subject.envValues), then
      // secret values forwarded from the caller's environment (subject.env), then the harness's own
      // comms wiring, which must win because only it knows the catch's address.
      ...(subjectEnvNames.length > 0 || Object.keys(subjectEnvValues).length > 0 || Object.keys(commsEnv).length > 0
        ? {
          envs: {
            ...subjectEnvValues,
            ...Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])),
            ...commsEnv
          }
        }
        : {}),
      resolution: spec.resolution,
      dpi: 96,
      lifecycle: { onTimeout: "kill" }
    }, e2bDesktopTemplate(config), {
      // The default loader reclaims an acquired handle before retrying failed desktop startup.
      // Its error names the cleanup outcome; pre-construction allocation failures remain unowned.
      onRetry: (reason) => {
        const named = redactText(deps.scrubKnownValues(reason));
        warnings.push(
          `Sandbox create for lane ${spec.laneId} retried once after a transient provider error (${named}).`
        );
        onSubjectPhase({ at: new Date(deps.now()).toISOString(), type: "cua-lab.sandbox.create.retry", message: `sandbox create retried once (${named})` });
      }
    });
    desktop = acquired.desktop;
    allocation = acquired.allocation;
    sandboxId = allocation.resourceId;
    // #358 salvage: journal the id to disk before any work — an interrupted run reclaims by
    // exact recorded id (`humanish reclaim`), never by enumerating the account.
    await appendSandboxReceipt(deps.artifactRoot, { at: new Date(deps.now()).toISOString(), laneId: spec.laneId, sandboxId, timeoutMs: deps.perLaneSandboxMs });
    // The billed span starts the instant the sandbox exists.
    sandboxCreatedAtMs = deps.now();
    desktopResources = await observeDesktopResources(desktop);
    if ("reason" in desktopResources) {
      warnings.push(`Desktop resource size unavailable (${desktopResources.reason}); compute cost remains unpriced.`);
    }

    if (deps.hooks.prepareDesktop) {
      await deps.hooks.prepareDesktop(desktop, { laneId: spec.laneId, laneIndex: spec.laneIndex, laneCount: deps.laneCount });
    }

    // Start the in-sandbox email catch BEFORE the subject serve, so the app's send-API base URL (injected
    // into its env at create) resolves the moment it boots. A comms-declared lab that can't stand the
    // catch up is a setup failure (fail closed) rather than silently sending real mail.
    if (deps.receiving) {
      const surface = await deployReceivingInbox(desktop, { leaseId: spec.streamId, requestTimeoutMs: Math.min(deps.requestTimeoutMs, 30_000) });
      receivingInboxUrl = surface.url;
      const email = config.comms?.email;
      try {
        await deps.receiving.attach(spec.laneId, {
          surface,
          allowedOrigins: [...new Set([new URL(targetUrl).origin, ...(email?.allowedOrigins ?? [])])],
          originMap: buildOriginMap({
            ...(config.subject.serve?.url === undefined ? {} : { internalServeUrl: config.subject.serve.url }),
            reachableBaseUrl: targetUrl,
            ...(email?.linkOrigin === undefined ? {} : { linkOrigin: email.linkOrigin })
          })
        });
        commsArtifactPath = "comms/receiving.json";
      } catch (error) { await surface.stop().catch(() => { }); throw error; }
    }
    if (commsEmail && commsPort !== undefined) {
      deployedComms = await deployCommsCatch(desktop, {
        port: commsPort,
        ...(commsSmtpPort === undefined ? {} : { smtpPort: commsSmtpPort }),
        requestTimeoutMs: deps.requestTimeoutMs
      });
      if (!deployedComms.ready) {
        throw new Error(`comms email catch did not become ready on 127.0.0.1:${commsPort} in the subject sandbox`);
      }
      // Write the EMPTY inbox once up front so the persona's /inbox always resolves to the "No messages
      // yet." page — never a bare 404 — the instant it navigates there, even before any mail arrives OR if
      // the app sends to an address no declared recipient matches (the loop only re-renders on new mail).
      await writeInboxSurface(desktop, deployedComms.surfaceDir, [], { originMap: commsOriginMap, requestTimeoutMs: deps.requestTimeoutMs });
      const deployedRef = deployedComms;
      surfaceLoop = (async () => {
        // Render-first (so even a short session gets a populated inbox), then refresh on a cadence. The
        // cadence uses a REAL timer, NOT the injected instant clock: this loop is unbounded, so an instant
        // sleep would busy-spin and starve the session's own timers. The wait is interruptible by
        // surfaceDispose (and the timer cleared) so teardown never blocks for a full cadence. Each refresh
        // is a full, idempotent rebuild; `surfaceRenderedCount` only advances on a SUCCESSFUL render so a
        // transient failure retries cleanly (no duplicate emails).
        for (; ;) {
          try {
            const refreshed = await refreshInboxSurface({
              desktop,
              deployed: deployedRef,
              recipients: surfaceRecipients,
              sinceCount: surfaceRenderedCount,
              originMap: commsOriginMap,
              requestTimeoutMs: deps.requestTimeoutMs
            });
            if (refreshed.rendered) surfaceRenderedCount = refreshed.count;
          } catch {
            // Never throw into the render loop; the teardown drain + by-id teardown must still run.
          }
          if (surfaceDisposed) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, INBOX_SURFACE_CADENCE_MS);
            void surfaceDispose.then(() => { clearTimeout(timer); resolve(); });
          });
          if (surfaceDisposed) break;
        }
      })();
    }

    // Per-lane geometry assertion (fail-closed) — the device claim is verified in-sandbox.
    const screenGeometry = await inspectDesktopScreenGeometry({
      desktop,
      laneId: spec.laneId,
      requestedScreen: spec.resolution,
      requestTimeoutMs: deps.requestTimeoutMs
    });
    if (screenGeometry.verified) {
      desktopGeometry = {
        ...desktopGeometry,
        screen: { ...desktopGeometry.screen, verified: screenGeometry.verified }
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
        `Lane ${spec.laneId} requested a ${spec.resolution[0]}x${spec.resolution[1]} screen but xdpyinfo reports ${screenGeometry.verified.width}x${screenGeometry.verified.height}; recording requested vs verified separately instead of failing the lane closed.`
      );
      warnings.push(mismatchWarning);
      desktopGeometry = {
        ...desktopGeometry,
        warnings: [...(desktopGeometry.warnings ?? []), mismatchWarning]
      };
    }
    if (desktopCliRoute) {
      // Prepare the runtime and any declared product install, UNKEYED. With install omitted,
      // the participant discovers and installs the product from its public surfaces.
      await provisionDesktopCli(desktop, {
        product: config.subject.product?.name ?? "",
        ...(config.subject.product?.install === undefined ? {} : { install: config.subject.product.install }),
        requestTimeoutMs: deps.requestTimeoutMs,
        scrub: deps.scrubKnownValues,
        onPhase: onSubjectPhase
      });
    }
    if (cloneRoute && serve && subjectRepo) {
      subjectCommit = await provisionCloneSubject(desktop, {
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
        ...(deps.hooks.detachedTimers ?? {})
      });
    } else if (localTreeRoute && serve && deps.localTreeArchiveBuffer) {
      await provisionLocalTreeSubject(desktop, {
        archiveBuffer: deps.localTreeArchiveBuffer,
        serve,
        ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
        requestTimeoutMs: deps.requestTimeoutMs,
        scrub: deps.scrubKnownValues,
        onStateStep: (record) => {
          stateStepRecords.push(record);
        },
        onPhase: onSubjectPhase,
        ...(deps.hooks.detachedTimers ?? {})
      });
    }

    if (!desktopCliRoute) {
      const requestedFidelity = config.execution?.desktop?.fidelity;
      // A declared camera (#509) is in place before the browser starts: the feed is generated or
      // uploaded first, and a feed that cannot be produced fails the lane closed here.
      const requestedMedia = config.execution?.desktop?.media;
      if (requestedMedia?.microphone?.source === "speech") {
        speech = await startE2BDesktopMedia({ desktop, media: requestedMedia, signal: mediaStop.signal,
          onTerminal: () => mediaStop.abort(), requestTimeoutMs: deps.requestTimeoutMs });
      }
      const mediaEvidence = requestedMedia === undefined
        ? undefined
        : await prepareDesktopMedia(desktop, requestedMedia, config.policies?.mediaPermission ?? "prompt", deps.labCwd, deps.requestTimeoutMs);
      const browserLaunch = await openDesktopBrowserTarget(
        desktop,
        targetUrl,
        deps.requestTimeoutMs,
        config.execution?.desktop?.browser,
        [
          ...(requestedFidelity?.mobileEmulation && spec.devicePreset.isMobile
            ? [
              `--user-agent=${requestedFidelity.userAgent ?? DEFAULT_MOBILE_USER_AGENT}`,
              ...(requestedFidelity.touch === false ? [] : ["--touch-events=enabled"])
            ]
            : []),
          ...(mediaEvidence?.flags ?? [])
        ],
        speech?.env
      );
      desktopBrowser = mediaEvidence === undefined
        ? browserLaunch.evidence
        : { requested: config.execution?.desktop?.browser ?? "default", ...(browserLaunch.evidence ?? {}), media: mediaEvidence };
      if (mediaEvidence !== undefined && browserLaunch.family !== "chromium") {
        throw new Error(
          `execution.desktop.media needs Chrome or Chromium on lane ${spec.laneId} (the fake-device flags are Chromium's); the launched browser family is ${browserLaunch.family}. Set execution.desktop.browser: chrome.`
        );
      }
      launchedBrowserFamily = browserLaunch.family;
      browserLaunchIdentity = browserLaunch.identity;
      browserLaunched = true;
      await desktop.wait(BROWSER_SETTLE_MS).catch(() => undefined);
      // Mobile fidelity beyond viewport size (#221): applied to the launch page before the
      // geometry capture and the participant's first observation, OUTSIDE the stream/geometry
      // try below (whose catch degrades to a warning): a request that cannot be applied fails
      // the lane closed with the reason.
      // Only lanes on a mobile preset are emulated: a run-wide flag must not hand a desktop or
      // tablet lane an iPhone user agent (the first live proof did exactly that to the desktop
      // newcomer beside the phone lane). Those lanes carry no fidelity block, which is honest.
      const fidelityRequest = config.execution?.desktop?.fidelity;
      if (fidelityRequest?.mobileEmulation && spec.devicePreset.isMobile) {
        if (launchedBrowserFamily !== "chromium") {
          throw new Error(
            `execution.desktop.fidelity.mobileEmulation needs Chrome or Chromium on lane ${spec.laneId}; the launched browser family is ${launchedBrowserFamily}. Set execution.desktop.browser: chrome.`
          );
        }
        const applied = await applyMobileEmulation(
          desktop,
          deps.requestTimeoutMs,
          {
            ...(browserLaunchIdentity?.cdpPort === undefined ? {} : { cdpPort: browserLaunchIdentity.cdpPort }),
            ...(browserLaunchIdentity?.profileDir === undefined ? {} : { profileDir: browserLaunchIdentity.profileDir }),
            targetUrl
          },
          browserTargetId,
          {
            width: spec.devicePreset.width,
            height: spec.devicePreset.height,
            deviceScaleFactor: fidelityRequest.deviceScaleFactor ?? spec.devicePreset.deviceScaleFactor,
            touch: fidelityRequest.touch ?? true,
            userAgent: fidelityRequest.userAgent ?? DEFAULT_MOBILE_USER_AGENT
          }
        );
        appliedFidelity = applied.fidelity;
        emulatedTargetId = applied.targetId;
        emulationHolderName = applied.holderName;
        warnings.push(...applied.warnings);
      }
    } else {
      // A terminal window, opened the way the browser is opened on every other route: the
      // participant arrives at a desktop with the thing they were asked to use already in front
      // of them. They can still open another from the dock — that is the point of a desktop.
      await openDesktopTerminal(desktop, deps.requestTimeoutMs, config.subject.product?.workdir);
      await desktop.wait(BROWSER_SETTLE_MS).catch(() => undefined);
    }
    prepared = true;

  }

  async function openSession(): Promise<ReadyCuaDesktop> {
    if (!prepared || !desktop || !allocation || opened || finalization) throw new Error('Desktop lane must be prepared and may only be opened once, before finalization.');
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
          requestTimeoutMs: deps.requestTimeoutMs
        });
        initialBrowserGeometry = browserGeometry;
        browserWindowId = browserGeometry.browserWindowId;
        browserTargetId = browserGeometry.browserTargetId;

      }
      // The WHOLE desktop, not one window: a person studying a terminal app opens other windows,
      // and a stream bound to the first one would quietly stop being evidence.
      await startDesktopStream(desktop, browserWindowId);
      const candidateStreamUrl: unknown = desktop.stream.getUrl({
        authKey: desktop.stream.getAuthKey(),
        autoConnect: true,
        viewOnly: true,
        resize: "scale"
      });
      if (typeof candidateStreamUrl === "string" && candidateStreamUrl.trim().length > 0) {
        streamUrl = candidateStreamUrl;
        await deps.hooks.onRuntimeStreamReady?.({
          laneId: spec.laneId,
          sandboxId: desktop.sandboxId,
          simId: spec.simId,
          streamId: spec.streamId,
          url: streamUrl
        });
      } else {
        warnings.push("Live desktop stream started but did not return a usable watch URL; Observer will fall back to screenshots.");
      }
    } catch (error) {
      warnings.push(`Live desktop stream unavailable (run continues; evidence still captured): ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`);
    }

    // This is outside the stream's best-effort catch: unusable geometry is a harness failure,
    // never a participant finding about missing controls. Both per-lane and concurrent seats
    // use this route; sequential seats enforce the same capture result in shared-world-lab.
    if (initialBrowserGeometry?.unusable !== undefined) {
      failureCode = "HUMANISH_CUA_LAB_DEVICE_GEOMETRY";
      throw new Error(`${failureCode}: ${initialBrowserGeometry.unusable} Participant actions were not started.`);
    }

    const inbox = deps.receiving && receivingInboxUrl
      ? { url: receivingInboxUrl, address: deps.receiving.address(spec.laneId), receiving: true }
      : commsEmail && commsInboxUrl && deployedComms?.ready && laneHasInboxRecipient(commsEmail, spec.laneId)
        ? { url: commsInboxUrl, ...optionalAddress(inboxRecipientFor(commsEmail, spec.laneId)?.address) }
        : deps.externalComms && laneHasInboxRecipient(deps.externalComms.email, spec.laneId)
          ? { url: deps.externalComms.inboxUrl, ...optionalAddress(inboxRecipientFor(deps.externalComms.email, spec.laneId)?.address) }
          : undefined;
    const executor = createE2BDesktopExecutor(
        desktop as unknown as E2BDesktopLike,
        {
          ...(launchedBrowserFamily === "chromium"
            ? {
              observeBrowserState: makeChromeBrowserStateObserver(
                desktop,
                deps.requestTimeoutMs,
                {
                  ...(browserLaunchIdentity?.cdpPort === undefined ? {} : { cdpPort: browserLaunchIdentity.cdpPort }),
                  ...(browserLaunchIdentity?.profileDir === undefined ? {} : { profileDir: browserLaunchIdentity.profileDir }),
                  targetUrl
                },
                browserTargetId,
                // Once per lane: a dark observation channel is a gap in the instrument, and the
                // funnel's NEVER MEASURED count needs this line to explain itself (#514).
                (reason) => {
                  warnings.push(
                    `Browser-state observer unavailable for lane ${spec.laneId} (${redactText(deps.scrubKnownValues(reason))}); ` +
                    "urlIncludes/urlPathEquals/textIncludes stop conditions and task criteria are NOT being measured this session."
                  );
                },
                emulatedTargetId === undefined
                  ? undefined
                  : {
                    emulatedTargetId,
                    expectedWidth: spec.devicePreset.width,
                    expectTouch: appliedFidelity?.requested.touch === true,
                    onDrift: (reason) => {
                      warnings.push(`Mobile emulation drift on lane ${spec.laneId}: ${reason} (#623).`);
                    },
                    onCovered: (coveredTargetId, read) => {
                      // A later tab the page itself reported at the phone width: evidence that
                      // the emulation followed the participant (#623), kept on the bundle.
                      if (appliedFidelity === undefined) return;
                      appliedFidelity = {
                        ...appliedFidelity,
                        laterTargets: [...(appliedFidelity.laterTargets ?? []), { targetId: coveredTargetId, ...read }]
                      };
                    }
                  }
              )
            }
            : {})
        }
      );
    return { executor: allocation.open(speech?.wrap(executor) ?? executor).executor,
      ...(inbox === undefined ? {} : { inbox }) };

  }

  async function finish(failed: boolean): Promise<void> {
    // Stop the mid-run inbox-surface loop FIRST — before the teardown evidence drain below — so the two
    // `cat`s never overlap and the final surface state is deterministic. A surface failure can never
    // block teardown (the loop body is fully try/caught and this await is on its already-caught promise).
    surfaceDisposed = true;
    releaseSurface();
    if (surfaceLoop) await surfaceLoop.catch(() => undefined);
    if (desktop && allocation) {
      try {
        if (browserLaunched) {
          const finalGeometry: Awaited<ReturnType<typeof captureDesktopBrowserGeometry>> = await captureDesktopBrowserGeometry({
            desktop,
            browserFamily: launchedBrowserFamily,
            ...(browserLaunchIdentity === undefined ? {} : { launchIdentity: browserLaunchIdentity }),
            ...(browserWindowId === undefined ? {} : { browserWindowId }),
            ...(browserTargetId === undefined ? {} : { browserTargetId }),
            laneId: spec.laneId,
            targetUrl,
            requestedScreen: spec.resolution,
            requestTimeoutMs: deps.requestTimeoutMs,
            pagePreference: "active",
            resize: false
          }).catch((error: unknown) => ({
            warnings: [`Final browser geometry measurement failed for lane ${spec.laneId}: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`]
          }));
          // Chosen capture rule: final-if-it-measured-anything, else launch-time. A final capture
          // that measured EITHER field wins whole, so a partial final capture omits fields the
          // launch-time capture had (honest omission); only a final capture that measured NOTHING
          // falls back to the launch-time capture.
          const chosenGeometry = finalGeometry.browserWindow !== undefined || finalGeometry.viewport !== undefined
            ? finalGeometry
            : initialBrowserGeometry ?? finalGeometry;
          const geometryWarnings = [...new Set([...(initialBrowserGeometry?.warnings ?? []), ...chosenGeometry.warnings].map((warning) => deps.scrubKnownValues(warning)))];
          warnings.push(...geometryWarnings);
          // The emulation holder's own log, after its announce line: which later targets it
          // attached to, what it sent, and any reply that came back as an error (#623). Read while
          // the sandbox is alive; the first live proof had no way to say what the holder did.
          if (appliedFidelity !== undefined && emulationHolderName !== undefined) {
            const holderLog = await readDetachedLog(desktop, emulationHolderName, deps.requestTimeoutMs).catch(() => "");
            const lines = holderLog.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{")).slice(1, 51);
            if (lines.length > 0) appliedFidelity = { ...appliedFidelity, holderLog: lines.map((line) => deps.scrubKnownValues(line)) };
          }
          desktopGeometry = {
            screen: desktopGeometry.screen,
            ...(chosenGeometry.browserWindow === undefined ? {} : { browserWindow: chosenGeometry.browserWindow }),
            ...(chosenGeometry.viewport === undefined ? {} : { viewport: chosenGeometry.viewport }),
            ...(appliedFidelity === undefined ? {} : { fidelity: appliedFidelity }),
            ...((desktopGeometry.warnings?.length ?? 0) + geometryWarnings.length === 0
              ? {}
              : { warnings: [...(desktopGeometry.warnings ?? []), ...geometryWarnings] })
          };
        }
        if (deps.receiving) {
          try { await deps.receiving.finishParticipant(spec.laneId); }
          catch { warnings.push("Real email finalization is incomplete. Inspect communication cleanup with humanish comms recover."); }
        }
        // Off-app comms evidence (#297): before this lane's sandbox is torn down, drain everything the
        // in-sandbox catch captured, route it into a host fake inbox addressed to the declared
        // recipients, and write the digest-only thread artifact. Wrapped so a drain failure NEVER
        // breaks teardown — the sandbox must still be killed either way. Runs only for a ready catch.
        if (commsEmail && deployedComms?.ready) {
          try {
            const commsChannel = new FakeInbox();
            const commsInboxes: CommsAddress[] = [];
            for (const recipient of commsEmail.recipients ?? []) {
              if (recipient.address !== undefined) {
                commsInboxes.push(await commsChannel.provisionAddress(recipient.lane, recipient.address));
              }
            }
            const collected = await collectCommsThread({
              desktop,
              deployed: deployedComms,
              channel: commsChannel,
              inboxes: commsInboxes,
              requestTimeoutMs: deps.requestTimeoutMs
            });
            if (collected.artifact) {
              const path = deps.laneCount === 1 ? "comms/thread.json" : `comms/${spec.streamId}.thread.json`;
              await writeContainedOutputFile(deps.artifactRoot, path, `${JSON.stringify(collected.artifact, null, 2)}\n`, "utf8");
              commsArtifactPath = path;
            } else if (collected.captured > 0) {
              // Captured mail that matched no declared recipient must not vanish silently (invariant 6:
              // honest signals): tell the operator to declare comms.email.recipients[].address to match
              // the address the app actually sends to (e.g. the one the persona surface will sign up with).
              warnings.push(`Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`);
            } else {
              // Zero captures is the silent-broken shape (#351): the app never posted to the catch at
              // all, so the personas stared at an empty inbox. Most common cause: the app does not
              // actually read the declared injectEnv var for its email API base URL.
              const transportHint = commsEmail.smtp
                ? `Verify the app reads ${commsEmail.smtp.hostEnv}/${commsEmail.smtp.portEnv} for its SMTP host and port`
                : `Verify the app reads ${commsEmail.injectEnv} for its email API base URL (an SDK that ignores it sends real mail or throws)`;
              warnings.push(`Comms catch captured ZERO email sends — the app never delivered mail through the catch. ${transportHint} and that the flow reached an email step.`);
            }
          } catch (error) {
            warnings.push(`Comms evidence collection failed (run continues; sandbox still torn down): ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`);
          }
        }
      } catch (error) {
        warnings.push(`Desktop final evidence collection failed: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`);
      } finally {
        mediaStop.abort();
        await speech?.close().catch(() => { warnings.push("Speech worker cleanup was interrupted; desktop teardown will reclaim it."); });
        // Each route's own keep flag gates its own lane only: a clone.keep can never leak into
        // a local-tree lane's teardown decision, and vice versa.
        const keepReason = cloneRoute && config.subject.clone?.keep === true
          ? "subject.clone.keep"
          : localTreeRoute && config.subject.localTree?.keep === true
            ? "subject.localTree.keep"
            : undefined;
        const keepForDebug = keepReason !== undefined && failed;
        const released = await allocation.close({ retainForDebug: keepForDebug });
        killed = released.status === "released";
        if (released.status === "released" && released.reason === "already_gone") {
          warnings.push("Sandbox was already absent when cleanup ran; its exact termination time is unknown. Desktop cost uses the observed acquisition-to-cleanup span.");
        } else if (released.status === "retained") {
          warnings.push(`Sandbox ${allocation.resourceId} kept for debugging (${keepReason} on failure); reclaim it via E2B or it will be killed on its server-side timeout.`);
        } else if (released.status === "unconfirmed") {
          if (released.reason === "release_unavailable") {
            warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox.");
          } else if (released.reason === "release_failed") {
            warnings.push(`Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(deps.scrubKnownValues(toErrorMessage(released.error)))}`);
          } else {
            warnings.push("Sandbox teardown returned an unexpected result; release is unconfirmed and server-side kill-on-timeout remains the backstop.");
          }
        }
        // Close the observed span. A kept or unconfirmed sandbox can still accrue compute cost;
        // the summary records that remaining lifetime as unknown instead of calling this complete.
        sandboxTornDownAtMs = deps.now();
        // The lane's live stream is now a dead page whichever teardown path ran (killed, kept, or
        // kill-failed-awaiting-TTL) — tell the watch overlay so the tile falls back to recorded
        // evidence instead of "sandbox not found" (#357). Guarded: a viewer callback must never
        // break teardown.
        if (streamUrl !== undefined) {
          try {
            await deps.hooks.onRuntimeStreamEnded?.({ laneId: spec.laneId, simId: spec.simId, streamId: spec.streamId });
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
    const desktopDurationMs = sandboxCreatedAtMs !== undefined && sandboxTornDownAtMs !== undefined
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
      desktopGeometry,
      stateStepRecords,
      phaseRecords,

      ...(failureCode === undefined ? {} : { failureCode }),
      ...(commsArtifactPath === undefined ? {} : { commsArtifactPath })
    };
  }

  return { prepare, openSession, snapshot, finalize({ failed }) { return finalization ??= finish(failed); } };
}
