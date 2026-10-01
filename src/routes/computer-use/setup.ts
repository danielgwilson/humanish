// The computer-use run's setup: resolve the project and route, plan the lanes, make the live
// checks that need no sandbox, pack a local tree, then start the run and build the lane deps and
// bundle base that the lanes and the finish share.

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { type RunScope } from "../../run/run.js";
import { externalInboxUrl } from "../../comms/sandbox-catch.js";
import { type LocalAgentId } from "../../actors/local-agent/cli.js";
import { redactText, scrubLiterals, toErrorMessage } from "../../evidence/redaction.js";
import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { LabCommsEmail, LabCommsExternal, LabConfig } from "../../lab/types.js";
import { buildRunSource, type RunRerunLineage } from "../../run/bundle.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareContainedOutputDirectory,
  prepareSelectedOutputDirectory,
} from "../../run/contained-output.js";
import { type LocalTreeArchive } from "../../run/source-archive.js";
import { renderCuaReviewMarkdown } from "./bundle.js";
import {
  emitPreflightPlan,
  makeCuaRunBudget,
  compileParticipantPersonas,
  planCuaParticipants,
  sanitizeParticipantRuns,
} from "./lane-plan.js";
import { e2bRequestTimeoutMs } from "../../substrates/e2b/lifetime.js";
import { subjectProvenanceArg } from "./lanes.js";
import { liveCuaRejection } from "./preflight.js";
import { cuaDescriptorOf, cuaRoute, cuaRouteOf, type ComputerUseRefusal } from "./plan.js";
import type { ComputerUsePlan } from "../../lab/plan-types.js";
import { trackRuntimeStreams, type LiveTraceFlush } from "./live-flush.js";
import { type CuaRunBundleBase } from "./assemble.js";
import { packRunLocalTree } from "./local-tree-pack.js";
import { projectParticipantSubjects } from "./subject-projection.js";
import {
  CUA_ACTOR_LAB_SCHEMA,
  type CuaActorLabErrorCode,
  type CuaActorLabHooks,
  type CuaActorLabResult,
  type CuaLaneDeps,
  type CuaLanePlan,
  type DesktopParticipantRun,
  type CuaSubjectProjection,
  type CuaSubjectProvenanceArg,
  type ComputerUseRunInput,
  type RunCuaActorLabOptions,
} from "./types.js";
import { labPersonaIds } from "../../lab/persona-resolve.js";
import { participantDesktopOf } from "./participant-desktop.js";

/**
 * Plans the run and starts it. Returns the refusal, with the envelope the route always used, or
 * everything runLabParticipants and finishCuaRun read.
 */
export async function prepareCuaRun(
  routePlan: ComputerUsePlan,
  input: ComputerUseRunInput,
  config: LabConfig,
  scope: RunScope,
): Promise<{ ok: false; result: CuaActorLabResult } | { ok: true; setup: CuaRunSetup }> {
  const planned = await planCuaRun(routePlan, input, config);
  if (!planned.ok) return planned;
  return startCuaRun(routePlan, input, planned.planned, scope);
}

/** The physical project, bound before any caller hook runs. */
async function bindProject(cwd: string) {
  // Capture the physical project before reading or invoking any caller hook. A supported
  // symlink cwd remains valid, but retargeting that alias from a hook cannot redirect source
  // reads, local-tree packing, managed run storage, or Observer output into another project.
  const physicalCwd = await realpath(path.resolve(cwd));
  return prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
}

/**
 * The envelope of a refusal the plan left for after the cwd checks. The lane cap and in-process
 * fan-out refusals come after the committed personas are read, so a persona-file error still wins.
 */
export async function refuseCuaLab(
  options: RunCuaActorLabOptions,
  refusal: ComputerUseRefusal,
): Promise<CuaActorLabResult> {
  const { config, dryRun } = options;
  const projectRoot = await bindProject(options.cwd);
  const hooks = options.hooks ?? {};
  // The committed personas are read before the refusal returns, so a persona-file error wins.
  if (refusal.stage === "after-personas")
    await compileParticipantPersonas(projectRoot, labPersonaIds(config));
  return {
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok: false,
    cwd: projectRoot.physicalPath,
    labId: config.id,
    actor: refusal.actor ?? config.actors[0]?.type ?? "",
    appUrl: cuaRoute(config, hooks).appUrl,
    dryRun,
    runId: options.runId ?? "not-created",
    lanes: [],
    warnings: [],
    error: { code: refusal.code, message: refusal.message },
  };
}

type PlannedCuaRun = Extract<Awaited<ReturnType<typeof planCuaRun>>, { ok: true }>["planned"];
type StartedRun = Extract<Awaited<ReturnType<RunScope["startRun"]>>, { ok: true }>["run"];

/** What the setup hands to runLabParticipants and finishCuaRun. */
export interface CuaRunSetup {
  routePlan: ComputerUsePlan;
  input: ComputerUseRunInput;
  /** Read only to build participants and by the lane runner, whose hooks take the whole config. */
  config: LabConfig;
  dryRun: boolean;
  cwd: string;
  hooks: CuaActorLabHooks;
  streams: ReturnType<typeof trackRuntimeStreams>;
  env: Record<string, string | undefined>;
  appUrl: string;
  inProcessRoute: boolean;
  /** The refusal envelope, for a run that stops before its bundle. */
  fail: (code: CuaActorLabErrorCode, message: string, actorLabel?: string) => CuaActorLabResult;
  descriptor: CuaActorDescriptor;
  /** The operator-hosted inbox on the app-url route, when declared. */
  externalCommsConfig: LabCommsExternal | undefined;
  externalCommsEmail: LabCommsEmail | undefined;
  participantRuns: DesktopParticipantRun[];
  plan: CuaLanePlan;
  rerunLineage: RunRerunLineage | undefined;
  participantCount: number;
  /** Every known secret value; email setup adds its own before the lanes run. */
  knownSecretValues: string[];
  scrubKnownValues: (text: string) => string;
  publicRepo: string | undefined;
  subjectEnvNames: string[];
  run: StartedRun;
  runId: string;
  artifactRoot: string;
  physicalArtifactRoot: string;
  runPaths: StartedRun["paths"];
  deps: Omit<CuaLaneDeps, "signalProvisioned">;
  /** Filled by runLabParticipants on a live run; deps.onTrace reads it. */
  liveTrace: { flush?: LiveTraceFlush["flush"]; stop?: LiveTraceFlush["stop"] };
  subjectArgs: Omit<Parameters<typeof projectParticipantSubjects>[0], "outcomes" | "dryRun">;
  inProgressSubjects: CuaSubjectProjection[];
  inProgressAggregateSubject: CuaSubjectProjection;
  inProgressProvenance: CuaSubjectProvenanceArg | undefined;
  bundleBase: CuaRunBundleBase;
}

/**
 * Everything before the run starts: the physical project, the route, the lane plan and preflight,
 * the key and subject-env scrubber, the live checks that need no sandbox, and the local-tree
 * archive. Returns the refusal, or the plan.
 */
async function planCuaRun(
  routePlan: ComputerUsePlan,
  input: ComputerUseRunInput,
  config: LabConfig,
) {
  const { dryRun } = routePlan;
  const projectRoot = await bindProject(input.cwd);
  const cwd = projectRoot.physicalPath;
  const hooks = input.hooks ?? {};
  const streams = trackRuntimeStreams(hooks);
  const env = hooks.env ?? process.env;

  const route = cuaRouteOf(routePlan);
  const { cloneRoute, localTreeRoute, inProcessRoute, appUrl, subjectRepo, subjectEnvNames } =
    route;

  const fail = (
    code: CuaActorLabErrorCode,
    message: string,
    actorLabel?: string,
  ): CuaActorLabResult => ({
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: routePlan.labId,
    actor: actorLabel ?? routePlan.actor,
    appUrl,
    dryRun,
    runId: input.runId ?? "not-created",
    lanes: [],
    warnings: [],
    error: { code, message },
  });
  const refuse = (...args: Parameters<typeof fail>) => ({
    ok: false as const,
    result: fail(...args),
  });

  const descriptor = cuaDescriptorOf(routePlan.actor);
  const runSession = hooks.runSession ?? descriptor.runSession;
  // Adopter-hosted comms plane on the app-url route (#380): humanish provisions no subject here,
  // so it cannot host a catch — the OPERATOR runs one, and humanish still does every other part
  // of the funnel: tells each persona its address and inbox URL, drains the catch over HTTP after
  // the lanes, and writes the same digest-only evidence. Declaring `external` previously did
  // nothing on this route (and, per #387, on every other) while its docs said otherwise.
  const comms = routePlan.residual.comms;
  const externalCommsConfig =
    !cloneRoute && !localTreeRoute && !inProcessRoute ? comms?.email?.external : undefined;
  const externalCommsEmail = externalCommsConfig ? comms?.email : undefined;

  const participantPlan = await planCuaParticipants({ plan: routePlan, cwd, projectRoot, env });
  if (!participantPlan.ok) {
    return refuse(participantPlan.code, participantPlan.message, descriptor.id);
  }
  const { participantRuns, plan, rerunLineage } = participantPlan;
  const participantCount = participantRuns.length;

  // Pre-flight plan: BEFORE any sandbox or provider call (dry-run AND live). The hook fires for
  // every N (observable + testable); the stderr table prints for fan-out (N>1) so single-lane
  // runs stay as quiet as they always were.
  if (participantCount > 1) {
    emitPreflightPlan(plan, routePlan.labId);
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
  sanitizeParticipantRuns(participantRuns, scrubKnownValues);

  const redactRepoLabel =
    routePlan.residual.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo =
    cloneRoute && subjectRepo ? (redactRepoLabel ? "repo-01" : subjectRepo) : undefined;
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");

  // The operator's own signed-in coding agent is the brain, so there is no provider key to ask
  // for — the entire point of the actor. E2B is still required: the persona needs a machine.
  const localAgentRoute = descriptor.id === "local-agent";
  // Which local CLI, from its OWN field: `model` means the model, so that "Claude Code running
  // Opus" is sayable. Preflight below refuses when the chosen one is missing or signed out — that
  // news is worthless after a sandbox is paid for.
  const preferredLocalAgent: LocalAgentId = config.actors[0]?.localAgent ?? "codex";
  // Key-gating is route-aware: the in-process route uses the caller's OWN model + executor, and
  // the local-agent route uses a CLI the operator has already signed in to.
  if (!dryRun && !inProcessRoute) {
    const rejection = await liveCuaRejection({
      caps: routePlan.caps,
      model: config.actors[0]?.model,
      hooks,
      env,
      openaiApiKey,
      e2bApiKey,
      localAgentRoute,
      preferredLocalAgent,
      subjectEnvNames,
      externalCommsConfig,
    });
    if (rejection) return refuse(rejection.code, rejection.message, descriptor.id);
  }

  // Pack the working tree ONCE per run, on the host, BEFORE any sandbox or provider call: every
  // fan-out lane below uploads this SAME archive, so one archiveSha256 describes every lane's
  // digest. Dry-run packs nothing (no fs side effects; the contract bundle carries no
  // archiveSha256). A packing failure fails the run closed here, before any sandbox is
  // created and before the run directory exists.
  let localTreeArchive: LocalTreeArchive | undefined;
  let localTreeArchiveBuffer: ArrayBuffer | undefined;
  if (localTreeRoute && !dryRun) {
    try {
      const packed = await packRunLocalTree(hooks, routePlan.residual, cwd);
      localTreeArchive = packed.archive;
      localTreeArchiveBuffer = packed.buffer;
    } catch (error) {
      return refuse(
        "HUMANISH_CUA_LAB_SUBJECT_INVALID",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id,
      );
    }
  }

  return {
    ok: true as const,
    planned: {
      config,
      dryRun,
      cwd,
      hooks,
      streams,
      env,
      route,
      fail,
      refuse,
      descriptor,
      runSession,
      externalCommsConfig,
      externalCommsEmail,
      participantRuns,
      plan,
      rerunLineage,
      participantCount,
      openaiApiKey,
      e2bApiKey,
      knownSecretValues,
      scrubKnownValues,
      publicRepo,
      hasGithubToken,
      localAgentRoute,
      preferredLocalAgent,
      localTreeArchive,
      localTreeArchiveBuffer,
    },
  };
}

/** Starts the run and builds what the lanes and the finish share: the lane deps and the bundle base. */
async function startCuaRun(
  routePlan: ComputerUsePlan,
  input: ComputerUseRunInput,
  planned: PlannedCuaRun,
  scope: RunScope,
): Promise<{ ok: false; result: CuaActorLabResult } | { ok: true; setup: CuaRunSetup }> {
  const { config, dryRun, cwd, hooks, descriptor, participantRuns, plan, publicRepo } = planned;
  const { appUrl, inProcessRoute, localAppSubject, cloneRoute, localTreeRoute, subjectEnvNames } =
    planned.route;
  // The run's status record exists from here on, so anything watching the runs directory can
  // tell which lab this is and that it is alive. The fail-closed returns below leave it finished
  // with no outcome when the scope closes; a crash leaves it stale, which reads as interrupted.
  const started = await scope.startRun({
    cwd,
    runId: input.runId,
    mintRunId: makeCuaRunId,
    mode: dryRun ? "dry-run" : "live",
    lab: routePlan.lab,
    renderReview: renderCuaReviewMarkdown,
    observer: { open: input.open === true, render: hooks.renderObserverFn },
  });
  if (!started.ok) return planned.refuse(started.code, started.message, descriptor.id);
  const { run } = started;
  const { runId, createdAt, paths: runPaths } = run;
  const artifactRoot = runPaths.absoluteRunRoot;
  const physicalArtifactRoot = runPaths.physicalRunRoot;
  const redactScreenshots = routePlan.residual.policies?.redactScreenshots === true;

  await prepareContainedOutputDirectory(runPaths, "screenshots");
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  // Live-trace flush seam (#441): runLabParticipants fills it when a live run has an in-progress bundle
  // to grow; lanes call it through deps.onTrace. It exists before deps so deps can reference it as
  // a stable indirection.
  const liveTrace: { flush?: LiveTraceFlush["flush"]; stop?: LiveTraceFlush["stop"] } = {};
  const deps = cuaParticipantDeps(routePlan, input, planned, {
    runPaths,
    redactScreenshots,
    liveTrace,
  });

  const subjectArgs = {
    routePlan,
    route: planned.route,
    ...(publicRepo === undefined ? {} : { publicRepo }),
    ...(planned.localTreeArchive === undefined
      ? {}
      : { localTreeArchive: planned.localTreeArchive }),
    runs: participantRuns,
  };
  const inProgressSubjects = projectParticipantSubjects({
    ...subjectArgs,
    outcomes: undefined,
    dryRun: false,
  });
  const inProgressAggregateSubject = inProgressSubjects[0]!;
  const inProgressProvenance = subjectProvenanceArg(
    inProgressAggregateSubject,
    publicRepo,
    subjectEnvNames,
  );

  const bundleBase: CuaRunBundleBase = {
    ...(routePlan.lab === undefined ? {} : { lab: routePlan.lab }),
    laneSpecs: participantRuns,
    descriptor,
    appUrl,
    createdAt,
    routePlan,
    runId,
    source,
    plan,
    ...(planned.rerunLineage === undefined ? {} : { rerun: planned.rerunLineage }),
    redactScreenshots,
    inProcessRoute,
    localAppSubject,
    cloneRoute,
    localTreeRoute,
    ...(publicRepo === undefined ? {} : { publicRepo }),
    subjectEnvNames,
  };

  return {
    ok: true as const,
    setup: {
      routePlan,
      input,
      config,
      dryRun,
      cwd,
      hooks,
      streams: planned.streams,
      env: planned.env,
      appUrl,
      inProcessRoute,
      fail: planned.fail,
      descriptor,
      externalCommsConfig: planned.externalCommsConfig,
      externalCommsEmail: planned.externalCommsEmail,
      participantRuns,
      plan,
      rerunLineage: planned.rerunLineage,
      participantCount: planned.participantCount,
      knownSecretValues: planned.knownSecretValues,
      scrubKnownValues: planned.scrubKnownValues,
      publicRepo,
      subjectEnvNames,
      run,
      runId,
      artifactRoot,
      physicalArtifactRoot,
      runPaths,
      deps,
      liveTrace,
      subjectArgs,
      inProgressSubjects,
      inProgressAggregateSubject,
      inProgressProvenance,
      bundleBase,
    },
  };
}

/** The lane deps every lane reads: the route, keys, timeouts, scrubber, budget and hooks. */
function cuaParticipantDeps(
  routePlan: ComputerUsePlan,
  input: ComputerUseRunInput,
  planned: PlannedCuaRun,
  run: {
    runPaths: StartedRun["paths"];
    redactScreenshots: boolean;
    liveTrace: CuaRunSetup["liveTrace"];
  },
): Omit<CuaLaneDeps, "signalProvisioned"> {
  const { config, dryRun, hooks, streams, env, descriptor, runSession, participantCount } = planned;
  const { localAgentRoute, preferredLocalAgent, hasGithubToken, localTreeArchiveBuffer } = planned;
  const { openaiApiKey, e2bApiKey, scrubKnownValues } = planned;
  const { externalCommsConfig, externalCommsEmail } = planned;
  const { appUrl, cloneRoute, desktopCliRoute, localTreeRoute, serve, subjectRepo } = planned.route;
  const { subjectEnvNames } = planned.route;
  const { runPaths, redactScreenshots, liveTrace } = run;
  const createDesktop = participantDesktopOf(hooks);
  const timeoutMs = routePlan.sessionBudgetMs;
  const requestTimeoutMs = e2bRequestTimeoutMs(env);
  return {
    ...(createDesktop === undefined ? {} : { createDesktop }),
    onTrace: (participantId, items, usage, metadata) =>
      liveTrace.flush?.(participantId, items, usage, metadata),
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
    perLaneSandboxMs: routePlan.sandboxMs,
    timeoutMs,
    laneCount: participantCount,
    artifactRoot: runPaths,
    labCwd: input.cwd,
    redactScreenshots,
    scrubKnownValues,
    runSession,
    // The study-level ledger exists once per RUN, shared by every lane (#299). Dry runs never
    // spend, so they carry none.
    ...(dryRun || routePlan.caps.maxTotalUsd === undefined
      ? {}
      : { runBudget: makeCuaRunBudget(routePlan.caps.maxTotalUsd) }),
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
}

function makeCuaRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `cua-${stamp}-${randomBytes(4).toString("hex")}`;
}
