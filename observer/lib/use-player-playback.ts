import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { liveEmbedUrl } from "./live";
import type { ObserverStream } from "./observer-data";
import {
  frameElapsedMs,
  frameEntry,
  frameHoldMs,
  isActionRow,
  isFindingRow,
  isWaitRow,
  type PlayerFrame,
  type PlayerModel,
  type PlayerRow,
} from "./player-model";
import {
  openPlayback,
  playbackIndex,
  seekPlayback,
  type PlaybackState,
  type PlayerView,
} from "./player-state";
import { formatHash, parseHash, replaceHash } from "./route";
import { completionLabel } from "./signal";
import type { StudyPlayerControl } from "./use-study-playback";

type Mode = "live" | "replay" | null;
/** Why the selection moved: a seek to a frame or entry, a jump to live, or a new address. */
type Navigation = "seek" | "live" | "address";

interface PlaybackOptions {
  stream: ObserverStream;
  model: PlayerModel;
  initialFrame: number | null;
  initialMode: Mode;
  initialEventId: string | null;
  navigationRevision: number;
  updating: boolean;
  studyPlayback: StudyPlayerControl | undefined;
  speed: number;
  skipWaits: boolean;
  onViewChange: ((view: PlayerView) => void) | undefined;
  onNavigate: (reason: Navigation) => void;
}

/** The selection the review player shows and the controls that move it. */
export interface PlayerPlayback {
  /** The selected capture's index, or -1 when no capture is selected. */
  frame: number;
  current: PlayerFrame | undefined;
  eventId: string | null | undefined;
  /** The selected entry when the current capture interval holds it. */
  selectedRow: PlayerRow | undefined;
  /** The shared study clock owns playback. */
  controlled: boolean;
  active: boolean;
  preparing: boolean;
  following: boolean;
  /** The read-only desktop URL while following an active participant that has one. */
  live: string | null;
  playing: boolean;
  elapsed: number;
  hold: number;
  /** How much of this capture interval local playback skips for recorded waits. */
  skipDuration: number;
  rows: ReturnType<typeof indexRows>;
  /** The action pins to draw on the current capture. */
  pins: PlayerRow[];
  seek: (index: number) => void;
  seekEntry: (row: PlayerRow) => void;
  togglePlay: () => void;
  jumpToLive: () => void;
}

function indexRows(model: PlayerModel, notableEnd: boolean) {
  const pins = new Map<number, PlayerRow[]>();
  const actions = new Set<number>();
  const findings = new Set<number>();
  const waits = new Set<number>();
  let thoughtCount = 0;
  let actionCount = 0;
  for (const row of model.rows) {
    if (row.coord) pins.set(row.frameIndex, [...(pins.get(row.frameIndex) ?? []), row]);
    if (isActionRow(row)) actions.add(row.frameIndex);
    if (isFindingRow(row)) findings.add(row.frameIndex);
    if (isWaitRow(row)) waits.add(row.frameIndex);
    if (row.kind === "reasoning") thoughtCount += 1;
    else if (isActionRow(row) || isWaitRow(row)) actionCount += 1;
  }
  if (notableEnd && model.frames.length > 0) findings.add(model.frames.length - 1);
  return {
    pins,
    actions: [...actions],
    findings: [...findings],
    waits,
    thoughtCount,
    actionCount,
    notableEnd,
    /** Each row's position in `model.rows`, by id. */
    positions: new Map(model.rows.map((row, index) => [row.id, index])),
  };
}

/**
 * The review player's selection. A shared study clock, when given, owns playback and this hook
 * only projects its participant; otherwise the player keeps its own state, follows address
 * changes, writes the selection into the address, advances recorded playback and answers the
 * Space and arrow shortcuts. `onNavigate` runs after each navigation, with its reason.
 */
export function usePlayerPlayback(options: PlaybackOptions): PlayerPlayback {
  const { stream, model, updating, studyPlayback, speed, skipWaits } = options;
  const controlled = studyPlayback !== undefined;
  const preparing = stream.status === "queued" || stream.status === "preparing";
  const active = updating && (stream.status === "running" || preparing);
  const { state, setState, sourcePlayback } = useLocalPlayback(options, active, controlled);
  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });
  const frames = model.frames;
  const controlledFrameId =
    studyPlayback?.moment.kind === "capture" ? studyPlayback.moment.frame.itemId : null;
  const frame = studyPlayback
    ? !studyPlayback.unavailableFrame && controlledFrameId !== null
      ? frames.findIndex((candidate) => candidate.itemId === controlledFrameId)
      : -1
    : playbackIndex(state, model);
  const current = frame >= 0 ? frames[frame] : undefined;
  const eventId = studyPlayback ? studyPlayback.eventId : state.eventId;
  const selectedRow = eventId ? frameEntry(model, eventId, frame) : undefined;
  const following = studyPlayback ? !studyPlayback.reviewing && active : state.mode === "live";
  const live = following && active ? liveEmbedUrl(stream) : null;
  const playing = studyPlayback ? studyPlayback.playing : state.playing;
  const selectedFrame = current?.index ?? null;
  const viewMode: PlayerView["mode"] = following && active ? "live" : "replay";
  useEffect(() => {
    callbacks.current.onViewChange?.({
      frame: selectedFrame,
      mode: viewMode,
      playing,
      ...(eventId ? { eventId } : {}),
    });
  }, [selectedFrame, viewMode, playing, eventId]);
  const notableEnd = completionLabel(stream) !== undefined;
  const rows = useMemo(() => indexRows(model, notableEnd), [model, notableEnd]);
  const hold = frameHoldMs(model, Math.max(0, frame));
  const skipDuration =
    !controlled && skipWaits && rows.waits.has(frame) && !rows.actions.includes(frame)
      ? Math.max(0, hold - 1000)
      : 0;
  const pins = cursorPins(rows.pins.get(frame) ?? [], selectedRow, eventId, studyPlayback, current);
  const seek = useCallback(
    (index: number) => {
      if (studyPlayback) {
        if (!model.frames.length) return;
        studyPlayback.onSeekFrame(Math.max(0, Math.min(model.frames.length - 1, index)));
      } else setState(seekPlayback(model, index));
      callbacks.current.onNavigate("seek");
    },
    [model, studyPlayback, setState],
  );
  const seekEntry = useCallback(
    (row: PlayerRow) => {
      if (studyPlayback) {
        if (!model.frames.length) return;
        studyPlayback.onSeekFrame(
          Math.max(0, Math.min(model.frames.length - 1, row.frameIndex)),
          row.isFrame ? undefined : row.id,
        );
      } else setState(seekPlayback(model, row.frameIndex, false, row.isFrame ? undefined : row.id));
      callbacks.current.onNavigate("seek");
    },
    [model, studyPlayback, setState],
  );
  const togglePlay = useCallback(() => {
    if (studyPlayback) {
      studyPlayback.onToggle();
      return;
    }
    if (model.frames.length === 0) return;
    if (playing) setState(seekPlayback(model, Math.max(0, frame)));
    else
      setState(
        seekPlayback(model, frame >= model.frames.length - 1 || frame < 0 ? 0 : frame, true),
      );
  }, [model, frame, playing, studyPlayback, setState]);
  const jumpToLive = () => {
    if (studyPlayback) studyPlayback.onLive();
    else setState(openPlayback(model, active, null, "live"));
    callbacks.current.onNavigate("live");
  };
  useEffect(() => {
    if (controlled) return;
    const navigate = () => {
      const route = parseHash(window.location.hash);
      if (route.laneId !== stream.id) return;
      setState(sourcePlayback(route.frame, route.mode ?? null, route.eventId));
      callbacks.current.onNavigate("address");
    };
    window.addEventListener("hashchange", navigate);
    window.addEventListener("popstate", navigate);
    return () => {
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("popstate", navigate);
    };
  }, [sourcePlayback, stream.id, controlled, setState]);
  const unavailableFrame = studyPlayback?.unavailableFrame;
  useEffect(() => {
    // Keep following intent in the address, including before the first capture.
    if (following && active) replaceHash(formatHash(stream.id, null, "live"));
    else if (current) replaceHash(formatHash(stream.id, current.index, null, eventId));
    else if (controlled && !unavailableFrame) replaceHash(formatHash(stream.id, null, "replay"));
  }, [following, active, playing, current, stream.id, eventId, controlled, unavailableFrame]);
  const nextFrameId = frames[frame + 1]?.itemId ?? null;
  useAutoplay(frame, playing, { controlled, nextFrameId, hold, skipDuration, speed }, setState);
  usePlaybackShortcuts(frame, seek, togglePlay);
  usePreloadNeighbors(frames, frame);
  return {
    frame,
    current,
    eventId,
    selectedRow,
    controlled,
    active,
    preparing,
    following,
    live,
    playing,
    elapsed: frameElapsedMs(model, Math.max(0, frame)),
    hold,
    skipDuration,
    rows,
    pins,
    seek,
    seekEntry,
    togglePlay,
    jumpToLive,
  };
}

/** The pins drawn on the current capture: the selected entry's alone when an entry is selected;
 * under a study clock, the capture interval's pins recorded up to the study cursor. */
function cursorPins(
  intervalPins: PlayerRow[],
  selectedRow: PlayerRow | undefined,
  eventId: string | null | undefined,
  studyPlayback: StudyPlayerControl | undefined,
  current: PlayerFrame | undefined,
): PlayerRow[] {
  const studyCursor =
    studyPlayback?.moment.kind === "capture" && current?.atMs !== undefined
      ? current.atMs + studyPlayback.moment.ageMs
      : null;
  return eventId
    ? selectedRow?.coord
      ? [selectedRow]
      : []
    : studyPlayback
      ? intervalPins.filter(
          (row) => studyCursor !== null && row.atMs !== undefined && row.atMs <= studyCursor,
        )
      : intervalPins;
}

/** Local playback: after each capture interval, shortened by skipped waits and divided by the
 * speed, select the next capture; stop at the last. */
function useAutoplay(
  frame: number,
  playing: boolean,
  next: {
    controlled: boolean;
    nextFrameId: string | null;
    hold: number;
    skipDuration: number;
    speed: number;
  },
  setState: Dispatch<SetStateAction<PlaybackState>>,
) {
  const { controlled, nextFrameId, hold, skipDuration, speed } = next;
  useEffect(() => {
    if (controlled || !playing || frame < 0) return;
    if (nextFrameId === null) {
      setState((value) => ({ ...value, playing: false }));
      return;
    }
    // An unchanged evidence poll must not reset a seven-second capture interval every
    // five seconds. Depend on the actual transition, never the snapshot object identity.
    const timer = setTimeout(
      () =>
        setState({
          mode: "replay",
          frameId: nextFrameId,
          requestedFrame: frame + 1,
          playing: true,
        }),
      Math.max(120, (hold - skipDuration) / speed),
    );
    return () => clearTimeout(timer);
  }, [playing, frame, nextFrameId, hold, skipDuration, speed, controlled, setState]);
}

/** The player's own playback state, used when no study clock controls it. A new address, or a
 * source that stops updating while following, adjusts it during render, before commit. */
function useLocalPlayback(options: PlaybackOptions, active: boolean, controlled: boolean) {
  const { stream, model, updating, initialFrame, initialMode, initialEventId } = options;
  const sourcePlayback = useCallback(
    (addressed: number | null, mode: Mode, eventId?: string | null) =>
      openPlayback(
        model,
        active,
        !updating && mode === "live" && addressed === null
          ? Math.max(0, model.frames.length - 1)
          : addressed,
        updating ? mode : "replay",
        eventId,
      ),
    [model, active, updating],
  );
  const [state, setState] = useState(() =>
    sourcePlayback(initialFrame, initialMode, initialEventId),
  );
  const [previousUpdating, setPreviousUpdating] = useState(updating);
  if (previousUpdating !== updating) {
    setPreviousUpdating(updating);
    if (!controlled && !updating && state.mode === "live")
      setState(seekPlayback(model, playbackIndex(state, model)));
  }
  // A URL navigation is a new instruction even in the same participant. Adjust before
  // commit so a stale frame cannot overwrite the incoming address in a later effect.
  const address = `${stream.id}:${initialMode ?? "auto"}:${initialFrame ?? "none"}:${initialEventId ?? "none"}:${options.navigationRevision}`;
  const [previousAddress, setPreviousAddress] = useState(address);
  if (address !== previousAddress) {
    setPreviousAddress(address);
    if (!controlled) setState(sourcePlayback(initialFrame, initialMode, initialEventId));
  }
  return { state, setState, sourcePlayback };
}

/** Space plays or pauses and the arrow keys step captures, except inside controls, editable
 * fields and widgets that own those keys, or when a modifier is held. */
function usePlaybackShortcuts(frame: number, seek: (index: number) => void, toggle: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, select, button, a, summary, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="slider"], [role="tab"], [role="combobox"], [role="listbox"], [role="checkbox"]',
        )
      )
        return;
      if (event.key === " ") {
        event.preventDefault();
        toggle();
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seek(Math.max(0, frame - 1));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        seek(frame + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frame, seek, toggle]);
}

/** Neighbor-only preload and decode: no eager decoding of a long screenshot recording. */
function usePreloadNeighbors(frames: PlayerFrame[], frame: number) {
  useEffect(() => {
    const neighbors = [frames[frame - 1], frames[frame + 1]];
    for (const neighbor of neighbors) {
      if (!neighbor) continue;
      const image = new Image();
      image.src = neighbor.href;
      void image.decode?.().catch(() => undefined);
    }
  }, [frames, frame]);
}
