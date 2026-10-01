// The computer-use run's setup: resolve the project and route, plan the lanes, make the live
// checks that need no sandbox, pack a local tree, then start the run and build the lane deps and
// bundle base that the lanes and the finish share.

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { type RunScope } from "../../run/run.js";
import { externalInboxUrl } from "../../comms/sandbox-catch.js";
import { redactText, scrubLiterals, toErrorMessage } from "../../evidence/redaction.js";
import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { LabCommsEmail, LabCommsExternal, LabConfig } from "../../lab/types.js";
import { buildRunSource, type RunRerunLineage } from "../../run/bundle.js";
import {
  assertPreparedSelectedOutputDirectory,
  prepareContainedOutputDirectory,
  prepareSelectedOutputDirectory,
} from "../../run/contained-output.js";
import { type LocalTreeArchive } from "../../subject/local-tree-archive.js";
import { renderCuaReviewMarkdown } from "./bundle.js";
import {
  emitPreflightPlan,
  compileParticipantPersonas,
  loadCuaParticipants,
  sanitizeParticipantRuns,
} from "./participant-runs.js";
import { makeCuaRunBudget } from "./participant-model.js";
import { e2bRequestTimeoutMs } from "../../substrates/e2b/lifetime.js";
import { liveCuaRejection } from "./preflight.js";
import { cuaDescriptorOf, declaredAppUrl, plannedAppUrl, type ComputerUseRefusal } from "./plan.js";
import type { ComputerUsePlan } from "../../lab/plan-types.js";
import { trackRuntimeStreams, type LiveTraceFlush } from "./live-flush.js";
import { type CuaRunBundleBase } from "./bundle.js";
import { packRunLocalTree } from "./local-tree-pack.js";
import { projectParticipantSubjects, subjectProvenanceArg } from "./subject-projection.js";
import {
  CUA_ACTOR_LAB_SCHEMA,
  type CuaActorLabErrorCode,
  type CuaActorLabHooks,
  type CuaActorLabResult,
  type CuaParticipantDeps,
  type CuaParticipantPlan,
  type DesktopParticipantRun,
  type CuaSubjectProjection,
  type CuaSubjectProvenanceArg,
  type ComputerUseRunInput,
  type RunCuaActorLabOptions,
  participantSubjectEnv,
} from "./types.js";
import { labPersonaIds } from "../../lab/persona-resolve.js";
import { participantDesktopOf } from "./participant-desktop.js";

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
  // The committed personas are read before the refusal returns, so a persona-file error wins.
  if (refusal.stage === "after-personas")
    await compileParticipantPersonas(projectRoot, labPersonaIds(config));
  return {
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok: false,
    cwd: projectRoot.physicalPath,
    labId: config.id,
    actor: refusal.actor ?? config.actors[0]?.type ?? "",
    appUrl: declaredAppUrl(config),
    dryRun,
    runId: options.runId ?? "not-created",
    lanes: [],
    warnings: [],
    error: { code: refusal.code, message: refusal.message },
  };
}

export type AdmittedCuaRun = Extract<
  Awaited<ReturnType<typeof admitCuaRun>>,
  { ok: true }
>["admitted"];
type StartedRun = Extract<Awaited<ReturnType<RunScope["startRun"]>>, { ok: true }>["run"];

/** What runLabParticipants and finishCuaRun both read. */
export interface CuaRunSetup {
  plan: ComputerUsePlan;
  input: ComputerUseRunInput;
  /** Read for values the plan does not carry yet, and by the compatibility hooks, which take the
   *  whole config. Participants come from the plan. */
  config: LabConfig;
  /** The physical project root. */
  cwd: string;
  descriptor: CuaActorDescriptor;
  run: StartedRun;
  streams: ReturnType<typeof trackRuntimeStreams>;
  participantRuns: DesktopParticipantRun[];
  participantPlan: CuaParticipantPlan;
  scrubKnownValues: (text: string) => string;
  bundleBase: CuaRunBundleBase;
}

/** What only runLabParticipants reads. */
export interface CuaParticipantsSetup {
  env: Record<string, string | undefined>;
  /** The array scrubKnownValues reads at each call. Email receiving appends the values it
   *  provisions before the participants run. */
  knownSecretValues: string[];
  deps: Omit<CuaParticipantDeps, "signalProvisioned">;
  /** Filled by runLabParticipants on a live run; deps.onTrace reads it. */
  liveTrace: { flush?: LiveTraceFlush["flush"]; stop?: LiveTraceFlush["stop"] };
  /** The operator-hosted inbox on the app-url route, when declared. */
  externalComms: { config: LabCommsExternal; email: LabCommsEmail } | undefined;
  /** The subjects of the in-progress bundle, written before any participant starts. */
  inProgress: {
    subjects: CuaSubjectProjection[];
    aggregateSubject: CuaSubjectProjection;
    provenance: CuaSubjectProvenanceArg | undefined;
  };
  /** The refusal envelope, for a run that stops before its bundle. */
  fail: (code: CuaActorLabErrorCode, message: string, actorLabel?: string) => CuaActorLabResult;
}

/** What only finishCuaRun reads besides the participants' outcomes. */
export interface CuaFinishFacts {
  hooks: CuaActorLabHooks;
  rerunLineage: RunRerunLineage | undefined;
  publicRepo: string | undefined;
  subjectArgs: Omit<Parameters<typeof projectParticipantSubjects>[0], "outcomes" | "dryRun">;
}

type PreparedCuaRun =
  | { ok: false; result: CuaActorLabResult }
  | { ok: true; setup: CuaRunSetup; participants: CuaParticipantsSetup; finish: CuaFinishFacts };

/**
 * Everything before the run starts: the physical project, the route, the participant plan and
 * preflight, the key and subject-env scrubber, the live checks that need no sandbox, and the
 * local-tree archive. These read files, env and the network, which planLab does not. Returns the
 * refusal, or what startCuaRun reads.
 */
export async function admitCuaRun(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  config: LabConfig,
) {
  const { dryRun } = plan;
  const projectRoot = await bindProject(input.cwd);
  const cwd = projectRoot.physicalPath;
  const hooks = input.hooks ?? {};
  const streams = trackRuntimeStreams(hooks);
  const env = hooks.env ?? process.env;

  const { subject, desktop } = plan.runner;
  const inProcess = desktop === "in-process";
  const appUrl = plannedAppUrl(subject);
  const subjectEnvNames = [...participantSubjectEnv(subject)];

  const fail = (
    code: CuaActorLabErrorCode,
    message: string,
    actorLabel?: string,
  ): CuaActorLabResult => ({
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: plan.labId,
    actor: actorLabel ?? plan.actor,
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

  const descriptor = cuaDescriptorOf(plan.actor);
  const runSession = hooks.runSession ?? descriptor.runSession;
  // Adopter-hosted comms plane on the app-url route (#380): humanish provisions no subject here,
  // so it cannot host a catch — the OPERATOR runs one, and humanish still does every other part
  // of the funnel: tells each persona its address and inbox URL, drains the catch over HTTP after
  // the lanes, and writes the same digest-only evidence. Declaring `external` previously did
  // nothing on this route (and, per #387, on every other) while its docs said otherwise.
  const comms = plan.residual.comms;
  const externalCommsConfig =
    subject.kind !== "clone" && subject.kind !== "local-tree" && !inProcess
      ? comms?.email?.external
      : undefined;
  const externalCommsEmail = externalCommsConfig ? comms?.email : undefined;

  const participants = await loadCuaParticipants({ plan, cwd, projectRoot, env });
  if (!participants.ok) {
    return refuse(participants.code, participants.message, descriptor.id);
  }
  const { participantRuns, participantPlan, rerunLineage } = participants;
  const participantCount = participantRuns.length;

  // Pre-flight plan: BEFORE any sandbox or provider call (dry-run AND live). The hook fires for
  // every N (observable + testable); the stderr table prints for fan-out (N>1) so single-lane
  // runs stay as quiet as they always were.
  if (participantCount > 1) {
    emitPreflightPlan(participantPlan, plan.labId);
  }
  hooks.onPreflight?.(participantPlan);
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
    plan.residual.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo =
    subject.kind === "clone" ? (redactRepoLabel ? "repo-01" : subject.repo) : undefined;

  // Key-gating is route-aware: the in-process route uses the caller's OWN model + executor, and
  // the local-agent route uses a CLI the operator has already signed in to.
  if (!dryRun && !inProcess) {
    const rejection = await liveCuaRejection({
      caps: plan.caps,
      brain: plan.runner.brain,
      hooks,
      env,
      requirements: plan.requirements,
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
  if (subject.kind === "local-tree" && !dryRun) {
    try {
      const packed = await packRunLocalTree(hooks, plan.residual, cwd);
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
    admitted: {
      config,
      dryRun,
      cwd,
      hooks,
      streams,
      env,
      appUrl,
      fail,
      refuse,
      descriptor,
      runSession,
      externalCommsConfig,
      externalCommsEmail,
      participantRuns,
      participantPlan,
      rerunLineage,
      participantCount,
      openaiApiKey,
      e2bApiKey,
      knownSecretValues,
      scrubKnownValues,
      publicRepo,
      localTreeArchive,
      localTreeArchiveBuffer,
    },
  };
}

/** Starts the run and builds what the participants and the finish read: the deps and the bundle base. */
export async function startCuaRun(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  admitted: AdmittedCuaRun,
  scope: RunScope,
): Promise<PreparedCuaRun> {
  const { config, dryRun, cwd, hooks, descriptor, participantRuns, participantPlan, publicRepo } =
    admitted;
  const { appUrl } = admitted;
  // The run's status record exists from here on, so anything watching the runs directory can
  // tell which lab this is and that it is alive. The fail-closed returns below leave it finished
  // with no outcome when the scope closes; a crash leaves it stale, which reads as interrupted.
  const started = await scope.startRun({
    cwd,
    runId: input.runId,
    mintRunId: makeCuaRunId,
    mode: dryRun ? "dry-run" : "live",
    lab: plan.lab,
    renderReview: renderCuaReviewMarkdown,
    observer: { open: input.open === true, render: hooks.renderObserverFn },
  });
  if (!started.ok) return admitted.refuse(started.code, started.message, descriptor.id);
  const { run } = started;
  const { runId, createdAt, paths: runPaths } = run;
  const redactScreenshots = plan.residual.policies?.redactScreenshots === true;

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
  const deps = cuaParticipantDeps(plan, input, admitted, {
    runPaths,
    redactScreenshots,
    liveTrace,
  });

  const subjectArgs = {
    plan,
    ...(publicRepo === undefined ? {} : { publicRepo }),
    ...(admitted.localTreeArchive === undefined
      ? {}
      : { localTreeArchive: admitted.localTreeArchive }),
    runs: participantRuns,
  };
  const inProgressSubjects = projectParticipantSubjects({
    ...subjectArgs,
    outcomes: undefined,
    dryRun: false,
  });
  const inProgressAggregateSubject = inProgressSubjects[0]!;
  const inProgressProvenance = subjectProvenanceArg(inProgressAggregateSubject, publicRepo, [
    ...participantSubjectEnv(plan.runner.subject),
  ]);

  const bundleBase: CuaRunBundleBase = {
    ...(plan.lab === undefined ? {} : { lab: plan.lab }),
    participantRuns,
    descriptor,
    appUrl,
    createdAt,
    plan,
    runId,
    source,
    participantPlan,
    ...(admitted.rerunLineage === undefined ? {} : { rerun: admitted.rerunLineage }),
    redactScreenshots,
    ...(publicRepo === undefined ? {} : { publicRepo }),
  };

  const { externalCommsConfig, externalCommsEmail } = admitted;
  return {
    ok: true as const,
    setup: {
      plan,
      input,
      config,
      cwd,
      descriptor,
      run,
      streams: admitted.streams,
      participantRuns,
      participantPlan,
      scrubKnownValues: admitted.scrubKnownValues,
      bundleBase,
    },
    participants: {
      env: admitted.env,
      knownSecretValues: admitted.knownSecretValues,
      deps,
      liveTrace,
      externalComms:
        externalCommsConfig === undefined || externalCommsEmail === undefined
          ? undefined
          : { config: externalCommsConfig, email: externalCommsEmail },
      inProgress: {
        subjects: inProgressSubjects,
        aggregateSubject: inProgressAggregateSubject,
        provenance: inProgressProvenance,
      },
      fail: admitted.fail,
    },
    finish: { hooks, rerunLineage: admitted.rerunLineage, publicRepo, subjectArgs },
  };
}

/** The lane deps every lane reads: the route, keys, timeouts, scrubber, budget and hooks. */
function cuaParticipantDeps(
  plan: ComputerUsePlan,
  input: ComputerUseRunInput,
  admitted: AdmittedCuaRun,
  run: {
    runPaths: StartedRun["paths"];
    redactScreenshots: boolean;
    liveTrace: CuaParticipantsSetup["liveTrace"];
  },
): Omit<CuaParticipantDeps, "signalProvisioned"> {
  const { config, dryRun, hooks, streams, env, descriptor, runSession, participantCount } =
    admitted;
  const { localTreeArchiveBuffer } = admitted;
  const { openaiApiKey, e2bApiKey, scrubKnownValues } = admitted;
  const { externalCommsConfig, externalCommsEmail } = admitted;
  const { appUrl } = admitted;
  const { runPaths, redactScreenshots, liveTrace } = run;
  const createDesktop = participantDesktopOf(hooks);
  const timeoutMs = plan.sessionBudgetMs;
  const requestTimeoutMs = e2bRequestTimeoutMs(env);
  return {
    ...(createDesktop === undefined ? {} : { createDesktop }),
    onTrace: (participantId, items, usage, metadata) =>
      liveTrace.flush?.(participantId, items, usage, metadata),
    config,
    descriptor,
    appUrl,
    brain: plan.runner.brain,
    subject: plan.runner.subject,
    ...(localTreeArchiveBuffer === undefined ? {} : { localTreeArchiveBuffer }),
    env,
    openaiApiKey,
    e2bApiKey,
    requestTimeoutMs,
    sandboxMs: plan.sandboxMs,
    timeoutMs,
    participantCount,
    artifactRoot: runPaths,
    labCwd: input.cwd,
    redactScreenshots,
    scrubKnownValues,
    runSession,
    // The study-level ledger exists once per RUN, shared by every lane (#299). Dry runs never
    // spend, so they carry none.
    ...(dryRun || plan.caps.maxTotalUsd === undefined
      ? {}
      : { runBudget: makeCuaRunBudget(plan.caps.maxTotalUsd) }),
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
