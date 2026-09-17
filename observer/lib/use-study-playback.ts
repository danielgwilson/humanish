import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildGridRecording, clampGridTime, gridMoment, type GridMoment } from "./grid-recording";
import type { ObserverStream } from "./observer-data";

export interface StudyPlayerControl {
  moment: GridMoment;
  reviewing: boolean;
  playing: boolean;
  eventId: string | null;
  unavailableFrame?: boolean;
  onSeekFrame: (index: number, eventId?: string) => void;
  onToggle: () => void;
  onLive: () => void;
}

interface EvidenceSelection {
  streamId: string;
  frameId: string | null;
  requestedFrame: number;
  eventId: string | null;
}

interface StudyState {
  runId: string;
  atMs: number | null;
  reviewing: boolean;
  playing: boolean;
  speed: number;
  selection: EvidenceSelection | null;
}

const initialState = (runId: string): StudyState => ({ runId, atMs: null, reviewing: false, playing: false, speed: 1, selection: null });

/** One capture clock survives participant/grid navigation and same-run polls. */
export function useStudyPlayback(runId: string, streams: readonly ObserverStream[]) {
  const recording = useMemo(() => buildGridRecording(streams), [streams]);
  const recordingRef = useRef(recording); recordingRef.current = recording;
  const [stored, setState] = useState(() => initialState(runId));
  const state = stored.runId === runId ? stored : initialState(runId);
  if (stored.runId !== runId) setState(state);
  const atMs = state.reviewing ? state.atMs : recording.endMs;
  const cursorUnavailable = state.reviewing && atMs !== null && (recording.startMs === null || recording.endMs === null || atMs < recording.startMs || atMs > recording.endMs);
  const pause = useCallback(() => setState((value) => value.playing ? { ...value, playing: false } : value), []);
  const seek = useCallback((requestedMs: number) => {
    setState((value) => ({ ...value, atMs: clampGridTime(recordingRef.current, requestedMs), reviewing: true, playing: false, selection: null }));
  }, []);
  const latest = useCallback(() => setState((value) => ({ ...value, atMs: null, reviewing: false, playing: false, selection: null })), []);
  const setSpeed = useCallback((speed: number) => {
    if (Number.isFinite(speed) && speed > 0) setState((value) => ({ ...value, speed }));
  }, []);
  const selectFrame = useCallback((streamId: string, index: number, eventId?: string) => {
    const lane = recordingRef.current.lanes.get(streamId);
    const frame = lane?.model?.frames[index];
    setState((value) => ({ ...value, reviewing: true, playing: false,
      atMs: lane?.times?.[index] ?? value.atMs,
      selection: { streamId, frameId: frame?.itemId ?? null, requestedFrame: index, eventId: eventId ?? null }
    }));
  }, []);
  const toggle = useCallback(() => {
    setState((value) => {
      if (value.playing) return { ...value, playing: false };
      const { startMs, endMs } = recordingRef.current;
      if (startMs === null || endMs === null || startMs === endMs) return value;
      if (value.reviewing && value.atMs !== null && (value.atMs < startMs || value.atMs > endMs)) return value;
      return { ...value, reviewing: true, playing: true, selection: null,
        atMs: !value.reviewing || value.atMs === null || value.atMs >= endMs ? startMs : value.atMs };
    });
  }, []);
  useEffect(() => {
    if (!state.playing) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now(); const delta = (now - previous) * state.speed; previous = now;
      setState((value) => {
        if (!value.playing) return value;
        const current = recordingRef.current;
        if (current.startMs === null || current.endMs === null || (value.atMs !== null && (value.atMs < current.startMs || value.atMs > current.endMs))) return { ...value, playing: false };
        const next = clampGridTime(current, (value.atMs ?? current.startMs) + delta);
        return { ...value, atMs: next, playing: next !== null && next < current.endMs };
      });
    }, 100);
    const hide = () => { if (document.hidden) pause(); };
    document.addEventListener("visibilitychange", hide);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", hide); };
  }, [state.playing, state.speed, pause]);
  useEffect(() => { if (state.playing && (cursorUnavailable || atMs === null || atMs >= (recording.endMs ?? 0))) pause(); }, [state.playing, cursorUnavailable, atMs, recording.endMs, pause]);

  const playerControl = (streamId: string): StudyPlayerControl => {
    const lane = recording.lanes.get(streamId);
    const selection = state.reviewing && state.selection?.streamId === streamId ? state.selection : null;
    let moment = gridMoment(recording, streamId, atMs ?? Number.NaN);
    let unavailableFrame = false;
    if (selection) {
      const frame = selection.frameId !== null ? lane?.model?.frames.find((candidate) => candidate.itemId === selection.frameId)
        : lane?.model?.frames[selection.requestedFrame];
      unavailableFrame = !frame;
      moment = frame ? { kind: "capture", frame, ageMs: Math.max(0, (atMs ?? frame.atMs ?? 0) - (frame.atMs ?? atMs ?? 0)), coverage: "within" } : { kind: "no-captures" };
    }
    return { moment, reviewing: state.reviewing, playing: state.playing, eventId: selection?.eventId ?? null, unavailableFrame,
      onSeekFrame: (index, eventId) => selectFrame(streamId, index, eventId), onToggle: toggle, onLive: latest };
  };
  return { recording, atMs, reviewing: state.reviewing, playing: state.playing, speed: state.speed, selection: state.selection,
    cursorUnavailable, seek, selectFrame, toggle, setSpeed, latest, pause, playerControl };
}
