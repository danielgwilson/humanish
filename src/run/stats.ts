// `humanish stats`: what a directory of studies cost and how they came out. It rolls up per-bundle
// numbers under the per-run rules: an estimate is labelled an estimate, a run whose cost is unknown
// counts as unknown and never as zero, and every rate has a denominator next to it.

import path from "node:path";

import { readRunIndex, type RunIndexEntry } from "./run-index.js";
import {
  addCostTotals,
  emptyCostTotals,
  readCostTotals,
  type CostTotals,
  type CostRow,
} from "./costs.js";
import { round6 } from "./pricing.js";
import { plural } from "./text.js";

const STATS_SCHEMA = "humanish.stats.v2";

interface StatsParticipants {
  total: number;
  reachedGoal: number;
  reportedFriction: number;
}

interface StatsStudyRow {
  /** The study's `id`. */
  study: string;
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
  /** Participant and desktop median over runs with a known estimate; excludes analysis. */
  medianCostUsd?: number;
  costSamples: number;
  /** Runs with no estimate: a subscription brain, an interrupted run, an old bundle. Never zero. */
  unpricedRuns: number;
  participants: StatsParticipants;
  costs: CostTotals;
}

interface StatsDayRow {
  day: string;
  runs: number;
  live: number;
  /** Participant and desktop subtotal; `costs` also includes retained analysis. */
  estimatedSpendUsd: number;
  unpricedRuns: number;
  costs: CostTotals;
}

export interface StatsResult {
  schema: typeof STATS_SCHEMA;
  ok: true;
  cwd: string;
  since?: string;
  /** The study the stats are limited to, when one was given. */
  study?: string;
  totals: {
    runs: number;
    live: number;
    dryRun: number;
    running: number;
    /** Participant and desktop subtotal. costs.estimatedTotalUsd also includes retained analysis. */
    estimatedSpendUsd: number;
    unpricedRuns: number;
    participants: StatsParticipants;
    verdicts: Record<string, number>;
    costs: CostTotals;
  };
  studies: StatsStudyRow[];
  days: StatsDayRow[];
  /** Same selected runs; individual accounting gaps are inspectable without reading private evidence. */
  costsByRun: CostRow[];
  /** Directories that could not be read, by name: surfaced, never silently dropped. */
  unreadable: string[];
  note: string;
}

// docs/contracts/study-costs.md holds the accounting rules this sentence summarizes.
const STATS_NOTE =
  "Dollar figures are estimates from humanish's rate table, never provider charges, and a cost humanish does not know is left out of every total.";

export interface StatsOptions {
  /** ISO date or datetime; runs that started before it are excluded. */
  since?: string;
  /** Lab id; runs from other labs are excluded. */
  study?: string;
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

/**
 * A run's participant and desktop estimate: its recorded figure, or $0 for a dry run that records
 * none, since a dry run makes no model request and creates no desktop. Undefined when the cost is
 * unknown, including a dry run that records an unknown (null) figure.
 */
function runEstimateUsd(entry: RunIndexEntry): number | undefined {
  const usd = entry.estimatedCostUsd;
  if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) return usd;
  return usd === undefined && entry.mode === "dry-run" ? 0 : undefined;
}

function entryTime(entry: RunIndexEntry): string | undefined {
  return entry.startedAt ?? entry.completedAt ?? entry.updatedAt;
}

type StudyAccumulator = StatsStudyRow & { durations: number[]; runCosts: number[] };

function addToStudyRow(
  studies: Map<string, StudyAccumulator>,
  entry: RunIndexEntry,
  runUsd: number | undefined,
  costs: CostTotals,
): void {
  const studyId = entry.study?.id ?? "(no study)";
  let row = studies.get(studyId);
  if (row === undefined) {
    row = {
      study: studyId,
      runs: 0,
      live: 0,
      dryRun: 0,
      judged: 0,
      passed: 0,
      durationSamples: 0,
      costSamples: 0,
      unpricedRuns: 0,
      participants: emptyParticipants(),
      durations: [],
      costs: emptyCostTotals(),
      runCosts: [],
    };
    studies.set(studyId, row);
  }
  row.runs += 1;
  if (entry.mode === "live") row.live += 1;
  if (entry.mode === "dry-run") row.dryRun += 1;
  if (entry.verdict !== undefined) {
    row.judged += 1;
    if (entry.verdict === "pass") row.passed += 1;
  }
  if (entry.mode === "live" && entry.durationMs !== undefined) row.durations.push(entry.durationMs);
  if (runUsd === undefined) row.unpricedRuns += 1;
  else row.runCosts.push(runUsd);
  addParticipants(row.participants, entry);
  addCostTotals(row.costs, costs);
}

function addToDayRow(
  days: Map<string, StatsDayRow>,
  entry: RunIndexEntry,
  runUsd: number | undefined,
  costs: CostTotals,
): void {
  const at = entryTime(entry);
  const day = at === undefined ? "(undated)" : at.slice(0, 10);
  let dayRow = days.get(day);
  if (dayRow === undefined) {
    dayRow = {
      day,
      runs: 0,
      live: 0,
      estimatedSpendUsd: 0,
      unpricedRuns: 0,
      costs: emptyCostTotals(),
    };
    days.set(day, dayRow);
  }
  dayRow.runs += 1;
  if (entry.mode === "live") dayRow.live += 1;
  if (runUsd === undefined) dayRow.unpricedRuns += 1;
  else dayRow.estimatedSpendUsd += runUsd;
  addCostTotals(dayRow.costs, costs);
}

export async function computeStats(
  cwdInput: string,
  options: StatsOptions = {},
): Promise<StatsResult | StatsFailure> {
  const cwd = path.resolve(cwdInput);
  let sinceMs: number | undefined;
  if (options.since !== undefined) {
    sinceMs = Date.parse(options.since);
    if (Number.isNaN(sinceMs)) {
      return {
        schema: STATS_SCHEMA,
        ok: false,
        cwd,
        error: {
          code: "HUMANISH_STATS_INVALID_SINCE",
          message: `--since must be an ISO date or datetime, got "${options.since}".`,
        },
      };
    }
  }

  const index = await readRunIndex(
    cwd,
    options.nowMs === undefined ? {} : { nowMs: options.nowMs },
  );
  // Corrupt source metadata must not hide separately retained paid analysis receipts.
  // These directories cannot be attributed to a lab/date, so scoped filters exclude them.
  const indexedIds = new Set(index.runs.map((entry) => entry.runId));
  const entries: RunIndexEntry[] = [
    ...index.runs,
    ...index.unreadable
      .filter((id) => !indexedIds.has(id))
      .map((runId) => ({
        runId,
        derivedFrom: "directory" as const,
        liveness: "interrupted" as const,
      })),
  ];
  const selected = entries.filter((entry) => {
    if (options.study !== undefined && entry.study?.id !== options.study) return false;
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
    verdicts: {},
    costs: emptyCostTotals(),
  };
  const studies = new Map<string, StudyAccumulator>();
  const days = new Map<string, StatsDayRow>();
  const costsByRun: CostRow[] = [];

  for (const entry of selected) {
    const accounting = await readCostTotals(cwd, entry);
    costsByRun.push(accounting);
    addCostTotals(totals.costs, accounting.costs);
    totals.runs += 1;
    if (entry.mode === "live") totals.live += 1;
    if (entry.mode === "dry-run") totals.dryRun += 1;
    if (entry.liveness === "running") totals.running += 1;
    const runUsd = runEstimateUsd(entry);
    if (runUsd === undefined) totals.unpricedRuns += 1;
    else totals.estimatedSpendUsd += runUsd;
    addParticipants(totals.participants, entry);
    if (entry.verdict !== undefined)
      totals.verdicts[entry.verdict] = (totals.verdicts[entry.verdict] ?? 0) + 1;

    addToStudyRow(studies, entry, runUsd, accounting.costs);
    addToDayRow(days, entry, runUsd, accounting.costs);
  }

  const studyRows: StatsStudyRow[] = [...studies.values()]
    .map(({ durations, runCosts, ...row }) => ({
      ...row,
      ...(row.judged === 0 ? {} : { passRate: round6(row.passed / row.judged) }),
      ...(durations.length === 0 ? {} : { medianDurationMs: Math.round(median(durations)!) }),
      durationSamples: durations.length,
      ...(runCosts.length === 0 ? {} : { medianCostUsd: round6(median(runCosts)!) }),
      costSamples: runCosts.length,
    }))
    .sort((a, b) => b.runs - a.runs || a.study.localeCompare(b.study));

  return {
    schema: STATS_SCHEMA,
    ok: true,
    cwd,
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.study === undefined ? {} : { study: options.study }),
    totals: { ...totals, estimatedSpendUsd: round6(totals.estimatedSpendUsd) },
    studies: studyRows,
    days: [...days.values()]
      .map((row) => ({ ...row, estimatedSpendUsd: round6(row.estimatedSpendUsd) }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    costsByRun,
    unreadable: index.unreadable,
    note: STATS_NOTE,
  };
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function knownMoney(value: number | null): string {
  return value === null ? "no retained estimate" : money(value);
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Whether every selected run is a dry run whose accounting is a complete $0: no recorded figure,
 * no incomplete estimate and no analysis attempt. Only then does the one-line report hold.
 */
function onlyFreeDryRuns(t: StatsResult["totals"]): boolean {
  return (
    t.runs > 0 &&
    t.runs === t.dryRun &&
    t.costs.estimatedTotalUsd === 0 &&
    t.costs.incompleteRunEstimates === 0 &&
    t.costs.analysisAttempts === 0
  );
}

/** The run counts, with dry runs on their own line. */
function runCountLines(t: StatsResult["totals"]): string[] {
  if (t.runs === 0) return ["no runs yet; start one with humanish run first-run"];
  if (onlyFreeDryRuns(t)) return [`${plural(t.dryRun, "dry run")} ($0); no live runs yet`];
  const running = t.running > 0 ? ` (${t.running} still running)` : "";
  return [`live runs: ${t.live}${running}`, ...(t.dryRun > 0 ? [`dry runs: ${t.dryRun}`] : [])];
}

/** Spend, analysis, participants and verdicts across the selected live runs. */
function totalsLines(t: StatsResult["totals"]): string[] {
  const c = t.costs;
  const incomplete =
    c.incompleteRunEstimates > 0
      ? `; ${plural(c.incompleteRunEstimates, "run")} with incomplete accounting`
      : "";
  const unpriced =
    c.analysisUnpricedAttempts > 0 || c.analysisUnresolvedAttempts > 0
      ? `; ${c.analysisUnpricedAttempts} unpriced, ${c.analysisUnresolvedAttempts} unresolved`
      : "";
  const verdicts = Object.entries(t.verdicts).map(([verdict, count]) => `${verdict} ${count}`);
  return [
    `known estimated spend: ${knownMoney(c.estimatedTotalUsd)}`,
    `participants and desktops: ${knownMoney(c.runEstimatedUsd)}${incomplete}`,
    c.analysisAttempts === 0
      ? "analysis: none recorded"
      : `analysis: ${knownMoney(c.analysisEstimatedUsd)} over ${plural(c.analysisAttempts, "recorded attempt")}${unpriced}`,
    ...(c.analysisHistoryUncertainRuns > 0
      ? [
          `analysis history: ${plural(c.analysisHistoryUncertainRuns, "run")} missing or uncertain; --json lists each run`,
        ]
      : []),
    ...(t.participants.total > 0
      ? [
          `participants: ${t.participants.reachedGoal} of ${t.participants.total} reached the goal, ${t.participants.reportedFriction} reported friction`,
        ]
      : []),
    ...(verdicts.length > 0 ? [`verdicts: ${verdicts.join(", ")}`] : []),
  ];
}

function dayLine(row: StatsDayRow): string {
  return `- ${row.day}: ${plural(row.runs, "run")}, ${row.live} live, known study spend ${knownMoney(row.costs.estimatedTotalUsd)}${unpricedTail(row.unpricedRuns, row.costs.analysisUnpricedAttempts)}`;
}

/** "; 2 unpriced runs, 1 unpriced analysis", or nothing when both are zero. */
function unpricedTail(runs: number, analyses: number): string {
  if (runs === 0 && analyses === 0) return "";
  return `; ${plural(runs, "unpriced run")}, ${plural(analyses, "unpriced analysis", "unpriced analyses")}`;
}

/** Human output; a failure is an error the CLI prints on stderr (HumanOutput in src/cli/io.ts). */
export function formatStatsHuman(result: StatsResult): string;
export function formatStatsHuman(
  result: StatsResult | StatsFailure,
): string | { error: StatsFailure["error"] };
export function formatStatsHuman(
  result: StatsResult | StatsFailure,
): string | { error: StatsFailure["error"] } {
  if (!result.ok) return { error: result.error };
  const t = result.totals;
  const scope = [
    result.study === undefined ? undefined : `study ${result.study}`,
    result.since === undefined ? undefined : `since ${result.since}`,
  ].filter((part): part is string => part !== undefined);
  const lines = [
    `humanish stats${scope.length === 0 ? "" : ` (${scope.join(", ")})`}`,
    ...runCountLines(t),
  ];
  // Free dry runs alone have no spend, outcome or duration to report. Anything else, an unreadable
  // directory or a dry run that records a cost included, gets the full report.
  const reportable = t.runs > 0 && !onlyFreeDryRuns(t);
  if (reportable) {
    lines.push(...totalsLines(t));
    if (result.studies.length > 0)
      lines.push(
        "",
        "per study:",
        ...result.studies.map((row) => {
          const rate =
            row.passRate === undefined ? "no verdicts" : `${row.passed} of ${row.judged} passed`;
          const duration =
            row.medianDurationMs === undefined
              ? "no timed live runs"
              : `median ${minutes(row.medianDurationMs)} over ${row.durationSamples}`;
          const cost =
            row.medianCostUsd === undefined
              ? "no priced participant/desktop runs"
              : `participant/desktop median ${money(row.medianCostUsd)} over ${row.costSamples}`;
          return `- ${row.study}: ${plural(row.runs, "run")}, ${row.live} live; ${rate}; ${duration}; known study spend ${knownMoney(row.costs.estimatedTotalUsd)}; ${cost}${unpricedTail(row.unpricedRuns, row.costs.analysisUnpricedAttempts)}`;
        }),
      );
    if (result.days.length > 0) lines.push("", "by day:", ...result.days.map(dayLine));
  }
  if (result.unreadable.length > 0)
    lines.push("", `unreadable run directories: ${result.unreadable.join(", ")}`);
  if (reportable) lines.push("", result.note);
  return `${lines.join("\n")}\n`;
}
