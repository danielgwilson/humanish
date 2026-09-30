// Starts a concurrent shared-world run and prepares what its plane reads: the physical project,
// the run, the seat specs, comms, the packed tree and email receiving.

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { LabSubjectServe, LabSubjectStateCheckpoint } from "../../lab/types.js";
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
  subjectCommsOf,
  type SubjectComms,
} from "./comms.js";
import { declaredOriginDigestOf } from "./external-public.js";
import type { SharedWorldLabHooks } from "./hooks.js";
import { packSubjectTree, type ProvisionedPlaneSetup } from "./provisioned.js";
import { emptyPlaneResults } from "./result.js";
import { buildSeatSpecs, defaultSeatSessionTimeoutMs } from "./seats.js";
import type {
  ConcurrentSharedWorldLabErrorCode,
  ConcurrentSharedWorldLabResult,
  ConcurrentSharedWorldPlaneClass,
  FinishFacts,
  LiveSeats,
  PlaneContext,
  PlaneResults,
  PlaneSelection,
  RunConcurrentSharedWorldLabOptions,
} from "./types.js";
import path from "node:path";

const DEFAULT_PROBER_CADENCE_MS = 1000;

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `concurrent-shared-world-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** What validation derived from the lab, which setup reads. */
interface AdmittedLab {
  options: RunConcurrentSharedWorldLabOptions;
  requestedCwd: string;
  hooks: SharedWorldLabHooks;
  env: Record<string, string | undefined>;
  descriptor: CuaActorDescriptor;
  planeClass: ConcurrentSharedWorldPlaneClass;
  concurrency: number;
  runBudget: PlaneContext["runBudget"];
  runSession: PlaneContext["runSession"];
  serve: LabSubjectServe | undefined;
  localTreeRoute: boolean;
  subjectRepo: string;
  subjectEnvNames: string[];
  checkpoints: LabSubjectStateCheckpoint[];
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
 * after it (run storage, source and persona reads, local-tree packing, comms, the Observer) uses
 * it, so retargeting a symlinked cwd from a hook cannot redirect any of it into another project.
 */
async function startInPhysicalProject(
  options: RunConcurrentSharedWorldLabOptions,
  requestedCwd: string,
  hooks: SharedWorldLabHooks,
  scope: RunScope,
): Promise<{ cwd: string; started: Awaited<ReturnType<RunScope["startRun"]>> }> {
  const physicalCwd = await realpath(requestedCwd);
  const cwd = (await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd))
    .physicalPath;
  const started = await scope.startRun({
    cwd,
    runId: options.runId,
    mintRunId: makeRunId,
    mode: options.dryRun ? "dry-run" : "live",
    lab: options.lab,
    renderReview: renderConcurrentReviewMarkdown,
    observer: { open: options.open === true, render: hooks.renderObserverFn },
  });
  return { cwd, started };
}

/**
 * Starts the run and prepares what the planes read: the physical project, the run, the seat
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
      live: LiveSeats;
      results: PlaneResults;
      plane: PlaneSelection;
      finish: FinishFacts;
    }
> {
  const { options, requestedCwd, hooks, env, descriptor, planeClass, concurrency, fail } = lab;
  const { runBudget, runSession, localTreeRoute, subjectEnvNames, publicRepo } = lab;
  const { openaiApiKey, e2bApiKey, knownSecretValues, scrubKnownValues } = lab;
  const { config, dryRun } = options;
  const roles = config.actors[0]?.lanes ?? [];
  const { cwd, started } = await startInPhysicalProject(options, requestedCwd, hooks, scope);
  if (!started.ok) return { ok: false, result: fail(started.code, started.message, descriptor.id) };
  const { run } = started;
  const { runId, createdAt, paths: runPaths } = run;
  const artifactRoot = runPaths.absoluteRunRoot;
  const timeoutMs = config.execution?.timeoutMs ?? defaultSeatSessionTimeoutMs(config);
  const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;
  const timers: DetachedTimers = hooks.detachedTimers ?? {};
  const now = hooks.now ?? Date.now;
  const proberCadenceMs = hooks.proberCadenceMs ?? DEFAULT_PROBER_CADENCE_MS;
  const seedDigest = seedRecipeDigest(config);

  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  const warnings: string[] = [];
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  const stateSnapshots: SharedWorldStateSnapshot[] = [];
  const actorSpecs = await buildSeatSpecs(config, roles, cwd, scrubKnownValues);
  const results = emptyPlaneResults();
  const live: LiveSeats = { streamUrls: [] };

  const subjectComms = subjectCommsOf(config, planeClass);
  const externalComms = await prepareExternalComms(config, planeClass, dryRun, warnings);
  if (!externalComms.ok) {
    return {
      ok: false,
      result: fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_CATCH_UNREACHABLE",
        externalComms.message,
      ),
    };
  }

  const declaredOriginDigest =
    planeClass === "external-public" ? declaredOriginDigestOf(config) : undefined;

  // Pack the working tree ONCE per run, on the host, BEFORE the subject sandbox is created
  // (mirrors the cua route's ordering): a packing failure fails the run
  // closed here, never spending sandbox cost. Dry-run packs nothing.
  const packed =
    localTreeRoute && !dryRun
      ? await packSubjectTree(cwd, config, hooks, scrubKnownValues)
      : { ok: true as const, archive: undefined, buffer: undefined };
  if (!packed.ok) {
    return {
      ok: false,
      result: fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", packed.message, descriptor.id),
    };
  }
  const localTreeArchive = packed.archive;
  const localTreeArchiveBuffer = packed.buffer;

  const email = await prepareEmailReceiving({
    cwd,
    runId,
    config,
    env,
    participants: actorSpecs.map((spec) => spec.laneId),
    runPaths,
    knownSecretValues,
    dryRun,
  });
  if (!email.ok) {
    return {
      ok: false,
      result: fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", email.message, descriptor.id),
    };
  }
  const receiving = email.receiving;
  if (receiving) results.commsArtifactPath = "comms/receiving.json";
  const ctx: PlaneContext = {
    options,
    config,
    descriptor,
    hooks,
    env,
    roles,
    concurrency,
    runBudget,
    runSession,
    openaiApiKey,
    e2bApiKey,
    scrubKnownValues,
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
