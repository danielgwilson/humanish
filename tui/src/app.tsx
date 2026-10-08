import { Text, useApp, useInput, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { HelpScreen } from "./screens/help-screen.js";
import { ConnectionsScreen } from "./screens/connections-screen.js";
import { PALETTE } from "./palette.js";

import type { StudySummary } from "../../src/study/summary.js";
import type { RunDetail } from "../../src/run/detail.js";
import type { RunIndexEntry } from "../../src/run/run-index.js";
import type { StudyRow } from "../../src/run/projection.js";
import type { TuiOptions } from "../../src/tui/contract.js";
import { currentScreen, initialNav, navigate, selectedIndex } from "./navigation.js";
import { Frame, contentWidth } from "./frame.js";
import { frameText } from "./frame-text.js";
import {
  countRows,
  identityOf,
  indexOfIdentity,
  itemsForStudy,
  openSelected,
  projectData,
  retiredFileOf,
  type ProjectData,
} from "./project.js";
import { renderScreen } from "./screen-body.js";
import { runActions } from "./screens/run-screen.js";
import { startStudy } from "./start-study.js";

export interface AppProps {
  onKeyEntry?: () => void;
  options: TuiOptions;
  onReady?: () => void;
  /** Frozen in tests so a golden never depends on the wall clock. */
  now?: number;
  /**
   * Frozen spinner phase, for the same reason `now` is frozen: the spinner glyph is part of every
   * live frame, and it advances on a 120ms timer, so a golden containing one is a coin flip on a
   * loaded machine. CI caught exactly that, passing on one Node version and failing on another.
   */
  tick?: number;
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

/**
 * The shortest gap between arming a live run and committing it. Key auto-repeat delivers around one
 * event every 30ms, so without a floor a held Enter arms and commits inside a single keypress.
 */
const LIVE_CONFIRM_MIN_MS = 400;

/** Spinner cadence. Fast enough to read as motion, slow enough not to strobe over SSH. */
const SPINNER_MS = 120;

export function App({
  options,
  onReady,
  onKeyEntry,
  now,
  tick: frozenTick,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const size = useWindowSize();
  const [nav, dispatch] = useReducer(navigate, undefined, initialNav);
  const [data, setData] = useState<ProjectData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // A live start is armed by the first Enter and committed by the second; a dry run needs neither.
  const [confirming, setConfirming] = useState<"live" | undefined>(undefined);
  // Launch state is scoped to the study it belongs to: it is one surface with one piece of state, and
  // an unscoped note follows the operator to a different study's screen and reports something about
  // that study which is not true of it.
  const [launchError, setLaunchError] = useState<{ studyKey: string; text: string } | undefined>(
    undefined,
  );
  /** A launch in flight, or one whose record has not appeared yet. Not an error. */
  const [launchNote, setLaunchNote] = useState<{ studyKey: string; text: string } | undefined>(
    undefined,
  );
  /** When the live confirmation was armed, so a held key cannot blow through it. */
  const [armedAt, setArmedAt] = useState<number | undefined>(undefined);
  /**
   * The open run's participants. `undefined` means "not read yet" and `null` means "read, and it
   * has no bundle": a run that has just started. The screen says something different for each,
   * because "still loading" and "nothing there" are different facts.
   */
  const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined);
  /** What the last run-card action reported. An action that appears to do nothing is a bug. */
  const [actionNote, setActionNote] = useState<string | undefined>(undefined);
  /** When a stop was armed. Ending paid work needs the same two keystrokes starting it does. */
  const [stopArmedAt, setStopArmedAt] = useState<number | undefined>(undefined);
  const [showHelp, setShowHelp] = useState(false);
  const [showConnections, setShowConnections] = useState(options.initialScreen === "connections");
  /** When the "set up humanish here" action was armed: it writes into the operator's directory. */
  const [initArmedAt, setInitArmedAt] = useState<number | undefined>(undefined);
  /** Advances the spinners. A live row that does not move reads as stale data. */
  const [liveTick, setTick] = useState(0);
  const tick = frozenTick ?? liveTick;
  /** Which side the Start toggle is on. Per study, so switching studies does not carry `live` across. */
  const [summary, setSummary] = useState<StudySummary | null | undefined>(undefined);
  /** Detail for live runs only, so the studies list can name who is in them. */
  const [liveDetails, setLiveDetails] = useState<Map<string, RunDetail>>(new Map());
  /** Whether this is a humanish project. Cheap and synchronous: two existence checks. */
  const projectState = useMemo(() => options.capabilities.readProjectState(options.cwd), [options]);
  // Study files humanish no longer reads make this a project, even one with only .humanish/labs/.
  const initialized = projectState.initialized || (data?.retired.length ?? 0) > 0;
  const clock = now ?? Date.now();

  // Identity of the selected row, kept current so a refresh that reorders the list can put the
  // cursor back on the same thing. A live study sorts to the top the moment a run starts, so an index
  // held across a refresh silently points at a different study, and that is how someone opens, or
  // starts, the wrong one.
  const selectedIdRef = useRef<string | undefined>(undefined);
  /** Where the operator is right now, readable from an async launch that started long ago. */
  const screenRef = useRef<ReturnType<typeof currentScreen>>({ name: "studies" });

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        // Read both sides before rendering either: a labs list assembled from history alone is
        // empty on a fresh project, and one from manifests alone hides real runs.
        const [index, studies] = await Promise.all([
          // Caching is the capability's business, not the view's: the injected reader keeps a
          // stat-keyed cache across these calls, so a refresh re-reads only what changed.
          options.capabilities.readRunIndex(options.cwd),
          options.capabilities.listStudies(options.cwd),
        ]);
        if (cancelled) return;
        setError(undefined);
        setData(projectData(index, studies.studies, studies.retired));
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
  // has written that frame: signalling beside setState reports ready while the screen still says
  // "reading…".
  useEffect(() => {
    if (data !== undefined || error !== undefined) onReady?.();
  }, [data, error, onReady]);

  const screen = currentScreen(nav);
  const selected = selectedIndex(nav);
  const rowCount = countRows(screen, data, detail);

  useEffect(() => {
    screenRef.current = screen;
    const identity = identityOf(screen, data, selected);
    if (identity !== undefined) selectedIdRef.current = identity;
  }, [screen, data, selected]);

  // After a refresh, put the cursor back on the same row rather than the same index. When the row
  // is gone entirely (a run deleted underneath us) the index is left where it was and clamped by
  // the reducer, which keeps the cursor near where the operator left it.
  useEffect(() => {
    if (data === undefined) return;
    const identity = selectedIdRef.current;
    if (identity === undefined) return;
    const next = indexOfIdentity(screen, data, identity);
    if (next >= 0 && next !== selected) {
      dispatch({ type: "select", index: next, total: countRows(screen, data, detail) });
    }
    // `selected` is deliberately absent: this reacts to data changing, not to the operator moving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, screen]);

  const start = useCallback(
    async (row: StudyRow, mode: "dry-run" | "live"): Promise<void> => {
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
      setLaunchNote({ studyKey: row.key, text: `starting ${row.name}…` });
      const started = await startStudy(options, row, mode);
      setLaunchNote(undefined);
      if (!started.ok) {
        setLaunchError({ studyKey: row.key, text: started.message });
        return;
      }
      // Publish what was just read before navigating. Reading the index into a local and then
      // navigating leaves `data` on its pre-launch snapshot, so the run screen looks the new run
      // up in a map that does not contain it and reports the run it just started as "no longer
      // on disk": on every single start.
      setData(started.data);
      // Only follow the run if the operator is still where they launched from. This resolves up
      // to five seconds later, by which time they may have gone somewhere else, and yanking the
      // screen out from under them is worse than not following.
      if (screenRef.current.name === "study" && screenRef.current.studyKey === row.key) {
        dispatch({
          type: "enter",
          screen: { name: "run", studyId: row.studyId, runId: started.runId },
        });
      }
    },
    [confirming, armedAt, options],
  );

  /**
   * Run a card's action. Every branch sets a note, because a control that fires and says nothing is
   * indistinguishable from one that is broken.
   */
  const act = useCallback(
    async (
      run: RunIndexEntry,
      action: "observer" | "again" | "reclaim" | "stop" | "cancel-analysis",
    ): Promise<void> => {
      if (action === "stop" || action === "cancel-analysis") {
        // Armed like a live start, and for the same reason: it ends work that has already been paid
        // for, and a single keystroke should not be able to do that by accident.
        if (stopArmedAt === undefined) {
          setStopArmedAt(Date.now());
          setActionNote(
            action === "cancel-analysis"
              ? "cancel analysis? ⏎ again to confirm · esc keep analyzing"
              : "stop this run? ⏎ again to confirm · esc cancel",
          );
          return;
        }
        if (Date.now() - stopArmedAt < LIVE_CONFIRM_MIN_MS) return;
        setStopArmedAt(undefined);
        setActionNote(action === "cancel-analysis" ? "cancelling analysis…" : "stopping…");
        const result = await options.capabilities.stopRun(
          options.cwd,
          run.runId,
          action === "cancel-analysis" ? "analysis" : "run",
        );
        setActionNote(result.message);
        return;
      }
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
        setActionNote("reclaiming: stopping sandboxes, keeping evidence…");
        const result = await options.capabilities.reclaimRun(options.cwd, run.runId);
        const found = result.outcomes.length;
        setActionNote(
          result.error === undefined
            ? `reclaim ${result.state}: ${found} sandbox${found === 1 ? "" : "es"} found by receipt or E2B tag`
            : `could not reclaim: ${result.error.message}`,
        );
        return;
      }
      // Run again: the same study, in the same mode it ran in, launched the same detached way.
      const studyId = run.study?.id;
      const matching =
        studyId === undefined
          ? []
          : (data?.rows.filter(
              (candidate) => candidate.studyId === studyId && candidate.declared,
            ) ?? []);
      if (matching.length > 1) {
        setActionNote(
          "multiple manifests share this study id; choose the exact one from the list to run again",
        );
        return;
      }
      const row = matching[0];
      if (row === undefined || !row.declared) {
        const retired = data === undefined ? undefined : retiredFileOf(data, studyId);
        setActionNote(
          retired === undefined
            ? "cannot run this again: its study has no manifest here any more"
            : `cannot run this again: ${retired.message}`,
        );
        return;
      }
      setActionNote(`starting ${row.name}…`);
      const started = await options.capabilities.startRun({
        cwd: options.cwd,
        study: row.name,
        ...(row.path ? { manifestPath: row.path } : {}),
        mode: run.mode === "live" ? "live" : "dry-run",
      });
      setActionNote(
        started.ok ? `started ${row.name} (pid ${started.run.pid})` : started.error.message,
      );
    },
    [detail, options, data, stopArmedAt],
  );

  useInput(
    useCallback(
      (
        input: string,
        key: {
          upArrow?: boolean;
          downArrow?: boolean;
          return?: boolean;
          escape?: boolean;
          leftArrow?: boolean;
          rightArrow?: boolean;
        },
      ) => {
        if (showConnections) {
          if (input === "q") exit();
          return;
        }
        if (showHelp) {
          // Any key leaves: a help screen you can get stuck in is worse than none. `q` still quits.
          setShowHelp(false);
          if (input === "q") exit();
          return;
        }
        if (input === "?") {
          setShowHelp(true);
          return;
        }
        if (input === "q") {
          exit();
          return;
        }
        if (input === "c" && options.capabilities.comms) {
          setConfirming(undefined);
          setArmedAt(undefined);
          setStopArmedAt(undefined);
          setInitArmedAt(undefined);
          setShowConnections(true);
          return;
        }
        if (input === "g" || input === "G") {
          if (confirming !== undefined) {
            setConfirming(undefined);
            setArmedAt(undefined);
          }
          dispatch({ type: "move", delta: input === "g" ? -rowCount : rowCount, total: rowCount });
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
        if (key.escape || key.leftArrow) {
          // Escape cancels an armed confirmation before it means "go back": the nearer meaning of
          // "no" wins, so a confirmation can never be dismissed by accidentally leaving the screen.
          // Both kinds (starting a live run, and stopping one) are armed, and both are undone
          // here rather than carried to whatever screen you land on next.
          if (confirming !== undefined) {
            setConfirming(undefined);
            setArmedAt(undefined);
            return;
          }
          if (stopArmedAt !== undefined) {
            setStopArmedAt(undefined);
            setActionNote(undefined);
            return;
          }
          if (initArmedAt !== undefined) {
            setInitArmedAt(undefined);
            return;
          }
          dispatch({ type: "back" });
          return;
        }
        if (key.return || key.rightArrow) {
          // The empty-project screen has exactly one action, so Enter means it. Armed, because it
          // writes into the operator's directory and touches package.json.
          if (screen.name === "studies" && !initialized) {
            if (initArmedAt === undefined) {
              setInitArmedAt(Date.now());
              return;
            }
            if (Date.now() - initArmedAt < LIVE_CONFIRM_MIN_MS) return;
            setInitArmedAt(undefined);
            void (async () => {
              const outcome = await options.capabilities.initProject(options.cwd);
              setActionNote(outcome.message);
            })();
            return;
          }
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
          if (screen.name === "study" && data !== undefined) {
            const { row, items } = itemsForStudy(data, screen.studyKey);
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
      [
        exit,
        rowCount,
        screen,
        data,
        selected,
        confirming,
        start,
        detail,
        act,
        stopArmedAt,
        showHelp,
        showConnections,
        initArmedAt,
        initialized,
        options,
      ],
    ),
  );

  useEffect(() => {
    if (nav.quit) exit();
  }, [nav.quit, exit]);

  // Detail is fetched only for the run being looked at. It opens that run's bundle, which the index
  // deliberately does not: affordable for one run, not for a listing.
  const openRunId = screen.name === "run" ? screen.runId : undefined;
  useEffect(() => {
    setActionNote(undefined);
    setStopArmedAt(undefined);
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
    if (frozenTick !== undefined) return;
    const timer = setInterval(() => setTick((previous) => previous + 1), SPINNER_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [frozenTick]);

  // Live participants plus the latest run of the open study, so its post-run analysis stays visible.
  // Never open all historical bundles merely to populate a list.
  const watchedStudy =
    screen.name === "study" ? data?.rows.find((row) => row.key === screen.studyKey) : undefined;
  const watchedLatestId =
    watchedStudy === undefined
      ? undefined
      : data?.runsByStudy.get(watchedStudy.studyId)?.[0]?.runId;
  const liveRunIds = [
    ...new Set([
      ...(data?.rows ?? []).flatMap((row) => row.liveRuns.map((run) => run.runId)),
      ...(watchedLatestId === undefined ? [] : [watchedLatestId]),
    ]),
  ].join(",");
  useEffect(() => {
    if (liveRunIds === "") {
      setLiveDetails(new Map());
      return;
    }
    let cancelled = false;
    let reading = false;
    const read = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      const ids = liveRunIds.split(",");
      const entries = await Promise.all(
        ids.map(async (runId): Promise<[string, RunDetail] | null> => {
          const read = await options.capabilities
            .readRunDetail(options.cwd, runId)
            .catch(() => null);
          return read === null ? null : [runId, read];
        }),
      );
      if (!cancelled)
        setLiveDetails(
          new Map(entries.filter((entry): entry is [string, RunDetail] => entry !== null)),
        );
      reading = false;
    };
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    timer.unref?.();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [liveRunIds, options]);

  // What the open study is. Includes the key probe, which is why it is read per study rather than for
  // the whole list.
  const openStudyKey = screen.name === "study" ? screen.studyKey : undefined;
  const openStudyRow =
    openStudyKey === undefined ? undefined : data?.rows.find((row) => row.key === openStudyKey);
  const openStudyName = openStudyRow?.path ?? openStudyRow?.name;
  useEffect(() => {
    if (openStudyName === undefined) {
      setSummary(undefined);
      return;
    }
    let cancelled = false;
    setSummary(undefined);
    void (async () => {
      const read = await options.capabilities
        .readStudySummary(options.cwd, openStudyName, { checkKeys: true })
        .catch(() => null);
      if (!cancelled) setSummary(read);
    })();
    return () => {
      cancelled = true;
    };
  }, [openStudyName, options]);

  const viewport = Math.max(1, size.rows - CHROME_ROWS);
  const body = useMemo(() => {
    if (showConnections && options.capabilities.comms)
      return (
        <ConnectionsScreen
          capabilities={options.capabilities.comms}
          columns={contentWidth(size.columns)}
          notice={options.connectionNotice}
          onBack={() => setShowConnections(false)}
          onKeyEntry={() => {
            onKeyEntry?.();
            exit();
          }}
        />
      );
    if (showHelp)
      return (
        <HelpScreen
          columns={contentWidth(size.columns)}
          connections={!!options.capabilities.comms}
        />
      );
    if (error !== undefined)
      return <Text color={PALETTE.bad}>could not read this project: {error}</Text>;
    if (data === undefined) return <Text dimColor>reading project…</Text>;
    return renderScreen({
      screen,
      data,
      selected,
      columns: contentWidth(size.columns),
      viewport,
      now: clock,
      confirming,
      launchError,
      launchNote,
      detail,
      summary,
      liveDetails,
      tick,
      initialized,
      actionNote,
      initArmed: initArmedAt !== undefined,
    });
  }, [
    showHelp,
    showConnections,
    options,
    onKeyEntry,
    exit,
    error,
    data,
    screen,
    selected,
    size.columns,
    viewport,
    clock,
    confirming,
    launchError,
    launchNote,
    detail,
    summary,
    liveDetails,
    tick,
    initialized,
    actionNote,
  ]);

  return (
    <Frame
      columns={size.columns}
      {...frameText({
        screen,
        data,
        selected,
        confirming,
        initialized,
        overlay: showConnections ? "connections" : showHelp ? "help" : undefined,
        connections: !!options.capabilities.comms,
        cwd: options.cwd,
        columns: size.columns,
      })}
    >
      {body}
    </Frame>
  );
}
