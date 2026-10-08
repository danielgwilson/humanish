import { Text, useApp, useInput, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { HelpScreen } from "./screens/help-screen.js";
import { ConnectionsScreen } from "./screens/connections-screen.js";
import { KeysScreen } from "./screens/keys-screen.js";
import { PALETTE } from "./palette.js";
import { useArming } from "./arming.js";

import type { StudySummary } from "../../src/study/summary.js";
import type { RunDetail } from "../../src/run/detail.js";
import type { RunIndexEntry } from "../../src/run/run-index.js";
import type { StudyRow } from "../../src/run/projection.js";
import type { TuiHandoff, TuiOptions } from "../../src/tui/contract.js";
import {
  currentScreen,
  initialNav,
  navigate,
  screenKey,
  selectedIndex,
  type Screen,
} from "./navigation.js";
import { Frame, contentWidth } from "./frame.js";
import { frameText } from "./frame-text.js";
import {
  countRows,
  identityOf,
  indexOfIdentity,
  itemsForStudy,
  openSelected,
  projectData,
  rerunStudyOf,
  type ProjectData,
} from "./project.js";
import { renderScreen } from "./screen-body.js";
import { runActions } from "./screens/run-screen.js";
import { liveCostText } from "./screens/study-screen.js";
import { startStudy } from "./start-study.js";

export interface AppProps {
  /** A key the person asked to enter; the surface exits after it so the host can prompt. */
  onKeyEntry?: (handoff: TuiHandoff) => void;
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

/** Spinner cadence. Fast enough to read as motion, slow enough not to strobe over SSH. */
const SPINNER_MS = 120;

/**
 * Why a live start of this study cannot happen here. `humanish run` runs a file in the mode it
 * sets, and no flag turns a dry-run file live, so a live start would start a dry run under a prompt
 * that promised spend.
 */
function dryRunFileNote(row: StudyRow): string {
  return `Set mode: live in ${row.path ?? row.name} to start a live run.`;
}

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
  /**
   * The open run's participants. `undefined` means "not read yet" and `null` means "read, and it
   * has no bundle": a run that has just started. The screen says something different for each,
   * because "still loading" and "nothing there" are different facts.
   */
  const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined);
  /** What the last run-card action reported. An action that appears to do nothing is a bug. */
  const [actionNote, setActionNote] = useState<string | undefined>(undefined);
  const [showHelp, setShowHelp] = useState(false);
  /** `c keys and accounts`, and the email connection one of its rows opens. */
  const [accounts, setAccounts] = useState<"keys" | "email" | undefined>(
    options.initialScreen === "connections"
      ? "email"
      : options.initialScreen === "keys"
        ? "keys"
        : undefined,
  );
  const [keysCursor, setKeysCursor] = useState(0);
  const hasAccounts =
    options.capabilities.keys !== undefined || options.capabilities.comms !== undefined;
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
  /**
   * The time this frame measures elapsed durations against. Held in state and advanced by the
   * spinner timer below, because a clock read during render renders the same state differently.
   */
  const [wallClock, setWallClock] = useState(() => Date.now());
  const clock = now ?? wallClock;

  // The row the person chose on each screen, by identity, keyed like the navigation's per-screen
  // index. A live study sorts to the top the moment a run starts, and a run that finishes swaps Stop
  // for Run again, so an index held across a refresh silently points at a different row, and that
  // is how someone opens, or starts, the wrong one.
  const chosenRef = useRef(new Map<string, string>());
  /** The cursor at the last commit, which tells the person's moves apart from refreshes. */
  const cursorRef = useRef<{ screen: Screen; selected: number } | undefined>(undefined);
  /** Where the operator is right now, readable from an async launch that started long ago. */
  const screenRef = useRef<Screen>({ name: "studies" });

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
  // A live start, Run again on a live run, Stop, Cancel analysis and setting up the project each take
  // two Enters, and the second counts only while the cursor is on the same action of the same screen.
  const {
    armed,
    press: pressArmed,
    disarm,
  } = useArming(`${screenKey(screen)}\n${identityOf(screen, data, selected, detail) ?? selected}`);
  const confirming = armed === "live-start" ? "live" : undefined;

  // A move on the same screen records the row the cursor is on. Anything else (a refresh, arriving
  // at a screen, coming back to one) puts the cursor on the recorded row. When that row is gone
  // (a run deleted, a Stop that no longer applies) the cursor keeps its index and the record stays
  // until the person moves, so Enter on the run screen can tell that nobody chose the row under it.
  useEffect(() => {
    screenRef.current = screen;
    if (data === undefined) return;
    const last = cursorRef.current;
    cursorRef.current = { screen, selected };
    const key = screenKey(screen);
    const chosen = chosenRef.current.get(key);
    const moved = last?.screen === screen && last.selected !== selected;
    if (!moved && chosen !== undefined) {
      const next = indexOfIdentity(screen, data, chosen, detail);
      if (next >= 0 && next !== selected) {
        dispatch({ type: "select", index: next, total: countRows(screen, data, detail) });
      }
      return;
    }
    const identity = identityOf(screen, data, selected, detail);
    if (identity === undefined) chosenRef.current.delete(key);
    else chosenRef.current.set(key, identity);
  }, [screen, data, selected, detail]);

  const start = useCallback(
    async (row: StudyRow, mode: "dry-run" | "live"): Promise<void> => {
      if (mode === "live" && summary?.mode === "dry-run") {
        setLaunchNote({ studyKey: row.key, text: dryRunFileNote(row) });
        return;
      }
      // The first Enter arms. The prompt restates what a live run costs, and the operator presses
      // again having read it.
      if (mode === "live" && pressArmed("live-start") !== "confirmed") return;
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
    [pressArmed, options, summary],
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
        const pressed = pressArmed(action);
        if (pressed === "armed") setActionNote(undefined);
        if (pressed !== "confirmed") return;
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
      if (data === undefined) return;
      const { row, refusal } = rerunStudyOf(data, run);
      if (row === undefined) {
        setActionNote(refusal);
        return;
      }
      const mode = run.mode === "live" ? "live" : "dry-run";
      if (mode === "live" && summary?.mode === "dry-run") {
        setActionNote(dryRunFileNote(row));
        return;
      }
      if (mode === "live") {
        // Armed like a live start from the study screen: the prompt below the actions restates
        // the cost, and only a second Enter spends it.
        const pressed = pressArmed("run-again");
        if (pressed === "armed") setActionNote(undefined);
        if (pressed !== "confirmed") return;
      }
      setActionNote(`starting ${row.name}…`);
      const started = await options.capabilities.startRun({
        cwd: options.cwd,
        study: row.name,
        ...(row.path ? { manifestPath: row.path } : {}),
        mode,
      });
      setActionNote(
        started.ok ? `started ${row.name} (pid ${started.run.pid})` : started.error.message,
      );
    },
    [detail, options, data, pressArmed, summary],
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
        if (accounts !== undefined) {
          if (input === "q") exit();
          return;
        }
        if (showHelp) {
          // Any key leaves: a help screen you can get stuck in is worse than none. `q` still quits.
          setShowHelp(false);
          if (input === "q") exit();
          return;
        }
        // Only Enter or → on the armed action confirms it. Any other key cancels it, and escape
        // cancels before it means "go back": the nearer meaning of "no" wins, so a confirmation is
        // never dismissed by accidentally leaving the screen.
        if (!(key.return || key.rightArrow) && disarm() && (key.escape || key.leftArrow)) return;
        if (input === "?") {
          setShowHelp(true);
          return;
        }
        if (input === "q") {
          exit();
          return;
        }
        if (input === "c" && hasAccounts) {
          setKeysCursor(0);
          setAccounts("keys");
          return;
        }
        if (input === "g" || input === "G") {
          dispatch({ type: "move", delta: input === "g" ? -rowCount : rowCount, total: rowCount });
          return;
        }
        if (key.upArrow || input === "k" || key.downArrow || input === "j") {
          dispatch({ type: "move", delta: key.upArrow || input === "k" ? -1 : 1, total: rowCount });
          return;
        }
        if (key.escape || key.leftArrow) {
          dispatch({ type: "back" });
          return;
        }
        if (key.return || key.rightArrow) {
          // The empty-project screen has exactly one action, so Enter means it. Armed, because it
          // writes into the operator's directory and touches package.json.
          if (screen.name === "studies" && !initialized) {
            if (pressArmed("init") !== "confirmed") return;
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
              const key = screenKey(screen);
              const chosen = chosenRef.current.get(key);
              const identity = identityOf(screen, data, selected, detail);
              if (identity !== undefined && chosen !== undefined && identity !== chosen) {
                // The action the person chose went away under the cursor (Cancel analysis when the
                // analysis ends, Stop when the run does), and this key was meant for it. Acting on
                // the row now there would start or stop something nobody chose.
                chosenRef.current.set(key, identity);
                setActionNote("nothing was done: this run's actions changed before that key");
                return;
              }
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
        start,
        detail,
        act,
        pressArmed,
        disarm,
        showHelp,
        accounts,
        hasAccounts,
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
  // What belongs to the open run starts over when another run opens or the run screen closes. It is
  // adjusted during render (react.dev, "Adjusting some state when a prop changes"), so no frame
  // shows the previous run's detail or note.
  const [detailRunId, setDetailRunId] = useState(openRunId);
  if (detailRunId !== openRunId) {
    setDetailRunId(openRunId);
    setDetail(undefined);
    setActionNote(undefined);
  }
  useEffect(() => {
    if (openRunId === undefined) return;
    let cancelled = false;
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

  // The spinner and the clock. Independent of the data refresh, because motion is what says "live"
  // and a 2s heartbeat does not read as motion.
  useEffect(() => {
    if (frozenTick !== undefined && now !== undefined) return;
    const timer = setInterval(() => {
      setTick((previous) => previous + 1);
      setWallClock(Date.now());
    }, SPINNER_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [frozenTick, now]);

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
  // With no live run and no study open to watch, what was read for earlier runs is dropped, so a run
  // that comes back into view starts unread. Adjusted during render, as the run detail is above.
  const [liveDetailRunIds, setLiveDetailRunIds] = useState(liveRunIds);
  if (liveDetailRunIds !== liveRunIds) {
    setLiveDetailRunIds(liveRunIds);
    if (liveRunIds === "") setLiveDetails(new Map());
  }
  useEffect(() => {
    if (liveRunIds === "") return;
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

  // What the open study is, or the study a run card would run again. Includes the key probe, which
  // is why it is read per study rather than for the whole list.
  const openRun = screen.name === "run" ? data?.runsById.get(screen.runId) : undefined;
  const openStudyRow =
    screen.name === "study"
      ? data?.rows.find((row) => row.key === screen.studyKey)
      : data === undefined || openRun === undefined
        ? undefined
        : rerunStudyOf(data, openRun).row;
  const openStudyName = openStudyRow?.path ?? openStudyRow?.name;
  // A summary belongs to one study, so it starts unread whenever the open study changes. Adjusted
  // during render, as the run detail is above.
  const [summaryStudyName, setSummaryStudyName] = useState(openStudyName);
  if (summaryStudyName !== openStudyName) {
    setSummaryStudyName(openStudyName);
    setSummary(undefined);
  }
  useEffect(() => {
    if (openStudyName === undefined) return;
    let cancelled = false;
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
    const handOff = (handoff: TuiHandoff): void => {
      onKeyEntry?.(handoff);
      exit();
    };
    if (accounts === "email" && options.capabilities.comms)
      return (
        <ConnectionsScreen
          capabilities={options.capabilities.comms}
          columns={contentWidth(size.columns)}
          notice={options.initialScreen === "connections" ? options.connectionNotice : undefined}
          onBack={() => setAccounts("keys")}
          onKeyEntry={() => handOff({ action: "agentmail-key" })}
        />
      );
    if (accounts !== undefined)
      return (
        <KeysScreen
          keys={options.capabilities.keys}
          email={options.capabilities.comms !== undefined}
          columns={contentWidth(size.columns)}
          notice={options.initialScreen === "keys" ? options.connectionNotice : undefined}
          selected={keysCursor}
          onSelect={setKeysCursor}
          onBack={() => setAccounts(undefined)}
          onEmail={() => setAccounts("email")}
          onKeyEntry={handOff}
        />
      );
    if (showHelp)
      return <HelpScreen columns={contentWidth(size.columns)} connections={hasAccounts} />;
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
      actionNote:
        armed === "stop"
          ? "stop this run? ⏎ again to confirm · esc cancel"
          : armed === "cancel-analysis"
            ? "cancel analysis? ⏎ again to confirm · esc keep analyzing"
            : armed === "run-again" && openStudyRow !== undefined
              ? `run again live? ${liveCostText(openStudyRow, summary)} · ⏎ again to confirm · esc cancel`
              : actionNote,
      initArmed: armed === "init",
    });
  }, [
    showHelp,
    accounts,
    hasAccounts,
    keysCursor,
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
    armed,
    openStudyRow,
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
        overlay:
          accounts === "email" ? "connections" : (accounts ?? (showHelp ? "help" : undefined)),
        connections: hasAccounts,
        cwd: options.cwd,
        columns: size.columns,
      })}
    >
      {body}
    </Frame>
  );
}
