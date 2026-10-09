// How a computer-use run records its subject: each participant's subject and the subject-state
// marker, from the declared subject and what the participants ran, and the run-level subject
// aggregated from them. Both bundle shapes and the JSON result write what this module returns.

import { commandDigestOf } from "../../subject/state.js";
import type { ComputerUsePlan } from "../../study/plan-types.js";
import type { StudySubjectState } from "../../study/types.js";
import { cuaDeclaredState } from "./plan.js";
import { type RunSubjectProvenance, type RunSubjectStateStepRecord } from "../../run/bundle.js";
import { type LocalTreeArchive } from "../../subject/local-tree-archive.js";
import {
  type DesktopParticipantRun,
  type ParticipantRunOutcome,
  participantSubjectEnv,
} from "./types.js";

/**
 * Each participant's subject projection. A participant's outcome adds the subject commit it resolved and the
 * state steps it executed; without outcomes (dry run, or a run still in progress) the declared
 * state is projected as not yet run.
 */
export function projectParticipantSubjects(args: {
  plan: ComputerUsePlan;
  publicRepo?: string;
  localTreeArchive?: LocalTreeArchive;
  runs: readonly DesktopParticipantRun[];
  outcomes: readonly ParticipantRunOutcome[] | undefined;
  dryRun: boolean;
}): RunSubjectProvenance[] {
  const { publicRepo, localTreeArchive } = args;
  const { subject } = args.plan.runner;
  const subjectEnvNames = [...participantSubjectEnv(subject)];
  // Only a provisioned subject declares state; cuaDeclaredState is undefined for the others.
  const declaredState = cuaDeclaredState(args.plan);
  return args.runs.map((_spec, index) => {
    const outcome = args.outcomes?.[index];
    const subjectState = resolveSubjectState({
      declared: declaredState,
      dryRun: args.dryRun,
      executed: outcome?.stateStepRecords ?? [],
    });
    return participantSubjectProjection({
      subject,
      ...(publicRepo === undefined ? {} : { publicRepo }),
      subjectEnvNames,
      ...(outcome?.subjectCommit === undefined ? {} : { subjectCommit: outcome.subjectCommit }),
      ...(localTreeArchive === undefined ? {} : { localTreeArchive }),
      subjectState,
    });
  });
}

/**
 * Resolve the bundle's state marker from the declaration and what actually ran.
 * Precedence: external declared → "unpinned" (seed records, if any, stay attached; a
 * migrated external DB is still unpinned overall); else seed declared → "seeded" only when
 * every declared step executed ok on a live run, otherwise "declared-not-run" (dry-run
 * contract bundles and failed live provisioning); no declaration → "undeclared".
 */
export function resolveSubjectState(args: {
  declared: StudySubjectState | undefined;
  dryRun: boolean;
  executed: RunSubjectStateStepRecord[];
}): RunSubjectProvenance["state"] {
  const declared = args.declared;
  if (!declared) {
    return { provenance: "undeclared" };
  }
  const declaredSeed = declared.seed ?? [];
  const external = declared.external ?? [];
  // Dry-run: nothing executes (no sandbox), so record the declared recipe: name, phase, and
  // command digest only, with no execution fields.
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

/** Build the per-participant subject projection. Local-tree participants all share
 *  one host-packed archive, so every participant's projection carries the identical archiveSha256/
 *  commit/dirty (no divergence is possible, unlike the clone route's per-participant
 *  in-sandbox commit). */
function participantSubjectProjection(args: {
  subject: ComputerUsePlan["runner"]["subject"];
  publicRepo?: string;
  subjectEnvNames: string[];
  subjectCommit?: string;
  localTreeArchive?: LocalTreeArchive;
  subjectState: RunSubjectProvenance["state"];
}): RunSubjectProvenance {
  if (args.subject.kind === "clone" && args.publicRepo) {
    return {
      source: "clone",
      repo: args.publicRepo,
      ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
      envNames: args.subjectEnvNames,
      state: args.subjectState,
    };
  }
  if (args.subject.kind === "local-tree") {
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
  if (args.subject.kind === "desktop-cli") {
    return { source: "desktop-cli", product: args.subject.product.name, state: args.subjectState };
  }
  if (args.subject.kind === "local-app") return { source: "local-app", state: args.subjectState };
  return { source: "app-url", state: args.subjectState };
}

/**
 * The run-level subject for the top level and the bundle. Local-tree participants all pack from the
 * same once-per-run archive, so every participant already carries the identical archiveSha256/commit/dirty and
 * the first participant's projection is the aggregate. Clone participants each resolve their own
 * commit; the aggregate carries it only when every participant agrees, and warns when they diverge.
 */
export function aggregateCuaSubject(args: {
  subjects: readonly RunSubjectProvenance[];
  outcomes: readonly ParticipantRunOutcome[] | undefined;
  participantCount: number;
  dryRun: boolean;
}): { subject: RunSubjectProvenance; warnings: string[] } {
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
          "Participants resolved different subject commits, so the top-level subject.commit is omitted; each participant's provenance in result.lanes has its pinned commit.",
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
