// The computer-use lab backend: a subject (an app-url the caller provisioned, or a repo the
// lab clones AND serves in-sandbox) driven by a REGISTRY-RESOLVED computer-use actor inside a
// hosted E2B desktop. This is the path that makes `actors[].type` load-bearing — the
// descriptor returned by the registry runs the session; the lab provisions the desktop and
// subject, composes the prompt from config, persists the evidence bundle, and tears down.
//
// Substrate notes:
// - The desktop is created via the shared loader in src/substrates/e2b/desktop-launch.ts with
//   kill-on-timeout lifecycle, so a dead host process can never orphan a sandbox past its
//   server-side deadline.
// - Env placement follows the doctrine (docs/principles/invariants-and-defaults.md): the
//   ACTOR's key never enters the sandbox (the model drives from outside via the provider API);
//   the SUBJECT's declared env NAMES are provisioned in on the clone route — values come from
//   the caller's environment and are never logged or persisted.
// - The live stream URL is runtime-only (carries an auth key) and is never persisted into run
//   artifacts — only its presence is recorded, mirroring the meta lab's convention.
// - Evidence redaction is mode-aware (docs/principles/invariants-and-defaults.md, the
//   capture-vs-publish rule): screenshots persist RAW (full fidelity) by default into gitignored
//   .humanish/; `policies.redactScreenshots: true` opts into blur-at-capture for a share-as-is
//   bundle. Length-only typed text and text redaction of reasoning/messages are UNCONDITIONAL;
//   harness errors are redacted at THIS boundary; the bundle's `stream.actor` carries the
//   conformant humanish.actor-trace.v1 projection, whose `redaction.screenshots` records the
//   run's actual mode ("raw" | "blurred" | "n/a") — every label downstream derives from it.

import { prepareReceivingRun } from "../../comms/receiving-runtime.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import { commandDigestOf } from "../../substrates/e2b/cua-provisioning.js";
import { withTransientCommsSecrets } from "../../run/narration-secrets.js";
import { randomBytes } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import {
  completeAutomaticAnalysis,
  markFinalizedStudyResult,
} from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { taskProtocolValidationReason } from "../../lab/validation.js";
import { toErrorMessage } from "../../substrates/command-failure.js";
import { actorRegistry, isCuaActorDescriptor } from "../../actors/registry.js";
import { applyBrowserAdapterHooks } from "../../lab/adapter-extension.js";
import { externalInboxUrl } from "../../comms/sandbox-catch.js";
import type { LabConfig, LabSubjectState } from "../../lab/types.js";
import { type LocalAgentId } from "../../actors/local-agent/cli.js";
import { renderObserver } from "../../observer/render.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { redactText, scrubLiterals } from "../../evidence/redaction.js";
import { createRunArtifactPaths } from "../../run/paths.js";
import {
  beginRunStatus,
  withRunStatusScope,
  type RunStatusHandle,
  runStatusOutcome,
} from "../../run/status.js";
import {
  buildRunSource,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareContainedOutputDirectory,
  prepareSelectedOutputDirectory,
} from "../../run/selected-output-paths.js";
import { createLocalTreeArchive, type LocalTreeArchive } from "../../run/source-archive.js";
import { observerResultForCuaArtifacts, writeCuaRunArtifacts } from "./bundle.js";
import {
  defaultSessionTimeoutMs,
  emitPreflightPlan,
  makeCuaRunBudget,
  planCuaLanes,
  readPositiveInt,
  resolvePerLaneSandboxMs,
  sanitizeLaneSpecs,
} from "./lane-plan.js";
import {
  aggregateCuaSubject,
  laneSubjectProjection,
  perLaneCapWarning,
  runAllCuaLanes,
  subjectProvenanceArg,
} from "./lanes.js";
import { cuaLabRejection, cuaRoute, liveCuaRejection, type CuaRoute } from "./preflight.js";
import { startLiveTraceFlush, trackRuntimeStreams, type LiveTraceFlush } from "./live-flush.js";
import { drainExternalComms } from "./external-comms.js";
import { buildCuaRunBundle, type CuaRunBundleBase } from "./assemble.js";
import { cuaLabResult } from "./result.js";
import {
  CUA_ACTOR_LAB_SCHEMA,
  type CuaActorLabErrorCode,
  type CuaActorLabHooks,
  type CuaActorLabResult,
  type CuaLaneDeps,
  type CuaLaneSpec,
  type CuaSubjectProjection,
  type LaneRunOutcome,
  type RunCuaActorLabOptions,
} from "./types.js";

export { inboxRecipientFor, laneHasInboxRecipient } from "./desktop-lane.js";
export {
  CUA_ACTOR_LAB_PROVIDER_METADATA,
  SUBJECT_DIR,
  buildFillDesktopWindowCommand,
  captureDesktopBrowserGeometry,
  commandDigestOf,
  declaredScreenForRender,
  makeChromeBrowserStateObserver,
  makeChromeDesktopGeometryObserver,
  parseXwininfoGeometry,
  provisionCloneSubject,
  provisionLocalTreeSubject,
  type SubjectPhaseEvent,
} from "../../substrates/e2b/cua-provisioning.js";

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runCuaActorLab(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  return withTransientCommsSecrets(() => runCuaActorLabWithSecrets(options));
}

async function runCuaActorLabWithSecrets(
  options: RunCuaActorLabOptions,
): Promise<CuaActorLabResult> {
  const analysisReason = resolveAutomaticAnalysis(options.config.review?.analysis);
  const tasksReason = analysisReason.ok
    ? taskProtocolValidationReason(options.config, true)
    : analysisReason.message;
  if (tasksReason)
    return {
      schema: CUA_ACTOR_LAB_SCHEMA,
      ok: false,
      cwd: path.resolve(options.cwd),
      labId: options.config.id,
      actor: options.config.actors[0]?.type ?? "",
      dryRun: options.dryRun,
      runId: options.runId ?? "not-created",
      appUrl: options.config.subject.appUrl ?? options.config.subject.serve?.url ?? "",
      lanes: [],
      warnings: [],
      error: {
        code: analysisReason.ok
          ? "HUMANISH_LAB_TASKS_UNSUPPORTED"
          : "HUMANISH_LAB_ANALYSIS_INVALID",
        message: tasksReason,
      },
    };
  const analysis = resolveAutomaticAnalysis(options.config.review?.analysis);
  const result = await withRunStatusScope(() => runCuaActorLabInScope(options));
  return completeAutomaticAnalysis(
    result,
    analysis.ok ? analysis.config : undefined,
    options.automaticAnalysis,
    options.config.review?.analysis === undefined ? "default" : "explicit",
    analysis.ok && analysis.preferLargerOutput === true,
  );
}

async function runCuaActorLabInScope(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  const { config, dryRun } = options;
  // Capture the physical project before reading or invoking any caller hook. A supported
  // symlink cwd remains valid, but retargeting that alias from a hook cannot redirect source
  // reads, local-tree packing, managed run storage, or Observer output into another project.
  const physicalCwd = await realpath(path.resolve(options.cwd));
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const cwd = projectRoot.physicalPath;
  const hooks = options.hooks ?? {};
  const streams = trackRuntimeStreams(hooks);
  const env = hooks.env ?? process.env;
  const render = hooks.renderObserverFn ?? renderObserver;

  const route = cuaRoute(config, hooks);
  const {
    cloneRoute,
    desktopCliRoute,
    localTreeRoute,
    localAppSubject,
    inProcessRoute,
    serve,
    appUrl,
    subjectRepo,
    subjectEnvNames,
  } = route;
  const actor = config.actors[0];
  const actorType = actor?.type ?? "";

  const fail = (
    code: CuaActorLabErrorCode,
    message: string,
    actorLabel?: string,
  ): CuaActorLabResult => ({
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: actorLabel ?? actorType,
    appUrl,
    dryRun,
    runId: options.runId ?? "not-created",
    lanes: [],
    warnings: [],
    error: { code, message },
  });

  // Resolve the actor through the registry — the parse layer validated this, but the engine fails
  // closed rather than trusting a config that arrived through another door.
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail(
      "HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered computer-use actor.`,
    );
  }
  const runSession = hooks.runSession ?? descriptor.runSession;
  const rejection = cuaLabRejection(config, hooks, route);
  if (rejection) return fail(rejection.code, rejection.message, descriptor.id);
  // Adopter-hosted comms plane on the app-url route (#380): humanish provisions no subject here,
  // so it cannot host a catch — the OPERATOR runs one, and humanish still does every other part
  // of the funnel: tells each persona its address and inbox URL, drains the catch over HTTP after
  // the lanes, and writes the same digest-only evidence. Declaring `external` previously did
  // nothing on this route (and, per #387, on every other) while its docs said otherwise.
  const externalCommsConfig =
    !cloneRoute && !localTreeRoute && !inProcessRoute ? config.comms?.email?.external : undefined;
  const externalCommsEmail = externalCommsConfig ? config.comms?.email : undefined;

  const lanePlan = await planCuaLanes({
    config,
    cwd,
    projectRoot,
    env,
    dryRun,
    inProcessRoute,
    ...(options.countOverride === undefined ? {} : { countOverride: options.countOverride }),
    ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
  });
  if (!lanePlan.ok) return fail(lanePlan.code, lanePlan.message, descriptor.id);
  const { laneSpecs, plan, rerunLineage } = lanePlan;
  const laneCount = laneSpecs.length;

  // Pre-flight plan: BEFORE any sandbox or provider call (dry-run AND live). The hook fires for
  // every N (observable + testable); the stderr table prints for fan-out (N>1) so single-lane
  // runs stay as quiet as they always were.
  if (laneCount > 1) {
    emitPreflightPlan(plan, config.id);
  }
  hooks.onPreflight?.(plan);
  await assertPreparedSelectedOutputDirectory(projectRoot);

  // Read keys once into locals (names only; values never logged or persisted).
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  // Literal scrubber for every known provisioned value (no secret "shape" to pattern-match).
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? ""),
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = scrubLiterals(knownSecretValues);
  sanitizeLaneSpecs(laneSpecs, scrubKnownValues);

  const redactRepoLabel = config.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo =
    cloneRoute && subjectRepo ? (redactRepoLabel ? "repo-01" : subjectRepo) : undefined;
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");

  // The operator's own signed-in coding agent is the brain, so there is no provider key to ask
  // for — the entire point of the actor. E2B is still required: the persona needs a machine.
  const localAgentRoute = actorType === "local-agent";
  // Which local CLI, from its OWN field: `model` means the model, so that "Claude Code running
  // Opus" is sayable. Preflight below refuses when the chosen one is missing or signed out — that
  // news is worthless after a sandbox is paid for.
  const preferredLocalAgent: LocalAgentId = config.actors[0]?.localAgent ?? "codex";
  // Key-gating is route-aware: the in-process route uses the caller's OWN model + executor, and
  // the local-agent route uses a CLI the operator has already signed in to.
  if (!dryRun && !inProcessRoute) {
    const rejection = await liveCuaRejection({
      config,
      hooks,
      env,
      openaiApiKey,
      e2bApiKey,
      localAgentRoute,
      preferredLocalAgent,
      subjectEnvNames,
      externalCommsConfig,
    });
    if (rejection) return fail(rejection.code, rejection.message, descriptor.id);
  }

  const runId = options.runId ?? makeCuaRunId();
  const created = await createRunArtifactPaths(cwd, runId);
  if (!created.ok) return fail(created.code, created.message, descriptor.id);
  const runPaths = created.paths;
  // Identity + liveness on disk from the first moment (#455): anything watching the runs
  // directory — the TUI, another terminal, an agent — can now tell which lab this is and that
  // it is alive, without waiting for the interactive observer flush that used to be the only
  // mid-run write. The success path finalizes it with the real outcome; the fail-closed returns
  // below do not, so `runLab`'s status scope finalizes those with no outcome. A crash reaches
  // neither and leaves the record stale, which reads as interrupted rather than as a lie.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab }),
  });
  const artifactRoot = runPaths.absoluteRunRoot;
  const physicalArtifactRoot = runPaths.physicalRunRoot;
  const createdAt = new Date().toISOString();
  const timeoutMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
  const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;

  await prepareContainedOutputDirectory(runPaths, "screenshots");
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  // Pack the working tree ONCE per run, on the host, BEFORE any sandbox or provider call: every
  // fan-out lane below uploads this SAME archive, so one archiveSha256 describes every lane's
  // digest. Dry-run packs nothing (no fs side effects; the contract bundle carries no
  // archiveSha256). A packing failure fails the run closed here, before createDesktopSandbox is
  // ever reached.
  let localTreeArchive: LocalTreeArchive | undefined;
  let localTreeArchiveBuffer: ArrayBuffer | undefined;
  if (localTreeRoute && !dryRun) {
    try {
      const packed = await packRunLocalTree(hooks, config, cwd);
      localTreeArchive = packed.archive;
      localTreeArchiveBuffer = packed.buffer;
    } catch (error) {
      return fail(
        "HUMANISH_CUA_LAB_SUBJECT_INVALID",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id,
      );
    }
  }

  // Live-trace flush seam (#441): assigned by the attached-Observer block below when a live
  // run has an in-progress bundle to grow; lanes call it through deps.onTrace. Declared here
  // (before deps) so deps can reference it as a stable indirection.
  let flushLiveTrace: LiveTraceFlush["flush"] | undefined;
  let stopLiveFlush: LiveTraceFlush["stop"] | undefined;

  const deps: Omit<CuaLaneDeps, "signalProvisioned"> = {
    ...(hooks.createDesktopLane ? { createDesktopLane: hooks.createDesktopLane } : {}),
    onTrace: (laneId, items, usage, metadata) => flushLiveTrace?.(laneId, items, usage, metadata),
    config,
    descriptor,
    appUrl,
    ...(localAgentRoute ? { localAgent: preferredLocalAgent } : {}),
    cloneRoute,
    desktopCliRoute,
    localTreeRoute,
    ...(serve === undefined ? {} : { serve }),
    ...(subjectRepo === undefined ? {} : { subjectRepo }),
    subjectEnvNames,
    hasGithubToken,
    ...(localTreeArchiveBuffer === undefined ? {} : { localTreeArchiveBuffer }),
    env,
    openaiApiKey,
    e2bApiKey,
    requestTimeoutMs,
    perLaneSandboxMs: resolvePerLaneSandboxMs(config),
    timeoutMs,
    laneCount,
    artifactRoot: runPaths,
    labCwd: options.cwd,
    redactScreenshots,
    scrubKnownValues,
    runSession,
    // The study-level ledger exists once per RUN, shared by every lane (#299). Dry runs never
    // spend, so they carry none.
    ...(dryRun || config.execution?.caps?.maxTotalUsd === undefined
      ? {}
      : { runBudget: makeCuaRunBudget(config.execution.caps.maxTotalUsd) }),
    ...(externalCommsConfig === undefined || externalCommsEmail === undefined
      ? {}
      : {
          externalComms: {
            email: externalCommsEmail,
            inboxUrl: externalInboxUrl(externalCommsConfig),
          },
        }),
    now: hooks.now ?? Date.now,
    hooks: streams.hooks,
  };

  const subjectArgs = {
    config,
    route,
    ...(publicRepo === undefined ? {} : { publicRepo }),
    ...(localTreeArchive === undefined ? {} : { localTreeArchive }),
    laneSpecs,
  };
  const inProgressLaneSubjects = projectLaneSubjects({
    ...subjectArgs,
    outcomes: undefined,
    dryRun: false,
  });
  const inProgressAggregateSubject = inProgressLaneSubjects[0]!;
  const inProgressProvenance = subjectProvenanceArg(
    inProgressAggregateSubject,
    publicRepo,
    subjectEnvNames,
  );

  const bundleBase: CuaRunBundleBase = {
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    laneSpecs,
    descriptor,
    appUrl,
    createdAt,
    config,
    runId,
    source,
    plan,
    ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
    redactScreenshots,
    inProcessRoute,
    localAppSubject,
    cloneRoute,
    localTreeRoute,
    ...(publicRepo === undefined ? {} : { publicRepo }),
    subjectEnvNames,
  };

  // A live run writes what it is doing AS IT DOES IT, whether or not anyone is currently watching.
  // This used to be gated on `options.onObserverReady` — the interactive Observer callback — so a
  // run launched by an agent (`lab run --json`), detached, or from the terminal surface recorded
  // nothing at all until it completed, and anything asking "what is this participant doing right
  // now" got silence for the whole run. Who reads the evidence is not the run's business; the
  // callback below stays conditional, the writing does not.
  if (!dryRun) {
    const inProgressBundle = buildCuaRunBundle(bundleBase, {
      dryRun: false,
      outcomes: undefined,
      laneSubjects: inProgressLaneSubjects,
      aggregateSubject: inProgressAggregateSubject,
      subjectProvenance: inProgressProvenance,
      inProgress: true,
    });
    await writeCuaRunArtifacts(inProgressBundle, createdAt, runPaths);
    const liveObserver = observerResultForCuaArtifacts(cwd, runId, artifactRoot, [
      "Live CUA Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted.",
    ]);
    streams.showIn(liveObserver);
    if (options.onObserverReady) await options.onObserverReady(liveObserver);

    // Incremental live flush (#441): as each lane's loop reports its recorded-so-far items,
    // rewrite the in-progress bundle with per-stream `liveActor` partials so the attached
    // Observer's 5s poll sees the timeline grow. Throttled (one write per interval, trailing
    // write guaranteed), serialized (never two writers), and CLOSED before the final artifact
    // write so a stale flush can never resurrect the in-progress bundle. A flush failure is
    // swallowed: mid-run observability must never break the run itself.
    const liveFlush = startLiveTraceFlush({
      bundle: inProgressBundle,
      laneSpecs,
      model: config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL,
      createdAt,
      runPaths,
    });
    flushLiveTrace = liveFlush.flush;
    stopLiveFlush = liveFlush.stop;
  }

  const receivingWarnings: string[] = [];
  let receiving: CommsReceivingRun | undefined;
  if (!dryRun && config.comms?.email?.kind === "real") {
    try {
      receiving = await prepareReceivingRun({
        cwd,
        runId,
        config,
        env,
        participants: laneSpecs.map((spec) => spec.laneId),
        runPaths,
        registerSecrets: (values) => {
          for (const value of values)
            if (value.length >= 4 && !knownSecretValues.includes(value))
              knownSecretValues.push(value);
        },
      });
      if (receiving) deps.receiving = receiving;
    } catch {
      await stopLiveFlush?.();
      return fail(
        "HUMANISH_CUA_LAB_SUBJECT_INVALID",
        "Real email setup failed before desktop allocation. Run humanish comms check --online and humanish comms recover to inspect authentication and pending cleanup.",
        descriptor.id,
      );
    }
  }
  // Run lanes (dry-run runs none). In-process is always one lane.
  let outcomes: LaneRunOutcome[] | undefined;
  let failFastReason: string | undefined;
  try {
    if (!dryRun)
      ({ outcomes, failFastReason } = await runAllCuaLanes(laneSpecs, deps, plan, inProcessRoute));
  } finally {
    try {
      await receiving?.finish();
    } catch {
      receivingWarnings.push(
        "Email finalization could not complete. Inspect humanish comms recover; provider cleanup remains unresolved.",
      );
    }
  }
  // Close the live flush BEFORE any final artifact work: no new flush may start, and an
  // in-flight one is awaited, so the final bundle write can never race a stale in-progress
  // rewrite (which would resurrect `liveActor` after completion).
  await stopLiveFlush?.();

  const externalCommsWarnings =
    !dryRun && externalCommsConfig && externalCommsEmail && outcomes !== undefined
      ? await drainExternalComms({
          externalCommsConfig,
          externalCommsEmail,
          env,
          runPaths,
          laneSpecs,
          outcomes,
          scrubKnownValues,
        })
      : [];

  // Per-lane subject projections (invariant 5).
  const laneSubjects = projectLaneSubjects({ ...subjectArgs, outcomes, dryRun });

  const aggregate = aggregateCuaSubject({ laneSubjects, outcomes, laneCount, dryRun });
  const aggregateSubject = aggregate.subject;
  const capWarning = perLaneCapWarning(config, laneCount);
  const aggregateWarnings = [
    ...externalCommsWarnings,
    ...(capWarning === undefined ? [] : [capWarning]),
    ...aggregate.warnings,
  ];
  const finalProvenance = subjectProvenanceArg(aggregateSubject, publicRepo, subjectEnvNames);

  const bundle = buildCuaRunBundle(bundleBase, {
    dryRun,
    outcomes,
    laneSubjects,
    aggregateSubject,
    subjectProvenance: finalProvenance,
    ...(failFastReason === undefined ? {} : { failFastReason }),
  });

  const adapterWarnings: string[] = [];
  const scorerResult = await applyBrowserAdapterHooks({
    hooks,
    bundle,
    context: {
      bundle,
      runDir: physicalArtifactRoot,
      labId: config.id,
      runId,
      actor: descriptor.id,
      backend: "cua",
      dryRun,
      laneCount,
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "cuaHooks",
    ...(options.scorerProvenance === undefined
      ? {}
      : { scorerProvenance: options.scorerProvenance }),
  });

  if (receiving) bundle.commsReceiving = receiving.snapshot();
  await writeCuaRunArtifacts(bundle, createdAt, runPaths);
  // Finalize the status record from the bundle that was just written, so the index can never
  // claim an outcome the evidence does not carry. A run that throws before reaching here leaves
  // its record `running` and goes stale — read as interrupted, which is the truth.
  await runStatus.finish(runStatusOutcome(bundle));

  const observer = await render(cwd, runId, { open: options.open === true });
  streams.attachFinal(observer);

  return markFinalizedStudyResult(
    cuaLabResult({
      config,
      cwd,
      runId,
      actorId: descriptor.id,
      appUrl,
      dryRun,
      laneSpecs,
      outcomes,
      laneSubjects,
      aggregateSubject,
      plan,
      rerunLineage,
      bundle,
      observer,
      declaredVerdictFailure: scorerResult.declaredVerdictFailure,
      receivingWarnings,
      aggregateWarnings,
      adapterWarnings,
    }),
    runPaths,
  );
}

/**
 * Pack the working tree for a local-tree run and report what left the host on stderr, by counts
 * and digest only, never paths or file names.
 */
async function packRunLocalTree(
  hooks: CuaActorLabHooks,
  config: LabConfig,
  cwd: string,
): Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }> {
  const packLocalTree = hooks.packLocalTree ?? defaultPackLocalTree;
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
    `humanish local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}` +
      `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`,
  );
  return packed;
}

/**
 * Default local-tree packing implementation: createLocalTreeArchive(root, opts) on the host,
 * then a single read of the produced archive file into an ArrayBuffer for upload. The DI seam
 * (CuaActorLabHooks.packLocalTree) overrides this in deterministic tests so they never require
 * tar/git.
 */
export async function defaultPackLocalTree(args: {
  root: string;
  extraExclude?: string[];
  maxArchiveBytes?: number;
}): Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }> {
  const archive = createLocalTreeArchive(args.root, {
    ...(args.extraExclude === undefined ? {} : { extraExclude: args.extraExclude }),
    ...(args.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: args.maxArchiveBytes }),
  });
  const bytes = await readFile(archive.archivePath);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  // The archive was written to a fresh mkdtemp dir (no outputPath passed above); once the
  // bytes are buffered the on-disk copy is pure residue, and a packed working tree left in
  // the host tmpdir is itself a small leak surface. Best-effort removal.
  await rm(path.dirname(archive.archivePath), { recursive: true, force: true }).catch(
    () => undefined,
  );
  return { archive, buffer };
}

/**
 * Each lane's subject projection. A lane's outcome adds the subject commit it resolved and the
 * state steps it executed; without outcomes (dry run, or a run still in progress) the declared
 * state is projected as not yet run.
 */
function projectLaneSubjects(args: {
  config: LabConfig;
  route: CuaRoute;
  publicRepo?: string;
  localTreeArchive?: LocalTreeArchive;
  laneSpecs: readonly CuaLaneSpec[];
  outcomes: readonly LaneRunOutcome[] | undefined;
  dryRun: boolean;
}): CuaSubjectProjection[] {
  const { config, route, publicRepo, localTreeArchive } = args;
  return args.laneSpecs.map((_spec, index) => {
    const outcome = args.outcomes?.[index];
    const subjectState = resolveSubjectState({
      declared: route.provisionedRoute ? config.subject.state : undefined,
      dryRun: args.dryRun,
      executed: outcome?.stateStepRecords ?? [],
    });
    return laneSubjectProjection({
      cloneRoute: route.cloneRoute,
      localTreeRoute: route.localTreeRoute,
      ...(publicRepo === undefined ? {} : { publicRepo }),
      subjectEnvNames: route.subjectEnvNames,
      ...(outcome?.subjectCommit === undefined ? {} : { subjectCommit: outcome.subjectCommit }),
      ...(localTreeArchive === undefined ? {} : { localTreeArchive }),
      subjectState,
    });
  });
}

/**
 * Resolve the bundle's state marker from the declaration and what actually ran.
 * Precedence: external declared → "unpinned" (seed records, if any, stay attached — a
 * migrated external DB is still unpinned overall); else seed declared → "seeded" only when
 * every declared step executed ok on a live run, otherwise "declared-not-run" (dry-run
 * contract bundles and failed live provisioning); no declaration → "undeclared".
 */
export function resolveSubjectState(args: {
  declared: LabSubjectState | undefined;
  dryRun: boolean;
  executed: RunSubjectStateStepRecord[];
}): RunSubjectProvenance["state"] {
  const declared = args.declared;
  if (!declared) {
    return { provenance: "undeclared" };
  }
  const declaredSeed = declared.seed ?? [];
  const external = declared.external ?? [];
  // Dry-run: nothing executes (no sandbox) — record the DECLARED recipe: name, phase, and
  // command digest only, with NO execution fields.
  const seed: RunSubjectStateStepRecord[] = args.dryRun
    ? declaredSeed.map((step) => ({
        name: step.name,
        when: step.when ?? "before-start",
        commandDigest: commandDigestOf(step.command),
      }))
    : args.executed;
  const allRanOk =
    !args.dryRun &&
    declaredSeed.length > 0 &&
    seed.length === declaredSeed.length &&
    seed.every((record) => record.ok === true);
  const provenance: RunSubjectProvenance["state"]["provenance"] =
    external.length > 0
      ? "unpinned"
      : declaredSeed.length === 0
        ? "undeclared"
        : allRanOk
          ? "seeded"
          : "declared-not-run";
  return {
    provenance,
    ...(seed.length > 0 ? { seed } : {}),
    ...(external.length > 0 ? { externalEnvNames: external } : {}),
  };
}

function makeCuaRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `cua-${stamp}-${randomBytes(4).toString("hex")}`;
}
