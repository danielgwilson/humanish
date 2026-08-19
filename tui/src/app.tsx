import { Box, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import type { LabListEntry } from "../../src/labs.js";
import type { RunIndexEntry, RunIndexResult } from "../../src/run-index.js";
import { labRows, type LabRow } from "../../src/run-projection.js";
import type { TuiOptions } from "../../src/tui-contract.js";
import { fitPathToWidth } from "./fit-text.js";
import { currentScreen, initialNav, navigate, selectedIndex, type NavState } from "./navigation.js";
import { LabScreen } from "./screens/lab-screen.js";
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

export function App({ options, onReady, now }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const size = useTerminalSize();
  const [nav, dispatch] = useReducer(navigate, undefined, initialNav);
  const [data, setData] = useState<ProjectData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const clock = now ?? Date.now();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Read both sides before rendering either: a labs list assembled from history alone is
        // empty on a fresh project, and one from manifests alone hides real runs.
        const [index, labs] = await Promise.all([
          options.capabilities.readRunIndex(options.cwd),
          options.capabilities.listLabs(options.cwd)
        ]);
        if (cancelled) return;
        setData(project(index, labs.labs));
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
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
          dispatch({ type: "back" });
          return;
        }
        if (key.return || key.rightArrow) {
          const next = openSelected(screen, data, selected);
          if (next !== undefined) dispatch({ type: "enter", screen: next });
        }
      },
      [exit, rowCount, screen, data, selected]
    )
  );

  useEffect(() => {
    if (nav.quit) exit();
  }, [nav.quit, exit]);

  const viewport = Math.max(1, size.rows - CHROME_ROWS);
  const body = useMemo(() => {
    if (error !== undefined) return <Text color="red">could not read this project: {error}</Text>;
    if (data === undefined) return <Text dimColor>reading project…</Text>;
    return renderScreen({ screen, data, selected, columns: size.columns, viewport, now: clock });
  }, [error, data, screen, selected, size.columns, viewport, clock]);

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
        <Text dimColor>{keyHints(screen)}</Text>
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

/** Only the keys that do something HERE. A legend listing inert keys teaches the wrong model. */
function keyHints(screen: ReturnType<typeof currentScreen>): string {
  const move = "↑↓ move";
  switch (screen.name) {
    case "labs":
      return `${move} · ↵ open · q quit`;
    case "lab":
      return `${move} · ↵ open run · esc back · q quit`;
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

function countRows(screen: ReturnType<typeof currentScreen>, data: ProjectData | undefined): number {
  if (data === undefined) return 0;
  switch (screen.name) {
    case "labs":
      return data.rows.length;
    case "lab": {
      const row = data.rows.find((candidate) => candidate.key === screen.labKey);
      return row === undefined ? 0 : (data.runsByLab.get(row.labId)?.length ?? 0);
    }
    default:
      return 0;
  }
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
    const row = data.rows.find((candidate) => candidate.key === screen.labKey);
    const run = row === undefined ? undefined : data.runsByLab.get(row.labId)?.[selected];
    if (run === undefined || row === undefined) return undefined;
    return { name: "run", labId: row.labId, runId: run.runId };
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
}): React.ReactElement {
  const { screen, data, selected, columns, viewport, now } = args;
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
      />
    );
  }
  const run = data.runsById.get(screen.runId);
  if (run === undefined) return <Text color="yellow">that run is no longer on disk</Text>;
  return <RunScreen run={run} columns={columns} />;
}
