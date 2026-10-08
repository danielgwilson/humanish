import type { StudyListEntry, StudyListResult } from "../../src/study/discover.js";
import { studyFileStem } from "../../src/study/files.js";
import type { RunDetail } from "../../src/run/detail.js";
import type { RunIndexEntry, RunIndexResult } from "../../src/run/run-index.js";
import { studyRows, type StudyRow } from "../../src/run/projection.js";
import type { Screen } from "./navigation.js";
import { runActions } from "./screens/run-screen.js";
import { studyItems } from "./screens/study-screen.js";

/** What the surface has read. `undefined` means "not yet", which is never rendered as "none". */
export interface ProjectData {
  rows: StudyRow[];
  unattributed: RunIndexEntry[];
  runsByStudy: Map<string, RunIndexEntry[]>;
  runsById: Map<string, RunIndexEntry>;
  unreadable: string[];
  /**
   * Study files humanish no longer reads. The home screen says how to fix them, and a study whose
   * runs outlived its file says why it cannot run.
   */
  retired: StudyListResult["retired"];
}

export function projectData(
  index: RunIndexResult,
  studies: readonly StudyListEntry[],
  retired: StudyListResult["retired"],
): ProjectData {
  const { rows, unattributed } = studyRows(
    studies.map((study) => ({
      id: study.id,
      ...(study.title === undefined ? {} : { title: study.title }),
      ...(study.description === undefined ? {} : { description: study.description }),
      path: study.path,
      origin: study.origin,
    })),
    index.runs,
  );
  const runsByStudy = new Map<string, RunIndexEntry[]>();
  const runsById = new Map<string, RunIndexEntry>();
  for (const run of index.runs) {
    runsById.set(run.runId, run);
    const studyId = run.study?.id;
    if (studyId === undefined) continue;
    const bucket = runsByStudy.get(studyId);
    if (bucket === undefined) runsByStudy.set(studyId, [run]);
    else bucket.push(run);
  }
  return { rows, unattributed, runsByStudy, runsById, unreadable: index.unreadable, retired };
}

/**
 * The file humanish no longer reads that this study's runs came from. A run records its study file's
 * project-relative path, and the declared id need not match the file name, so a recorded path is
 * matched exactly. Runs that recorded no path fall back to the file name.
 */
export function retiredFileOf(
  data: ProjectData,
  studyId: string | undefined,
): StudyListResult["retired"][number] | undefined {
  if (studyId === undefined) return undefined;
  const slashed = (value: string): string => value.replace(/\\/g, "/");
  const recorded = new Set(
    (data.runsByStudy.get(studyId) ?? []).flatMap((run) =>
      run.study?.path === undefined ? [] : [slashed(run.study.path)],
    ),
  );
  if (recorded.size > 0) return data.retired.find((file) => recorded.has(slashed(file.path)));
  return data.retired.find(
    (file) => studyFileStem(slashed(file.path).split("/").pop() ?? "") === studyId,
  );
}

/**
 * Every live run in the project, once.
 *
 * Not a flatMap over study rows: two manifests can declare the same study id, so a run belonging to
 * that id is reachable from both rows and would be listed twice: the same participant, twice, at
 * the same elapsed time, which reads as two people working.
 */
export function liveRunsOf(data: ProjectData): RunIndexEntry[] {
  const seen = new Set<string>();
  const out: RunIndexEntry[] = [];
  for (const run of data.rows.flatMap((row) => row.liveRuns)) {
    if (seen.has(run.runId)) continue;
    seen.add(run.runId);
    out.push(run);
  }
  return out;
}

/** The study screen's rows, from the one definition both counting and opening share. */
export function itemsForStudy(
  data: ProjectData,
  studyKey: string,
): { row?: StudyRow; items: ReturnType<typeof studyItems> } {
  const row = data.rows.find((candidate) => candidate.key === studyKey);
  if (row === undefined) return { items: [] };
  return { row, items: studyItems(data.runsByStudy.get(row.studyId) ?? [], row.declared) };
}

export function countRows(
  screen: Screen,
  data: ProjectData | undefined,
  detail?: RunDetail | null,
): number {
  if (data === undefined) return 0;
  switch (screen.name) {
    case "studies":
      // The labs, plus the "All runs" peer beneath them.
      return data.rows.length + 1;
    case "all-runs":
      return liveRunsOf(data).length;
    case "study":
      return itemsForStudy(data, screen.studyKey).items.length;
    case "run": {
      const run = data.runsById.get(screen.runId);
      return run === undefined ? 0 : runActions(run, detail).length;
    }
    default:
      return 0;
  }
}

/**
 * A stable identity for whatever is selected, so a refresh that reorders the list can restore the
 * cursor to the same thing rather than the same index.
 */
export function identityOf(
  screen: Screen,
  data: ProjectData | undefined,
  selected: number,
  detail?: RunDetail | null,
): string | undefined {
  if (data === undefined) return undefined;
  if (screen.name === "studies") return data.rows[selected]?.key ?? "peer:all-runs";
  if (screen.name === "all-runs") return liveRunsOf(data)[selected]?.runId;
  if (screen.name === "study") {
    const item = itemsForStudy(data, screen.studyKey).items[selected];
    if (item === undefined) return undefined;
    return item.kind === "start" ? `start:${item.mode}` : `run:${item.run.runId}`;
  }
  return openRunActions(screen, data, detail)?.[selected];
}

/** Where that identity sits now. -1 when it is gone (a run deleted, a manifest removed). */
export function indexOfIdentity(
  screen: Screen,
  data: ProjectData,
  identity: string,
  detail?: RunDetail | null,
): number {
  if (screen.name === "studies") {
    return identity === "peer:all-runs"
      ? data.rows.length
      : data.rows.findIndex((row) => row.key === identity);
  }
  if (screen.name === "all-runs") {
    return liveRunsOf(data).findIndex((run) => run.runId === identity);
  }
  if (screen.name === "study") {
    return itemsForStudy(data, screen.studyKey).items.findIndex((item) =>
      item.kind === "start"
        ? identity === `start:${item.mode}`
        : `run:${item.run.runId}` === identity,
    );
  }
  return openRunActions(screen, data, detail)?.findIndex((action) => action === identity) ?? -1;
}

/**
 * The open run's actions once its detail has been read. Before that the list is provisional: a
 * finished run offers only Run again until the read finds its Observer artifact, and a cursor that
 * followed Run again from that list would land on it once Open in Observer appears above.
 */
function openRunActions(
  screen: Screen,
  data: ProjectData,
  detail: RunDetail | null | undefined,
): ReturnType<typeof runActions> | undefined {
  if (screen.name !== "run" || detail === undefined) return undefined;
  const run = data.runsById.get(screen.runId);
  return run === undefined ? undefined : runActions(run, detail);
}

export function openSelected(
  screen: Screen,
  data: ProjectData | undefined,
  selected: number,
): Screen | undefined {
  if (data === undefined) return undefined;
  if (screen.name === "studies") {
    const row = data.rows[selected];
    // Past the last study is the peer.
    if (row === undefined) return selected === data.rows.length ? { name: "all-runs" } : undefined;
    return { name: "study", studyKey: row.key };
  }
  if (screen.name === "all-runs") {
    const run = liveRunsOf(data)[selected];
    return run === undefined
      ? undefined
      : {
          name: "run",
          ...(run.study?.id === undefined ? {} : { studyId: run.study.id }),
          runId: run.runId,
        };
  }
  if (screen.name === "study") {
    // Indexed through the same item list that counting uses. Reading `selected` as an index into
    // runs alone is off by the number of action rows above them: selecting the first run then
    // opens nothing at all, silently.
    const { row, items } = itemsForStudy(data, screen.studyKey);
    const item = items[selected];
    if (row === undefined || item === undefined || item.kind !== "run") return undefined;
    return { name: "run", studyId: row.studyId, runId: item.run.runId };
  }
  return undefined;
}
