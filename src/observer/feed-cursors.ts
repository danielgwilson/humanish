// The cursors of the Observer's feed. A cursor is `<position>.<generation>.<items>.<bytes>`: the
// live file live/<position>.<generation>.ndjson (src/run/live-items.ts names them) and the prefix of
// it a page holds. Each feed response gives a running participant's cursor as `live`; the page sends
// the cursors back in `after` and compares them only as strings, so a cursor has one spelling:
// decimal integers without leading zeros.

import type { LiveItemsCursor } from "../run/live-items.js";
import type { LiveItemsRead } from "../run/stream-trace.js";
import type { ObserverItems } from "./participant-items.js";

/** A live file's stem, `<position>.<generation>`, as isLiveItemsIndex accepts its path. */
const LIVE_PATH = /^live\/([1-9]\d{0,5}\.[1-9]\d{0,8})\.ndjson$/;
/** A cursor: the stem, then the line and byte counts. */
const CURSOR = /^([1-9]\d{0,5}\.[1-9]\d{0,8})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})$/;
/** More cursors than any page sends: a run has one live file per participant. */
const MAX_CURSORS = 10_000;

/**
 * The prefixes a poll's `after` parameter says the page holds, by live file path. A parameter with
 * a cursor that is not spelled as the server spells them, more than 10,000 cursors, or two for one
 * file is ignored whole, so the page gets every list in full.
 */
export function parseFeedCursors(after: string | null): ReadonlyMap<string, LiveItemsCursor> {
  const cursors = new Map<string, LiveItemsCursor>();
  if (after === null || after === "") return cursors;
  const parts = after.split(",", MAX_CURSORS + 1);
  if (parts.length > MAX_CURSORS) return new Map();
  for (const part of parts) {
    const match = CURSOR.exec(part);
    const path = `live/${match?.[1]}.ndjson`;
    const cursor = { items: Number(match?.[2]), bytes: Number(match?.[3]) };
    if (
      match === null ||
      !Number.isSafeInteger(cursor.items) ||
      !Number.isSafeInteger(cursor.bytes) ||
      cursors.has(path)
    )
      return new Map();
    cursors.set(path, cursor);
  }
  return cursors;
}

/** The cursor at `items` lines and `bytes` bytes into the live file at `path`. */
function cursorText(path: string, position: { items: number; bytes: number }): string {
  const stem = LIVE_PATH.exec(path)?.[1];
  if (stem === undefined) throw new Error(`${path} is not a live file name.`);
  return `${stem}.${position.items}.${position.bytes}`;
}

/**
 * `items` with each live file's cursor on the entry of the stream it was joined into, and
 * `liveAfter`, the page's cursor, where the entry's `liveActor` holds only the items past it. A
 * live file the loader stopped reading (LiveItemsRead's `stopped`) keeps the page's cursor as its
 * own, so the page holds its items and sends that cursor again.
 */
export function withFeedCursors(
  items: ObserverItems,
  live: readonly LiveItemsRead[],
): ObserverItems {
  const streams: ObserverItems["streams"] = Object.assign(Object.create(null), items.streams);
  for (const read of live) {
    const entry = Object.hasOwn(streams, read.streamId) ? streams[read.streamId] : undefined;
    if (entry === undefined || !Array.isArray(entry.liveActor)) continue;
    const end = read.stopped === undefined ? read.index : (read.after ?? read.index);
    streams[read.streamId] = {
      ...entry,
      live: cursorText(read.index.path, end),
      ...(read.after === undefined ? {} : { liveAfter: cursorText(read.index.path, read.after) }),
    };
  }
  return { ...items, streams };
}
