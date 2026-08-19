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
 *
 * MODE MATTERS, and mixing modes is a lie rather than an imprecision. A dry run spends nothing and
 * takes no time, so a median over nine dry runs and one live one reports that a live run is free —
 * next to a control that spends money. Pass the mode the figure is about; omit it only for a
 * summary that is not attached to an action.
 */
export function expectationFor(
  entries: readonly RunIndexEntry[],
  mode?: "dry-run" | "live"
): LabExpectation {
  const scoped = mode === undefined ? entries : entries.filter((entry) => entry.mode === mode);
  const finished = scoped.filter((entry) => entry.liveness === "finished");
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

/** A lab as the labs list shows it: what is declared, joined to what actually happened. */
export interface LabRow {
  /**
   * Stable identity for THIS ROW. A manifest's path when it has one, else the lab id — because two
   * manifests can declare the same id, and keying rows by id makes them collapse into a pair of
   * indistinguishable duplicates.
   */
  key: string;
  /** The declared id. Run history attributes to this, so it is NOT unique across manifests. */
  labId: string;
  /**
   * The handle an operator would actually type. Lab resolution is by FILENAME, so the manifest
   * `\`.humanish/labs/persona-contrast-live.yaml\`` is reached as `persona-contrast-live` even when
   * the id inside it says something else.
   */
  name: string;
  /** The manifest's own title, when it has one. */
  title?: string;
  /**
   * The shortest label that is UNIQUE among the rows it is listed with: the title when no other
   * lab shares it, else the filename, else the full path. A list is only navigable if every row can
   * be told from every other one, and a title is not guaranteed to be distinct — two manifests in
   * this repo carry the same title AND the same declared id, differing only by filename.
   */
  label: string;
  /** Repo-relative manifest path, absent for a lab known only from run history. */
  path?: string;
  origin?: "committed" | "ignored" | "explicit";
  /**
   * False for a lab that has runs but NO manifest here — renamed, deleted, or run from a path that
   * is gone. Its runs are still evidence and must stay reachable, so it is listed and marked rather
   * than dropped.
   */
  declared: boolean;
  /**
   * How many OTHER manifests declare this same lab id. Above zero, the run history below is shared
   * between them and cannot be attributed to one file — worth saying, because it is a
   * misconfiguration the operator almost certainly does not know about.
   */
  sharesIdWith: number;
  runs: number;
  live: number;
  latest?: RunIndexEntry;
  liveRuns: RunIndexEntry[];
  /** Across every finished run, whatever its mode. A summary, never attached to a spend decision. */
  expectation: LabExpectation;
  /** Live runs only — the figure that belongs beside anything that spends money. */
  liveExpectation: LabExpectation;
}

/** The addressable handle for a manifest: its filename without directory or extension. */
export function labNameFromPath(manifestPath: string): string {
  const base = manifestPath.split("/").pop() ?? manifestPath;
  return base.replace(/\.(ya?ml)$/i, "");
}

export interface DeclaredLab {
  id: string;
  title?: string;
  path?: string;
  origin?: "committed" | "ignored" | "explicit";
}

/**
 * Join declared lab manifests to run history.
 *
 * Neither side alone is the truth. A fresh project has manifests and no runs — those labs are the
 * whole screen, and a list built only from history would be empty on exactly the first visit that
 * matters. A long-lived project accumulates runs from labs whose manifest has since been renamed or
 * deleted — that evidence still exists on disk, so dropping those rows would make real runs
 * unreachable from the surface that is supposed to list them.
 *
 * ONE ROW PER MANIFEST, not per id. The two are not the same thing: a manifest is addressed by its
 * filename while its runs attribute to the id declared inside it, so several files can legitimately
 * share an id. Collapsing them hides a real file; keying by id duplicates a row with no way to tell
 * the copies apart. Both happen in practice — this repo has exactly that pair.
 *
 * Order puts a lab someone is working in first, then labs by how recently they ran, then declared
 * labs that have never run (alphabetically BY WHAT IS DISPLAYED, so the order on screen is the
 * order a reader can predict), then labs known only from history.
 */
export function labRows(
  declared: readonly DeclaredLab[],
  entries: readonly RunIndexEntry[]
): { rows: LabRow[]; unattributed: RunIndexEntry[] } {
  const { labs, unattributed } = groupRunsByLab(entries);
  const byId = new Map(labs.map((lab) => [lab.labId, lab]));
  const runsOf = new Map<string, RunIndexEntry[]>();
  for (const entry of entries) {
    const labId = entry.lab?.id;
    if (labId === undefined) continue;
    const bucket = runsOf.get(labId);
    if (bucket === undefined) runsOf.set(labId, [entry]);
    else bucket.push(entry);
  }

  const idCounts = new Map<string, number>();
  for (const lab of declared) idCounts.set(lab.id, (idCounts.get(lab.id) ?? 0) + 1);

  const build = (labId: string, manifest: DeclaredLab | undefined, isDeclared: boolean): LabRow => {
    const rollup = byId.get(labId);
    const manifestPath = manifest?.path;
    return {
      key: manifestPath ?? `id:${labId}`,
      labId,
      name: manifestPath === undefined ? labId : labNameFromPath(manifestPath),
      ...(manifest?.title === undefined ? {} : { title: manifest.title }),
      ...(manifestPath === undefined ? {} : { path: manifestPath }),
      ...(manifest?.origin === undefined ? {} : { origin: manifest.origin }),
      declared: isDeclared,
      // Replaced by assignLabels once the whole set is known; a label is only meaningful relative
      // to the rows it sits beside.
      label: manifest?.title ?? (manifestPath === undefined ? labId : labNameFromPath(manifestPath)),
      sharesIdWith: Math.max(0, (idCounts.get(labId) ?? 0) - 1),
      runs: rollup?.runs ?? 0,
      live: rollup?.live ?? 0,
      ...(rollup?.latest === undefined ? {} : { latest: rollup.latest }),
      liveRuns: rollup?.liveRuns ?? [],
      expectation: expectationFor(runsOf.get(labId) ?? []),
      liveExpectation: expectationFor(runsOf.get(labId) ?? [], "live")
    };
  };

  const declaredIds = new Set(declared.map((lab) => lab.id));
  const rows = [
    ...declared.map((lab) => build(lab.id, lab, true)),
    ...labs.filter((lab) => !declaredIds.has(lab.labId)).map((lab) => build(lab.labId, undefined, false))
  ];

  // Resolve each row's label BEFORE sorting, so the list is ordered by what a reader actually sees.
  assignLabels(rows);

  const label = (row: LabRow): string => row.label;
  rows.sort((left, right) => {
    if (left.live !== right.live) return right.live - left.live;
    const rank = (row: LabRow): number => (row.runs > 0 ? 0 : row.declared ? 1 : 2);
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    if (left.runs > 0 && right.runs > 0) {
      const recency = recencyOf(right.latest) - recencyOf(left.latest);
      if (recency !== 0) return recency;
    }
    const byLabel = label(left).localeCompare(label(right));
    return byLabel !== 0 ? byLabel : left.key.localeCompare(right.key);
  });

  return { rows, unattributed };
}

/**
 * Give every row the shortest label that distinguishes it: title, else filename, else path.
 *
 * Falling straight back to the filename whenever a title repeats — rather than decorating the
 * duplicate with a suffix — keeps the label something the operator can act on, because the filename
 * is exactly what `humanish lab run` takes.
 */
function assignLabels(rows: LabRow[]): void {
  const count = (values: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  };
  const titles = count(rows.map((row) => row.title ?? row.name));
  const names = count(rows.map((row) => row.name));
  for (const row of rows) {
    const title = row.title ?? row.name;
    if ((titles.get(title) ?? 0) === 1) {
      row.label = title;
      continue;
    }
    row.label = (names.get(row.name) ?? 0) === 1 ? row.name : (row.path ?? row.name);
  }
}
