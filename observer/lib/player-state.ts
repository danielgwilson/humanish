import type { PlayerModel } from "./player-model";

/** Actual player selection, independent of the last browser URL write. */
export interface PlayerView {
  frame: number | null;
  mode: "live" | "replay";
  playing: boolean;
  eventId?: string;
}

export interface PlaybackState {
  mode: "live" | "replay";
  frameId: string | null;
  requestedFrame: number;
  playing: boolean;
  eventId?: string;
}

export function openPlayback(model: PlayerModel, active: boolean, frame: number | null, mode: "live" | "replay" | null, eventId?: string | null): PlaybackState {
  const following = mode === "live" || (mode === null && frame === null && active);
  const index = frame ?? (following ? Math.max(0, model.frames.length - 1) : 0);
  return { mode: following ? "live" : "replay", frameId: model.frames[index]?.itemId ?? null, requestedFrame: index, playing: false,
    ...(!following && eventId ? { eventId } : {}) };
}

/** Only explicit following intent advances when snapshots append frames. */
export function playbackIndex(state: PlaybackState, model: PlayerModel): number {
  if (model.frames.length === 0) return -1;
  if (state.mode === "live") return model.frames.length - 1;
  if (state.frameId !== null) return model.frames.findIndex((frame) => frame.itemId === state.frameId);
  return state.requestedFrame < model.frames.length ? state.requestedFrame : -1;
}

export function seekPlayback(model: PlayerModel, index: number, playing = false, eventId?: string): PlaybackState {
  const bounded = Math.max(0, Math.min(model.frames.length - 1, index));
  return { mode: "replay", frameId: model.frames[bounded]?.itemId ?? null, requestedFrame: bounded, playing,
    ...(!playing && eventId ? { eventId } : {}) };
}
