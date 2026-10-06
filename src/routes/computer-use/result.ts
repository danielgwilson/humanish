import { adapterScoreFailureMessage, applyBrowserScorer } from "../../study/adapter-extension.js";
import { redactText } from "../../evidence/redaction.js";
import type { ObserverResult } from "../../observer/render.js";
import type { RunBundle, RunRerunLineage } from "../../run/bundle.js";
import { round6 } from "../../run/pricing.js";
import type { ComputerUsePlan } from "../../study/plan-types.js";
import {
  foldScorerFailures,
  judgeExecution,
  OUTCOME_POLICIES,
  participantHarnessFailed,
  resultOk,
  type ExecutionFailure,
  type ExecutionOutcome,
} from "../../run/judge.js";
import {
  participantFactsOf,
  participantOutcomeOk,
  unreleasedSandboxFailures,
} from "./participant-facts.js";
import { summarizeCuaDiagnostics } from "./diagnostics.js";
import { toParticipantResult } from "./participant-execution.js";
import { buildCuaRunBundle, judgeComputerUseRun } from "./bundle.js";
import type { runStudyParticipants } from "./live-phase.js";
import type { CuaFinishFacts, CuaRunSetup } from "./setup.js";
import {
  aggregateCuaSubject,
  projectParticipantSubjects,
  subjectProvenanceArg,
} from "./subject-projection.js";
import {
  CUA_FANOUT_STRATEGY,
  type CuaActorStudyErrorCode,
  type CuaActorStudyResult,
  type CuaParticipantPlan,
  type CuaParticipantSummary,
  type DesktopParticipantRun,
  type CuaSubjectProjection,
  type ParticipantRunOutcome,
  participantSubjectEnv,
} from "./types.js";
import { plannedAppUrl } from "./plan.js";
import { studyResultIdentity } from "../../run/study-result.js";
import { plural } from "../../run/text.js";

/** Aggregate participant counts for the result projection. */
function buildParticipantSummary(
  outcomes: ParticipantRunOutcome[] | undefined,
  participantCount: number,
  participantPlan: CuaParticipantPlan,
  dryRun: boolean,
): CuaParticipantSummary {
  if (dryRun || !outcomes) {
    return {
      strategy: CUA_FANOUT_STRATEGY,
      total: participantCount,
      passed: 0,
      skipped: 0,
      harnessErrors: 0,
      hollow: 0,
      concurrency: participantPlan.concurrency,
      waves: participantPlan.waves,
    };
  }
  let passed = 0;
  let skipped = 0;
  let harnessErrors = 0;
  let hollow = 0;
  for (const outcome of outcomes) {
    if (outcome.skippedReason !== undefined) {
      skipped += 1;
      continue;
    }
    if (outcome.harnessError) harnessErrors += 1;
    if (outcome.noEngagement) hollow += 1;
    if (participantOutcomeOk(outcome, dryRun)) passed += 1;
  }
  return {
    strategy: CUA_FANOUT_STRATEGY,
    total: participantCount,
    passed,
    skipped,
    harnessErrors,
    hollow,
    concurrency: participantPlan.concurrency,
    waves: participantPlan.waves,
  };
}

/**
 * The computer-use study result for a finished run. The run passes only when the Observer rendered,
 * every participant passed (dry-run participants pass as contracts), and no adapter score or declared scorer
 * verdict failed; otherwise the error names the first reason.
 */
function cuaStudyResult(args: {
  studyId: string;
  cwd: string;
  runId: string;
  actorId: string;
  appUrl: string;
  dryRun: boolean;
  participantRuns: DesktopParticipantRun[];
  outcomes: ParticipantRunOutcome[] | undefined;
  subjects: CuaSubjectProjection[];
  aggregateSubject: CuaSubjectProjection;
  participantPlan: CuaParticipantPlan;
  rerunLineage: RunRerunLineage | undefined;
  bundle: RunBundle;
  /** The run's ok and execution outcome as run.json records them (FinishedRun.outcome). */
  outcome: { ok: boolean; execution: ExecutionOutcome };
  observer: ObserverResult;
  receivingWarnings: string[];
  aggregateWarnings: string[];
  adapterWarnings: string[];
}): CuaActorStudyResult {
  const {
    studyId,
    cwd,
    runId,
    appUrl,
    dryRun,
    participantRuns,
    outcomes,
    subjects,
    aggregateSubject,
    participantPlan,
    rerunLineage,
    bundle,
    observer,
    receivingWarnings,
    aggregateWarnings,
    adapterWarnings,
  } = args;
  const participantCount = participantRuns.length;
  // Participant-level pass: dry-run participants are contract-ok; live ones need a passed,
  // engaged session.
  const participantOk = (outcome: ParticipantRunOutcome | undefined): boolean =>
    participantOutcomeOk(outcome, dryRun);
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const { ok } = args.outcome;

  const participantWarnings = (outcomes ?? []).flatMap((outcome) => outcome.warnings);
  const warnings = [
    ...receivingWarnings,
    ...participantWarnings,
    ...aggregateWarnings,
    ...adapterWarnings,
    ...observer.warnings,
  ];

  const participantResults = participantRuns.map((spec, index) =>
    toParticipantResult(spec, outcomes?.[index], subjects[index]!, dryRun),
  );
  const summary = buildParticipantSummary(outcomes, participantCount, participantPlan, dryRun);
  const firstOutcome = outcomes?.[0];

  const errorResult = ((): CuaActorStudyResult["error"] | undefined => {
    if (ok) return undefined;
    if (adapterFailure !== undefined) {
      return { code: "HUMANISH_COMPUTER_USE_FAILED", message: adapterFailure };
    }
    if (participantCount === 1) {
      const outcome = firstOutcome;
      return {
        code: outcome?.failureCode ?? "HUMANISH_COMPUTER_USE_FAILED",
        message:
          outcome?.sessionError ??
          outcome?.providerCleanupError ??
          outcome?.providerPolicyError ??
          (outcome?.noEngagement
            ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
            : // The participant result (toParticipantResult) named this refusal; the N=1 envelope fell through to
              // "did not produce a terminal session", which is false: it produced one and refused it.
              outcome?.selfReportedBlocker
              ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
              : observer.ok
                ? outcome?.session?.completionReason === "harness_error"
                  ? `Computer-use session ended with a harness error: ${outcome.session.reason}`
                  : outcome?.session?.status !== "passed"
                    ? `Computer-use session ended with ${outcome?.session?.status ?? "unknown"}: ${outcome?.session?.reason ?? "no terminal reason"}`
                    : "The computer-use run did not produce a terminal session."
                : (observer.error?.message ?? "Observer failed for the computer-use run.")),
      };
    }
    const failing = (outcomes ?? []).find((outcome) => !participantOk(outcome));
    const geometryFailure = (outcomes ?? []).find(
      (outcome) => outcome.failureCode === "HUMANISH_COMPUTER_USE_DEVICE_GEOMETRY",
    );
    const code: CuaActorStudyErrorCode =
      geometryFailure?.failureCode ?? "HUMANISH_COMPUTER_USE_FAILED";
    return {
      code,
      message: observer.ok
        ? `Fan-out run failed: ${summary.passed}/${plural(participantCount, "participant")} passed (${summary.skipped} skipped, ${plural(summary.harnessErrors, "harness error")}, ${summary.hollow} without engagement)${failing?.sessionError !== undefined ? `; first failure: ${failing.sessionError}` : failing === undefined && args.outcome.execution.failures[0] !== undefined ? `; ${args.outcome.execution.failures[0].message}` : ""}.`
        : (observer.error?.message ?? "Observer failed for the computer-use fan-out run."),
    };
  })();

  return {
    ...studyResultIdentity("computer-use", studyId),
    ok,
    cwd,
    actor: args.actorId,
    appUrl,
    dryRun,
    runId,
    ...(firstOutcome?.session
      ? {
          session: {
            status: firstOutcome.session.status,
            completionReason: firstOutcome.session.completionReason,
            ...(firstOutcome.session.trace.stopCause === undefined
              ? {}
              : { stopCause: firstOutcome.session.trace.stopCause }),
            reason: firstOutcome.session.reason,
            screenshots: firstOutcome.screenshots.length,
          },
        }
      : {}),
    ...(firstOutcome?.sandboxId
      ? {
          sandbox: {
            sandboxId: firstOutcome.sandboxId,
            killed: firstOutcome.killed,
            streamUrlPresent: firstOutcome.streamUrlPresent,
          },
        }
      : {}),
    subject: aggregateSubject,
    plan: participantPlan,
    lanes: participantResults,
    diagnostics: summarizeCuaDiagnostics({
      dryRun,
      evidenceInvalid: !observer.ok,
      participants: participantResults,
    }),
    laneSummary: summary,
    ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
    observer,
    warnings,
    ...(errorResult === undefined ? {} : { error: errorResult }),
  };
}

/**
 * The run's execution failures before the Observer renders: each participant whose session failed
 * in the harness, each provider whose cleanup is unconfirmed or that reported a disallowed item
 * after its last request, and each sandbox whose release is unconfirmed. FinishedRun.renderObserver
 * adds an Observer that did not render.
 */
function computerUseExecutionFailures(
  outcomes: readonly ParticipantRunOutcome[] | undefined,
  runId: string,
): ExecutionFailure[] {
  return [
    ...(outcomes ?? [])
      .filter((outcome) => participantHarnessFailed(participantFactsOf(outcome)))
      .map((outcome) => ({
        kind: "harness" as const,
        message: `${outcome.spec.planned.id}: ${outcome.sessionError ?? outcome.session?.reason ?? "harness error"}`,
      })),
    ...(outcomes ?? []).flatMap((outcome) =>
      outcome.providerCleanupError === undefined
        ? []
        : [
            {
              kind: "provider-cleanup" as const,
              message: `${outcome.spec.planned.id}: ${outcome.providerCleanupError}`,
            },
          ],
    ),
    ...(outcomes ?? []).flatMap((outcome) =>
      outcome.providerPolicyError === undefined
        ? []
        : [
            {
              kind: "provider-policy" as const,
              message: `${outcome.spec.planned.id}: ${outcome.providerPolicyError}`,
            },
          ],
    ),
    ...unreleasedSandboxFailures(outcomes, runId),
  ];
}

/**
 * caps.maxUsd is enforced inside each participant's loop independently, so an
 * N-participant fan-out can spend up to N × maxUsd before any participant aborts, while the run cost summary reports the larger
 * aggregate. The warning names that ceiling, unless the study declared a shared maxTotalUsd budget.
 */
function participantCapWarning(
  caps: ComputerUsePlan["caps"],
  participantCount: number,
): string | undefined {
  const capUsd = caps.maxUsd;
  if (capUsd === undefined || participantCount <= 1) return undefined;
  if (caps.maxTotalUsd !== undefined) return undefined;
  return `caps.maxUsd ($${capUsd}) caps each participant, so ${participantCount} participants may spend up to ${participantCount} × $${capUsd} (about $${round6(capUsd * participantCount)}) before any of them stops. Set caps.maxTotalUsd for one budget across the study.`;
}

/** Builds and publishes the final bundle, runs the adapter hooks, renders the Observer and returns the result. */
export async function finishCuaRun(
  setup: CuaRunSetup,
  finish: CuaFinishFacts,
  ran: Extract<Awaited<ReturnType<typeof runStudyParticipants>>, { ok: true }>,
): Promise<CuaActorStudyResult> {
  const { plan, input, cwd, streams, descriptor, run } = setup;
  const { participantRuns, participantPlan, bundleBase } = setup;
  const { rerunLineage, publicRepo, subjectArgs } = finish;
  const { dryRun } = plan;
  const appUrl = plannedAppUrl(plan.runner.subject);
  const subjectEnvNames = [...participantSubjectEnv(plan.runner.subject)];
  const { runId } = run;
  const participantCount = participantRuns.length;
  const { outcomes, failFastReason, receiving, receivingWarnings, externalCommsWarnings } = ran;
  // Per-participant subject projections.
  const subjects = projectParticipantSubjects({ ...subjectArgs, outcomes, dryRun });

  const aggregate = aggregateCuaSubject({ subjects, outcomes, participantCount, dryRun });
  const aggregateSubject = aggregate.subject;
  const capWarning = participantCapWarning(plan.caps, participantCount);
  const aggregateWarnings = [
    ...externalCommsWarnings,
    ...(capWarning === undefined ? [] : [capWarning]),
    ...aggregate.warnings,
  ];
  const finalProvenance = subjectProvenanceArg(aggregateSubject, publicRepo, subjectEnvNames);

  // One judgment for the whole run: the bundle's verdict and the result's ok both read it.
  const judgment = judgeComputerUseRun(bundleBase, { dryRun, outcomes });
  const bundle = buildCuaRunBundle(bundleBase, {
    judgment,
    dryRun,
    outcomes,
    subjects,
    aggregateSubject,
    subjectProvenance: finalProvenance,
    ...(failFastReason === undefined ? {} : { failFastReason }),
  });

  const adapterWarnings: string[] = [];
  const scorerResult = await applyBrowserScorer({
    scorer: input.scorer,
    bundle,
    context: {
      bundle,
      runDir: run.paths.physicalRunRoot,
      studyId: plan.studyId,
      runId,
      actor: descriptor.id,
      route: "computer-use",
      dryRun,
      participantCount,
    },
    sanitize: (text) => redactText(run.secrets.scrub(text)),
    warnings: adapterWarnings,
    ...(input.scorerProvenance === undefined ? {} : { scorerProvenance: input.scorerProvenance }),
  });
  // The one final verdict fold: scoring can only make the judged verdict stricter.
  bundle.review = foldScorerFailures(bundle.review, scorerResult.failures);

  if (receiving) bundle.commsReceiving = receiving.snapshot();
  const policy = OUTCOME_POLICIES["computer-use"];
  const execution = judgeExecution(computerUseExecutionFailures(outcomes, runId), policy);
  const finished = await run.finish(bundle, {
    ok: resultOk({ judgment, execution, scorerFailures: scorerResult.failures, policy }),
    execution,
    policy,
  });
  const observer = await finished.renderObserver();
  streams.attachFinal(observer);

  return cuaStudyResult({
    studyId: plan.studyId,
    cwd,
    runId,
    actorId: descriptor.id,
    appUrl,
    dryRun,
    participantRuns,
    outcomes,
    subjects,
    aggregateSubject,
    participantPlan,
    rerunLineage,
    bundle,
    outcome: finished.outcome,
    observer,
    receivingWarnings,
    aggregateWarnings,
    adapterWarnings,
  });
}
