// A rerun narrowed to the participants it selects: the source run is read from disk, and the
// participants that failed, blocked, timed out or finished hollow are picked unless ids are given.

import { type RunRerunLineage } from "../../run/bundle.js";
import { loadRunBundle } from "../../run/locate.js";
import { resolveLatestRunPointer } from "../../run/paths.js";
import { type RunStream } from "../../run/streams.js";
import type { CuaParticipantPlan, DesktopParticipantRun } from "./types.js";
import { plural } from "../../run/text.js";
import { access } from "node:fs/promises";
import { cli } from "../../cli/invocation.js";

export async function resolveCuaRerunSelection(args: {
  cwd: string;
  studyId: string;
  sandboxMs: number;
  sourceRunId: string;
  participantIds?: string[];
  participantRuns: DesktopParticipantRun[];
  participantPlan: CuaParticipantPlan;
}): Promise<
  | {
      ok: true;
      participantRuns: DesktopParticipantRun[];
      participantPlan: CuaParticipantPlan;
      rerun: RunRerunLineage;
    }
  | { ok: false; message: string }
> {
  const { studyId, sourceRunId } = args;
  // Every refusal ends with the command that runs the whole study, which is what a user who
  // reached for a rerun too early wants.
  const instead = `To run every participant of ${studyId} instead, leave out --rerun-failed-from: ${cli(`watch ${studyId}`)} or ${cli(`run ${studyId}`)}.`;
  const refuse = (what: string) => ({ ok: false as const, message: `${what} ${instead}` });
  const source = await loadRunBundle(args.cwd, sourceRunId);
  if (!source) {
    const noRuns =
      sourceRunId === "latest" &&
      !(await access(resolveLatestRunPointer(args.cwd)).then(
        () => true,
        () => false,
      ));
    return refuse(
      noRuns
        ? "--rerun-failed-from latest found no run: this project has no runs yet, and a rerun repeats the failed participants of an earlier live run."
        : `--rerun-failed-from ${sourceRunId} names no run humanish can read in this project. ${cli("runs")} lists its runs.`,
    );
  }
  const bundle = source.bundle;
  const run = `Run ${bundle.runId}${sourceRunId === bundle.runId ? "" : ` (the ${sourceRunId} run)`}`;
  const notFanout = `${run} is not a live computer-use run with more than one participant, so it has no participants to rerun.`;
  if (bundle.mode !== "live") {
    return refuse(
      `${run} is a dry run: no participant ran in it, so none can be rerun. A rerun repeats the failed participants of a live run with more than one participant.`,
    );
  }
  const fanoutEvent = bundle.events.some((event) => event.type === "cua-lab.fanout.plan");
  if (!fanoutEvent || bundle.streams.length < 2) return refuse(notFanout);

  const prior = bundle.streams
    .map(snapshotPriorParticipant)
    .filter(
      (entry): entry is NonNullable<ReturnType<typeof snapshotPriorParticipant>> => entry !== null,
    );
  const priorById = new Map(prior.map((entry) => [entry.participantId, entry]));
  if (priorById.size < 2) return refuse(notFanout);

  const explicitIds = uniqueIds(args.participantIds ?? []);
  const selectedIds =
    explicitIds.length > 0
      ? explicitIds
      : prior.filter((entry) => entry.rerunnable).map((entry) => entry.participantId);
  if (selectedIds.length === 0)
    return refuse(
      `${run} has no participant to rerun: none failed, was blocked, timed out or ended without engaging.`,
    );

  const missingPrior = selectedIds.filter((id) => !priorById.has(id));
  if (missingPrior.length > 0) {
    return {
      ok: false,
      message: `${plural(missingPrior.length, "selected participant id")} ${missingPrior.length === 1 ? "was" : "were"} not present in source run ${bundle.runId}: ${missingPrior.join(", ")}`,
    };
  }

  const specsById = new Map(args.participantRuns.map((spec) => [spec.planned.id, spec]));
  const missingCurrent = selectedIds.filter((id) => !specsById.has(id));
  if (missingCurrent.length > 0) {
    return {
      ok: false,
      message: `${plural(missingCurrent.length, "selected participant id")} ${missingCurrent.length === 1 ? "is" : "are"} not present in the current study file ${args.studyId}: ${missingCurrent.join(", ")}`,
    };
  }

  const selectedSpecs = selectedIds.map((id) => specsById.get(id)!);
  const selectedPlanIds = new Set(selectedIds);
  const selectedPlanEntries = args.participantPlan.lanes.filter((entry) =>
    selectedPlanIds.has(entry.id),
  );
  const concurrency = Math.max(1, Math.min(args.participantPlan.concurrency, selectedSpecs.length));
  const participantPlan: CuaParticipantPlan = {
    ...args.participantPlan,
    laneCount: selectedSpecs.length,
    concurrency,
    waves: Math.ceil(selectedSpecs.length / concurrency),
    worstCaseSandboxMinutes: Math.round((selectedSpecs.length * args.sandboxMs) / 60_000),
    lanes: selectedPlanEntries,
  };

  const previous = selectedIds.map((id) => priorById.get(id)!.previous);
  return {
    ok: true,
    participantRuns: selectedSpecs,
    participantPlan,
    rerun: {
      sourceRunId: bundle.runId,
      selectedLaneIds: selectedIds,
      previous,
    },
  };
}

function uniqueIds(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function snapshotPriorParticipant(stream: RunStream): {
  participantId: string;
  previous: RunRerunLineage["previous"][number];
  rerunnable: boolean;
} | null {
  if (stream.kind !== "browser" || typeof stream.laneId !== "string" || !stream.laneId.trim()) {
    return null;
  }
  const actorStatus = stream.actor?.status;
  const completionReason = stream.actor?.completionReason;
  const reason = stream.ui?.state ?? stream.actor?.reason;
  const actions = stream.actor?.counts.actions ?? 0;
  const messages = stream.actor?.counts.messages ?? 0;
  // The judge's status decides, so a participant the review counts as blocked is rerunnable. A
  // bundle written before streams carried it falls back to the trace status and counts.
  const hollow = completionReason === "goal_satisfied" && actions === 0 && messages === 0;
  const rerunnable =
    stream.judgedStatus !== undefined
      ? stream.judgedStatus !== "passed"
      : stream.status !== "passed" ||
        actorStatus === "failed" ||
        actorStatus === "blocked" ||
        actorStatus === "timed_out" ||
        completionReason === "harness_error" ||
        hollow;
  return {
    participantId: stream.laneId,
    previous: {
      laneId: stream.laneId,
      streamId: stream.id,
      status: stream.status,
      ...(reason === undefined ? {} : { reason }),
      ...(actorStatus === undefined ? {} : { actorStatus }),
      ...(completionReason === undefined ? {} : { completionReason }),
    },
    rerunnable,
  };
}
