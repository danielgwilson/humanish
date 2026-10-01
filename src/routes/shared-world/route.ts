// The CONCURRENT shared-world lab backend (#164 phase 2): N persona lanes drive ONE shared,
// mutable service plane SIMULTANEOUSLY — the actual leverage of a sim. A recomposition of shipped
// pieces + the getHost wrapper:
//
//   - ONE SUBJECT sandbox: provisionCloneSubject ONCE (clone+install+build+seed) + serve on
//     0.0.0.0, exposed via getHost(port) → a tokenless reachable URL (the headless service host;
//     no GUI seat).
//   - N ACTOR desktop sandboxes: fan-out's runCuaParticipant machinery (per-lane device/persona, by-id
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
import { missingKeys, missingSubjectEnv } from "../../lab/requirements.js";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { scrubLiterals } from "../../evidence/redaction.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import { withTransientCommsSecrets } from "../../run/transient-comms-secrets.js";
import { type FinishedRun, runScope, type RunScope } from "../../run/run.js";
import { makeCuaRunBudget } from "../computer-use/participant-model.js";
import { runExternalPublicPlane } from "./external-public.js";
import { planSharedWorldLab, sharedWorldDescriptorOf, type SharedWorldRefusal } from "./plan.js";
import { localAgentRefusal, type LocalAgentRefusal } from "../../actors/local-agent/readiness.js";
import { runProvisionedPlane } from "./provisioned.js";
import { concurrentLabFailure, finishConcurrentRun } from "./result.js";
import { prepareConcurrentRun } from "./setup.js";
import type { SharedWorldPlan } from "../../lab/plan-types.js";
import { sharedWorldInputWithScorer } from "../../lab/route-inputs.js";
import type { AdmittedPlan } from "../../run-lab.js";
import type { LabConfig } from "../../lab/types.js";
import {
  type ConcurrentSharedWorldLabErrorCode,
  type ConcurrentSharedWorldLabResult,
  type SharedWorldRunInput,
  type ConcurrentSharedWorldPlaneClass,
  type LiveParticipants,
  type PlaneContext,
  type PlaneResults,
  type RunConcurrentSharedWorldLabOptions,
  type PlaneSelection,
} from "./types.js";
import { rosterOf } from "../../lab/parse/actors.js";

/** The shared-world code for each local-agent refusal, kind for kind with computer-use. */
const LOCAL_AGENT_REFUSAL_CODES = {
  "agent-missing": "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_AGENT_MISSING",
  "signin-required": "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_AGENT_SIGNIN_REQUIRED",
  unsupported: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED",
  "unpriced-cap": "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_UNPRICED_CAP",
} as const satisfies Record<LocalAgentRefusal["kind"], ConcurrentSharedWorldLabErrorCode>;

/**
 * The library entry for a shared-world lab. It plans the config with planSharedWorldLab and runs
 * the plan with runSharedWorldPlan, whose run scope and withTransientCommsSecrets wrapper cover the
 * run and its analysis.
 */
export async function runConcurrentSharedWorld(
  options: RunConcurrentSharedWorldLabOptions,
): Promise<ConcurrentSharedWorldLabResult> {
  const { config, dryRun, lab, ...input } = options;
  // planSharedWorldLab makes every configuration refusal, in the order this route always has.
  const planned = planSharedWorldLab(config, {
    dryRun,
    ...(lab === undefined ? {} : { lab }),
    hooks: input.hooks ?? {},
  });
  if (planned.ok) return runSharedWorldPlan(planned.plan, input, config);
  return sharedWorldLabRefusal(options, planned.refusal);
}

/** A refused shared-world lab's result: the route's envelope, and a refusal's analysis record. */
export function sharedWorldLabRefusal(
  options: RunConcurrentSharedWorldLabOptions,
  refusal: SharedWorldRefusal,
): Promise<ConcurrentSharedWorldLabResult> {
  const { config, dryRun } = options;
  const declared = rosterOf(config.actors[0]) ?? [];
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
 * runLab's step for a shared-world plan. It runs a live plan's local checks (the keys, a local
 * agent's sign-in and the subject env) before any run scope opens, so the CLI can present their refusal before it loads a
 * declared scorer, and returns the run that continues from them with that scorer.
 */
export async function admitSharedWorldPlan(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
  config: LabConfig,
): Promise<AdmittedPlan<"shared-world">> {
  const refused = await admitSharedWorldRun(plan, input);
  if (refused) return { ok: false, outcome: sharedWorldOutcome(refused) };
  return {
    ok: true,
    run: async (scorer) =>
      sharedWorldOutcome(
        await runAdmittedSharedWorldRun(plan, sharedWorldInputWithScorer(input, scorer), config),
      ),
  };
}

function sharedWorldOutcome(result: ConcurrentSharedWorldLabResult) {
  return { route: "shared-world", backend: "concurrent-shared-world", result } as const;
}

/** Run a shared-world plan: its local checks, then the run. */
export async function runSharedWorldPlan(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
  config: LabConfig,
): Promise<ConcurrentSharedWorldLabResult> {
  const refused = await admitSharedWorldRun(plan, input);
  return refused ?? runAdmittedSharedWorldRun(plan, input, config);
}

/**
 * A live plan's local checks, made outside any run scope: the keys, a local agent's sign-in, then
 * the subject env. A refusal is the result runSharedWorldPlan returns for it, with the analysis
 * record of a run that never started.
 */
async function admitSharedWorldRun(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
): Promise<ConcurrentSharedWorldLabResult | undefined> {
  if (plan.dryRun) return undefined;
  const env = input.hooks?.env ?? process.env;
  const fail = (code: ConcurrentSharedWorldLabErrorCode, message: string) =>
    completeSharedWorldAnalysis(
      plan,
      input,
      sharedWorldFailure(plan, input)(code, message, sharedWorldDescriptorOf(plan.actor).id),
      undefined,
    );
  // The plan lists OPENAI_API_KEY for an openai brain's seats and the external-public plane's
  // lobby-code reader; a local-agent brain's seats run on the operator's signed-in agent instead.
  const missing = missingKeys(plan.requirements, env);
  if (missing.length > 0) {
    return fail(
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING",
      `Live concurrent shared-world labs need ${missing.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missing, env)}`,
    );
  }
  if (plan.brain.kind === "local-agent") {
    // A missing or signed-out agent found after the seats' desktops are paid for is the same
    // news at the worst moment.
    const refusal = await localAgentRefusal({ agent: plan.brain.agent, env, caps: plan.caps });
    if (refusal) return fail(LOCAL_AGENT_REFUSAL_CODES[refusal.kind], refusal.message);
  }
  const unsetSubjectEnv = missingSubjectEnv(plan.requirements, env);
  if (unsetSubjectEnv.length > 0) {
    return fail(
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING",
      `subject.env declares ${unsetSubjectEnv.join(", ")} but the environment does not provide ${unsetSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
    );
  }
  return undefined;
}

/**
 * Runs an admitted plan in its own run scope, then its automatic analysis. The
 * withTransientCommsSecrets wrapper scopes any email secret the run registers to this run and its
 * analysis.
 */
function runAdmittedSharedWorldRun(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
  config: LabConfig,
): Promise<ConcurrentSharedWorldLabResult> {
  return withTransientCommsSecrets(async () => {
    const { result, finished } = await runScope((scope) =>
      runPlanInScope(plan, input, config, scope),
    );
    return completeSharedWorldAnalysis(plan, input, result, finished);
  });
}

function completeSharedWorldAnalysis(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
  result: ConcurrentSharedWorldLabResult,
  finished: FinishedRun | undefined,
): Promise<ConcurrentSharedWorldLabResult> {
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

/** The route's envelope for a run that stops before its bundle. */
function sharedWorldFailure(plan: SharedWorldPlan, input: SharedWorldRunInput) {
  return concurrentLabFailure({
    cwd: path.resolve(input.cwd),
    labId: plan.labId,
    actor: plan.actor,
    participantCount: plan.plane.participants.length,
    concurrency: plan.concurrency,
    dryRun: plan.dryRun,
    runId: input.runId,
  });
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
  const fail = sharedWorldFailure(plan, input);
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
  live: LiveParticipants,
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
