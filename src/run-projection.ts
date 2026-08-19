// The disk→view-model projection (#455 PR 2). Pure functions, no I/O, no rendering: this is where
// lab grouping, the trust line's arithmetic, thought normalization and list-window math live, so
// the parts most likely to be wrong are testable without a terminal.
//
// The honesty rules these encode, because they are the ones a UI is most tempted to break:
//   - a statistic ALWAYS carries its denominator, and says when it has none;
//   - an unknown cost is `null` (declared absent), never 0;
//   - truncation is reported, never silent;
//   - a participant's reported thinking is quoted, never paraphrased or summarized.

import type { RunIndexEntry } from "./run-index.js";

/** One lab as the labs list shows it. */
export interface LabRollup {
  labId: string;
  /** Total runs attributed to this lab. */
  runs: number;
  /** Runs whose status record is fresh right now. */
  live: number;
  /** The newest run of this lab, whatever its state. */
  latest?: RunIndexEntry;
  /** Live runs, newest first — the labs list shows the first one inline. */
  liveRuns: RunIndexEntry[];
}

/**
 * Group runs by lab, newest-first within each lab and by recency between labs. Runs with no lab
 * attribution are collected under `unattributed` rather than invented into a lab — the honest
 * home for pre-contract runs and library callers.
 */
export function groupRunsByLab(entries: readonly RunIndexEntry[]): {
  labs: LabRollup[];
  unattributed: RunIndexEntry[];
} {
  const byLab = new Map<string, RunIndexEntry[]>();
  const unattributed: RunIndexEntry[] = [];
  for (const entry of entries) {
    const labId = entry.lab?.id;
    if (labId === undefined) {
      unattributed.push(entry);
      continue;
    }
    const bucket = byLab.get(labId);
    if (bucket === undefined) byLab.set(labId, [entry]);
    else bucket.push(entry);
  }
  const labs: LabRollup[] = [...byLab.entries()].map(([labId, runs]) => {
    const liveRuns = runs.filter((run) => run.liveness === "running");
    return {
      labId,
      runs: runs.length,
      live: liveRuns.length,
      ...(runs[0] === undefined ? {} : { latest: runs[0] }),
      liveRuns
    };
  });
  // A lab someone is working in sorts first; otherwise most recently used.
  labs.sort((left, right) => {
    if (left.live !== right.live) return right.live - left.live;
    return recencyOf(right.latest) - recencyOf(left.latest);
  });
  return { labs, unattributed };
}

function recencyOf(entry: RunIndexEntry | undefined): number {
  if (entry === undefined) return 0;
  for (const candidate of [entry.completedAt, entry.updatedAt, entry.startedAt]) {
    if (candidate === undefined) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * What the launch screen may claim about a lab, and on what evidence. Every figure carries the
 * number of runs it came from; `sample: 0` means there is nothing to claim and the caller must
 * say so rather than showing an empty number.
 */
export interface LabExpectation {
  /** How many completed runs of this lab the figures are drawn from. */
  sample: number;
  medianDurationMs?: number;
  /** Range across the sample, so the UI can show a span instead of a false point estimate. */
  durationRangeMs?: { min: number; max: number };
  medianCostUsd?: number;
  /** Completed runs whose cost was declared absent — excluded from the median, reported here so
   *  a partial sample can never masquerade as a full one. */
  costUnknown: number;
}

/**
 * Derive what to expect from a lab's own history. Only FINISHED runs count: an interrupted run's
 * duration is the length of an accident, not of a study, and including it would quietly bias the
 * estimate the operator uses to decide whether to press Start.
 */
export function expectationFor(entries: readonly RunIndexEntry[]): LabExpectation {
  const finished = entries.filter((entry) => entry.liveness === "finished");
  const durations = finished
    .map((entry) => entry.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const costs = finished
    .map((entry) => entry.estimatedCostUsd)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  const costUnknown = finished.filter((entry) => entry.estimatedCostUsd === null).length;
  return {
    sample: finished.length,
    ...(durations.length === 0
      ? {}
      : {
          medianDurationMs: median(durations),
          durationRangeMs: { min: durations[0]!, max: durations[durations.length - 1]! }
        }),
    ...(costs.length === 0 ? {} : { medianCostUsd: median(costs) }),
    costUnknown
  };
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The one sentence the launch screen shows about time and money, with its denominator attached.
 * A lab with no history says so plainly instead of borrowing another lab's numbers or inventing
 * a range — "no runs yet" is information, and the operator can still press Start.
 */
export function expectationLine(expectation: LabExpectation): string {
  if (expectation.sample === 0) return "no runs yet";
  const parts: string[] = [];
  if (expectation.durationRangeMs !== undefined) {
    const { min, max } = expectation.durationRangeMs;
    parts.push(min === max ? formatDuration(min) : `${formatDuration(min)}–${formatDuration(max)}`);
  }
  if (expectation.medianCostUsd !== undefined) {
    parts.push(`~$${expectation.medianCostUsd.toFixed(2)} median`);
  }
  const sample = `${expectation.sample} run${expectation.sample === 1 ? "" : "s"}`;
  const unknown = expectation.costUnknown > 0 ? `, ${expectation.costUnknown} unpriced` : "";
  return parts.length === 0 ? `${sample}${unknown}, nothing timed` : `${parts.join(" · ")} · ${sample}${unknown}`;
}

/** Compact duration: seconds under a minute, then m/s, then h/m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

export interface NormalizedThought {
  lines: string[];
  /** True when the source text did not fit and was cut — shown, never silent. */
  truncated: boolean;
}

/**
 * Prepare a participant's recorded reasoning summary for a fixed-width surface. Provider summaries
 * arrive with markdown section leads (`**Thinking through setup**`) and hard newlines; a terminal
 * needs plain text wrapped to a line budget.
 *
 * The text is never paraphrased or shortened by meaning — only wrapped, and cut at a word boundary
 * with an ellipsis when it does not fit. `truncated` is how the surface says so.
 */
export function normalizeThought(text: string, options: { width: number; maxLines: number }): NormalizedThought {
  const width = Math.max(8, Math.floor(options.width));
  const maxLines = Math.max(1, Math.floor(options.maxLines));
  const flat = text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // markdown bold leads: keep the words, drop the syntax
    .replace(/\s*\n+\s*/g, " ") // hard newlines are the provider's formatting, not the meaning
    .replace(/\s{2,}/g, " ")
    .trim();
  if (flat === "") return { lines: [], truncated: false };

  const words = flat.split(" ");
  const lines: string[] = [];
  let current = "";
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index]!;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    current = word.length <= width ? word : `${word.slice(0, width - 1)}…`;
    if (word.length > width) {
      // A single unbreakable token longer than the line (a URL, a long id) is cut rather than
      // allowed to overflow the pane.
      lines.push(current);
      current = "";
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && current !== "") {
    lines.push(current);
    index = words.length;
  }
  const truncated = index < words.length;
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    lines[lines.length - 1] = last.length + 1 <= width ? `${last}…` : `${last.slice(0, width - 1)}…`;
  }
  return { lines, truncated };
}

/**
 * Which slice of a list to draw, keeping the selection visible with a little context around it.
 * Ink has no scroll container, so every long list windows by hand; getting this wrong is how a
 * selection disappears off the top of a phone screen.
 */
export function listWindow(args: {
  total: number;
  selected: number;
  viewport: number;
  /** Rows of context to keep above/below the selection when scrolling. */
  margin?: number;
}): { start: number; end: number } {
  const total = Math.max(0, Math.floor(args.total));
  const viewport = Math.max(1, Math.floor(args.viewport));
  if (total <= viewport) return { start: 0, end: total };
  const selected = Math.min(Math.max(0, Math.floor(args.selected)), total - 1);
  const margin = Math.min(Math.max(0, Math.floor(args.margin ?? 1)), Math.floor((viewport - 1) / 2));
  let start = Math.min(Math.max(0, selected - margin), total - viewport);
  if (selected >= start + viewport - margin) start = Math.min(selected - viewport + 1 + margin, total - viewport);
  start = Math.max(0, Math.min(start, total - viewport));
  return { start, end: start + viewport };
}

/** The label for a run's state, in the register the surfaces share. */
export function livenessLabel(entry: Pick<RunIndexEntry, "liveness" | "verdict">): string {
  switch (entry.liveness) {
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    default:
      return entry.verdict ?? "finished";
  }
}
