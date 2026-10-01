import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks,
} from "../../lab/adapter-extension.js";
import { redactText } from "../../evidence/redaction.js";
import type { ObserverResult } from "../../observer/render.js";
import type { RunBundle, RunRerunLineage } from "../../run/bundle.js";
import { foldScorerFailures, type Judgment } from "../../run/judge.js";
import { buildLaneSummary, laneOutcomeOk } from "./bundle.js";
import { summarizeCuaDiagnostics } from "./diagnostics.js";
import {
  aggregateCuaSubject,
  perLaneCapWarning,
  subjectProvenanceArg,
  toLaneResult,
} from "./lanes.js";
import { buildCuaRunBundle, judgeComputerUseRun } from "./assemble.js";
import type { runLabLanes } from "./run-lanes.js";
import type { CuaRunSetup } from "./setup.js";
import { projectLaneSubjects } from "./subject-projection.js";
import {
  CUA_ACTOR_LAB_SCHEMA,
  type CuaActorLabErrorCode,
  type CuaActorLabResult,
  type CuaLanePlan,
  type DesktopParticipantRun,
  type CuaSubjectProjection,
  type LaneRunOutcome,
} from "./types.js";

/**
 * The computer-use lab result for a finished run. The run passes only when the Observer rendered,
 * every lane passed (dry-run lanes pass as contracts), and no adapter score or declared scorer
 * verdict failed; otherwise the error names the first reason.
 */
function cuaLabResult(args: {
  labId: string;
  cwd: string;
  runId: string;
  actorId: string;
  appUrl: string;
  dryRun: boolean;
  laneSpecs: DesktopParticipantRun[];
  outcomes: LaneRunOutcome[] | undefined;
  laneSubjects: CuaSubjectProjection[];
  aggregateSubject: CuaSubjectProjection;
  plan: CuaLanePlan;
  rerunLineage: RunRerunLineage | undefined;
  bundle: RunBundle;
  /** The run's judgment; ok requires every participant to have passed. */
  judgment: Judgment;
  observer: ObserverResult;
  /** Why the scorer failed the run; already folded into the bundle's review. */
  scorerFailures: readonly string[];
  receivingWarnings: string[];
  aggregateWarnings: string[];
  adapterWarnings: string[];
}): CuaActorLabResult {
  const {
    labId,
    cwd,
    runId,
    appUrl,
    dryRun,
    laneSpecs,
    outcomes,
    laneSubjects,
    aggregateSubject,
    plan,
    rerunLineage,
    bundle,
    observer,
    receivingWarnings,
    aggregateWarnings,
    adapterWarnings,
  } = args;
  const laneCount = laneSpecs.length;
  // Lane-level pass: dry-run lanes are contract-ok; live lanes need a passed, engaged session.
  const laneOk = (outcome: LaneRunOutcome | undefined): boolean => laneOutcomeOk(outcome, dryRun);
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok = observer.ok && args.judgment.allPassed && args.scorerFailures.length === 0;

  const laneWarnings = (outcomes ?? []).flatMap((outcome) => outcome.warnings);
  const warnings = [
    ...receivingWarnings,
    ...laneWarnings,
    ...aggregateWarnings,
    ...adapterWarnings,
    ...observer.warnings,
  ];

  const laneResults = laneSpecs.map((spec, index) =>
    toLaneResult(spec, outcomes?.[index], laneSubjects[index]!, dryRun),
  );
  const laneSummary = buildLaneSummary(outcomes, laneCount, plan, dryRun);
  const firstOutcome = outcomes?.[0];

  const errorResult = ((): CuaActorLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (adapterFailure !== undefined) {
      return {
        code: "HUMANISH_CUA_LAB_FAILED",
        message: adapterFailure,
      };
    }
    if (laneCount === 1) {
      const outcome = firstOutcome;
      return {
        code: outcome?.failureCode ?? "HUMANISH_CUA_LAB_FAILED",
        message:
          outcome?.sessionError ??
          (outcome?.noEngagement
            ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
            : // The lane result (toLaneResult) named this refusal; the N=1 envelope fell through to
              // "did not produce a terminal session", which is false — it produced one and refused it.
              outcome?.selfReportedBlocker
              ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
              : observer.ok
                ? outcome?.session?.completionReason === "harness_error"
                  ? `Computer-use session ended with a harness error: ${outcome.session.reason}`
                  : outcome?.session?.status !== "passed"
                    ? `Computer-use session ended with ${outcome?.session?.status ?? "unknown"}: ${outcome?.session?.reason ?? "no terminal reason"}`
                    : "Computer-use lab did not produce a terminal session."
                : (observer.error?.message ?? "Observer failed for the computer-use lab run.")),
      };
    }
    const failingLane = (outcomes ?? []).find((outcome) => !laneOk(outcome));
    const geometryLane = (outcomes ?? []).find(
      (outcome) => outcome.failureCode === "HUMANISH_CUA_LAB_DEVICE_GEOMETRY",
    );
    const code: CuaActorLabErrorCode = geometryLane?.failureCode ?? "HUMANISH_CUA_LAB_FAILED";
    return {
      code,
      message: observer.ok
        ? `Fan-out run failed: ${laneSummary.passed}/${laneCount} lane(s) passed (${laneSummary.skipped} skipped, ${laneSummary.harnessErrors} harness error(s), ${laneSummary.hollow} hollow)${failingLane?.sessionError ? `; first failure: ${failingLane.sessionError}` : ""}.`
        : (observer.error?.message ?? "Observer failed for the computer-use fan-out run."),
    };
  })();

  return {
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok,
    cwd,
    labId,
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
    plan,
    lanes: laneResults,
    diagnostics: summarizeCuaDiagnostics({
      dryRun,
      evidenceInvalid: !observer.ok,
      lanes: laneResults,
    }),
    laneSummary,
    ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
    observer,
    warnings,
    ...(errorResult === undefined ? {} : { error: errorResult }),
  };
}

/** Builds and publishes the final bundle, runs the adapter hooks, renders the Observer and returns the result. */
export async function finishCuaRun(
  setup: CuaRunSetup,
  lanes: Extract<Awaited<ReturnType<typeof runLabLanes>>, { ok: true }>,
): Promise<CuaActorLabResult> {
  const {
    routePlan,
    input,
    config,
    dryRun,
    cwd,
    hooks,
    streams,
    appUrl,
    descriptor,
    laneSpecs,
    plan,
    rerunLineage,
    laneCount,
    scrubKnownValues,
    publicRepo,
    subjectEnvNames,
    run,
    runId,
    physicalArtifactRoot,
    subjectArgs,
    bundleBase,
  } = setup;
  const { outcomes, failFastReason, receiving, receivingWarnings, externalCommsWarnings } = lanes;
  // Per-lane subject projections (invariant 5).
  const laneSubjects = projectLaneSubjects({ ...subjectArgs, outcomes, dryRun });

  const aggregate = aggregateCuaSubject({ laneSubjects, outcomes, laneCount, dryRun });
  const aggregateSubject = aggregate.subject;
  const capWarning = perLaneCapWarning(config, laneCount);
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
    laneSubjects,
    aggregateSubject,
    subjectProvenance: finalProvenance,
    ...(failFastReason === undefined ? {} : { failFastReason }),
  });

  const adapterWarnings: string[] = [];
  const scorerResult = await applyBrowserAdapterHooks({
    hooks,
    bundle,
    context: {
      bundle,
      runDir: physicalArtifactRoot,
      labId: routePlan.labId,
      runId,
      actor: descriptor.id,
      backend: "cua",
      dryRun,
      laneCount,
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "cuaHooks",
    ...(input.scorerProvenance === undefined ? {} : { scorerProvenance: input.scorerProvenance }),
  });
  // The one final verdict fold: scoring can only make the judged verdict stricter.
  bundle.review = foldScorerFailures(bundle.review, scorerResult.failures);

  if (receiving) bundle.commsReceiving = receiving.snapshot();
  const finished = await run.finish(bundle);
  const observer = await finished.renderObserver();
  streams.attachFinal(observer);

  return cuaLabResult({
    labId: routePlan.labId,
    cwd,
    runId,
    actorId: descriptor.id,
    appUrl,
    dryRun,
    laneSpecs,
    outcomes,
    laneSubjects,
    aggregateSubject,
    plan,
    rerunLineage,
    bundle,
    judgment,
    observer,
    scorerFailures: scorerResult.failures,
    receivingWarnings,
    aggregateWarnings,
    adapterWarnings,
  });
}
