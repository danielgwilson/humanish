// The PROVISIONED-GETHOST plane: the harness provisions ONE subject sandbox (clone or local-tree,
// install/build, seed, serve on 0.0.0.0), exposes it through getHost, probes its state on a
// cadence, and runs every seat against that one shared plane. All sandboxes are torn down by exact
// id in the plane's finally, never through Sandbox.list.

import { buildOriginMap, type OriginMap } from "../../comms/capture-surface.js";
import {
  deployCommsCatch,
  refreshInboxSurface,
  writeInboxSurface,
  type DeployedCommsCatch,
} from "../../comms/sandbox-catch.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type {
  LabCommsEmail,
  LabConfig,
  LabSubjectServe,
  LabSubjectStateCheckpoint,
} from "../../lab/types.js";
import { liveObserverResult } from "../../observer/live.js";
import type { RunSubjectStateStepRecord } from "../../run/bundle.js";
import { mapWithConcurrency } from "../../run/concurrency.js";
import type { SharedWorldStateSnapshot } from "../../run/shared-world-evidence.js";
import type { LocalTreeArchive } from "../../run/source-archive.js";
import { provisionCloneSubject } from "../../subject/clone.js";
import { provisionLocalTreeSubject } from "../../subject/local-tree.js";
import type { SubjectPhaseEvent } from "../../subject/steps.js";
import type { DetachedTimers } from "../../substrates/detached.js";
import {
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox,
} from "../../substrates/e2b/desktop-launch.js";
import { acquireE2BDesktopSandbox } from "../../substrates/e2b/sandbox.js";
import { e2bShell } from "../../substrates/e2b/shell.js";
import type { Shell } from "../../substrates/shell.js";
import {
  defaultPackLocalTree,
  inboxRecipientFor,
  laneHasInboxRecipient,
  resolveSubjectState,
} from "../computer-use/lab.js";
import { withInboxMission } from "../computer-use/lane-plan.js";
import { runCuaLane } from "../computer-use/lanes.js";
import { buildConcurrentSharedWorldBundle } from "./bundle.js";
import { runCheckpointSnapshot } from "./checkpoints.js";
import { drainSubjectComms } from "./comms.js";
import type { SharedWorldLabHooks } from "./hooks.js";
import {
  buildSubjectProvenance,
  hostOriginDigest,
  isTokenlessHost,
  servePort,
} from "./provenance.js";
import {
  DEFAULT_STATE_STEP_TIMEOUT_MS,
  SANDBOX_TIMEOUT_BUFFER_MS,
  SUBJECT_PROVISION_BUDGET_MS,
  resolveActorSeatUrl,
  seatLaneDeps,
  startSeatFlush,
} from "./seats.js";
import {
  CONCURRENT_SHARED_WORLD_PROVIDER_METADATA,
  type ActorLaneResult,
  type LiveSeats,
  type PlaneContext,
} from "./types.js";

/** What the provisioned plane needs besides the shared plane context. */
export interface ProvisionedPlaneSetup {
  serve: LabSubjectServe;
  localTreeRoute: boolean;
  localTreeArchive: LocalTreeArchive | undefined;
  localTreeArchiveBuffer: ArrayBuffer | undefined;
  subjectRepo: string;
  publicRepo: string;
  subjectEnvNames: string[];
  hasGithubToken: boolean;
  checkpoints: LabSubjectStateCheckpoint[];
  /** The in-sandbox email catch, when a comms lab declared one. */
  commsEmail: LabCommsEmail | undefined;
  commsPort: number | undefined;
  /** The catch's base URL, injected into the subject's env at create. */
  commsEnv: Record<string, string>;
  /** The executed seed steps. The plane appends; the orchestrator reads them at finish. */
  stateStepRecords: RunSubjectStateStepRecord[];
  /** The prober's state series. The plane appends; the orchestrator reads it at finish. */
  stateSnapshots: SharedWorldStateSnapshot[];
  timers: DetachedTimers;
  proberCadenceMs: number;
}

/** What the provisioned plane hands back to the orchestrator. */
export interface ProvisionedPlaneOutcome {
  actorResults: ActorLaneResult[];
  runError: string | undefined;
  subjectCommit: string | undefined;
  subjectSandboxId: string | undefined;
  subjectKilled: boolean;
  getHostUrl: string | undefined;
  /** Set when the teardown drain wrote a comms thread. */
  commsArtifactPath: string | undefined;
}

/**
 * A failure of the caller's `onObserverReady` gate on the provisioned plane. The gate runs inside
 * the try that records participant failures, so it is wrapped to be told apart and rethrown: a gate
 * failure stops the run before any participant starts, as it does on the other routes, and the
 * teardown in that try's finally still kills the subject.
 */
class ObserverGateError extends Error {
  constructor(cause: unknown) {
    super("onObserverReady failed", { cause });
    this.name = "ObserverGateError";
  }
}

/** The ONE subject sandbox and the loops that run against it until teardown. */
class SubjectPlane {
  commsInboxUrl: string | undefined;
  subjectCommit: string | undefined;
  subjectSandboxId: string | undefined;
  subjectKilled = false;
  getHostUrl: string | undefined;
  private readonly ctx: PlaneContext;
  private readonly setup: ProvisionedPlaneSetup;
  private subjectModule: E2BDesktopModule | undefined;
  private subjectDesktop: E2BDesktopSandbox | undefined;
  private subjectShell: Shell | undefined;
  // The in-sandbox email catch on the ONE subject sandbox (#297); drained at teardown. Undefined
  // unless a comms lab declared it.
  private deployedComms: DeployedCommsCatch | undefined;
  // Background prober dispose signal (FIX-9: cleared in teardown).
  private proberDisposed = false;
  private releaseDispose: () => void = () => {};
  private readonly disposeSignal: Promise<void>;
  private proberLoop: Promise<void> | undefined;
  private snapshotIndex = 0;
  // Persona inbox SURFACE (#297 slice B, shared-world): the serve->getHost origin-rewrite map
  // (REQUIRED here so the app's loopback verify links resolve to a reachable host), and the
  // dedicated surface render loop.
  private commsOriginMap: OriginMap = [];
  private surfaceRenderedCount = 0;
  private surfaceLoop: Promise<void> | undefined;

  constructor(ctx: PlaneContext, setup: ProvisionedPlaneSetup) {
    this.ctx = ctx;
    this.setup = setup;
    this.disposeSignal = new Promise<void>((resolve) => {
      this.releaseDispose = resolve;
    });
  }

  async snapshot(): Promise<void> {
    if (!this.subjectShell) return;
    const timestamp = this.ctx.now();
    const idx = this.snapshotIndex;
    this.snapshotIndex += 1;
    const snapshot = await runCheckpointSnapshot({
      shell: this.subjectShell,
      snapshotIndex: idx,
      name: `state-${idx}`,
      checkpoints: this.setup.checkpoints,
      prevDigest: undefined,
      scrub: this.ctx.scrubKnownValues,
      requestTimeoutMs: this.ctx.requestTimeoutMs,
      timers: this.setup.timers,
    });
    this.setup.stateSnapshots.push({ timestamp, digest: snapshot.digest });
  }

  async acquire(): Promise<void> {
    const { config, hooks, env, requestTimeoutMs, timeoutMs, roles } = this.ctx;
    const { subjectEnvNames, commsEnv } = this.setup;
    this.subjectModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
    // The ONE subject sandbox: headless service host (no GUI seat). The SUBJECT env is provisioned
    // HERE; the actor sandboxes get NONE of it (FIX-10). A custom desktop template (image) is
    // honored on BOTH the subject sandbox (here) and every actor sandbox (via runCuaLane, which
    // reads the same config); absent keeps the byte-stable Sandbox.create(opts) default. The
    // receipt is on disk before any work, so `humanish reclaim` can kill it by exact id.
    const subject = await acquireE2BDesktopSandbox({
      module: this.subjectModule,
      options: {
        apiKey: this.ctx.e2bApiKey,
        requestTimeoutMs,
        timeoutMs:
          timeoutMs +
          SUBJECT_PROVISION_BUDGET_MS +
          (config.subject.state?.seed ?? []).reduce(
            (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
            0,
          ) +
          SANDBOX_TIMEOUT_BUFFER_MS,
        metadata: {
          ...CONCURRENT_SHARED_WORLD_PROVIDER_METADATA,
          labId: config.id,
          topology: "shared-world",
          topologyMode: "concurrent",
          role: "subject",
          roleCount: String(roles.length),
        },
        ...(subjectEnvNames.length > 0 || Object.keys(commsEnv).length > 0
          ? {
              envs: {
                ...Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])),
                ...commsEnv,
              },
            }
          : {}),
        dpi: 96,
        lifecycle: { onTimeout: "kill" },
      },
      template: config.execution?.desktop?.template,
      receipt: { root: this.ctx.runPaths, laneId: "subject" },
    });
    this.subjectDesktop = subject.sandbox;
    this.subjectShell = e2bShell(this.subjectDesktop);
    this.subjectSandboxId = subject.allocation.resourceId;

    if (hooks.prepareDesktop) {
      await hooks.prepareDesktop(this.subjectDesktop);
    }
  }

  // Start the in-sandbox email catch BEFORE the subject serve, so the app's send-API base URL
  // (injected into its env at create) resolves the moment it boots. Fail closed if the catch can't
  // stand up rather than let a comms-declared app silently send real mail to the internet.
  async deployCatch(): Promise<void> {
    const { commsEmail, commsPort } = this.setup;
    if (commsEmail && commsPort !== undefined) {
      // A SECOND (0.0.0.0) read-only inbox listener on commsPort+1 so the persona — which lives in a
      // DIFFERENT sandbox here — can reach the inbox surface via getHost; capture stays loopback.
      this.deployedComms = await deployCommsCatch(this.subjectShell!, {
        port: commsPort,
        inboxPort: commsPort + 1,
        requestTimeoutMs: this.ctx.requestTimeoutMs,
        timers: this.setup.timers,
      });
      if (!this.deployedComms.ready) {
        throw new Error(
          `comms email catch did not become ready in the subject sandbox (loopback capture ${commsPort} / inbox ${commsPort + 1})`,
        );
      }
    }
  }

  // Provision the ONE shared plane: clone + install/build + seed + serve on 0.0.0.0 + probe
  // (clone route), or upload/extract the once-per-run packed archive + the SAME shared serve
  // pipeline (local-tree route).
  async provision(): Promise<void> {
    const { config, hooks, requestTimeoutMs, scrubKnownValues } = this.ctx;
    const { serve, timers, stateStepRecords } = this.setup;
    const subjectShell = this.subjectShell!;
    const onSubjectPhase =
      hooks.onPhase ??
      ((event: SubjectPhaseEvent) => {
        process.stderr.write(
          `humanish shared-world (concurrent): ${event.message}${event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`}\n`,
        );
      });
    if (this.setup.localTreeRoute) {
      await provisionLocalTreeSubject(subjectShell, {
        archiveBuffer: this.setup.localTreeArchiveBuffer!,
        serve,
        ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
        requestTimeoutMs,
        scrub: scrubKnownValues,
        onStateStep: (record) => {
          stateStepRecords.push(record);
        },
        onPhase: onSubjectPhase,
        ...timers,
      });
    } else {
      this.subjectCommit = await provisionCloneSubject(subjectShell, {
        repo: this.setup.subjectRepo,
        depth: config.subject.clone?.depth ?? 1,
        serve,
        ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
        hasGithubToken: this.setup.hasGithubToken,
        requestTimeoutMs,
        scrub: scrubKnownValues,
        onCommit: (commit) => {
          this.subjectCommit = commit;
        },
        onStateStep: (record) => {
          stateStepRecords.push(record);
        },
        onPhase: onSubjectPhase,
        ...timers,
      });
    }
  }

  // Expose the served port via getHost (FIX-2). Fail closed if the SDK lacks it.
  exposeHost(): void {
    const subjectDesktop = this.subjectDesktop!;
    if (typeof subjectDesktop.getHost !== "function") {
      throw new Error(
        "the installed @e2b/desktop SDK does not expose getHost(port); the concurrent shared-world route requires it to reach the subject plane",
      );
    }
    // getHost returns a BARE host (e.g. "3000-<sandboxId>.e2b.app", no scheme); e2b exposes the
    // port over https. Normalize to a full URL before the tokenless check + before persisting.
    const rawHost = subjectDesktop.getHost(servePort(this.setup.serve.url));
    const hostUrl = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
    if (!isTokenlessHost(hostUrl)) {
      throw new Error(
        "getHost returned a non-tokenless URL; refusing to persist a host URL that may carry a credential (invariant 1)",
      );
    }
    this.getHostUrl = hostUrl;
  }

  // Persona inbox SURFACE (#297 slice B, shared-world): getHost-expose the read-only inbox listener so
  // a persona in a DIFFERENT sandbox can open it; build the serve->getHost origin map (REQUIRED here —
  // the app's loopback verify links must be rewritten to a reachable host); provision the surface
  // channel; write the EMPTY inbox up front (so /inbox never 404s); and start a render loop that drains
  // + re-renders on a cadence. The loop shares the prober's dispose signal (disposed together, before
  // the teardown evidence drain), and uses a DEDICATED FakeInbox + cursor (independent of that drain).
  async startInboxSurface(): Promise<void> {
    const { commsEmail } = this.setup;
    const { requestTimeoutMs } = this.ctx;
    const deployedComms = this.deployedComms;
    if (!commsEmail || deployedComms?.inboxPort === undefined) return;
    const subjectShell = this.subjectShell!;
    // exposeHost already refused an SDK without getHost.
    const rawInboxHost = this.subjectDesktop!.getHost!(deployedComms.inboxPort);
    const inboxHostUrl = /^https?:\/\//i.test(rawInboxHost)
      ? rawInboxHost
      : `https://${rawInboxHost}`;
    if (!isTokenlessHost(inboxHostUrl)) {
      throw new Error(
        "getHost returned a non-tokenless URL for the comms inbox; refusing to advertise it (invariant 1)",
      );
    }
    this.commsInboxUrl = `${inboxHostUrl}/inbox`;
    this.commsOriginMap = buildOriginMap({
      internalServeUrl: this.setup.serve.url,
      reachableBaseUrl: this.getHostUrl!,
      ...(commsEmail.linkOrigin === undefined ? {} : { linkOrigin: commsEmail.linkOrigin }),
    });
    const surfaceRecipients = (commsEmail.recipients ?? [])
      .filter(
        (recipient): recipient is { lane: string; address: string } =>
          recipient.address !== undefined,
      )
      .map((recipient) => ({ lane: recipient.lane, address: recipient.address }));
    await writeInboxSurface(subjectShell, deployedComms.surfaceDir, [], {
      originMap: this.commsOriginMap,
      requestTimeoutMs,
    });
    const surfaceCadenceMs = 2500;
    this.surfaceLoop = (async () => {
      // Full, idempotent rebuild each tick; surfaceRenderedCount advances only on a successful render,
      // so a transient failure retries cleanly. Real timer (dispose-interruptible + cleared) — an
      // unbounded loop must not busy-spin on the injected instant clock.
      for (;;) {
        try {
          const refreshed = await refreshInboxSurface({
            shell: subjectShell,
            deployed: deployedComms,
            recipients: surfaceRecipients,
            sinceCount: this.surfaceRenderedCount,
            originMap: this.commsOriginMap,
            requestTimeoutMs,
          });
          if (refreshed.rendered) this.surfaceRenderedCount = refreshed.count;
        } catch {
          // Never throw into the render loop; the teardown drain + by-id teardown must still run.
        }
        if (this.proberDisposed) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, surfaceCadenceMs);
          void this.disposeSignal.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (this.proberDisposed) break;
      }
    })();
  }

  startProber(): void {
    const { proberCadenceMs } = this.setup;
    this.proberLoop = (async () => {
      while (!this.proberDisposed) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, proberCadenceMs);
          }),
          this.disposeSignal,
        ]);
        if (timer) clearTimeout(timer); // FIX-9: no dangling prober timer.
        if (this.proberDisposed) break;
        await this.snapshot().catch(() => undefined);
      }
    })();
  }

  /**
   * FIX-9: stop the prober, take a final snapshot while the subject is still alive, then tear
   * down the ONE subject sandbox BY id (the actor sandboxes are torn down inside runCuaLane).
   * Returns the comms thread's path when the drain wrote one.
   */
  async teardown(): Promise<string | undefined> {
    const { warnings, scrubKnownValues } = this.ctx;
    this.proberDisposed = true;
    this.releaseDispose();
    if (this.proberLoop) {
      await this.proberLoop.catch(() => undefined);
    }
    // Stop the inbox-surface render loop too (shares the prober's dispose signal), before the teardown
    // evidence drain below — so the two in-sandbox reads never overlap and the surface state is final.
    if (this.surfaceLoop) {
      await this.surfaceLoop.catch(() => undefined);
    }
    if (this.subjectDesktop && this.getHostUrl) {
      await this.snapshot().catch(() => undefined);
    }
    let commsArtifactPath: string | undefined;
    const { commsEmail } = this.setup;
    if (commsEmail && this.deployedComms?.ready && this.subjectShell) {
      commsArtifactPath = await drainSubjectComms(
        this.ctx,
        commsEmail,
        this.subjectShell,
        this.deployedComms,
      );
    }
    if (this.subjectSandboxId !== undefined && this.subjectModule) {
      if (typeof this.subjectModule.Sandbox.kill === "function") {
        try {
          await this.subjectModule.Sandbox.kill(this.subjectSandboxId, {
            requestTimeoutMs: 60_000,
          });
          this.subjectKilled = true;
        } catch (error) {
          warnings.push(
            `Subject sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
          );
        }
      } else {
        warnings.push(
          "Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the subject sandbox.",
        );
      }
    }
    return commsArtifactPath;
  }
}

/** Writes the in-progress bundle, runs the caller's Observer gate and starts the seat flush. */
async function publishInProgress(
  plane: SubjectPlane,
  ctx: PlaneContext,
  live: LiveSeats,
  setup: ProvisionedPlaneSetup,
): Promise<void> {
  const { config, options } = ctx;
  const { localTreeRoute, localTreeArchive } = setup;
  const inProgressPlaneCommit = localTreeRoute
    ? localTreeArchive?.git?.commit
    : plane.subjectCommit;
  const inProgressSubject = buildSubjectProvenance({
    localTreeRoute,
    publicRepo: setup.publicRepo,
    subjectCommit: inProgressPlaneCommit,
    localTreeArchive,
    subjectEnvNames: setup.subjectEnvNames,
    state: resolveSubjectState({
      declared: config.subject.state,
      dryRun: false,
      executed: setup.stateStepRecords,
    }),
  });
  const inProgressBundle = buildConcurrentSharedWorldBundle({
    config,
    descriptor: ctx.descriptor,
    createdAt: ctx.createdAt,
    dryRun: false,
    inProgress: true,
    runId: ctx.runId,
    source: ctx.source,
    roles: ctx.roles,
    actorSpecs: ctx.actorSpecs,
    actorResults: [],
    stateSnapshots: setup.stateSnapshots,
    subject: inProgressSubject,
    seedDigest: ctx.seedDigest,
    ...(inProgressPlaneCommit === undefined ? {} : { subjectCommit: inProgressPlaneCommit }),
    hostDigest: hostOriginDigest(plane.getHostUrl!),
  });
  await ctx.run.writeSnapshot(inProgressBundle);
  if (options.onObserverReady) {
    live.observer = liveObserverResult(ctx.cwd, ctx.runId, ctx.artifactRoot, [
      "Live concurrent shared-world Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted.",
    ]);
    try {
      await options.onObserverReady(live.observer);
    } catch (error) {
      throw new ObserverGateError(error);
    }
  }
  startSeatFlush(ctx, live, inProgressBundle);
}

// Launch N actor sandboxes CONCURRENTLY, INDEPENDENT (FIX-11: runCuaLane + mapWithConcurrency,
// NOT runCuaLanes — no pipeline gate / fail-fast). Each actor's window is measured on the ONE
// orchestrator clock (FIX-1).
function runSeats(
  plane: SubjectPlane,
  ctx: PlaneContext,
  live: LiveSeats,
  setup: ProvisionedPlaneSetup,
): Promise<ActorLaneResult[]> {
  const { roles, now } = ctx;
  const { commsEmail } = setup;
  const baseActorDeps = seatLaneDeps(ctx, live, ctx.scrubKnownValues);
  return mapWithConcurrency(ctx.actorSpecs, Math.max(1, ctx.concurrency), async (spec, i) => {
    const route = resolveActorSeatUrl(plane.getHostUrl!, roles[i]?.entry);
    // Tell this persona its (getHost-reachable) inbox URL — but only when comms is live AND this lane
    // has a declared recipient it can actually receive mail into (else it would stall on an empty
    // inbox). Only the in-sandbox catch exists on this plane; the adopter-hosted catch is the
    // external-public plane's (#387).
    const laneSpec =
      commsEmail && plane.commsInboxUrl && laneHasInboxRecipient(commsEmail, spec.laneId)
        ? withInboxMission(
            spec,
            plane.commsInboxUrl,
            inboxRecipientFor(commsEmail, spec.laneId)?.address,
          )
        : spec;
    const startedAt = now();
    const outcome = await runCuaLane(laneSpec, { ...baseActorDeps, appUrl: route });
    const endedAt = now();
    return { spec, outcome, startedAt, endedAt, route };
  });
}

export async function runProvisionedPlane(
  ctx: PlaneContext,
  live: LiveSeats,
  setup: ProvisionedPlaneSetup,
): Promise<ProvisionedPlaneOutcome> {
  const plane = new SubjectPlane(ctx, setup);
  let actorResults: ActorLaneResult[] = [];
  let runError: string | undefined;
  let commsArtifactPath: string | undefined;
  try {
    await plane.acquire();
    await plane.deployCatch();
    await plane.provision();
    plane.exposeHost();
    await plane.startInboxSurface();
    // Baseline state snapshot, then start the background cadence prober.
    await plane.snapshot();
    await publishInProgress(plane, ctx, live, setup);
    plane.startProber();
    actorResults = await runSeats(plane, ctx, live, setup);
  } catch (error) {
    if (error instanceof ObserverGateError) throw error.cause;
    runError = redactText(ctx.scrubKnownValues(toErrorMessage(error)));
    ctx.warnings.push(`Concurrent shared-world run failed before completion: ${runError}`);
  } finally {
    commsArtifactPath = await plane.teardown();
  }
  return {
    actorResults,
    runError,
    subjectCommit: plane.subjectCommit,
    subjectSandboxId: plane.subjectSandboxId,
    subjectKilled: plane.subjectKilled,
    getHostUrl: plane.getHostUrl,
    commsArtifactPath,
  };
}

/**
 * Packs the working tree once per run, on the host, for a local-tree subject. Returns the archive,
 * or the message the run fails with.
 */
export async function packSubjectTree(
  cwd: string,
  config: LabConfig,
  hooks: SharedWorldLabHooks,
  scrubKnownValues: (text: string) => string,
): Promise<
  { ok: true; archive: LocalTreeArchive; buffer: ArrayBuffer } | { ok: false; message: string }
> {
  const packLocalTree = hooks.packLocalTree ?? defaultPackLocalTree;
  try {
    const packed = await packLocalTree({
      root: cwd,
      ...(config.subject.localTree?.exclude === undefined
        ? {}
        : { extraExclude: config.subject.localTree.exclude }),
      ...(config.subject.localTree?.maxArchiveBytes === undefined
        ? {}
        : { maxArchiveBytes: config.subject.localTree.maxArchiveBytes }),
    });
    process.stderr.write(
      `humanish concurrent shared-world local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}` +
        `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`,
    );
    return { ok: true, archive: packed.archive, buffer: packed.buffer };
  } catch (error) {
    return {
      ok: false,
      message: `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
    };
  }
}
