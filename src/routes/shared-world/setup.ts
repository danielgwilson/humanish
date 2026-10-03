// Starts a concurrent shared-world run and prepares what its plane reads: the physical project,
// the run, the participant specs, comms, the packed tree and email receiving.

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { CuaActorDescriptor } from "../../actors/registry.js";
import type {
  StudyConfig,
  StudySubjectServe,
  StudySubjectStateCheckpoint,
} from "../../study/types.js";
import { buildRunSource, type RunSubjectStateStepRecord } from "../../run/bundle.js";
import type { RunScope } from "../../run/run.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";
import type { SharedWorldStateSnapshot } from "../../run/shared-world-evidence.js";
import type { DetachedTimers } from "../../substrates/detached.js";
import { renderConcurrentReviewMarkdown } from "./bundle.js";
import { seedRecipeDigest } from "./checkpoints.js";
import {
  prepareEmailReceiving,
  prepareExternalComms,
  receivingSourceOf,
  subjectCommsOf,
  type SubjectComms,
} from "./comms.js";
import { declaredOriginDigestOf } from "./external-public.js";
import { packSubjectTree, type ProvisionedPlaneSetup } from "./provisioned.js";
import { emptyPlaneResults } from "./result.js";
import { buildParticipantSpecs, defaultSessionTimeoutMs } from "./participant-specs.js";
import type {
  ConcurrentSharedWorldLabErrorCode,
  ConcurrentSharedWorldLabResult,
  ConcurrentSharedWorldPlaneClass,
  FinishFacts,
  LiveParticipants,
  PlaneContext,
  PlaneResults,
  PlaneSelection,
  SharedWorldRunInput,
} from "./types.js";
import type { StudyDeps } from "../../study/study-deps.js";
import type { SharedWorldPlan } from "../../study/plan-types.js";
import { planeStateOf } from "./plan.js";
import path from "node:path";

import { e2bRequestTimeoutMs } from "../../substrates/e2b/lifetime.js";

const DEFAULT_PROBER_CADENCE_MS = 1000;

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `concurrent-shared-world-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** What validation derived from the lab, which setup reads. */
interface AdmittedLab {
  plan: SharedWorldPlan;
  input: SharedWorldRunInput;
  /** Read for the subject's serve URL, which each participant's subject names. Participants, their
   *  count and their host and entry come from the plan's participants. */
  config: StudyConfig;
  requestedCwd: string;
  deps: StudyDeps;
  env: Record<string, string | undefined>;
  descriptor: CuaActorDescriptor;
  planeClass: ConcurrentSharedWorldPlaneClass;
  runBudget: PlaneContext["runBudget"];
  runSession: PlaneContext["runSession"];
  serve: StudySubjectServe | undefined;
  localTreeRoute: boolean;
  subjectRepo: string;
  subjectEnvNames: string[];
  checkpoints: StudySubjectStateCheckpoint[];
  openaiApiKey: string;
  e2bApiKey: string;
  knownSecretValues: string[];
  scrubKnownValues: (text: string) => string;
  publicRepo: string;
  hasGithubToken: boolean;
  fail: (
    code: ConcurrentSharedWorldLabErrorCode,
    message: string,
    actorLabel?: string,
  ) => ConcurrentSharedWorldLabResult;
}

/** The provisioned plane's setup, or undefined when the lab declares no `subject.serve`. */
function provisionedSetup(
  lab: AdmittedLab,
  prepared: Pick<
    ProvisionedPlaneSetup,
    | "localTreeArchive"
    | "localTreeArchiveBuffer"
    | "stateStepRecords"
    | "stateSnapshots"
    | "timers"
    | "proberCadenceMs"
  > & { subjectComms: SubjectComms },
): ProvisionedPlaneSetup | undefined {
  if (!lab.serve) return undefined;
  const { subjectComms, ...rest } = prepared;
  return {
    serve: lab.serve,
    localTreeRoute: lab.localTreeRoute,
    subjectRepo: lab.subjectRepo,
    publicRepo: lab.publicRepo,
    subjectEnvNames: lab.subjectEnvNames,
    hasGithubToken: lab.hasGithubToken,
    checkpoints: lab.checkpoints,
    commsEmail: subjectComms.email,
    commsPort: subjectComms.port,
    commsEnv: subjectComms.env,
    ...rest,
  };
}

/**
 * Binds the physical project before the run starts, as the computer-use route does. Everything
 * after it (local-tree packing, run storage, source and persona reads, comms, the Observer) uses
 * it, so retargeting a symlinked cwd from a hook cannot redirect any of it into another project.
 */
async function bindPhysicalProject(requestedCwd: string): Promise<string> {
  const physicalCwd = await realpath(requestedCwd);
  return (await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd))
    .physicalPath;
}

function startConcurrentRun(
  lab: AdmittedLab,
  cwd: string,
  scope: RunScope,
): ReturnType<RunScope["startRun"]> {
  const { plan, input, deps } = lab;
  return scope.startRun({
    cwd,
    runId: input.runId,
    mintRunId: makeRunId,
    mode: plan.dryRun ? "dry-run" : "live",
    lab: plan.lab,
    renderReview: renderConcurrentReviewMarkdown,
    observer: { open: input.open === true, render: deps.renderObserver },
  });
}

/**
 * Starts the run and prepares what the planes read: the physical project, the run, the participant
 * specs, comms, the packed tree and email receiving. Returns the refusal when one of them fails.
 */
export async function prepareConcurrentRun(
  lab: AdmittedLab,
  scope: RunScope,
): Promise<
  | { ok: false; result: ConcurrentSharedWorldLabResult }
  | {
      ok: true;
      ctx: PlaneContext;
      live: LiveParticipants;
      results: PlaneResults;
      plane: PlaneSelection;
      finish: FinishFacts;
    }
> {
  const { plan, input, config, requestedCwd, deps, env, descriptor, planeClass, fail } = lab;
  const { runBudget, runSession, localTreeRoute, subjectEnvNames, publicRepo } = lab;
  const { openaiApiKey, e2bApiKey, knownSecretValues, scrubKnownValues } = lab;
  const { dryRun, concurrency } = plan;
  const cwd = await bindPhysicalProject(requestedCwd);
  const warnings: string[] = [];
  // The comms catch and the packed tree are checked before the run starts, so a refusal leaves
  // no run directory. Neither spends: the probe is one request and packing runs on the host.
  const externalComms = await prepareExternalComms(
    plan.residual,
    planeClass,
    dryRun,
    warnings,
    env,
  );
  if (!externalComms.ok) {
    return { ok: false, result: fail(externalComms.code, externalComms.message) };
  }
  // Pack the working tree once per run, on the host, before any sandbox exists: a packing
  // failure fails the run closed without sandbox cost. Dry-run packs nothing.
  const packed =
    localTreeRoute && !dryRun
      ? await packSubjectTree(cwd, plan.residual, deps, scrubKnownValues)
      : { ok: true as const, archive: undefined, buffer: undefined };
  if (!packed.ok) {
    return {
      ok: false,
      result: fail("HUMANISH_SHARED_WORLD_FAILED", packed.message, descriptor.id),
    };
  }
  const localTreeArchive = packed.archive;
  const localTreeArchiveBuffer = packed.buffer;

  const started = await startConcurrentRun(lab, cwd, scope);
  if (!started.ok) return { ok: false, result: fail(started.code, started.message, descriptor.id) };
  const { run } = started;
  const { runId, createdAt, paths: runPaths } = run;
  const artifactRoot = runPaths.absoluteRunRoot;
  const timeoutMs = plan.sessionTimeoutMs ?? defaultSessionTimeoutMs(plan);
  const requestTimeoutMs = e2bRequestTimeoutMs(env);
  const redactScreenshots = plan.residual.policies?.redactScreenshots === true;
  const timers: DetachedTimers = deps.detachedTimers ?? {};
  const now = deps.now ?? Date.now;
  const proberCadenceMs = deps.proberCadenceMs ?? DEFAULT_PROBER_CADENCE_MS;
  const seedDigest = seedRecipeDigest(planeStateOf(plan));

  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  const stateSnapshots: SharedWorldStateSnapshot[] = [];
  const actorSpecs = await buildParticipantSpecs(plan.plane.participants, cwd, scrubKnownValues);
  const results = emptyPlaneResults();
  const live: LiveParticipants = { streamUrls: [] };

  const subjectComms = subjectCommsOf(plan.residual, planeClass);

  const declaredOriginDigest =
    plan.plane.kind === "external-public" ? declaredOriginDigestOf(plan.plane.appUrl) : undefined;

  const email = await prepareEmailReceiving({
    cwd,
    runId,
    source: receivingSourceOf(plan.residual, subjectEnvNames),
    env,
    participants: actorSpecs.map((spec) => spec.planned.id),
    runPaths,
    knownSecretValues,
    dryRun,
  });
  if (!email.ok) {
    // The run exists by now, so the refusal names it rather than "not-created".
    return {
      ok: false,
      result: {
        ...fail("HUMANISH_SHARED_WORLD_INVALID", email.message, descriptor.id),
        runId,
      },
    };
  }
  const receiving = email.receiving;
  if (receiving) results.commsArtifactPath = "comms/receiving.json";
  const ctx: PlaneContext = {
    plan,
    input,
    config,
    descriptor,
    deps,
    env,
    concurrency,
    runBudget,
    runSession,
    openaiApiKey,
    e2bApiKey,
    scrubKnownValues,
    knownSecretValues,
    cwd,
    run,
    runId,
    createdAt,
    runPaths,
    artifactRoot,
    timeoutMs,
    requestTimeoutMs,
    redactScreenshots,
    now,
    source,
    seedDigest,
    actorSpecs,
    receiving,
    warnings,
  };
  const provisioned = provisionedSetup(lab, {
    localTreeArchive,
    localTreeArchiveBuffer,
    subjectComms,
    stateStepRecords,
    stateSnapshots,
    timers,
    proberCadenceMs,
  });
  return {
    ok: true,
    ctx,
    live,
    results,
    plane: { planeClass, provisioned, externalWiring: externalComms.wiring },
    finish: {
      planeClass,
      localTreeRoute,
      localTreeArchive,
      publicRepo,
      subjectEnvNames,
      stateStepRecords,
      stateSnapshots,
      declaredOriginDigest,
    },
  };
}
