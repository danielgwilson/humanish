// A rerun narrowed to the participants it selects: the source run is read from disk, and the
// participants that failed, blocked, timed out or finished hollow are picked unless ids are given.

import { type RunRerunLineage } from "../../run/bundle.js";
import { loadRunBundle } from "../../run/locate.js";
import { type RunStream } from "../../run/streams.js";
import type { CuaParticipantPlan, DesktopParticipantRun } from "./types.js";

export async function resolveCuaRerunSelection(args: {
  cwd: string;
  labId: string;
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
  const source = await loadRunBundle(args.cwd, args.sourceRunId);
  if (!source) {
    return { ok: false, message: `source run not found or invalid: ${args.sourceRunId}` };
  }
  const bundle = source.bundle;
  if (bundle.mode !== "live") {
    return {
      ok: false,
      message: `source run ${bundle.runId} is ${bundle.mode}; rerun selection only applies to live CUA fan-out evidence.`,
    };
  }
  const fanoutEvent = bundle.events.some((event) => event.type === "cua-lab.fanout.plan");
  if (!fanoutEvent || bundle.streams.length < 2) {
    return { ok: false, message: `source run ${bundle.runId} is not a CUA fan-out run.` };
  }

  const prior = bundle.streams
    .map(snapshotPriorParticipant)
    .filter(
      (entry): entry is NonNullable<ReturnType<typeof snapshotPriorParticipant>> => entry !== null,
    );
  const priorById = new Map(prior.map((entry) => [entry.participantId, entry]));
  if (priorById.size < 2) {
    return {
      ok: false,
      message: `source run ${bundle.runId} does not expose multiple participant ids.`,
    };
  }

  const explicitIds = uniqueIds(args.participantIds ?? []);
  const selectedIds =
    explicitIds.length > 0
      ? explicitIds
      : prior.filter((entry) => entry.rerunnable).map((entry) => entry.participantId);
  if (selectedIds.length === 0) {
    return {
      ok: false,
      message: `source run ${bundle.runId} has no participant to rerun: none failed, was blocked, timed out or ended without engaging.`,
    };
  }

  const missingPrior = selectedIds.filter((id) => !priorById.has(id));
  if (missingPrior.length > 0) {
    return {
      ok: false,
      message: `selected participant id(s) were not present in source run ${bundle.runId}: ${missingPrior.join(", ")}`,
    };
  }

  const specsById = new Map(args.participantRuns.map((spec) => [spec.planned.id, spec]));
  const missingCurrent = selectedIds.filter((id) => !specsById.has(id));
  if (missingCurrent.length > 0) {
    return {
      ok: false,
      message: `selected participant id(s) are not present in the current lab config ${args.labId}: ${missingCurrent.join(", ")}`,
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
