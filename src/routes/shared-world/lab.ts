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
import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { actorRegistry, isCuaActorDescriptor } from "../../actors/registry.js";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { scrubLiterals } from "../../evidence/redaction.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import {
  concurrentSharedWorldValidationReason,
  desktopMediaValidationReason,
  externalPublicSharedWorldValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  scenarioCapsValidationReason,
  taskProtocolValidationReason,
} from "../../lab/validation.js";
import { withTransientCommsSecrets } from "../../run/narration-secrets.js";
import { MODEL_RATES } from "../../run/pricing.js";
import { runScope, type RunScope } from "../../run/run.js";
import { makeCuaRunBudget } from "../computer-use/lane-plan.js";
import { runExternalPublicPlane } from "./external-public.js";
import { runProvisionedPlane } from "./provisioned.js";
import { concurrentLabFailure, finishConcurrentRun } from "./result.js";
import { prepareConcurrentRun } from "./setup.js";
import {
  type ConcurrentSharedWorldLabResult,
  type ConcurrentSharedWorldPlaneClass,
  type LiveSeats,
  type PlaneContext,
  type PlaneResults,
  type RunConcurrentSharedWorldLabOptions,
  type PlaneSelection,
} from "./types.js";

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

  const fail = concurrentLabFailure(options, requestedCwd, concurrency);

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

  const prepared = await prepareConcurrentRun(
    {
      options,
      requestedCwd,
      hooks,
      env,
      descriptor,
      planeClass,
      concurrency,
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
  const { dryRun } = ctx.options;
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
