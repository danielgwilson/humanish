import { Box, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { LabListEntry } from "../../src/labs.js";
import type { LabSummary } from "../../src/lab-summary.js";
import type { RunDetail } from "../../src/run-detail.js";
import type { RunIndexEntry, RunIndexResult } from "../../src/run-index.js";
import { labRows, type LabRow } from "../../src/run-projection.js";
import type { TuiOptions } from "../../src/tui-contract.js";
import { fitPathToWidth } from "./fit-text.js";
import { currentScreen, initialNav, navigate, selectedIndex, type NavState } from "./navigation.js";
import { Frame, contentWidth } from "./frame.js";
import { AllRunsScreen } from "./screens/all-runs-screen.js";
import { LabScreen, labItems } from "./screens/lab-screen.js";
import { runActions } from "./screens/run-screen.js";
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

/**
 * The shortest gap between arming a live run and committing it. Key auto-repeat delivers around one
 * event every 30ms, so without a floor a held Enter arms and commits inside a single keypress.
 */
const LIVE_CONFIRM_MIN_MS = 400;

/** Spinner cadence. Fast enough to read as motion, slow enough not to strobe over SSH. */
const SPINNER_MS = 120;

export function App({ options, onReady, now }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const size = useTerminalSize();
  const [nav, dispatch] = useReducer(navigate, undefined, initialNav);
  const [data, setData] = useState<ProjectData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // A live start is armed by the first Enter and committed by the second; a dry run needs neither.
  const [confirming, setConfirming] = useState<"live" | undefined>(undefined);
  // Launch state is SCOPED TO THE LAB it belongs to: it is one surface with one piece of state, and
  // an unscoped note follows the operator to a different lab's screen and reports something about
  // that lab which is not true of it.
  const [launchError, setLaunchError] = useState<{ labKey: string; text: string } | undefined>(undefined);
  /** A launch in flight, or one whose record has not appeared yet. NOT an error. */
  const [launchNote, setLaunchNote] = useState<{ labKey: string; text: string } | undefined>(undefined);
  /** When the live confirmation was armed, so a HELD key cannot blow through it. */
  const [armedAt, setArmedAt] = useState<number | undefined>(undefined);
  /**
   * The open run's participants. `undefined` means "not read yet" and `null` means "read, and it
   * has no bundle" — a run that has just started. The screen says something different for each,
   * because "still loading" and "nothing there" are different facts.
   */
  const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined);
  /** What the last run-card action reported. An action that appears to do nothing is a bug. */
  const [actionNote, setActionNote] = useState<string | undefined>(undefined);
  /** Advances the spinners. A live row that does not move reads as stale data. */
  const [tick, setTick] = useState(0);
  /** Which side the Start toggle is on. Per lab, so switching labs does not carry `live` across. */
  const [modeByLab, setModeByLab] = useState<Record<string, "dry-run" | "live">>({});
  const [summary, setSummary] = useState<LabSummary | null | undefined>(undefined);
  /** Detail for LIVE runs only, so the labs list can name who is in them. */
  const [liveDetails, setLiveDetails] = useState<Map<string, RunDetail>>(new Map());
  /** Whether this is a humanish project. Cheap and synchronous — two existence checks. */
  const projectState = useMemo(() => options.capabilities.readProjectState(options.cwd), [options]);
  const clock = now ?? Date.now();

  // Identity of the selected row, kept current so a refresh that REORDERS the list can put the
  // cursor back on the same thing. A live lab sorts to the top the moment a run starts, so an index
  // held across a refresh silently points at a different lab — and that is how someone opens, or
  // starts, the wrong one.
  const selectedIdRef = useRef<string | undefined>(undefined);
  /** Where the operator is RIGHT NOW, readable from an async launch that started long ago. */
  const screenRef = useRef<ReturnType<typeof currentScreen>>({ name: "labs" });

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
    screenRef.current = screen;
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
        // Arm, do not fire. The row above says what a live run costs; this makes the operator press
        // again having read it.
        setConfirming("live");
        setArmedAt(Date.now());
        return;
      }
      if (mode === "live" && armedAt !== undefined && Date.now() - armedAt < LIVE_CONFIRM_MIN_MS) {
        // A held Enter delivers repeats every ~30ms, which would arm and commit a live run inside
        // one keypress. A confirmation nobody had time to read is not a confirmation.
        return;
      }
      setConfirming(undefined);
      setArmedAt(undefined);
      setLaunchError(undefined);
      setLaunchNote({ labKey: row.key, text: `starting ${row.name}…` });
      const result = await options.capabilities.startRun({ cwd: options.cwd, lab: row.name, mode });
      if (!result.ok) {
        setLaunchNote(undefined);
        setLaunchError({ labKey: row.key, text: result.error.message });
        return;
      }

      // Find the run this launch produced. A pid ALONE is not an identity: pids are recycled, and a
      // finished run keeps its pid in status.json forever, so a week-old record can carry the pid
      // the kernel just handed this child. The record must also be NEWER than the launch.
      const launchedMs = Date.parse(result.run.launchedAt);
      const isOurs = (run: RunIndexEntry): boolean => {
        if (run.pid !== result.run.pid) return false;
        const started = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
        if (!Number.isFinite(started) || !Number.isFinite(launchedMs)) return false;
        // A second of slack for clock granularity between the two processes.
        return started >= launchedMs - 1_000;
      };

      const deadline = Date.now() + LAUNCH_RECORD_TIMEOUT_MS;
      for (;;) {
        const index = await options.capabilities.readRunIndex(options.cwd);
        const started = index.runs.find(isOurs);
        if (started !== undefined) {
          // Publish what was just read BEFORE navigating. Reading the index into a local and then
          // navigating leaves `data` on its pre-launch snapshot, so the run screen looks the new run
          // up in a map that does not contain it and reports the run it just started as "no longer
          // on disk" — on every single start.
          const labs = await options.capabilities.listLabs(options.cwd);
          setData(project(index, labs.labs));
          setLaunchNote(undefined);
          // Only follow the run if the operator is still where they launched from. This resolves up
          // to LAUNCH_RECORD_TIMEOUT_MS later, by which time they may have gone somewhere else, and
          // yanking the screen out from under them is worse than not following.
          if (screenRef.current.name === "lab" && screenRef.current.labKey === row.key) {
            dispatch({ type: "enter", screen: { name: "run", labId: row.labId, runId: started.runId } });
          }
          return;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, LAUNCH_RECORD_POLL_MS));
      }

      // Still nothing. The process may have died before writing anything, and the launch log is the
      // only account of that — so show it rather than leaving a silent gap.
      const log = await options.capabilities.readLaunchLog(result.run.logPath);
      setLaunchNote(undefined);
      setLaunchError({
        labKey: row.key,
        text:
          log === ""
            ? `${row.name} started (pid ${result.run.pid}) but has not reported in. Check ${result.run.logPath}.`
            : `${row.name} did not report in. Its log ends:\n${log.split("\n").slice(-3).join("\n")}`
      });
    },
    [confirming, armedAt, options]
  );

  /**
   * Run a card's action. Every branch sets a note, because a control that fires and says nothing is
   * indistinguishable from one that is broken.
   */
  const act = useCallback(
    async (run: RunIndexEntry, action: "observer" | "again" | "reclaim"): Promise<void> => {
      if (action === "observer") {
        const observerPath = detail?.observerPath;
        if (observerPath === undefined) {
          setActionNote("this run has no Observer artifact on disk");
          return;
        }
        setActionNote("opening…");
        const result = await options.capabilities.openObserver(options.cwd, observerPath);
        setActionNote(result.message);
        return;
      }
      if (action === "reclaim") {
        setActionNote("reclaiming — stopping sandboxes, keeping evidence…");
        const result = await options.capabilities.reclaimRun(options.cwd, run.runId);
        setActionNote(
          result.ok
            ? `reclaimed ${result.receiptCount} recorded resource${result.receiptCount === 1 ? "" : "s"}`
            : `could not reclaim: ${result.error?.message ?? "unknown"}`
        );
        return;
      }
      // Run again: the SAME lab, in the same mode it ran in, launched the same detached way.
      const labId = run.lab?.id;
      const row = labId === undefined ? undefined : data?.rows.find((candidate) => candidate.labId === labId);
      if (row === undefined || !row.declared) {
        setActionNote("cannot run this again — its lab has no manifest here any more");
        return;
      }
      setActionNote(`starting ${row.name}…`);
      const started = await options.capabilities.startRun({
        cwd: options.cwd,
        lab: row.name,
        mode: run.mode === "live" ? "live" : "dry-run"
      });
      setActionNote(started.ok ? `started ${row.name} (pid ${started.run.pid})` : started.error.message);
    },
    [detail, options, data]
  );

  useInput(
    useCallback(
      (input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean; leftArrow?: boolean; rightArrow?: boolean }) => {
        if (input === "q") {
          exit();
          return;
        }
        if (key.upArrow || input === "k" || key.downArrow || input === "j") {
          // Moving off the armed row disarms it. Otherwise the banner keeps claiming Enter will
          // confirm a live run while the cursor sits somewhere Enter does something else entirely.
          if (confirming !== undefined) {
            setConfirming(undefined);
            setArmedAt(undefined);
          }
          dispatch({ type: "move", delta: key.upArrow || input === "k" ? -1 : 1, total: rowCount });
          return;
        }
        // ←/→ switch the Start toggle when it is selected; otherwise ← is back.
        if ((key.leftArrow || key.rightArrow) && screen.name === "lab" && data !== undefined) {
          const { row, items } = itemsForLab(data, screen.labKey);
          if (row !== undefined && items[selected]?.kind === "start") {
            setModeByLab((previous) => ({
              ...previous,
              [row.key]: key.rightArrow ? "live" : "dry-run"
            }));
            // Switching the mode disarms: a confirmation shown for one mode must not commit another.
            setConfirming(undefined);
            setArmedAt(undefined);
            return;
          }
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
          if (screen.name === "run" && data !== undefined) {
            const run = data.runsById.get(screen.runId);
            if (run !== undefined) {
              const action = runActions(run, detail)[selected];
              if (action !== undefined) {
                void act(run, action);
                return;
              }
            }
          }
          if (screen.name === "lab" && data !== undefined) {
            const { row, items } = itemsForLab(data, screen.labKey);
            const item = items[selected];
            if (row !== undefined && item?.kind === "start") {
              void start(row, modeByLab[row.key] ?? "dry-run");
              return;
            }
          }
          const next = openSelected(screen, data, selected);
          if (next !== undefined) dispatch({ type: "enter", screen: next });
        }
      },
      [exit, rowCount, screen, data, selected, confirming, start, modeByLab, detail, act]
    )
  );

  useEffect(() => {
    if (nav.quit) exit();
  }, [nav.quit, exit]);

  // Detail is fetched ONLY for the run being looked at. It opens that run's bundle, which the index
  // deliberately does not — affordable for one run, not for a listing.
  const openRunId = screen.name === "run" ? screen.runId : undefined;
  useEffect(() => {
    setActionNote(undefined);
    if (openRunId === undefined) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    setDetail(undefined);
    const read = async (): Promise<void> => {
      try {
        const next = await options.capabilities.readRunDetail(options.cwd, openRunId);
        if (!cancelled) setDetail(next);
      } catch {
        // A detail that cannot be read leaves the run's own facts on screen rather than replacing
        // them with an error: the index already told the truth about this run.
        if (!cancelled) setDetail(null);
      }
    };
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    timer.unref?.();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [openRunId, options]);

  // The spinner clock. Independent of the data refresh, because motion is what says "live" and a
  // 2s heartbeat does not read as motion.
  useEffect(() => {
    const timer = setInterval(() => setTick((previous) => previous + 1), SPINNER_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);

  // Who is in each LIVE run, so the labs list can name them. Only live runs — reading detail for
  // the whole list would open every bundle, which is exactly what the index exists to avoid.
  const liveRunIds = (data?.rows ?? []).flatMap((row) => row.liveRuns.map((run) => run.runId)).join(",");
  useEffect(() => {
    if (liveRunIds === "") {
      setLiveDetails(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const ids = liveRunIds.split(",");
      const entries = await Promise.all(
        ids.map(async (runId): Promise<[string, RunDetail] | null> => {
          const read = await options.capabilities.readRunDetail(options.cwd, runId).catch(() => null);
          return read === null ? null : [runId, read];
        })
      );
      if (!cancelled) setLiveDetails(new Map(entries.filter((entry): entry is [string, RunDetail] => entry !== null)));
    })();
    return () => {
      cancelled = true;
    };
  }, [liveRunIds, options, tick]);

  // What the open lab IS. Includes the key probe, which is why it is read per lab rather than for
  // the whole list.
  const openLabKey = screen.name === "lab" ? screen.labKey : undefined;
  const openLabName = openLabKey === undefined ? undefined : data?.rows.find((row) => row.key === openLabKey)?.name;
  useEffect(() => {
    if (openLabName === undefined) {
      setSummary(undefined);
      return;
    }
    let cancelled = false;
    setSummary(undefined);
    void (async () => {
      const read = await options.capabilities
        .readLabSummary(options.cwd, openLabName, { checkKeys: true })
        .catch(() => null);
      if (!cancelled) setSummary(read);
    })();
    return () => {
      cancelled = true;
    };
  }, [openLabName, options]);

  const viewport = Math.max(1, size.rows - CHROME_ROWS);
  const body = useMemo(() => {
    if (error !== undefined) return <Text color="red">could not read this project: {error}</Text>;
    if (data === undefined) return <Text dimColor>reading project…</Text>;
    return renderScreen({
      screen, data, selected, columns: contentWidth(size.columns), viewport, now: clock,
      confirming, launchError, launchNote, detail, summary, liveDetails, tick, modeByLab,
      initialized: projectState.initialized, actionNote
    });
  }, [error, data, screen, selected, size.columns, viewport, clock, confirming, launchError, launchNote, detail, summary, liveDetails, tick, modeByLab, projectState, actionNote]);

  return (
    <Frame
      columns={size.columns}
      context={contextLine(screen, data, options)}
      breadcrumb={breadcrumbOf(screen, data)}
      hints={keyHints(screen, data, selected, confirming)}
    >
      {body}
    </Frame>
  );
}

/**
 * The right of the header: the project, and whether anyone is working in it. The two things a
 * stakeholder wants without reading anything else.
 */
function contextLine(
  screen: ReturnType<typeof currentScreen>,
  data: ProjectData | undefined,
  options: TuiOptions
): string | undefined {
  const project = options.cwd.split("/").filter(Boolean).pop();
  // On a run card the context carries WHICH RUN, because the card itself leads with the verdict —
  // the id still has to be somewhere, and this is where the mock puts it.
  if (screen.name === "run" && data !== undefined) {
    const run = data.runsById.get(screen.runId);
    const short = screen.runId.split("-").pop() ?? screen.runId;
    return [run?.lab?.id, short].filter(Boolean).join(" · ");
  }
  if (data === undefined) return project;
  const live = liveRunsOf(data).length;
  if (live === 0) return project;
  return `${project} · ${live} participant${live === 1 ? "" : "s"} working`;
}

/** Where you are, as a path back. */
function breadcrumbOf(
  screen: ReturnType<typeof currentScreen>,
  data: ProjectData | undefined
): string | undefined {
  if (screen.name === "labs") return undefined;
  if (screen.name === "all-runs") return "‹ labs / all runs";
  if (screen.name === "lab") {
    const row = data?.rows.find((candidate) => candidate.key === screen.labKey);
    return `‹ labs / ${row?.name ?? screen.labKey}`;
  }
  const lab = screen.labId;
  return lab === undefined ? "‹ labs / run" : `‹ labs / ${lab} / run`;
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
      // Nothing to move through or open on an empty screen, and a legend that lists inert keys
      // teaches the wrong model of the surface.
      return (data?.rows.length ?? 0) === 0 ? "q quit" : `${move}   ⏎ open   q quit`;
    case "lab": {
      if (confirming !== undefined) return "↵ confirm · esc cancel";
      const item = data === undefined ? undefined : itemsForLab(data, screen.labKey).items[selected];
      const enter = item?.kind === "start" ? "⏎ start · ←→ mode" : "⏎ open run";
      return `${move}   ${enter}   esc back   q quit`;
    }
    case "all-runs":
      return `${move}   ⏎ open run   esc back   q quit`;
    default: {
      // Only when the card actually has actions — an empty legend beats one promising a key that
      // does nothing on a run still in flight.
      const run = data === undefined ? undefined : data.runsById.get(screen.name === "run" ? screen.runId : "");
      const hasActions = run !== undefined && runActions(run, undefined).length > 0;
      return hasActions ? `${move}   ⏎ select   esc back   q quit` : "esc back   q quit";
    }
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

/**
 * Every live run in the project, ONCE.
 *
 * Not a flatMap over lab rows: two manifests can declare the same lab id, so a run belonging to
 * that id is reachable from both rows and would be listed twice — the same participant, twice, at
 * the same elapsed time, which reads as two people working.
 */
function liveRunsOf(data: ProjectData): RunIndexEntry[] {
  const seen = new Set<string>();
  const out: RunIndexEntry[] = [];
  for (const run of data.rows.flatMap((row) => row.liveRuns)) {
    if (seen.has(run.runId)) continue;
    seen.add(run.runId);
    out.push(run);
  }
  return out;
}

/** A lab's display name from its id, for screens that only carry the id. */
function labelForLab(data: ProjectData, labId: string | undefined): string {
  if (labId === undefined) return "";
  return data.rows.find((row) => row.labId === labId)?.label ?? labId;
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
      // The labs, plus the "All runs" peer beneath them.
      return data.rows.length + 1;
    case "all-runs":
      return liveRunsOf(data).length;
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
  if (screen.name === "labs") return data.rows[selected]?.key ?? "peer:all-runs";
  if (screen.name === "all-runs") return liveRunsOf(data)[selected]?.runId;
  if (screen.name === "lab") {
    const item = itemsForLab(data, screen.labKey).items[selected];
    if (item === undefined) return undefined;
    return item.kind === "start" ? "start" : `run:${item.run.runId}`;
  }
  return undefined;
}

/** Where that identity sits now. -1 when it is gone (a run deleted, a manifest removed). */
function indexOfIdentity(
  screen: ReturnType<typeof currentScreen>,
  data: ProjectData,
  identity: string
): number {
  if (screen.name === "labs") {
    return identity === "peer:all-runs" ? data.rows.length : data.rows.findIndex((row) => row.key === identity);
  }
  if (screen.name === "all-runs") {
    return liveRunsOf(data).findIndex((run) => run.runId === identity);
  }
  if (screen.name === "lab") {
    return itemsForLab(data, screen.labKey).items.findIndex((item) =>
      item.kind === "start" ? identity === "start" : `run:${item.run.runId}` === identity
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
    // Past the last lab is the peer.
    if (row === undefined) return selected === data.rows.length ? { name: "all-runs" } : undefined;
    return { name: "lab", labKey: row.key };
  }
  if (screen.name === "all-runs") {
    const run = liveRunsOf(data)[selected];
    return run === undefined ? undefined : { name: "run", ...(run.lab?.id === undefined ? {} : { labId: run.lab.id }), runId: run.runId };
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
  launchError: { labKey: string; text: string } | undefined;
  launchNote: { labKey: string; text: string } | undefined;
  detail: RunDetail | null | undefined;
  summary: LabSummary | null | undefined;
  liveDetails: Map<string, RunDetail>;
  tick: number;
  modeByLab: Record<string, "dry-run" | "live">;
  initialized: boolean;
  actionNote: string | undefined;
}): React.ReactElement {
  const { screen, data, selected, columns, viewport, now, confirming, launchError, launchNote, detail } = args;
  const { summary, liveDetails, tick, modeByLab, initialized, actionNote } = args;
  if (screen.name === "labs") {
    return (
      <LabsScreen
        rows={data.rows}
        selected={selected}
        columns={columns}
        viewport={viewport}
        unattributed={data.unattributed.length}
        tick={tick}
        initialized={initialized}
        peerSelected={selected === data.rows.length}
        liveTotal={liveRunsOf(data).length}
        liveParticipants={
          new Map(
            [...liveDetails.entries()]
              .map(([runId, value]): [string, string] | null => {
                const who = value.participants[0]?.personaId ?? value.participants[0]?.label;
                return who === undefined ? null : [runId, who];
              })
              .filter((entry): entry is [string, string] => entry !== null)
          )
        }
        now={now}
      />
    );
  }
  if (screen.name === "lab") {
    const row = data.rows.find((candidate) => candidate.key === screen.labKey);
    if (row === undefined) return <Text color="yellow">that lab is no longer in this project</Text>;
    return (
      <LabScreen
        row={row}
        summary={summary}
        runs={data.runsByLab.get(row.labId) ?? []}
        liveDetail={liveDetails.get(row.liveRuns[0]?.runId ?? "")}
        selected={selected}
        columns={columns}
        viewport={viewport}
        now={now}
        tick={tick}
        canStart={row.declared}
        mode={modeByLab[row.key] ?? "dry-run"}
        confirming={confirming}
        launchError={launchError?.labKey === row.key ? launchError.text : undefined}
        launchNote={launchNote?.labKey === row.key ? launchNote.text : undefined}
      />
    );
  }
  if (screen.name === "all-runs") {
    const live = liveRunsOf(data);
    return (
      <AllRunsScreen
        runs={live}
        details={liveDetails}
        labels={new Map(live.map((run) => [run.runId, labelForLab(data, run.lab?.id)]))}
        expected={
          new Map(
            data.rows
              .map((row): [string, number] | null =>
                row.liveExpectation.medianDurationMs === undefined ? null : [row.labId, row.liveExpectation.medianDurationMs]
              )
              .filter((entry): entry is [string, number] => entry !== null)
          )
        }
        selected={selected}
        columns={columns}
        viewport={viewport}
        tick={tick}
        now={now}
      />
    );
  }
  const run = data.runsById.get(screen.runId);
  if (run === undefined) return <Text color="yellow">that run is no longer on disk</Text>;
  return (
    <RunScreen
      run={run}
      detail={detail}
      columns={columns}
      viewport={viewport}
      selected={selected}
      tick={tick}
      now={now}
      actionNote={actionNote}
    />
  );
}
