import { adapterScoreFailureMessage } from "../../lab/adapter-extension.js";
import type { ObserverResult } from "../../observer/render.js";
import type { RunBundle, RunRerunLineage } from "../../run/bundle.js";
import type { LabConfig } from "../../lab/types.js";
import { buildLaneSummary, laneOutcomeOk } from "./bundle.js";
import { summarizeCuaDiagnostics } from "./diagnostics.js";
import { toLaneResult } from "./lanes.js";
import {
  CUA_ACTOR_LAB_SCHEMA,
  type CuaActorLabErrorCode,
  type CuaActorLabResult,
  type CuaLanePlan,
  type CuaLaneSpec,
  type CuaSubjectProjection,
  type LaneRunOutcome,
} from "./types.js";

/**
 * The computer-use lab result for a finished run. The run passes only when the Observer rendered,
 * every lane passed (dry-run lanes pass as contracts), and no adapter score or declared scorer
 * verdict failed; otherwise the error names the first reason.
 */
export function cuaLabResult(args: {
  config: LabConfig;
  cwd: string;
  runId: string;
  actorId: string;
  appUrl: string;
  dryRun: boolean;
  laneSpecs: CuaLaneSpec[];
  outcomes: LaneRunOutcome[] | undefined;
  laneSubjects: CuaSubjectProjection[];
  aggregateSubject: CuaSubjectProjection;
  plan: CuaLanePlan;
  rerunLineage: RunRerunLineage | undefined;
  bundle: RunBundle;
  observer: ObserverResult;
  declaredVerdictFailure: string | undefined;
  receivingWarnings: string[];
  aggregateWarnings: string[];
  adapterWarnings: string[];
}): CuaActorLabResult {
  const {
    config,
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
  const allLanesOk = laneSpecs.every((_, index) => laneOk(outcomes?.[index]));
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok =
    observer.ok &&
    allLanesOk &&
    adapterFailure === undefined &&
    args.declaredVerdictFailure === undefined;

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
    labId: config.id,
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
