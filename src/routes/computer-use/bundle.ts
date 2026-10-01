import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { ComputerUsePlan } from "../../lab/plan-types.js";
import type { RunBundle, RunRerunLineage } from "../../run/bundle.js";
import type { RunLabProvenance } from "../../run/status.js";
import { judgeOneParticipant, judgeParticipants, type Judgment } from "../../run/judge.js";
import { participantFactsOf } from "./bundle-parts.js";
import { buildCuaFanoutBundle } from "./fanout-bundle.js";
import { buildSingleParticipantBundle } from "./single-bundle.js";
import type {
  CuaParticipantPlan,
  DesktopParticipantRun,
  CuaSubjectProjection,
  CuaSubjectProvenanceArg,
  ParticipantRunOutcome,
} from "./types.js";

/** What every bundle of one run shares, in progress or final. */
export interface CuaRunBundleBase {
  lab?: RunLabProvenance;
  participantRuns: DesktopParticipantRun[];
  descriptor: CuaActorDescriptor;
  appUrl: string;
  createdAt: string;
  plan: ComputerUsePlan;
  runId: string;
  source: RunBundle["source"];
  participantPlan: CuaParticipantPlan;
  rerun?: RunRerunLineage;
  redactScreenshots: boolean;
  inProcessRoute: boolean;
  localAppSubject: boolean;
  cloneRoute: boolean;
  localTreeRoute: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
}

/** One participant without a rerun keeps the single-participant bundle shape and its rule. */
function isOneParticipantRun(base: Pick<CuaRunBundleBase, "participantRuns" | "rerun">): boolean {
  return base.participantRuns.length === 1 && base.rerun === undefined;
}

/**
 * The judgment for the current state of a computer-use run, by the rule for its shape: one
 * participant (its tallied status is the verdict) or several (every lane must pass). The bundle's
 * verdict and the lab result's ok both come from it.
 */
export function judgeComputerUseRun(
  base: Pick<CuaRunBundleBase, "participantRuns" | "rerun">,
  state: { dryRun: boolean; outcomes: ParticipantRunOutcome[] | undefined; inProgress?: true },
): Judgment {
  const inProgress = state.inProgress === true;
  if (isOneParticipantRun(base)) {
    const outcome = state.outcomes?.[0];
    return judgeOneParticipant({
      dryRun: state.dryRun,
      inProgress,
      participant: outcome === undefined ? undefined : participantFactsOf(outcome),
    });
  }
  return judgeParticipants({
    dryRun: state.dryRun,
    inProgress,
    expected: base.participantRuns.length,
    participants: (state.outcomes ?? []).map(participantFactsOf),
  });
}

/**
 * The run bundle for the current state of a computer-use run. One lane without a rerun keeps the
 * single-lane shape; a fan-out or a rerun uses the fan-out shape, which carries the plan and each
 * lane's subject.
 */
export function buildCuaRunBundle(
  base: CuaRunBundleBase,
  state: {
    judgment: Judgment;
    dryRun: boolean;
    outcomes: ParticipantRunOutcome[] | undefined;
    subjects: CuaSubjectProjection[];
    aggregateSubject: CuaSubjectProjection;
    subjectProvenance: CuaSubjectProvenanceArg | undefined;
    failFastReason?: string;
    inProgress?: true;
  },
): RunBundle {
  const lab = base.lab === undefined ? {} : { lab: base.lab };
  const inProgress = state.inProgress === undefined ? {} : { inProgress: true };
  if (isOneParticipantRun(base)) {
    const spec = base.participantRuns[0]!;
    return buildSingleParticipantBundle({
      verdict: state.judgment.verdict,
      ...lab,
      spec,
      outcome: state.outcomes?.[0],
      descriptor: base.descriptor,
      appUrl: spec.planned.targetUrl ?? base.appUrl,
      createdAt: base.createdAt,
      dryRun: state.dryRun,
      plan: base.plan,
      runId: base.runId,
      source: base.source,
      redactScreenshots: base.redactScreenshots,
      ...(state.subjectProvenance === undefined
        ? {}
        : { subjectProvenance: state.subjectProvenance }),
      inProcessRoute: base.inProcessRoute,
      localAppSubject: base.localAppSubject,
      ...inProgress,
    });
  }
  return buildCuaFanoutBundle({
    verdict: state.judgment.verdict,
    ...lab,
    specs: base.participantRuns,
    ...(state.outcomes === undefined ? {} : { outcomes: state.outcomes }),
    subjects: state.subjects,
    aggregateSubject: state.aggregateSubject,
    descriptor: base.descriptor,
    appUrl: base.appUrl,
    createdAt: base.createdAt,
    dryRun: state.dryRun,
    plan: base.plan,
    runId: base.runId,
    source: base.source,
    participantPlan: base.participantPlan,
    ...(base.rerun === undefined ? {} : { rerun: base.rerun }),
    ...(state.failFastReason === undefined ? {} : { failFastReason: state.failFastReason }),
    cloneRoute: base.cloneRoute,
    localTreeRoute: base.localTreeRoute,
    ...(base.publicRepo === undefined ? {} : { publicRepo: base.publicRepo }),
    subjectEnvNames: base.subjectEnvNames,
    ...inProgress,
  });
}
