import { Box, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { LabListEntry } from "../../src/labs.js";
import type { RunIndexEntry, RunIndexResult } from "../../src/run-index.js";
import { labRows, type LabRow } from "../../src/run-projection.js";
import type { TuiOptions } from "../../src/tui-contract.js";
import { fitPathToWidth } from "./fit-text.js";
import { currentScreen, initialNav, navigate, selectedIndex, type NavState } from "./navigation.js";
import { LabScreen, labItems } from "./screens/lab-screen.js";
import { LabsScreen } from "./screens/labs-screen.js";
import { RunScreen } from "./screens/run-screen.js";
import { useTerminalSize } from "./use-terminal-size.js";

/** What the surface has read. `undefined` means "not yet", which is never rendered as "none". */
interface ProjectData {
  rows: LabRow[];
  unattributed: RunIndexEntry[];
  runsByLab: Map<string, RunIndexEntry[]>;
  runsById: Map<string, RunIndexEntry>;
  unreadable: string[];
}

export interface AppProps {
  options: TuiOptions;
  onReady?: () => void;
  /** Frozen in tests so a golden never depends on the wall clock. */
  now?: number;
}

/** Chrome the frame always spends: title, path, blank, footer. */
const CHROME_ROWS = 6;

/**
 * How often the surface re-reads the project.
 *
 * A live run touches its record every 5s, so anything faster only re-reads unchanged bytes; much
 * slower and a run that ends sits on screen looking alive. The read is stat-keyed and cached
 * (~3ms warm on a 25-run project), which is why this can be a plain interval rather than a
 * carefully-gated one.
 */
const REFRESH_MS = 2_000;

/** How long to wait for a started run to write its first record, and how often to look. */
const LAUNCH_RECORD_TIMEOUT_MS = 5_000;
const LAUNCH_RECORD_POLL_MS = 100;

export function App({ options, onReady, now }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const size = useTerminalSize();
  const [nav, dispatch] = useReducer(navigate, undefined, initialNav);
  const [data, setData] = useState<ProjectData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // A live start is armed by the first Enter and committed by the second; a dry run needs neither.
  const [confirming, setConfirming] = useState<"live" | undefined>(undefined);
  const [launchError, setLaunchError] = useState<string | undefined>(undefined);
  /** A launch in flight, or one whose record has not appeared yet. NOT an error. */
  const [launchNote, setLaunchNote] = useState<string | undefined>(undefined);
  const clock = now ?? Date.now();

  // Identity of the selected row, kept current so a refresh that REORDERS the list can put the
  // cursor back on the same thing. A live lab sorts to the top the moment a run starts, so an index
  // held across a refresh silently points at a different lab — and that is how someone opens, or
  // starts, the wrong one.
  const selectedIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        // Read both sides before rendering either: a labs list assembled from history alone is
        // empty on a fresh project, and one from manifests alone hides real runs.
        const [index, labs] = await Promise.all([
          // Caching is the CAPABILITY's business, not the view's — the injected reader keeps a
          // stat-keyed cache across these calls, so a refresh re-reads only what changed.
          options.capabilities.readRunIndex(options.cwd),
          options.capabilities.listLabs(options.cwd)
        ]);
        if (cancelled) return;
        setError(undefined);
        setData(project(index, labs.labs));
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    timer.unref?.();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [options]);

  // Fired from its own effect so it lands after React has committed the data-bearing render and Ink
  // has written that frame — signalling beside setState reports ready while the screen still says
  // "reading…".
  useEffect(() => {
    if (data !== undefined || error !== undefined) onReady?.();
  }, [data, error, onReady]);

  const screen = currentScreen(nav);
  const selected = selectedIndex(nav);
  const rowCount = countRows(screen, data);

  useEffect(() => {
    const identity = identityOf(screen, data, selected);
    if (identity !== undefined) selectedIdRef.current = identity;
  }, [screen, data, selected]);

  // After a refresh, put the cursor back on the SAME ROW rather than the same index. When the row
  // is gone entirely (a run deleted underneath us) the index is left where it was and clamped by
  // the reducer, which keeps the cursor near where the operator left it.
  useEffect(() => {
    if (data === undefined) return;
    const identity = selectedIdRef.current;
    if (identity === undefined) return;
    const next = indexOfIdentity(screen, data, identity);
    if (next >= 0 && next !== selected) {
      dispatch({ type: "select", index: next, total: countRows(screen, data) });
    }
    // `selected` is deliberately absent: this reacts to DATA changing, not to the operator moving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, screen]);

  const start = useCallback(
    async (row: LabRow, mode: "dry-run" | "live"): Promise<void> => {
      if (mode === "live" && confirming !== "live") {
        // Arm, do not fire. The row above says what a live run costs; this makes the operator
        // press again having read it.
        setConfirming("live");
        return;
      }
      setConfirming(undefined);
      setLaunchError(undefined);
      setLaunchNote(`starting ${row.name}…`);
      const result = await options.capabilities.startRun({ cwd: options.cwd, lab: row.name, mode });
      if (!result.ok) {
        setLaunchNote(undefined);
        setLaunchError(result.error.message);
        return;
      }

      // The run is detached and writes its own record as it starts; the surface finds it by the pid
      // it was handed rather than by minting an id or guessing at a new directory. Spawning takes a
      // moment, so this WAITS for the record rather than reading once and concluding it is missing
      // — a fast dry run beat that single read and reported a healthy run as a problem.
      const deadline = Date.now() + LAUNCH_RECORD_TIMEOUT_MS;
      for (;;) {
        const index = await options.capabilities.readRunIndex(options.cwd);
        const started = index.runs.find((run) => run.pid === result.run.pid);
        if (started !== undefined) {
          setLaunchNote(undefined);
          dispatch({ type: "enter", screen: { name: "run", labId: row.labId, runId: started.runId } });
          return;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, LAUNCH_RECORD_POLL_MS));
      }

      // Still nothing. The process may have died before writing anything, and the launch log is the
      // only account of that — so show it rather than leaving a silent gap.
      const log = await options.capabilities.readLaunchLog(result.run.logPath);
      setLaunchNote(undefined);
      setLaunchError(
        log === ""
          ? `${row.name} started (pid ${result.run.pid}) but has not reported in. Check ${result.run.logPath}.`
          : `${row.name} did not report in. Its log ends:\n${log.split("\n").slice(-3).join("\n")}`
      );
    },
    [confirming, options]
  );

  useInput(
    useCallback(
      (input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean; leftArrow?: boolean; rightArrow?: boolean }) => {
        if (input === "q") {
          exit();
          return;
        }
        if (key.upArrow || input === "k") {
          dispatch({ type: "move", delta: -1, total: rowCount });
          return;
        }
        if (key.downArrow || input === "j") {
          dispatch({ type: "move", delta: 1, total: rowCount });
          return;
        }
        if (key.escape || key.leftArrow) {
          // Escape cancels an armed live start before it means "go back": the nearer meaning of
          // "no" wins, so a confirmation can never be dismissed by accidentally leaving the screen.
          if (confirming !== undefined) {
            setConfirming(undefined);
            return;
          }
          dispatch({ type: "back" });
          return;
        }
        if (key.return || key.rightArrow) {
          if (screen.name === "lab" && data !== undefined) {
            const { row, items } = itemsForLab(data, screen.labKey);
            const item = items[selected];
            if (row !== undefined && item?.kind === "start") {
              void start(row, item.mode);
              return;
            }
          }
          const next = openSelected(screen, data, selected);
          if (next !== undefined) dispatch({ type: "enter", screen: next });
        }
      },
      [exit, rowCount, screen, data, selected, confirming, start]
    )
  );

  useEffect(() => {
    if (nav.quit) exit();
  }, [nav.quit, exit]);

  const viewport = Math.max(1, size.rows - CHROME_ROWS);
  const body = useMemo(() => {
    if (error !== undefined) return <Text color="red">could not read this project: {error}</Text>;
    if (data === undefined) return <Text dimColor>reading project…</Text>;
    return renderScreen({ screen, data, selected, columns: size.columns, viewport, now: clock, confirming, launchError, launchNote });
  }, [error, data, screen, selected, size.columns, viewport, clock, confirming, launchError, launchNote]);

  return (
    <Box flexDirection="column" width={size.columns}>
      <Box justifyContent="space-between">
        <Text bold>{title(screen, data)}</Text>
        <Text dimColor>humanish v{options.version.cli}</Text>
      </Box>
      <Text dimColor>{fitPathToWidth(options.cwd, size.columns)}</Text>
      <Box marginTop={1} flexDirection="column">
        {body}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{keyHints(screen, data, selected, confirming)}</Text>
      </Box>
    </Box>
  );
}

function title(screen: ReturnType<typeof currentScreen>, data: ProjectData | undefined): string {
  switch (screen.name) {
    case "labs":
      return "labs";
    case "lab": {
      // The header is the breadcrumb, so it carries the HUMAN name. The screen below then only has
      // to say the handle you would type — instead of printing the same lab three times in four
      // lines.
      const row = data?.rows.find((candidate) => candidate.key === screen.labKey);
      return row?.label ?? screen.labKey;
    }
    default:
      return "run";
  }
}

/**
 * Only the keys that do something HERE, and named for what they do to the CURRENT row. Enter starts
 * a run on one row and opens a run on the next, so a fixed legend would be wrong half the time —
 * and a legend that lists inert keys teaches the wrong model of the surface.
 */
function keyHints(
  screen: ReturnType<typeof currentScreen>,
  data: ProjectData | undefined,
  selected: number,
  confirming: "live" | undefined
): string {
  const move = "↑↓ move";
  switch (screen.name) {
    case "labs":
      return `${move} · ↵ open · q quit`;
    case "lab": {
      if (confirming !== undefined) return "↵ confirm · esc cancel";
      const item = data === undefined ? undefined : itemsForLab(data, screen.labKey).items[selected];
      const enter = item?.kind === "start" ? (item.mode === "live" ? "↵ start live" : "↵ start dry run") : "↵ open run";
      return `${move} · ${enter} · esc back · q quit`;
    }
    default:
      return "esc back · q quit";
  }
}

function project(index: RunIndexResult, labs: readonly LabListEntry[]): ProjectData {
  const { rows, unattributed } = labRows(
    labs.map((lab) => ({
      id: lab.id,
      ...(lab.title === undefined ? {} : { title: lab.title }),
      path: lab.path,
      origin: lab.origin
    })),
    index.runs
  );
  const runsByLab = new Map<string, RunIndexEntry[]>();
  const runsById = new Map<string, RunIndexEntry>();
  for (const run of index.runs) {
    runsById.set(run.runId, run);
    const labId = run.lab?.id;
    if (labId === undefined) continue;
    const bucket = runsByLab.get(labId);
    if (bucket === undefined) runsByLab.set(labId, [run]);
    else bucket.push(run);
  }
  return { rows, unattributed, runsByLab, runsById, unreadable: index.unreadable };
}

/** The lab screen's rows, from the one definition both counting and opening share. */
function itemsForLab(data: ProjectData, labKey: string): { row?: LabRow; items: ReturnType<typeof labItems> } {
  const row = data.rows.find((candidate) => candidate.key === labKey);
  if (row === undefined) return { items: [] };
  return { row, items: labItems(data.runsByLab.get(row.labId) ?? [], row.declared) };
}

function countRows(screen: ReturnType<typeof currentScreen>, data: ProjectData | undefined): number {
  if (data === undefined) return 0;
  switch (screen.name) {
    case "labs":
      return data.rows.length;
    case "lab":
      return itemsForLab(data, screen.labKey).items.length;
    default:
      return 0;
  }
}

/**
 * A stable identity for whatever is selected, so a refresh that reorders the list can restore the
 * cursor to the same thing rather than the same index.
 */
function identityOf(
  screen: ReturnType<typeof currentScreen>,
  data: ProjectData | undefined,
  selected: number
): string | undefined {
  if (data === undefined) return undefined;
  if (screen.name === "labs") return data.rows[selected]?.key;
  if (screen.name === "lab") {
    const item = itemsForLab(data, screen.labKey).items[selected];
    if (item === undefined) return undefined;
    return item.kind === "start" ? `start:${item.mode}` : `run:${item.run.runId}`;
  }
  return undefined;
}

/** Where that identity sits now. -1 when it is gone (a run deleted, a manifest removed). */
function indexOfIdentity(
  screen: ReturnType<typeof currentScreen>,
  data: ProjectData,
  identity: string
): number {
  if (screen.name === "labs") return data.rows.findIndex((row) => row.key === identity);
  if (screen.name === "lab") {
    return itemsForLab(data, screen.labKey).items.findIndex((item) =>
      item.kind === "start" ? `start:${item.mode}` === identity : `run:${item.run.runId}` === identity
    );
  }
  return -1;
}

function openSelected(
  screen: ReturnType<typeof currentScreen>,
  data: ProjectData | undefined,
  selected: number
): NavState["stack"][number] | undefined {
  if (data === undefined) return undefined;
  if (screen.name === "labs") {
    const row = data.rows[selected];
    return row === undefined ? undefined : { name: "lab", labKey: row.key };
  }
  if (screen.name === "lab") {
    // Indexed through the SAME item list that counting uses. Reading `selected` as an index into
    // runs alone is off by the number of action rows above them — selecting the first run then
    // opens nothing at all, silently.
    const { row, items } = itemsForLab(data, screen.labKey);
    const item = items[selected];
    if (row === undefined || item === undefined || item.kind !== "run") return undefined;
    return { name: "run", labId: row.labId, runId: item.run.runId };
  }
  return undefined;
}

function renderScreen(args: {
  screen: ReturnType<typeof currentScreen>;
  data: ProjectData;
  selected: number;
  columns: number;
  viewport: number;
  now: number;
  confirming: "live" | undefined;
  launchError: string | undefined;
  launchNote: string | undefined;
}): React.ReactElement {
  const { screen, data, selected, columns, viewport, now, confirming, launchError, launchNote } = args;
  if (screen.name === "labs") {
    return (
      <LabsScreen
        rows={data.rows}
        selected={selected}
        columns={columns}
        viewport={viewport}
        unattributed={data.unattributed.length}
      />
    );
  }
  if (screen.name === "lab") {
    const row = data.rows.find((candidate) => candidate.key === screen.labKey);
    if (row === undefined) return <Text color="yellow">that lab is no longer in this project</Text>;
    return (
      <LabScreen
        row={row}
        runs={data.runsByLab.get(row.labId) ?? []}
        selected={selected}
        columns={columns}
        viewport={viewport - 4}
        now={now}
        canStart={row.declared}
        confirming={confirming}
        launchError={launchError}
        launchNote={launchNote}
      />
    );
  }
  const run = data.runsById.get(screen.runId);
  if (run === undefined) return <Text color="yellow">that run is no longer on disk</Text>;
  return <RunScreen run={run} columns={columns} />;
}
