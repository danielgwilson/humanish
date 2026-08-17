// Hash deep links (#441, the declared #439 parity regression): every participant and
// frame is addressable, so a reload keeps its place, a link can carry a moment, and
// #428's cite-turns flags get frame addresses. The grammar is the visible UI's own:
// "#/lane/<streamId>" opens a participant; "#/lane/<streamId>/f/<n>" opens it at
// frame n, 1-based to match the transport counter ("3 / 30"). Anything else — an
// empty hash, an unknown lane, garbage — resolves to the grid, never an error.

export interface HashRoute {
  laneId: string | null;
  /** 0-based frame index, converted from the 1-based hash form. */
  frame: number | null;
}

const LANE_ROUTE = /^#\/lane\/([^/]+)(?:\/f\/(\d+))?$/;

export function parseHash(hash: string): HashRoute {
  const match = LANE_ROUTE.exec(hash);
  if (!match || match[1] === undefined) return { laneId: null, frame: null };
  const laneId = decodeURIComponent(match[1]);
  if (match[2] === undefined) return { laneId, frame: null };
  const oneBased = Number(match[2]);
  return { laneId, frame: oneBased >= 1 ? oneBased - 1 : null };
}

export function formatHash(laneId: string | null, frame: number | null): string {
  if (laneId === null) return "";
  const base = `#/lane/${encodeURIComponent(laneId)}`;
  return frame === null ? base : `${base}/f/${frame + 1}`;
}

/** Write the hash without growing history (frame scrubs); no-op when unchanged. */
export function replaceHash(next: string): void {
  const current = window.location.hash;
  if (current === next || (next === "" && current === "")) return;
  const base = window.location.href.split("#")[0] ?? window.location.href;
  window.history.replaceState(null, "", `${base}${next}`);
}

/** Write the hash as a history entry (lane open/close), so browser Back returns.
 *  pushState never fires hashchange, so writes cannot echo into our own listener. */
export function pushHash(next: string): void {
  const current = window.location.hash;
  if (current === next || (next === "" && current === "")) return;
  const base = window.location.href.split("#")[0] ?? window.location.href;
  window.history.pushState(null, "", `${base}${next}`);
}
