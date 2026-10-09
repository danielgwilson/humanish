import { useEffect, useMemo, useRef } from "react";
import type { StudyPlayback } from "./use-study-playback";

// Demo playback from the URL: `observer/index.html?autoplay=8&loop=1&sidebar=closed#...` starts the
// study transport at 8x once the recording has a time range, restarts it two seconds after the end,
// and opens with the library sidebar collapsed. Made for embedding a saved run (the homepage hero,
// a talk, a readme link); every control still works, and the visitor can pause or seek at any time.

export interface AutoplayIntent {
  /** Playback speed multiplier; `?autoplay` alone means 8x. Clamped to 1..64. */
  speed: number;
  /** Restart from the first capture after the recording ends. */
  loop: boolean;
  /** Start with the study library collapsed so the participants fill the frame. */
  sidebarClosed: boolean;
}

const AUTOPLAY_DEFAULT_SPEED = 8;
const AUTOPLAY_MAX_SPEED = 64;
/** Pause between the last capture and the restart, so the end state is readable. */
const AUTOPLAY_LOOP_DELAY_MS = 2000;

/** `?sidebar=closed` on its own, for a still embed (reduced motion) that should still fill the frame. */
export function sidebarClosedByUrl(search: string): boolean {
  try {
    return new URLSearchParams(search).get("sidebar") === "closed";
  } catch {
    return false;
  }
}

export function parseAutoplay(search: string): AutoplayIntent | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  if (!params.has("autoplay")) return null;
  const raw = (params.get("autoplay") ?? "").trim();
  const parsed = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : AUTOPLAY_DEFAULT_SPEED; // "", "on", "true" all mean the default speed
  const speed =
    parsed > 0 ? Math.min(AUTOPLAY_MAX_SPEED, Math.max(1, parsed)) : AUTOPLAY_DEFAULT_SPEED;
  const flag = (key: string) => {
    const value = params.get(key);
    return value !== null && value !== "0" && value !== "false";
  };
  return { speed, loop: flag("loop"), sidebarClosed: params.get("sidebar") === "closed" };
}

/** Presses play once the recording has a time range, and with `loop` again after it ends. */
export function useAutoplay(playback: StudyPlayback): void {
  const autoplay = useMemo(() => parseAutoplay(window.location.search), []);
  const started = useRef(false);
  const { startMs, endMs } = playback.recording;
  const { setSpeed, toggle, playing, reviewing, atMs } = playback;
  useEffect(() => {
    if (!autoplay || started.current || startMs === null || endMs === null || startMs === endMs)
      return;
    started.current = true;
    setSpeed(autoplay.speed);
    toggle();
  }, [autoplay, startMs, endMs, setSpeed, toggle]);
  useEffect(() => {
    if (
      !autoplay?.loop ||
      !started.current ||
      playing ||
      !reviewing ||
      atMs === null ||
      endMs === null ||
      atMs < endMs
    )
      return;
    const timer = window.setTimeout(toggle, AUTOPLAY_LOOP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoplay, playing, reviewing, atMs, endMs, toggle]);
}
