// The CONCURRENT shared-world lab backend (#164 phase 2): N persona lanes drive ONE shared,
// mutable service plane SIMULTANEOUSLY — the actual leverage of a sim. A recomposition of shipped
// pieces + the getHost wrapper:
//
//   - ONE SUBJECT sandbox: provisionCloneSubject ONCE (clone+install+build+seed) + serve on
//     0.0.0.0, exposed via getHost(port) → a tokenless reachable URL (the headless service host;
//     no GUI seat).
//   - N ACTOR desktop sandboxes: fan-out's runCuaLane machinery (per-lane device/persona, by-id
//     teardown) bounded by execution.concurrency, each browser pointed at the getHost URL —
//     driving the shared service AT THE SAME TIME. INDEPENDENT (FIX-11): no pipeline gate, no
//     fail-fast — one actor's failure must not block the swarm or corrupt the "M of N" outcomes.
//   - A background prober snapshots the subject DB checkpoint digests on a cadence → a stateSeries
//     of the shared world evolving under load.
//   - ALL N+1 sandboxes torn down BY exact id in a finally — NEVER Sandbox.list.
//
// HONEST ATTRIBUTION (verify-enforced, doctrine-audit fixes incorporated): the bundle declares
// attributionClass: shared-world + a CONCURRENT humanish.shared-world.v1 block (topologyMode
// "concurrent"; laneWindows + stateSeries + outcomes; NO timeline) whose attributionLimits drop
// `sequential-only`/`no-concurrent-races` and add `concurrent`,
// `best-effort-causal-attribution`, `non-deterministic-shared-state`,
// `window-and-snapshot-granularity`, `contention-observed-not-proven-safe`,
// `state-change-not-isolated-to-actors`. laneWindows + stateSeries are INDEPENDENT series with NO
// per-delta→actor field — causation under concurrency is structurally inexpressible.
//
// CAPABILITY vs PROOF (FIX-1): the deterministic $0 gate proves the PLUMBING + the honesty
// contract — the real mapWithConcurrency produces genuinely overlapping laneWindows (a rendezvous
// latch in the fake session forces two lane fns in-flight while the REAL orchestrator clock
// measures the windows). Every generated bundle describes only its own observations; no one run
// establishes scale, repeatability, or adopter-harness replacement.
//
// Synthetic-subject (FIX-3): a getHost URL is internet-reachable for the run, so this route is
// synthetic-seeded-subjects ONLY. Verify fail-closes on subject.state.provenance != "seeded" and
// requires the author attestation subject.exposure: synthetic. This is author-trust + a provenance
// gate, NOT a no-real-data guarantee (Humanish cannot tell synthetic from real data).

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { actorRegistry, isCuaActorDescriptor } from "../../actors/registry.js";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import { prepareReceivingRun } from "../../comms/receiving-runtime.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import { redactText, scrubLiterals, toErrorMessage } from "../../evidence/redaction.js";
import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks,
} from "../../lab/adapter-extension.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { labPersonaIds, resolveCommittedPersonasForCwd } from "../../lab/persona-resolve.js";
import { scrubPersonaBrief } from "../../lab/persona.js";
import {
  concurrentSharedWorldValidationReason,
  desktopMediaValidationReason,
  externalPublicSharedWorldValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  scenarioCapsValidationReason,
  taskProtocolValidationReason,
} from "../../lab/validation.js";
import { attachObserverRuntimeStreamUrls, type ObserverResult } from "../../observer/render.js";
import {
  buildRunSource,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import { withTransientCommsSecrets } from "../../run/narration-secrets.js";
import { MODEL_RATES } from "../../run/pricing.js";
import { runScope, type RunScope } from "../../run/run.js";
import { prepareSelectedOutputDirectory } from "../../run/selected-output-paths.js";
import type { SharedWorldStateSnapshot } from "../../run/shared-world-evidence.js";
import type { LocalTreeArchive } from "../../run/source-archive.js";
import type { DetachedTimers } from "../../substrates/detached.js";
import { defaultPackLocalTree, resolveSubjectState } from "../computer-use/lab.js";
import { makeCuaRunBudget } from "../computer-use/lane-plan.js";
import {
  actorLanePassed,
  actorWindowsOverlap,
  buildConcurrentSharedWorldBundle,
  maxSimultaneousWindows,
  renderConcurrentReviewMarkdown,
} from "./bundle.js";
import { seedRecipeDigest } from "./checkpoints.js";
import { prepareExternalComms, subjectCommsOf } from "./comms.js";
import { declaredOriginDigestOf, runExternalPublicPlane } from "./external-public.js";
import { runProvisionedPlane } from "./provisioned.js";
import { buildSubjectProvenance, hostOriginDigest } from "./provenance.js";
import { buildActorSpec, defaultSeatSessionTimeoutMs } from "./seats.js";
import {
  CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
  type ActorLaneResult,
  type ConcurrentSharedWorldLabErrorCode,
  type ConcurrentSharedWorldLabResult,
  type ConcurrentSharedWorldPlaneClass,
  type LiveSeats,
  type PlaneContext,
  type ConcurrentSharedWorldRoleResult,
  type RunConcurrentSharedWorldLabOptions,
} from "./types.js";

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

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runConcurrentSharedWorld(
  options: RunConcurrentSharedWorldLabOptions,
): Promise<ConcurrentSharedWorldLabResult> {
  return withTransientCommsSecrets(() => runConcurrentSharedWorldWithSecrets(options));
}

async function runConcurrentSharedWorldWithSecrets(
  options: RunConcurrentSharedWorldLabOptions,
): Promise<ConcurrentSharedWorldLabResult> {
  const analysis = resolveAutomaticAnalysis(options.config.review?.analysis);
  const { result, finished } = await runScope((scope) =>
    runConcurrentSharedWorldInScope(options, scope),
  );
  return completeAutomaticAnalysis(
    result,
    finished,
    analysis.ok ? analysis.config : undefined,
    options.automaticAnalysis,
    options.config.review?.analysis === undefined ? "default" : "explicit",
    analysis.ok && analysis.preferLargerOutput === true,
  );
}

async function runConcurrentSharedWorldInScope(
  options: RunConcurrentSharedWorldLabOptions,
  scope: RunScope,
): Promise<ConcurrentSharedWorldLabResult> {
  const { config, dryRun } = options;
  const requestedCwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const actorType = config.actors[0]?.type ?? "";
  const roles = config.actors[0]?.lanes ?? [];
  // All-parallel default (#350): the parser fills concurrency for multi-seat labs, so this
  // fallback serves only library callers constructing configs directly — same meaning: every
  // declared seat runs at once unless the author declared a cap.
  const concurrency = config.execution?.concurrency ?? Math.max(1, roles.length);

  const fail = (
    code: ConcurrentSharedWorldLabErrorCode,
    message: string,
    actorLabel?: string,
  ): ConcurrentSharedWorldLabResult => ({
    schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
    ok: false,
    cwd: requestedCwd,
    labId: config.id,
    actor: actorLabel ?? actorType,
    topology: "shared-world",
    topologyMode: "concurrent",
    roleCount: roles.length,
    concurrency,
    dryRun,
    runId: options.runId ?? "not-created",
    roles: [],
    warnings: [],
    error: { code, message },
  });

  const mediaReason = desktopMediaValidationReason(config, false);
  if (mediaReason) return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", mediaReason);

  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  if (!analysis.ok) return fail("HUMANISH_LAB_ANALYSIS_INVALID", analysis.message);
  const tasksReason = taskProtocolValidationReason(config, false);
  if (tasksReason) return fail("HUMANISH_LAB_TASKS_UNSUPPORTED", tasksReason);

  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail(
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered computer-use actor.`,
    );
  }

  // The PLANE-class discriminator (#164 phase 2): an app-url subject is the EXTERNAL-PUBLIC plane (a
  // real operator-owned public deployment used directly as the shared plane — NO getHost, clone,
  // subject sandbox, or seed); everything else is the historical provisioned-getHost plane.
  const planeClass: ConcurrentSharedWorldPlaneClass =
    config.subject.source === "app-url" ? "external-public" : "provisioned-getHost";

  // Re-enforce the cross-validation (library API surface). The external-public branch NEVER touches
  // the getHost synthetic gate — that gate exists because getHost is internet-reachable AND
  // harness-owned; a public site the harness neither provisioned nor exposed has neither property.
  const invalidReason =
    outputTokenLimitValidationReason(config) ??
    scenarioCapsValidationReason(config) ??
    (planeClass === "external-public"
      ? externalPublicSharedWorldValidationReason(config)
      : concurrentSharedWorldValidationReason(config));
  if (invalidReason) {
    return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", invalidReason, descriptor.id);
  }
  if (config.actors[0]?.maxOutputTokens !== undefined && hooks.runSession) {
    return fail(
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID",
      "maxOutputTokens cannot be enforced by a custom runSession.",
      descriptor.id,
    );
  }

  const caps = config.execution?.caps;
  if (!dryRun && (caps?.maxUsd !== undefined || caps?.maxTotalUsd !== undefined)) {
    const model = (config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL).trim().toLowerCase();
    if (!MODEL_RATES[model]) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID",
        `The declared spend cap cannot be enforced for unpriced model "${model}".`,
        descriptor.id,
      );
    }
  }
  const runBudget =
    !dryRun && caps?.maxTotalUsd !== undefined ? makeCuaRunBudget(caps.maxTotalUsd) : undefined;

  // provisioned-getHost fields (all absent on the external-public plane — forbidden at validation).
  const serve = config.subject.serve;
  const localTreeRoute = config.subject.source === "local-tree";
  const subjectRepo = config.subject.repos?.[0] ?? "";
  const subjectEnvNames = config.subject.env ?? [];
  const checkpoints = config.subject.state?.checkpoint ?? [];
  const runSession = hooks.runSession ?? descriptor.runSession;

  const receivingReason = receivingEmailValidationReason(config);
  if (receivingReason)
    return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", receivingReason, descriptor.id);
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? ""),
    ...checkpoints.flatMap((probe) => probe.redact ?? []),
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = scrubLiterals(knownSecretValues);

  const redactRepoLabel = config.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo = redactRepoLabel ? "repo-01" : subjectRepo;
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");

  if (!dryRun) {
    const missingKeys = [
      ...(openaiApiKey ? [] : ["OPENAI_API_KEY"]),
      ...(e2bApiKey ? [] : ["E2B_API_KEY"]),
    ];
    if (missingKeys.length > 0) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING",
        `Live concurrent shared-world labs need ${missingKeys.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missingKeys, env)}`,
        descriptor.id,
      );
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING",
        `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
        descriptor.id,
      );
    }
  }

  // Bind the physical project before the run starts, as the computer-use route does. Everything
  // below (run storage, source and persona reads, local-tree packing, comms, the Observer) uses it,
  // so retargeting a symlinked cwd from a hook cannot redirect any of it into another project.
  const physicalCwd = await realpath(requestedCwd);
  const cwd = (await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd))
    .physicalPath;
  const started = await scope.startRun({
    cwd,
    runId: options.runId,
    mintRunId: makeRunId,
    mode: dryRun ? "dry-run" : "live",
    lab: options.lab,
    renderReview: renderConcurrentReviewMarkdown,
    observer: { open: options.open === true, render: hooks.renderObserverFn },
  });
  if (!started.ok) return fail(started.code, started.message, descriptor.id);
  const { run } = started;
  const { runId, createdAt, paths: runPaths } = run;
  const artifactRoot = runPaths.absoluteRunRoot;
  const physicalArtifactRoot = runPaths.physicalRunRoot;
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
  // Compile committed personas so each seat's prompt carries real behavioral directives (#381).
  const personaResolution = await resolveCommittedPersonasForCwd(cwd, labPersonaIds(config));
  const actorSpecs = roles.map((role, i) =>
    buildActorSpec(config, role, i, personaResolution.personas),
  );
  for (const spec of actorSpecs) {
    if (spec.assignment) spec.assignment = participantAssignment(spec.assignment, scrubKnownValues);
    spec.evidenceInstructions = redactText(scrubKnownValues(spec.instructions));
    spec.persona = scrubPersonaBrief(spec.persona, scrubKnownValues);
  }
  let actorResults: ActorLaneResult[] = [];
  let subjectCommit: string | undefined;
  let subjectSandboxId: string | undefined;
  let subjectKilled = false;
  let getHostUrl: string | undefined;
  let runError: string | undefined;
  const live: LiveSeats = { streamUrls: [] };

  const subjectComms = subjectCommsOf(config, planeClass);
  let commsArtifactPath: string | undefined;
  const externalComms = await prepareExternalComms(config, planeClass, dryRun, warnings);
  if (!externalComms.ok) {
    return fail(
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_CATCH_UNREACHABLE",
      externalComms.message,
    );
  }

  // External-public plane results, set by runExternalPublicPlane.
  const declaredOriginDigest =
    planeClass === "external-public" ? declaredOriginDigestOf(config) : undefined;
  // The OBSERVED convergence origin — computed AFTER fan-out from what the seats ACTUALLY reached (the
  // convergence proof is what the seats OBSERVED, not what was declared). Set iff every observing seat
  // agrees on ONE origin; that agreement IS the convergence proof and becomes plane.publicOriginDigest.
  let publicOriginDigest: string | undefined;
  let lobbyConvergenceDigest: string | undefined;
  let handoffTimedOut = false;
  let hostHandoffFailure: string | undefined;

  // Pack the working tree ONCE per run, on the host, BEFORE the subject sandbox is created
  // (mirrors the cua route's ordering): a packing failure fails the run
  // closed here, never spending sandbox cost. Dry-run packs nothing.
  let localTreeArchive: LocalTreeArchive | undefined;
  let localTreeArchiveBuffer: ArrayBuffer | undefined;
  if (localTreeRoute && !dryRun) {
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
      localTreeArchive = packed.archive;
      localTreeArchiveBuffer = packed.buffer;
      process.stderr.write(
        `humanish concurrent shared-world local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}` +
          `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`,
      );
    } catch (error) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id,
      );
    }
  }

  let receiving: CommsReceivingRun | undefined;
  if (!dryRun && config.comms?.email?.kind === "real") {
    try {
      receiving = await prepareReceivingRun({
        cwd,
        runId,
        config,
        env,
        participants: actorSpecs.map((spec) => spec.laneId),
        runPaths,
        registerSecrets: (values) => {
          for (const value of values)
            if (value.length >= 4 && !knownSecretValues.includes(value))
              knownSecretValues.push(value);
        },
      });
      commsArtifactPath = "comms/receiving.json";
    } catch {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID",
        "Real email setup failed before desktop allocation. Run humanish comms check --online and humanish comms recover to inspect authentication and pending cleanup.",
        descriptor.id,
      );
    }
  }
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
  try {
    if (!dryRun && planeClass === "provisioned-getHost") {
      if (!serve) {
        // Defense-in-depth: concurrentSharedWorldValidationReason already required serve above.
        return fail(
          "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID",
          "the provisioned-getHost concurrent shared-world route requires `subject.serve`.",
          descriptor.id,
        );
      }
      const outcome = await runProvisionedPlane(ctx, live, {
        serve,
        localTreeRoute,
        localTreeArchive,
        localTreeArchiveBuffer,
        subjectRepo,
        publicRepo,
        subjectEnvNames,
        hasGithubToken,
        checkpoints,
        commsEmail: subjectComms.email,
        commsPort: subjectComms.port,
        commsEnv: subjectComms.env,
        stateStepRecords,
        stateSnapshots,
        timers,
        proberCadenceMs,
      });
      actorResults = outcome.actorResults;
      runError = outcome.runError;
      subjectCommit = outcome.subjectCommit;
      subjectSandboxId = outcome.subjectSandboxId;
      subjectKilled = outcome.subjectKilled;
      getHostUrl = outcome.getHostUrl;
      if (outcome.commsArtifactPath !== undefined) commsArtifactPath = outcome.commsArtifactPath;
    }

    if (!dryRun && planeClass === "external-public") {
      const outcome = await runExternalPublicPlane(ctx, live, externalComms.wiring);
      actorResults = outcome.actorResults;
      runError = outcome.runError;
      publicOriginDigest = outcome.publicOriginDigest;
      lobbyConvergenceDigest = outcome.lobbyConvergenceDigest;
      handoffTimedOut = outcome.handoffTimedOut;
      hostHandoffFailure = outcome.hostHandoffFailure;
      if (outcome.commsArtifactPath !== undefined) commsArtifactPath = outcome.commsArtifactPath;
    }
  } finally {
    try {
      await receiving?.finish();
    } catch {
      warnings.push(
        "Email finalization could not complete. Inspect humanish comms recover; provider cleanup remains unresolved.",
      );
    }
    // Stop the seats' flush timer on every exit, before the final write.
    await live.flush?.stop();
  }

  // Subject provenance: external-public is the operator-declared, operator-owned public deployment
  // (neither provisioned nor seeded); the provisioned path builds clone/local-tree provenance.
  const subject: RunSubjectProvenance =
    planeClass === "external-public"
      ? { source: "app-url", envNames: [], state: { provenance: "external-public" } }
      : buildSubjectProvenance({
          localTreeRoute,
          publicRepo,
          subjectCommit: localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit,
          localTreeArchive,
          subjectEnvNames,
          state: resolveSubjectState({
            declared: config.subject.state,
            dryRun,
            executed: stateStepRecords,
          }),
        });
  const planeCommit = localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit;

  // Collect per-actor warnings (each lane's own teardown/raw-screenshot notes).
  for (const result of actorResults) {
    warnings.push(...result.outcome.warnings);
  }

  const bundle = buildConcurrentSharedWorldBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    config,
    descriptor,
    createdAt,
    dryRun,
    runId,
    source,
    roles,
    actorSpecs,
    actorResults,
    stateSnapshots,
    subject,
    seedDigest,
    planeClass,
    ...(planeCommit === undefined ? {} : { subjectCommit: planeCommit }),
    ...(getHostUrl === undefined ? {} : { hostDigest: hostOriginDigest(getHostUrl) }),
    ...(publicOriginDigest === undefined ? {} : { publicOriginDigest }),
    ...(declaredOriginDigest === undefined ? {} : { declaredOriginDigest }),
    ...(lobbyConvergenceDigest === undefined ? {} : { lobbyConvergenceDigest }),
    ...(commsArtifactPath === undefined ? {} : { commsArtifactPath }),
    ...(runError === undefined ? {} : { runError }),
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
      backend: "concurrent-shared-world",
      dryRun,
      laneCount: roles.length,
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "sharedWorldHooks",
    ...(options.scorerProvenance === undefined
      ? {}
      : { scorerProvenance: options.scorerProvenance }),
  });

  if (receiving) bundle.commsReceiving = receiving.snapshot();
  const finished = await run.finish(bundle);
  const observer = await finished.renderObserver();
  if (observer.ok && live.observer) {
    attachObserverRuntimeStreamUrls(observer as ObserverResult & { ok: true }, live.streamUrls);
  }

  const roleOk = (result: ActorLaneResult | undefined): boolean => {
    if (dryRun) return true;
    return actorLanePassed(result);
  };
  // Concurrent "ok": every actor must produce a terminal, engaged PASSED session. This is a
  // harness/session-credibility gate, not mission-completion proof; a failed actor trace cannot
  // make the route green just because the harness got a terminal.
  const swarmRan =
    !dryRun && actorResults.length === roles.length && actorResults.every(actorLanePassed);
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok =
    observer.ok &&
    runError === undefined &&
    (dryRun || swarmRan) &&
    adapterFailure === undefined &&
    scorerResult.declaredVerdictFailure === undefined;

  const overlapProven = !dryRun && actorWindowsOverlap(actorResults);

  const roleResults: ConcurrentSharedWorldRoleResult[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const base = { id: spec.laneId, index: index + 1, persona: spec.persona.id };
    if (dryRun || !result) {
      return { ...base, status: "contract_proof_only", ok: dryRun };
    }
    const session = result.outcome.session;
    const thisOk = roleOk(result);
    return {
      ...base,
      status: session ? session.status : "failed",
      ok: thisOk,
      window: { startedAt: result.startedAt, endedAt: result.endedAt },
      ...(session
        ? {
            session: {
              status: session.status,
              completionReason: session.completionReason,
              reason: session.reason,
              screenshots: result.outcome.screenshots.length,
            },
          }
        : {}),
      ...(result.outcome.sandboxId === undefined
        ? {}
        : { sandbox: { sandboxId: result.outcome.sandboxId, killed: result.outcome.killed } }),
      ...(thisOk
        ? {}
        : {
            error: {
              code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED" as const,
              message:
                result.outcome.sessionError ??
                (result.outcome.noEngagement
                  ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                  : result.outcome.selfReportedBlocker
                    ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
                    : session?.completionReason === "harness_error"
                      ? `Actor seat ended with a harness error: ${session.reason}`
                      : "Actor did not produce a terminal session."),
            },
          }),
    };
  });

  const errorResult = ((): ConcurrentSharedWorldLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (handoffTimedOut) {
      // Checked BEFORE the observer failure: the host never yielded a /lobby/CODE within the
      // deadline (followers failed closed without opening), which is the ROOT CAUSE — and it can
      // itself make the Observer unable to render a coherent run. Report the distinct, honest
      // handoff-timeout code rather than a generic observer/run failure.
      return {
        code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT",
        message:
          runError ?? "The host seat never produced a /lobby/CODE URL within the handoff deadline.",
      };
    }
    if (hostHandoffFailure !== undefined) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: hostHandoffFailure };
    }
    if (!observer.ok) {
      return {
        code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
        message: observer.error?.message ?? "Observer failed for the concurrent shared-world run.",
      };
    }
    if (runError) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: runError };
    }
    if (adapterFailure !== undefined) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: adapterFailure };
    }
    const passed = roleResults.filter((role) => role.ok).length;
    return {
      code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
      message: `Concurrent shared-world run did not run coherently: ${passed}/${roles.length} actor(s) reached a terminal, engaged passed session.`,
    };
  })();

  return {
    schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    topology: "shared-world",
    topologyMode: "concurrent",
    roleCount: roles.length,
    concurrency,
    dryRun,
    runId,
    ...(getHostUrl === undefined ? {} : { host: getHostUrl }),
    ...(subjectSandboxId === undefined
      ? {}
      : { subjectSandbox: { sandboxId: subjectSandboxId, killed: subjectKilled } }),
    ...(dryRun ? {} : { overlapProven }),
    ...(dryRun ? {} : { maxSimultaneousLanes: maxSimultaneousWindows(actorResults) }),
    subject,
    roles: roleResults,
    observer,
    warnings: [...warnings, ...adapterWarnings, ...observer.warnings],
    ...(errorResult === undefined ? {} : { error: errorResult }),
  };
}
