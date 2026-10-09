// The concurrent shared-world route: N persona participants drive one shared,
// mutable service plane at the same time. A recomposition of shipped
// pieces + the getHost wrapper:
//
//   - One subject sandbox: provisionCloneSubject once (clone+install+build+seed) + serve on
//     0.0.0.0, exposed via getHost(port) → a tokenless reachable URL (the headless service host;
//     no GUI participant).
//   - N actor desktop sandboxes: fan-out's runCuaParticipant machinery (per-participant device/persona, by-id
//     teardown) bounded by execution.concurrency, each browser pointed at the getHost URL and
//     driving the shared service at the same time. Independent: no pipeline gate, no
//     fail-fast: one actor's failure must not block the swarm or corrupt the "M of N" outcomes.
//   - A background prober snapshots the subject DB checkpoint digests on a cadence → a stateSeries
//     of the shared world evolving under load.
//   - All N+1 sandboxes torn down by exact id in a finally, never through Sandbox.list.
//
// Attribution (enforced by verify): the bundle declares
// attributionClass: shared-world + a concurrent humanish.shared-world.v1 block (topologyMode
// "concurrent"; laneWindows + stateSeries + outcomes; no timeline) whose attributionLimits drop
// `sequential-only`/`no-concurrent-races` and add `concurrent`,
// `best-effort-causal-attribution`, `non-deterministic-shared-state`,
// `window-and-snapshot-granularity`, `contention-observed-not-proven-safe`,
// `state-change-not-isolated-to-actors`. laneWindows + stateSeries are independent series with no
// per-delta→actor field, so causation under concurrency is structurally inexpressible.
//
// Capability and proof: the deterministic $0 gate proves the plumbing + the claims-match-mechanism
// contract: the real mapWithConcurrency produces genuinely overlapping laneWindows (a rendezvous
// latch in the fake session forces two participant fns in-flight while the real orchestrator clock
// measures the windows). Every generated bundle describes only its own observations; no one run
// establishes scale, repeatability, or adopter-harness replacement.
//
// Synthetic subject: a getHost URL is internet-reachable for the run, so this route is for
// synthetic seeded subjects only. Verify fail-closes on subject.state.provenance != "seeded" and
// requires the author attestation subject.exposure: synthetic. This is author-trust + a provenance
// gate; humanish cannot tell synthetic from real data, so it makes no claim about real data.

import path from "node:path";
import {
  firstLiveRefusal,
  keysCheck,
  localAgentCheck,
  subjectEnvCheck,
} from "../../study/requirements.js";
import { type RunScope } from "../../run/run.js";
import { RunSecrets } from "../../run/secrets.js";
import {
  admitRoute,
  completeRefusalAnalysis,
  type RefusedStudy,
  type RouteAdmission,
} from "../../run/route-shell.js";
import { runExternalPublicPlane } from "./external-public.js";
import { sharedWorldDescriptorOf, type SharedWorldRefusal } from "./plan.js";
import type { LocalAgentRefusal } from "../../actors/local-agent/readiness.js";
import { runProvisionedPlane } from "./provisioned.js";
import { concurrentStudyFailure, finishConcurrentRun } from "./result.js";
import { prepareConcurrentRun } from "./setup.js";
import type { SharedWorldPlan } from "../../study/plan-types.js";
import { browserRouteScorer } from "../../study/adapter-scorer-loader.js";
import { withLateScorer } from "../../study/route-inputs.js";
import type { AdmittedPlan } from "../../run-study.js";
import type { StudyConfig } from "../../study/types.js";
import {
  type ConcurrentSharedWorldStudyErrorCode,
  type ConcurrentSharedWorldStudyResult,
  type SharedWorldRunInput,
  type ConcurrentSharedWorldPlaneClass,
  type LiveParticipants,
  type PlaneContext,
  type PlaneResults,
  type PlaneSelection,
} from "./types.js";
import { participantList } from "../../study/study-fields.js";

/** The shared-world code for each local-agent refusal, kind for kind with computer-use. */
const LOCAL_AGENT_REFUSAL_CODES = {
  "agent-missing": "HUMANISH_SHARED_WORLD_AGENT_MISSING",
  "signin-required": "HUMANISH_SHARED_WORLD_AGENT_SIGNIN_REQUIRED",
  unsupported: "HUMANISH_SHARED_WORLD_ACTOR_UNSUPPORTED",
  "unpriced-cap": "HUMANISH_SHARED_WORLD_UNPRICED_CAP",
} as const satisfies Record<LocalAgentRefusal["kind"], ConcurrentSharedWorldStudyErrorCode>;

/** A refused shared-world study's result: the route's envelope, and a refusal's analysis record. */
export function sharedWorldStudyRefusal(
  options: SharedWorldRunInput & RefusedStudy,
  refusal: SharedWorldRefusal,
): Promise<ConcurrentSharedWorldStudyResult> {
  const { config, dryRun } = options;
  const declared = participantList(config) ?? [];
  const fail = concurrentStudyFailure({
    cwd: path.resolve(options.cwd),
    studyId: config.id,
    actor: config.actor?.type ?? "",
    participantCount: declared.length,
    // A refused study never planned its concurrency, so its result reports the declared cap, else
    // every declared participant.
    concurrency: config.execution?.concurrency ?? Math.max(1, declared.length),
    dryRun,
    runId: options.runId,
  });
  return completeRefusalAnalysis(
    fail(refusal.code, refusal.message, refusal.actor),
    config,
    options,
  );
}

/**
 * runStudyWith's step for a shared-world plan. It runs a live plan's local checks (the keys, a local
 * agent's sign-in and the subject env) before any run scope opens, so the CLI can present their refusal before it loads a
 * declared scorer, and returns the run that continues from them with that scorer. The run and its
 * analysis share one scope for the email secrets it registers.
 */
export function admitSharedWorldPlan(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
  config: StudyConfig,
): Promise<AdmittedPlan<"shared-world">> {
  return admitRoute({
    route: "shared-world",
    analysis: plan.analysis,
    input,
    admit: () => admitSharedWorldRun(plan, input),
    withScorer: (base, scorer) => withLateScorer(base, scorer, browserRouteScorer),
    runInScope: (_admitted, running, scope) => runPlanInScope(plan, running, config, scope),
    commsSecrets: true,
  });
}

/**
 * A live plan's local checks, made outside any run scope: the keys, a local agent's sign-in, then
 * the subject env.
 */
async function admitSharedWorldRun(
  plan: SharedWorldPlan,
  input: SharedWorldRunInput,
): Promise<RouteAdmission<"shared-world", undefined>> {
  const admitted = { ok: true, admitted: undefined } as const;
  if (plan.dryRun) return admitted;
  const env = input.env ?? process.env;
  const { requirements } = plan;
  // The plan prices a cap before these, and its refusal wins over theirs.
  const refusal = await firstLiveRefusal<ConcurrentSharedWorldStudyErrorCode>([
    // The plan lists OPENAI_API_KEY for an openai brain's participants and the external-public
    // plane's lobby-code reader; a local-agent brain's participants run on the operator's
    // signed-in agent instead. Only on the provisioned plane does a local agent remove the key,
    // so only there does the refusal suggest one.
    () =>
      keysCheck({
        requirements,
        env,
        code: "HUMANISH_SHARED_WORLD_KEYS_MISSING",
        need: (names) =>
          `Live concurrent shared-world studies need ${names} in the environment (values are never persisted).`,
        suggestLocalAgent: plan.plane.kind === "provisioned",
      }),
    () =>
      localAgentCheck({
        brain: plan.brain,
        env,
        caps: plan.caps,
        codes: LOCAL_AGENT_REFUSAL_CODES,
      }),
    () => subjectEnvCheck({ requirements, env, code: "HUMANISH_SHARED_WORLD_SUBJECT_ENV_MISSING" }),
  ]);
  if (refusal === undefined) return admitted;
  const fail = sharedWorldFailure(plan, input);
  return {
    ok: false,
    result: fail(refusal.code, refusal.message, sharedWorldDescriptorOf(plan.actor).id),
  };
}

/** The route's envelope for a run that stops before its bundle. */
function sharedWorldFailure(plan: SharedWorldPlan, input: SharedWorldRunInput) {
  return concurrentStudyFailure({
    cwd: path.resolve(input.cwd),
    studyId: plan.studyId,
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
  config: StudyConfig,
  scope: RunScope,
): Promise<ConcurrentSharedWorldStudyResult> {
  const requestedCwd = path.resolve(input.cwd);
  const deps = input.deps ?? {};
  const env: Record<string, string | undefined> = input.env ?? process.env;
  const fail = sharedWorldFailure(plan, input);
  const descriptor = sharedWorldDescriptorOf(plan.actor);
  const planeClass: ConcurrentSharedWorldPlaneClass =
    plan.plane.kind === "external-public" ? "external-public" : "provisioned-getHost";

  // The provisioned plane's subject; the external-public plane has none.
  const subject = plan.plane.kind === "provisioned" ? plan.plane.subject : undefined;
  const serve = subject?.serve;
  const localTreeRoute = subject?.kind === "local-tree";
  const subjectRepo = plan.residual.subject.repos?.[0] ?? "";
  const subjectEnvNames = [...(subject?.env ?? [])];
  const checkpoints = [...(subject?.state.checkpoint ?? [])];
  const runSession = deps.runSession ?? descriptor.runSession;

  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  const secrets = new RunSecrets([
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? ""),
    ...checkpoints.flatMap((probe) => probe.redact ?? []),
  ]);

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
      deps,
      env,
      descriptor,
      planeClass,
      runSession,
      serve,
      localTreeRoute,
      subjectRepo,
      subjectEnvNames,
      checkpoints,
      openaiApiKey,
      e2bApiKey,
      secrets,
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
      "HUMANISH_SHARED_WORLD_INVALID",
      "the provisioned-getHost concurrent shared-world route requires `subject.serve`.",
      descriptor.id,
    );
  }
  return finishConcurrentRun(ctx, live, results, prepared.finish);
}

/**
 * Runs the plane the study declares, then finalizes email receiving and stops the participants'
 * flush on every exit. Returns false when a provisioned study reaches it without `subject.serve`.
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
    // Stop the participants' flush timer on every exit, before the final write.
    await live.flush?.stop();
  }
  return true;
}
