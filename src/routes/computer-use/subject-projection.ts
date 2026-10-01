// Each lane's subject projection and the subject-state marker, from the declared subject and what
// the lanes ran; the run-level subject aggregated from them; and the provenance argument the
// bundle builders take.

import { commandDigestOf } from "../../subject/state.js";
import type { ComputerUsePlan } from "../../lab/plan-types.js";
import type { LabSubjectState } from "../../lab/types.js";
import { cuaDeclaredState } from "./plan.js";
import { type RunSubjectProvenance, type RunSubjectStateStepRecord } from "../../run/bundle.js";
import { type LocalTreeArchive } from "../../subject/local-tree-archive.js";
import { type CuaSubjectRoute } from "./plan.js";
import {
  type DesktopParticipantRun,
  type CuaSubjectProjection,
  type CuaSubjectProvenanceArg,
  type ParticipantRunOutcome,
} from "./types.js";

/**
 * Each lane's subject projection. A lane's outcome adds the subject commit it resolved and the
 * state steps it executed; without outcomes (dry run, or a run still in progress) the declared
 * state is projected as not yet run.
 */
export function projectParticipantSubjects(args: {
  plan: ComputerUsePlan;
  subjectRoute: CuaSubjectRoute;
  publicRepo?: string;
  localTreeArchive?: LocalTreeArchive;
  runs: readonly DesktopParticipantRun[];
  outcomes: readonly ParticipantRunOutcome[] | undefined;
  dryRun: boolean;
}): CuaSubjectProjection[] {
  const { subjectRoute, publicRepo, localTreeArchive } = args;
  const declaredState = cuaDeclaredState(args.plan);
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

/** Build the per-lane subject projection (invariant 5). Local-tree lanes all share ONE
 *  host-packed archive, so every lane's projection carries the identical archiveSha256/
 *  commit/dirty (no per-lane divergence is possible, unlike the clone route's per-lane
 *  in-sandbox commit). */
function participantSubjectProjection(args: {
  cloneRoute: boolean;
  localTreeRoute: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
  subjectCommit?: string;
  localTreeArchive?: LocalTreeArchive;
  subjectState: RunSubjectProvenance["state"];
}): CuaSubjectProjection {
  if (args.cloneRoute && args.publicRepo) {
    return {
      source: "clone",
      repo: args.publicRepo,
      ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
      envNames: args.subjectEnvNames,
      state: args.subjectState,
    };
  }
  if (args.localTreeRoute) {
    const archive = args.localTreeArchive;
    return {
      source: "local-tree",
      ...(archive === undefined ? {} : { archiveSha256: archive.archiveSha256 }),
      ...(archive?.git === undefined
        ? {}
        : { commit: archive.git.commit, dirty: archive.git.dirty }),
      envNames: args.subjectEnvNames,
      state: args.subjectState,
    };
  }
  return { source: "app-url", state: args.subjectState };
}

/** Narrow a resolved CuaSubjectProjection into the shape buildSingleParticipantBundle's
 *  subjectProvenance param wants (provisioned-route sources only; app-url stays undeclared, the
 *  default branch that builder already handles). */
export function subjectProvenanceArg(
  subject: CuaSubjectProjection,
  publicRepo: string | undefined,
  subjectEnvNames: string[],
): CuaSubjectProvenanceArg | undefined {
  if (subject.source === "clone" && publicRepo) {
    return {
      source: "clone",
      repo: publicRepo,
      ...(subject.commit === undefined ? {} : { commit: subject.commit }),
      envNames: subjectEnvNames,
      state: subject.state,
    };
  }
  if (subject.source === "local-tree") {
    return {
      source: "local-tree",
      ...(subject.archiveSha256 === undefined ? {} : { archiveSha256: subject.archiveSha256 }),
      ...(subject.commit === undefined ? {} : { commit: subject.commit }),
      ...(subject.dirty === undefined ? {} : { dirty: subject.dirty }),
      envNames: subjectEnvNames,
      state: subject.state,
    };
  }
  return undefined;
}

/**
 * The run-level subject for the top level and the bundle. Local-tree lanes all pack from the same
 * once-per-run archive, so every lane already carries the identical archiveSha256/commit/dirty and
 * the first lane's projection is the aggregate. Clone lanes each resolve their own commit; the
 * aggregate carries it only when every lane agrees, and warns when they diverge.
 */
export function aggregateCuaSubject(args: {
  subjects: readonly CuaSubjectProjection[];
  outcomes: readonly ParticipantRunOutcome[] | undefined;
  participantCount: number;
  dryRun: boolean;
}): { subject: CuaSubjectProjection; warnings: string[] } {
  const { subjects, outcomes, participantCount, dryRun } = args;
  const first = subjects[0]!;
  if (first.source !== "clone") return { subject: first, warnings: [] };
  const commits = (outcomes ?? [])
    .map((outcome) => outcome.subjectCommit)
    .filter((commit): commit is string => commit !== undefined);
  const unanimous = !dryRun && commits.length === participantCount && new Set(commits).size === 1;
  const warnings =
    !dryRun && participantCount > 1 && new Set(commits).size > 1
      ? [
          "Fan-out lanes resolved DIVERGENT subject commits — the top-level subject.commit is omitted; see per-lane provenance in result.lanes for each lane's pinned commit.",
        ]
      : [];
  return {
    subject: {
      source: "clone",
      ...(first.repo === undefined ? {} : { repo: first.repo }),
      ...(first.envNames === undefined ? {} : { envNames: first.envNames }),
      state: first.state,
      ...(unanimous && commits[0] !== undefined ? { commit: commits[0] } : {}),
    },
    warnings,
  };
}
