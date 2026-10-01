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
// gate, NOT a no-real-data guarantee (humanish cannot tell synthetic from real data).

import path from "node:path";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { scrubLiterals } from "../../evidence/redaction.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import { withTransientCommsSecrets } from "../../run/transient-comms-secrets.js";
import { runScope, type RunScope } from "../../run/run.js";
import { makeCuaRunBudget } from "../computer-use/lane-plan.js";
import { runExternalPublicPlane } from "./external-public.js";
import { planSharedWorldLab, sharedWorldDescriptorOf, type SharedWorldRefusal } from "./plan.js";
import { runProvisionedPlane } from "./provisioned.js";
import { concurrentLabFailure, finishConcurrentRun } from "./result.js";
import { prepareConcurrentRun } from "./setup.js";
import type { SharedWorldPlan } from "../../lab/plan-types.js";
import type { LabConfig } from "../../lab/types.js";
import {
  type ConcurrentSharedWorldLabResult,
  type SharedWorldRunInput,
  type ConcurrentSharedWorldPlaneClass,
  type LiveSeats,
  type PlaneContext,
  type PlaneResults,
  type RunConcurrentSharedWorldLabOptions,
  type PlaneSelection,
} from "./types.js";

/**
 * The library entry for a shared-world lab. It plans the config with planSharedWorldLab and runs
 * the plan as runSharedWorldPlan does; runLab calls runSharedWorldPlan directly. The
 * withTransientCommsSecrets wrapper scopes any email secret the run registers to this run and its
 * analysis. The run's status record is opened and finalized by the run scope in runPlanWithSecrets.
 */
export async function runConcurrentSharedWorld(
  options: RunConcurrentSharedWorldLabOptions,
): Promise<ConcurrentSharedWorldLabResult> {
  return withTransientCommsSecrets(() => runConcurrentSharedWorldWithSecrets(options));
}

async function runConcurrentSharedWorldWithSecrets(
  options: RunConcurrentSharedWorldLabOptions,
): Promise<ConcurrentSharedWorldLabResult> {
  const { config, dryRun, lab, ...input } = options;
  // planSharedWorldLab makes every configuration refusal, in the order this route always has.
  const planned = planSharedWorldLab(config, {
    dryRun,
    ...(lab === undefined ? {} : { lab }),
    hooks: input.hooks ?? {},
  });
  if (planned.ok) return runPlanWithSecrets(planned.plan, input, config);
  return sharedWorldLabRefusal(options, planned.refusal);
}

/** A refused shared-world lab's result: the route's envelope, and a refusal's analysis record. */
export function sharedWorldLabRefusal(
  options: RunConcurrentSharedWorldLabOptions,
  refusal: SharedWorldRefusal,
): Promise<ConcurrentSharedWorldLabResult> {
  const { config, dryRun } = options;
  const declared = config.actors[0]?.lanes ?? [];
  const fail = concurrentLabFailure({
    cwd: path.resolve(options.cwd),
    labId: config.id,
    actor: config.actors[0]?.type ?? "",
    participantCount: declared.length,
    // The parser fills concurrency for multi-seat labs, so this fallback serves only library
    // callers: every declared seat runs at once unless the author declared a cap (#350).
    concurrency: config.execution?.concurrency ?? Math.max(1, declared.length),
    dryRun,
    runId: options.runId,
  });
  // A refusal starts no run, so a declared or default analysis is recorded as skipped.
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  return completeAutomaticAnalysis(
    fail(refusal.code, refusal.message, refusal.actor),
    undefined,
    analysis.ok ? analysis.config : undefined,
    options.automaticAnalysis,
    { trigger: config.review?.analysis === undefined ? "default" : "explicit" },
  );
}

/**
 * Run a shared-world plan. The run scope gives a direct library caller the same status-record
 * lifetime the CLI gets: returning finalizes any record the run opened, whichever of its
 * fail-closed exits it took. Seats come from the plan's participants. `config` is still read by
 * the computer-use lane runner, whose hooks and desktop setup take the whole config.
 */
export async function runSharedWorldPlan(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
  config: LabConfig,
): Promise<ConcurrentSharedWorldLabResult> {
  return withTransientCommsSecrets(() => runPlanWithSecrets(plan, input, config));
}

async function runPlanWithSecrets(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
  config: LabConfig,
): Promise<ConcurrentSharedWorldLabResult> {
  const { result, finished } = await runScope((scope) =>
    runPlanInScope(plan, input, config, scope),
  );
  return completeAutomaticAnalysis(
    result,
    finished,
    plan.analysis?.config,
    input.automaticAnalysis,
    {
      ...(plan.analysis === undefined ? {} : { trigger: plan.analysis.trigger }),
      preferLargerOutput: plan.analysis?.preferLargerOutput === true,
    },
  );
}

async function runPlanInScope(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
  config: LabConfig,
  scope: RunScope,
): Promise<ConcurrentSharedWorldLabResult> {
  const { dryRun } = plan;
  const requestedCwd = path.resolve(input.cwd);
  const hooks = input.hooks ?? {};
  const env = hooks.env ?? process.env;
  const fail = concurrentLabFailure({
    cwd: requestedCwd,
    labId: plan.labId,
    actor: plan.actor,
    participantCount: plan.plane.participants.length,
    concurrency: plan.concurrency,
    dryRun,
    runId: input.runId,
  });
  const descriptor = sharedWorldDescriptorOf(plan.actor);
  const planeClass: ConcurrentSharedWorldPlaneClass =
    plan.plane.kind === "external-public" ? "external-public" : "provisioned-getHost";
  const { maxTotalUsd } = plan.caps;
  const runBudget =
    !dryRun && maxTotalUsd !== undefined ? makeCuaRunBudget(maxTotalUsd) : undefined;

  // The provisioned plane's subject; the external-public plane has none.
  const subject = plan.plane.kind === "provisioned" ? plan.plane.subject : undefined;
  const serve = subject?.serve;
  const localTreeRoute = subject?.kind === "local-tree";
  const subjectRepo = plan.residual.subject.repos?.[0] ?? "";
  const subjectEnvNames = [...(subject?.env ?? [])];
  const checkpoints = [...(subject?.state.checkpoint ?? [])];
  const runSession = hooks.runSession ?? descriptor.runSession;

  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? ""),
    ...checkpoints.flatMap((probe) => probe.redact ?? []),
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = scrubLiterals(knownSecretValues);

  const redactRepoLabel =
    plan.residual.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
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

  const prepared = await prepareConcurrentRun(
    {
      plan,
      input,
      config,
      requestedCwd,
      hooks,
      env,
      descriptor,
      planeClass,
      runBudget,
      runSession,
      serve,
      localTreeRoute,
      subjectRepo,
      subjectEnvNames,
      checkpoints,
      openaiApiKey,
      e2bApiKey,
      knownSecretValues,
      scrubKnownValues,
      publicRepo,
      hasGithubToken,
      fail,
    },
    scope,
  );
  if (!prepared.ok) return prepared.result;
  const { ctx, live, results } = prepared;
  const planeRan = await runPlane(ctx, live, results, prepared.plane);
  if (!planeRan) {
    return fail(
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID",
      "the provisioned-getHost concurrent shared-world route requires `subject.serve`.",
      descriptor.id,
    );
  }
  return finishConcurrentRun(ctx, live, results, prepared.finish);
}

/**
 * Runs the plane the lab declares, then finalizes email receiving and stops the seats' flush on
 * every exit. Returns false when a provisioned lab reaches it without `subject.serve`.
 */
async function runPlane(
  ctx: PlaneContext,
  live: LiveSeats,
  results: PlaneResults,
  plane: PlaneSelection,
): Promise<boolean> {
  const { dryRun } = ctx.plan;
  try {
    if (!dryRun && plane.planeClass === "provisioned-getHost") {
      // Defense-in-depth: concurrentSharedWorldValidationReason already required serve above.
      if (!plane.provisioned) return false;
      const { commsArtifactPath, ...outcome } = await runProvisionedPlane(
        ctx,
        live,
        plane.provisioned,
      );
      Object.assign(results, outcome);
      if (commsArtifactPath !== undefined) results.commsArtifactPath = commsArtifactPath;
    }

    if (!dryRun && plane.planeClass === "external-public") {
      const { commsArtifactPath, ...outcome } = await runExternalPublicPlane(
        ctx,
        live,
        plane.externalWiring,
      );
      Object.assign(results, outcome);
      if (commsArtifactPath !== undefined) results.commsArtifactPath = commsArtifactPath;
    }
  } finally {
    try {
      await ctx.receiving?.finish();
    } catch {
      ctx.warnings.push(
        "Email finalization could not complete. Inspect humanish comms recover; provider cleanup remains unresolved.",
      );
    }
    // Stop the seats' flush timer on every exit, before the final write.
    await live.flush?.stop();
  }
  return true;
}
