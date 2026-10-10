import { adapterScoreFailureMessage, applyBrowserScorer } from "../../study/adapter-extension.js";
import { redactText } from "../../evidence/redaction.js";
import type { ObserverResult } from "../../observer/render.js";
import type { RunBundle, RunRerunLineage, RunSubjectProvenance } from "../../run/bundle.js";
import {
  foldScorerFailures,
  judgeExecution,
  judgeParticipantRecords,
  OUTCOME_POLICIES,
  participantHarnessFailed,
  resultOk,
  type ExecutionOutcome,
} from "../../run/judge.js";
import {
  readHostSuspensions,
  type HostSuspensionReading,
  type SuspendedParticipant,
} from "../../run/host-suspension.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import {
  participantExecutionFailures,
  participantOutcomeOk,
  participantFactsOf,
} from "./participant-facts.js";
import { participantCapWarning } from "./participant-model.js";
import { summarizeCuaDiagnostics } from "./diagnostics.js";
import { toParticipantResult } from "./participant-execution.js";
import { buildCuaRunBundle, judgeComputerUseRun } from "./bundle.js";
import type { runStudyParticipants } from "./live-phase.js";
import type { CuaFinishFacts, CuaRunSetup } from "./setup.js";
import { aggregateCuaSubject, projectParticipantSubjects } from "./subject-projection.js";
import {
  CUA_FANOUT_STRATEGY,
  type CuaActorStudyErrorCode,
  type CuaActorStudyResult,
  type CuaParticipantPlan,
  type CuaParticipantSummary,
  type DesktopParticipantRun,
  type ParticipantRunOutcome,
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
 * Each participant as the host-suspension reading reads it: a harness error, its session's time
 * limit or a skip, and when it started and its session ended.
 */
function suspendedParticipants(outcomes: readonly ParticipantRunOutcome[]): SuspendedParticipant[] {
  return outcomes.map((outcome) => {
    const facts = participantFactsOf(outcome);
    const trace = outcome.session?.trace;
    const failure = facts.skipped
      ? "skipped"
      : participantHarnessFailed(facts)
        ? "harness"
        : trace?.stopCause === "time_limit"
          ? "time-limit"
          : undefined;
    const startedAtMs =
      outcome.arrival?.startedAt ?? (trace === undefined ? undefined : Date.parse(trace.startedAt));
    return {
      id: outcome.spec.planned.id,
      ...(failure === undefined ? {} : { failure }),
      ...(startedAtMs === undefined ? {} : { startedAtMs }),
      ...(trace === undefined ? {} : { endedAtMs: Date.parse(trace.completedAt) }),
    };
  });
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
  subjects: RunSubjectProvenance[];
  aggregateSubject: RunSubjectProvenance;
  participantPlan: CuaParticipantPlan;
  rerunLineage: RunRerunLineage | undefined;
  bundle: RunBundle;
  /** The run's ok and execution outcome as run.json records them (FinishedRun.outcome). */
  outcome: { ok: boolean; execution: ExecutionOutcome };
  observer: ObserverResult;
  hostSuspension: HostSuspensionReading | undefined;
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
    hostSuspension,
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

  // A failure the host suspension likely caused names the suspension first.
  const suspended =
    hostSuspension !== undefined && hostSuspension.participantIds.length > 0
      ? hostSuspension.summary
      : undefined;
  const errorResult = ((): CuaActorStudyResult["error"] | undefined => {
    if (ok) return undefined;
    if (adapterFailure !== undefined) {
      return { code: "HUMANISH_COMPUTER_USE_FAILED", message: adapterFailure };
    }
    if (participantCount === 1) {
      const outcome = firstOutcome;
      return {
        code: outcome?.failureCode ?? "HUMANISH_COMPUTER_USE_FAILED",
        message: `${suspended === undefined ? "" : `${suspended} `}${
          outcome?.sessionError ??
          outcome?.providerCleanupError ??
          outcome?.providerPolicyError ??
          (outcome?.noEngagement || outcome?.selfReportedBlocker || observer.ok
            ? (participantResults[0]?.error?.message ??
              judgeParticipantRecords([participantFactsOf(outcome)]).participants[0]!
                .notPassedMessage)
            : (observer.error?.message ?? "Observer failed for the computer-use run."))
        }`,
      };
    }
    const failing = (outcomes ?? []).find((outcome) => !participantOk(outcome));
    const firstFailure =
      suspended !== undefined
        ? `; ${suspended.replace(/\.$/, "")}`
        : failing?.sessionError !== undefined
          ? `; first failure: ${failing.sessionError}`
          : failing === undefined && args.outcome.execution.failures[0] !== undefined
            ? `; ${args.outcome.execution.failures[0].message}`
            : "";
    // A participant whose desktop failed for a known cause gives the run that cause's code.
    const codedFailure = (outcomes ?? []).find((outcome) => outcome.failureCode !== undefined);
    const code: CuaActorStudyErrorCode =
      codedFailure?.failureCode ?? "HUMANISH_COMPUTER_USE_FAILED";
    return {
      code,
      message: observer.ok
        ? `Fan-out run failed: ${summary.passed}/${plural(participantCount, "participant")} passed (${summary.skipped} skipped, ${plural(summary.harnessErrors, "harness error")}, ${summary.hollow} without engagement)${firstFailure}.`
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
    ...(hostSuspension === undefined ? {} : { hostSuspension }),
    warnings,
    ...(errorResult === undefined ? {} : { error: errorResult }),
  };
}

/** Builds and publishes the final bundle, runs the adapter hooks, renders the Observer and returns the result. */
export async function finishCuaRun(
  setup: CuaRunSetup,
  finish: CuaFinishFacts,
  ran: Extract<Awaited<ReturnType<typeof runStudyParticipants>>, { ok: true }>,
): Promise<CuaActorStudyResult> {
  const { plan, input, cwd, streams, descriptor, run } = setup;
  const { participantRuns, participantPlan, bundleBase } = setup;
  const { rerunLineage, subjectArgs } = finish;
  const { dryRun } = plan;
  const appUrl = plannedAppUrl(plan.runner.subject);
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
  // One judgment for the whole run: the bundle's verdict and the result's ok both read it.
  const judgment = judgeComputerUseRun(bundleBase, { dryRun, outcomes });
  // One reading of the host suspensions: the review, the outcome and the result all name it.
  const hostSuspension = readHostSuspensions(
    run.hostSuspensions(),
    suspendedParticipants(outcomes ?? []),
    Date.parse(run.createdAt),
  );
  const bundle = buildCuaRunBundle(bundleBase, {
    judgment,
    dryRun,
    outcomes,
    subjects,
    aggregateSubject,
    ...(failFastReason === undefined ? {} : { failFastReason }),
    ...(hostSuspension === undefined ? {} : { hostSuspension }),
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
  // FinishedRun.renderObserver adds an Observer that did not render. A suspension that likely
  // caused participant failures is the run's first failure, ahead of each one it explains.
  const execution = judgeExecution(
    [
      ...(hostSuspension !== undefined && hostSuspension.participantIds.length > 0
        ? [{ kind: "run" as const, message: hostSuspension.summary }]
        : []),
      ...participantExecutionFailures(outcomes, runId),
    ],
    policy,
  );
  const finished = await run.finish(bundle, {
    ok: resultOk({ judgment, execution, scorerFailures: scorerResult.failures, policy }),
    execution,
    policy,
  });
  const observer = await finished.renderObserver();
  // A caller's renderer runs with this process's file access, so after one that reports success
  // the run directory is checked again before the result points anyone at it. A failed render is
  // already an evidence failure, and its error code stays the run's diagnosis.
  if (observer.ok) await validatePreparedRunArtifactPaths(finished.paths);
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
    hostSuspension,
    receivingWarnings,
    aggregateWarnings,
    adapterWarnings,
  });
}
