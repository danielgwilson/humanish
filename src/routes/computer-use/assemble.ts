import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { LabConfig } from "../../lab/types.js";
import type { RunBundle, RunRerunLineage } from "../../run/bundle.js";
import type { RunLabProvenance } from "../../run/status.js";
import { buildCuaFanoutBundle } from "./fanout-bundle.js";
import { buildSingleLaneBundle } from "./single-bundle.js";
import type {
  CuaLanePlan,
  CuaLaneSpec,
  CuaSubjectProjection,
  CuaSubjectProvenanceArg,
  LaneRunOutcome,
} from "./types.js";

/** What every bundle of one run shares, in progress or final. */
export interface CuaRunBundleBase {
  lab?: RunLabProvenance;
  laneSpecs: CuaLaneSpec[];
  descriptor: CuaActorDescriptor;
  appUrl: string;
  createdAt: string;
  config: LabConfig;
  runId: string;
  source: RunBundle["source"];
  plan: CuaLanePlan;
  rerun?: RunRerunLineage;
  redactScreenshots: boolean;
  inProcessRoute: boolean;
  localAppSubject: boolean;
  cloneRoute: boolean;
  localTreeRoute: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
}

/**
 * The run bundle for the current state of a computer-use run. One lane without a rerun keeps the
 * single-lane shape; a fan-out or a rerun uses the fan-out shape, which carries the plan and each
 * lane's subject.
 */
export function buildCuaRunBundle(
  base: CuaRunBundleBase,
  state: {
    dryRun: boolean;
    outcomes: LaneRunOutcome[] | undefined;
    laneSubjects: CuaSubjectProjection[];
    aggregateSubject: CuaSubjectProjection;
    subjectProvenance: CuaSubjectProvenanceArg | undefined;
    failFastReason?: string;
    inProgress?: true;
  },
): RunBundle {
  const lab = base.lab === undefined ? {} : { lab: base.lab };
  const inProgress = state.inProgress === undefined ? {} : { inProgress: true };
  if (base.laneSpecs.length === 1 && base.rerun === undefined) {
    const spec = base.laneSpecs[0]!;
    return buildSingleLaneBundle({
      ...lab,
      spec,
      outcome: state.outcomes?.[0],
      descriptor: base.descriptor,
      appUrl: spec.targetUrl ?? base.appUrl,
      createdAt: base.createdAt,
      dryRun: state.dryRun,
      config: base.config,
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
    ...lab,
    specs: base.laneSpecs,
    ...(state.outcomes === undefined ? {} : { outcomes: state.outcomes }),
    laneSubjects: state.laneSubjects,
    aggregateSubject: state.aggregateSubject,
    descriptor: base.descriptor,
    appUrl: base.appUrl,
    createdAt: base.createdAt,
    dryRun: state.dryRun,
    config: base.config,
    runId: base.runId,
    source: base.source,
    plan: base.plan,
    ...(base.rerun === undefined ? {} : { rerun: base.rerun }),
    ...(state.failFastReason === undefined ? {} : { failFastReason: state.failFastReason }),
    cloneRoute: base.cloneRoute,
    localTreeRoute: base.localTreeRoute,
    ...(base.publicRepo === undefined ? {} : { publicRepo: base.publicRepo }),
    subjectEnvNames: base.subjectEnvNames,
    ...inProgress,
  });
}
