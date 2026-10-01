// Each lane's subject projection and the subject-state marker, from the declared subject and what
// the lanes ran.

import { commandDigestOf } from "../../subject/state.js";
import type { ComputerUsePlan } from "../../lab/plan-types.js";
import type { LabSubjectState } from "../../lab/types.js";
import { cuaDeclaredState } from "./plan.js";
import { type RunSubjectProvenance, type RunSubjectStateStepRecord } from "../../run/bundle.js";
import { type LocalTreeArchive } from "../../run/source-archive.js";
import { participantSubjectProjection } from "./lanes.js";
import { type CuaSubjectRoute } from "./plan.js";
import {
  type DesktopParticipantRun,
  type CuaSubjectProjection,
  type LaneRunOutcome,
} from "./types.js";

/**
 * Each lane's subject projection. A lane's outcome adds the subject commit it resolved and the
 * state steps it executed; without outcomes (dry run, or a run still in progress) the declared
 * state is projected as not yet run.
 */
export function projectParticipantSubjects(args: {
  routePlan: ComputerUsePlan;
  subjectRoute: CuaSubjectRoute;
  publicRepo?: string;
  localTreeArchive?: LocalTreeArchive;
  runs: readonly DesktopParticipantRun[];
  outcomes: readonly LaneRunOutcome[] | undefined;
  dryRun: boolean;
}): CuaSubjectProjection[] {
  const { subjectRoute, publicRepo, localTreeArchive } = args;
  const declaredState = cuaDeclaredState(args.routePlan);
  return args.runs.map((_spec, index) => {
    const outcome = args.outcomes?.[index];
    const subjectState = resolveSubjectState({
      declared: subjectRoute.provisionedRoute ? declaredState : undefined,
      dryRun: args.dryRun,
      executed: outcome?.stateStepRecords ?? [],
    });
    return participantSubjectProjection({
      cloneRoute: subjectRoute.cloneRoute,
      localTreeRoute: subjectRoute.localTreeRoute,
      ...(publicRepo === undefined ? {} : { publicRepo }),
      subjectEnvNames: subjectRoute.subjectEnvNames,
      ...(outcome?.subjectCommit === undefined ? {} : { subjectCommit: outcome.subjectCommit }),
      ...(localTreeArchive === undefined ? {} : { localTreeArchive }),
      subjectState,
    });
  });
}

/**
 * Resolve the bundle's state marker from the declaration and what actually ran.
 * Precedence: external declared → "unpinned" (seed records, if any, stay attached — a
 * migrated external DB is still unpinned overall); else seed declared → "seeded" only when
 * every declared step executed ok on a live run, otherwise "declared-not-run" (dry-run
 * contract bundles and failed live provisioning); no declaration → "undeclared".
 */
export function resolveSubjectState(args: {
  declared: LabSubjectState | undefined;
  dryRun: boolean;
  executed: RunSubjectStateStepRecord[];
}): RunSubjectProvenance["state"] {
  const declared = args.declared;
  if (!declared) {
    return { provenance: "undeclared" };
  }
  const declaredSeed = declared.seed ?? [];
  const external = declared.external ?? [];
  // Dry-run: nothing executes (no sandbox) — record the DECLARED recipe: name, phase, and
  // command digest only, with NO execution fields.
  const seed: RunSubjectStateStepRecord[] = args.dryRun
    ? declaredSeed.map((step) => ({
        name: step.name,
        when: step.when ?? "before-start",
        commandDigest: commandDigestOf(step.command),
      }))
    : args.executed;
  const allRanOk =
    !args.dryRun &&
    declaredSeed.length > 0 &&
    seed.length === declaredSeed.length &&
    seed.every((record) => record.ok === true);
  const provenance: RunSubjectProvenance["state"]["provenance"] =
    external.length > 0
      ? "unpinned"
      : declaredSeed.length === 0
        ? "undeclared"
        : allRanOk
          ? "seeded"
          : "declared-not-run";
  return {
    provenance,
    ...(seed.length > 0 ? { seed } : {}),
    ...(external.length > 0 ? { externalEnvNames: external } : {}),
  };
}
