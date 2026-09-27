// Demo playback from the URL: `observer/index.html?autoplay=8&loop=1&sidebar=closed#...` starts the
// study transport at 8x once the recording has a time range, restarts it two seconds after the end,
// and opens with the library sidebar collapsed. Made for embedding a saved run (the homepage hero,
// a talk, a README link); every control still works, and the visitor can pause or seek at any time.

export interface AutoplayIntent {
  /** Playback speed multiplier; `?autoplay` alone means 8x. Clamped to 1..64. */
  speed: number;
  /** Restart from the first capture after the recording ends. */
  loop: boolean;
  /** Start with the study library collapsed so the participants fill the frame. */
  sidebarClosed: boolean;
}

export const AUTOPLAY_DEFAULT_SPEED = 8;
export const AUTOPLAY_MAX_SPEED = 64;
/** Pause between the last capture and the restart, so the end state is readable. */
export const AUTOPLAY_LOOP_DELAY_MS = 2000;

/** `?sidebar=closed` on its own, for a still embed (reduced motion) that should still fill the frame. */
export function sidebarClosedByUrl(search: string): boolean {
  try { return new URLSearchParams(search).get("sidebar") === "closed"; } catch { return false; }
}

export function parseAutoplay(search: string): AutoplayIntent | null {
  let params: URLSearchParams;
  try { params = new URLSearchParams(search); } catch { return null; }
  if (!params.has("autoplay")) return null;
  const raw = (params.get("autoplay") ?? "").trim();
  const parsed = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : AUTOPLAY_DEFAULT_SPEED; // "", "on", "true" all mean the default speed
  const speed = parsed > 0 ? Math.min(AUTOPLAY_MAX_SPEED, Math.max(1, parsed)) : AUTOPLAY_DEFAULT_SPEED;
  const flag = (key: string) => { const value = params.get(key); return value !== null && value !== "0" && value !== "false"; };
  return { speed, loop: flag("loop"), sidebarClosed: params.get("sidebar") === "closed" };
}
