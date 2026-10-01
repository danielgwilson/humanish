// Finishing a concurrent shared-world run: publishing its bundle, rendering the Observer, and the
// lab result with each role's outcome and the one error a run that did not pass reports.

import { redactText } from "../../evidence/redaction.js";
import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks,
} from "../../lab/adapter-extension.js";
import { attachObserverRuntimeStreamUrls, type ObserverResult } from "../../observer/render.js";
import type { RunSubjectProvenance } from "../../run/bundle.js";
import {
  foldScorerFailures,
  judgeExecution,
  OUTCOME_POLICIES,
  participantHarnessFailed,
  resultOk,
  sharedWorldShortfall,
  type ExecutionFailure,
} from "../../run/judge.js";
import { participantFactsOf } from "../computer-use/bundle.js";
import { resolveSubjectState } from "../computer-use/route.js";
import {
  actorRunPassed,
  buildConcurrentSharedWorldBundle,
  judgeSharedWorldRun,
  maxSimultaneousWindows,
} from "./bundle.js";
import { planeStateOf } from "./plan.js";
import { buildSubjectProvenance, hostOriginDigest } from "./provenance.js";
import {
  CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
  type ActorRunResult,
  type ConcurrentBundleArgs,
  type ConcurrentSharedWorldLabErrorCode,
  type ConcurrentSharedWorldLabResult,
  type ConcurrentSharedWorldRoleResult,
  type FinishFacts,
  type LiveParticipants,
  type PlaneContext,
  type PlaneResults,
} from "./types.js";
import type { DesktopParticipantRun } from "../computer-use/types.js";

/** The results of a run whose plane did not run (a dry run) or has not reported yet. */
export function emptyPlaneResults(): PlaneResults {
  return {
    actorResults: [],
    runError: undefined,
    subjectCommit: undefined,
    subjectSandboxId: undefined,
    subjectKilled: false,
    subjectDesktop: undefined,
    getHostUrl: undefined,
    publicOriginDigest: undefined,
    lobbyConvergenceDigest: undefined,
    handoffTimedOut: false,
    hostHandoffFailure: undefined,
    commsArtifactPath: undefined,
  };
}

/** Each participant's outcome, in plan order. */
function concurrentParticipantResults(
  actorSpecs: DesktopParticipantRun[],
  actorResults: ActorRunResult[],
  dryRun: boolean,
): ConcurrentSharedWorldRoleResult[] {
  const participantOk = (result: ActorRunResult | undefined): boolean => {
    if (dryRun) return true;
    return actorRunPassed(result);
  };
  return actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const base = { id: spec.planned.id, index: index + 1, persona: spec.persona.id };
    if (dryRun || !result) {
      return { ...base, status: "contract_proof_only", ok: dryRun };
    }
    const session = result.outcome.session;
    const thisOk = participantOk(result);
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
}

/** The error a run that did not pass reports, most specific cause first. */
function concurrentLabError(args: {
  ok: boolean;
  handoffTimedOut: boolean;
  hostHandoffFailure: string | undefined;
  observer: ObserverResult;
  runError: string | undefined;
  adapterFailure: string | undefined;
  participantResults: ConcurrentSharedWorldRoleResult[];
  participantCount: number;
  shortfall: string | undefined;
}): ConcurrentSharedWorldLabResult["error"] | undefined {
  const { ok, handoffTimedOut, hostHandoffFailure, observer, runError, adapterFailure } = args;
  const { participantResults, participantCount } = args;
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
  const passed = participantResults.filter((result) => result.ok).length;
  if (passed === participantCount && args.shortfall !== undefined) {
    return {
      code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
      message: `Concurrent shared-world run did not run coherently. ${args.shortfall}`,
    };
  }
  return {
    code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
    message: `Concurrent shared-world run did not run coherently: ${passed}/${participantCount} actor(s) reached a terminal, engaged passed session.`,
  };
}

/**
 * The refusal envelope for a run that stops before it has results: the requested cwd, no roles,
 * and the run id the caller asked for, if any. `actor` is the label when a refusal names none.
 */
export function concurrentLabFailure(envelope: {
  cwd: string;
  labId: string;
  actor: string;
  participantCount: number;
  concurrency: number;
  dryRun: boolean;
  runId: string | undefined;
}): (
  code: ConcurrentSharedWorldLabErrorCode,
  message: string,
  actorLabel?: string,
) => ConcurrentSharedWorldLabResult {
  return (code, message, actorLabel) => ({
    schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
    ok: false,
    cwd: envelope.cwd,
    labId: envelope.labId,
    actor: actorLabel ?? envelope.actor,
    topology: "shared-world",
    topologyMode: "concurrent",
    roleCount: envelope.participantCount,
    concurrency: envelope.concurrency,
    dryRun: envelope.dryRun,
    runId: envelope.runId ?? "not-created",
    roles: [],
    warnings: [],
    error: { code, message },
  });
}

/**
 * The run's execution failures: a run error (the handoff, the plane), each seat whose session
 * failed in the harness, and an Observer that failed.
 */
function sharedWorldExecutionFailures(args: {
  runError: string | undefined;
  actorResults: readonly ActorRunResult[];
  observer: Pick<ObserverResult, "ok" | "error">;
}): ExecutionFailure[] {
  const { runError, actorResults, observer } = args;
  return [
    ...(runError === undefined ? [] : [{ kind: "run" as const, message: runError }]),
    ...actorResults
      .filter((result) => participantHarnessFailed(participantFactsOf(result.outcome)))
      .map((result) => ({
        kind: "harness" as const,
        message: `${result.spec.planned.id}: ${result.outcome.sessionError ?? result.outcome.session?.reason ?? "harness error"}`,
      })),
    ...(observer.ok
      ? []
      : [
          {
            kind: "evidence" as const,
            message:
              observer.error?.message ?? "Observer failed for the concurrent shared-world run.",
          },
        ]),
  ];
}

/** Builds and publishes the bundle, renders the Observer and returns the lab result. */
export async function finishConcurrentRun(
  ctx: PlaneContext,
  live: LiveParticipants,
  results: PlaneResults,
  plane: FinishFacts,
): Promise<ConcurrentSharedWorldLabResult> {
  const { plan, input, descriptor, hooks, actorSpecs, run, runId, createdAt } = ctx;
  const participantCount = plan.plane.participants.length;
  const { cwd, concurrency, source, seedDigest, receiving, warnings, scrubKnownValues } = ctx;
  const { dryRun } = plan;
  const physicalArtifactRoot = ctx.runPaths.physicalRunRoot;
  const { planeClass, localTreeRoute, localTreeArchive, publicRepo, subjectEnvNames } = plane;
  const { stateStepRecords, stateSnapshots, declaredOriginDigest } = plane;
  const { actorResults, runError, subjectCommit, subjectSandboxId, subjectKilled } = results;
  const { getHostUrl, publicOriginDigest, lobbyConvergenceDigest } = results;
  const { handoffTimedOut, hostHandoffFailure, commsArtifactPath, subjectDesktop } = results;

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
            declared: planeStateOf(plan),
            dryRun,
            executed: stateStepRecords,
          }),
        });
  const planeCommit = localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit;

  // Collect per-actor warnings (each lane's own teardown/raw-screenshot notes).
  for (const result of actorResults) {
    warnings.push(...result.outcome.warnings);
  }

  const bundleArgs: Omit<ConcurrentBundleArgs, "judgment"> = {
    ...(plan.lab === undefined ? {} : { lab: plan.lab }),
    plan,
    descriptor,
    createdAt,
    dryRun,
    runId,
    source,
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
    ...(subjectDesktop === undefined ? {} : { subjectDesktop }),
  };
  // One judgment for the whole run: the bundle's verdict and the result's ok both read it.
  const judgment = judgeSharedWorldRun(bundleArgs);
  const bundle = buildConcurrentSharedWorldBundle({ ...bundleArgs, judgment });

  const adapterWarnings: string[] = [];
  const scorerResult = await applyBrowserAdapterHooks({
    hooks,
    bundle,
    context: {
      bundle,
      runDir: physicalArtifactRoot,
      labId: plan.labId,
      runId,
      actor: descriptor.id,
      backend: "concurrent-shared-world",
      dryRun,
      laneCount: participantCount,
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "sharedWorldHooks",
    ...(input.scorerProvenance === undefined ? {} : { scorerProvenance: input.scorerProvenance }),
  });
  // The one final verdict fold: scoring can only make the judged verdict stricter.
  bundle.review = foldScorerFailures(bundle.review, scorerResult.failures);

  if (receiving) bundle.commsReceiving = receiving.snapshot();
  const finished = await run.finish(bundle);
  const observer = await finished.renderObserver();
  if (observer.ok && live.observer) {
    attachObserverRuntimeStreamUrls(observer as ObserverResult & { ok: true }, live.streamUrls);
  }

  // Concurrent "ok": every actor must produce a terminal, engaged PASSED session, and the seats
  // must show the concurrency verify requires of a pass (judgeSharedWorld). This is a
  // harness/session-credibility gate, not mission-completion proof; a failed actor trace cannot
  // make the route green just because the harness got a terminal.
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const policy = OUTCOME_POLICIES["shared-world"];
  const execution = judgeExecution(
    sharedWorldExecutionFailures({ runError, actorResults, observer }),
    policy,
  );
  const ok = resultOk({ judgment, execution, scorerFailures: scorerResult.failures, policy });

  const overlapProven = !dryRun && judgment.world.overlap;

  const participantResults = concurrentParticipantResults(actorSpecs, actorResults, dryRun);

  const errorResult = concurrentLabError({
    ok,
    handoffTimedOut,
    hostHandoffFailure,
    observer,
    runError,
    adapterFailure,
    participantResults,
    participantCount,
    shortfall: dryRun ? undefined : sharedWorldShortfall(judgment.world),
  });

  const result: ConcurrentSharedWorldLabResult = {
    schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
    ok,
    cwd,
    labId: plan.labId,
    actor: descriptor.id,
    topology: "shared-world",
    topologyMode: "concurrent",
    roleCount: participantCount,
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
    roles: participantResults,
    observer,
    warnings: [...warnings, ...adapterWarnings, ...observer.warnings],
    ...(errorResult === undefined ? {} : { error: errorResult }),
  };
  await finished.recordOutcome({ ok, execution });
  return result;
}
