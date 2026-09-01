// `humanish stats`: what a directory of studies cost and how they came out (#472).
//
// Every number here already exists per bundle. What did not exist was the roll-up, so "what has
// this month of studies cost" meant reading run.json files by hand. The rules the per-run numbers
// live by carry over unchanged: an estimate is labelled an estimate, a run whose cost is unknown
// counts as unknown and never as zero, and every rate has a denominator next to it.

import path from "node:path";

import { readRunIndex, type RunIndexEntry } from "./run-index.js";

export const STATS_SCHEMA = "humanish.stats.v1";

export interface StatsParticipants {
  total: number;
  reachedGoal: number;
  reportedFriction: number;
}

export interface StatsLabRow {
  lab: string;
  runs: number;
  live: number;
  dryRun: number;
  /** Runs whose bundle carries a verdict; the denominator for passRate. */
  judged: number;
  passed: number;
  /** passed / judged, absent when judged is 0. */
  passRate?: number;
  /** Over live runs with both timestamps. */
  medianDurationMs?: number;
  durationSamples: number;
  /** Over runs with a known estimate. */
  medianCostUsd?: number;
  costSamples: number;
  /** Runs with no estimate: a subscription brain, an interrupted run, an old bundle. Never zero. */
  unpricedRuns: number;
  participants: StatsParticipants;
}

export interface StatsDayRow {
  day: string;
  runs: number;
  live: number;
  estimatedSpendUsd: number;
  unpricedRuns: number;
}

export interface StatsResult {
  schema: typeof STATS_SCHEMA;
  ok: true;
  cwd: string;
  since?: string;
  lab?: string;
  totals: {
    runs: number;
    live: number;
    dryRun: number;
    running: number;
    /** Sum over runs with a known estimate. */
    estimatedSpendUsd: number;
    unpricedRuns: number;
    participants: StatsParticipants;
    verdicts: Record<string, number>;
  };
  labs: StatsLabRow[];
  days: StatsDayRow[];
  /** Directories that could not be read, by name — surfaced, never silently dropped. */
  unreadable: string[];
  note: string;
}

export const STATS_NOTE =
  "Every dollar figure is an estimate summed from per-run rate-table estimates, never a provider charge. "
  + "A run with no estimate (a subscription brain, an interrupted run, an older bundle) is counted in unpricedRuns and adds nothing to the sum.";

export interface StatsOptions {
  /** ISO date or datetime; runs that started before it are excluded. */
  since?: string;
  /** Lab id; runs from other labs are excluded. */
  lab?: string;
  nowMs?: number;
}

export interface StatsFailure {
  schema: typeof STATS_SCHEMA;
  ok: false;
  cwd: string;
  error: { code: "HUMANISH_STATS_INVALID_SINCE"; message: string };
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function emptyParticipants(): StatsParticipants {
  return { total: 0, reachedGoal: 0, reportedFriction: 0 };
}

function addParticipants(into: StatsParticipants, entry: RunIndexEntry): void {
  if (entry.participants === undefined) return;
  into.total += entry.participants.total;
  into.reachedGoal += entry.participants.reachedGoal;
  into.reportedFriction += entry.participants.reportedFriction ?? 0;
}

function entryTime(entry: RunIndexEntry): string | undefined {
  return entry.startedAt ?? entry.completedAt ?? entry.updatedAt;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function computeStats(cwdInput: string, options: StatsOptions = {}): Promise<StatsResult | StatsFailure> {
  const cwd = path.resolve(cwdInput);
  let sinceMs: number | undefined;
  if (options.since !== undefined) {
    sinceMs = Date.parse(options.since);
    if (Number.isNaN(sinceMs)) {
      return {
        schema: STATS_SCHEMA,
        ok: false,
        cwd,
        error: { code: "HUMANISH_STATS_INVALID_SINCE", message: `--since must be an ISO date or datetime, got "${options.since}".` }
      };
    }
  }

  const index = await readRunIndex(cwd, options.nowMs === undefined ? {} : { nowMs: options.nowMs });
  const selected = index.runs.filter((entry) => {
    if (options.lab !== undefined && entry.lab?.id !== options.lab) return false;
    if (sinceMs !== undefined) {
      const at = entryTime(entry);
      if (at === undefined) return false;
      const atMs = Date.parse(at);
      if (Number.isNaN(atMs) || atMs < sinceMs) return false;
    }
    return true;
  });

  const totals: StatsResult["totals"] = {
    runs: 0,
    live: 0,
    dryRun: 0,
    running: 0,
    estimatedSpendUsd: 0,
    unpricedRuns: 0,
    participants: emptyParticipants(),
    verdicts: {}
  };
  const labs = new Map<string, StatsLabRow & { durations: number[]; costs: number[] }>();
  const days = new Map<string, StatsDayRow>();

  for (const entry of selected) {
    totals.runs += 1;
    if (entry.mode === "live") totals.live += 1;
    if (entry.mode === "dry-run") totals.dryRun += 1;
    if (entry.liveness === "running") totals.running += 1;
    const priced = typeof entry.estimatedCostUsd === "number";
    if (priced) totals.estimatedSpendUsd += entry.estimatedCostUsd as number;
    else totals.unpricedRuns += 1;
    addParticipants(totals.participants, entry);
    if (entry.verdict !== undefined) totals.verdicts[entry.verdict] = (totals.verdicts[entry.verdict] ?? 0) + 1;

    const labId = entry.lab?.id ?? "(no lab)";
    let row = labs.get(labId);
    if (row === undefined) {
      row = {
        lab: labId, runs: 0, live: 0, dryRun: 0, judged: 0, passed: 0, durationSamples: 0, costSamples: 0,
        unpricedRuns: 0, participants: emptyParticipants(), durations: [], costs: []
      };
      labs.set(labId, row);
    }
    row.runs += 1;
    if (entry.mode === "live") row.live += 1;
    if (entry.mode === "dry-run") row.dryRun += 1;
    if (entry.verdict !== undefined) {
      row.judged += 1;
      if (entry.verdict === "pass") row.passed += 1;
    }
    if (entry.mode === "live" && entry.durationMs !== undefined) row.durations.push(entry.durationMs);
    if (priced) row.costs.push(entry.estimatedCostUsd as number);
    else row.unpricedRuns += 1;
    addParticipants(row.participants, entry);

    const at = entryTime(entry);
    const day = at === undefined ? "(undated)" : at.slice(0, 10);
    let dayRow = days.get(day);
    if (dayRow === undefined) {
      dayRow = { day, runs: 0, live: 0, estimatedSpendUsd: 0, unpricedRuns: 0 };
      days.set(day, dayRow);
    }
    dayRow.runs += 1;
    if (entry.mode === "live") dayRow.live += 1;
    if (priced) dayRow.estimatedSpendUsd += entry.estimatedCostUsd as number;
    else dayRow.unpricedRuns += 1;
  }

  const labRows: StatsLabRow[] = [...labs.values()]
    .map(({ durations, costs, ...row }) => ({
      ...row,
      ...(row.judged === 0 ? {} : { passRate: round(row.passed / row.judged) }),
      ...(durations.length === 0 ? {} : { medianDurationMs: Math.round(median(durations)!) }),
      durationSamples: durations.length,
      ...(costs.length === 0 ? {} : { medianCostUsd: round(median(costs)!) }),
      costSamples: costs.length
    }))
    .sort((a, b) => b.runs - a.runs || a.lab.localeCompare(b.lab));

  return {
    schema: STATS_SCHEMA,
    ok: true,
    cwd,
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    totals: { ...totals, estimatedSpendUsd: round(totals.estimatedSpendUsd) },
    labs: labRows,
    days: [...days.values()].map((row) => ({ ...row, estimatedSpendUsd: round(row.estimatedSpendUsd) })).sort((a, b) => a.day.localeCompare(b.day)),
    unreadable: index.unreadable,
    note: STATS_NOTE
  };
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatStatsHuman(result: StatsResult | StatsFailure): string {
  if (!result.ok) return `${result.error.code}: ${result.error.message}\n`;
  const t = result.totals;
  const scope = [
    result.lab === undefined ? undefined : `lab ${result.lab}`,
    result.since === undefined ? undefined : `since ${result.since}`
  ].filter((part): part is string => part !== undefined);
  const lines = [
    `humanish stats${scope.length === 0 ? "" : ` (${scope.join(", ")})`}`,
    `runs: ${t.runs} (${t.live} live, ${t.dryRun} dry-run${t.running > 0 ? `, ${t.running} running` : ""})`,
    `estimated spend: ${money(t.estimatedSpendUsd)} over ${t.runs - t.unpricedRuns} priced run(s); ${t.unpricedRuns} unpriced (counted, not $0)`,
    `participants: ${t.participants.reachedGoal}/${t.participants.total} reached the goal, ${t.participants.reportedFriction} reported friction`,
    `verdicts: ${Object.entries(t.verdicts).map(([verdict, count]) => `${verdict} ${count}`).join(", ") || "none recorded"}`
  ];
  if (result.labs.length > 0) {
    lines.push("", "per lab:");
    for (const row of result.labs) {
      const rate = row.passRate === undefined ? "no verdicts" : `${row.passed}/${row.judged} pass`;
      const duration = row.medianDurationMs === undefined ? "no timed live runs" : `median ${minutes(row.medianDurationMs)} over ${row.durationSamples}`;
      const cost = row.medianCostUsd === undefined ? "no priced runs" : `median ${money(row.medianCostUsd)} over ${row.costSamples}`;
      lines.push(`- ${row.lab}: ${row.runs} run(s), ${row.live} live; ${rate}; ${duration}; ${cost}; ${row.unpricedRuns} unpriced`);
    }
  }
  if (result.days.length > 0) {
    lines.push("", "by day:");
    for (const row of result.days) {
      lines.push(`- ${row.day}: ${row.runs} run(s), ${row.live} live, ${money(row.estimatedSpendUsd)} estimated${row.unpricedRuns > 0 ? `, ${row.unpricedRuns} unpriced` : ""}`);
    }
  }
  if (result.unreadable.length > 0) lines.push("", `unreadable run directories: ${result.unreadable.join(", ")}`);
  lines.push("", result.note);
  return `${lines.join("\n")}\n`;
}
