// How an Observer page and the served feed carry a run's data: observer-data.json's content as
// JSON, and each participant's trace items gzip-compressed in base64 on their own, which a file://
// page decodes without a fetch. The items are most of a long run's bytes and compress about eight
// times. Packing one participant at a time keeps every string under V8's longest string
// (536,870,888 characters) while each participant's trace stays under the 32 MiB read limit.

import { promisify } from "node:util";
import { constants, gzip, gzipSync } from "node:zlib";

import type { LiveItemsRead } from "../run/stream-trace.js";
import type { ObserverData } from "./data.js";
import { withFeedCursors } from "./feed-cursors.js";
import {
  splitObserverData,
  type ObserverItems,
  type PackedObserverItems,
} from "./participant-items.js";

/** The page's data elements for `data`, in place of the built page's data slot. */
export function observerDataElements(data: ObserverData): string {
  const { shell, items } = splitObserverData(data);
  return (
    `<script id="observer-data" type="application/json">${escapeJsonScript(shell)}</script>` +
    `<script id="observer-items" type="application/json">${escapeJsonScript(packObserverItems(items))}</script>`
  );
}

const gzipOnThreadPool = promisify(gzip);

/**
 * observer-feed.json's body: observer-data.json's content and the items packed as the page packs
 * them, with each running participant's cursor from `live` on its entry.
 */
export async function observerFeedBody(
  data: ObserverData,
  live: readonly LiveItemsRead[] = [],
): Promise<string> {
  const { shell, items } = splitObserverData(data);
  const cursored = withFeedCursors(items, live);
  // Each open page polls every 5 seconds and gets every finished participant's items again, so the
  // server compresses them on the thread pool and answers other requests meanwhile. Level 1 took
  // half the time of the default on 30 MiB of items, for 13 percent more bytes. One participant
  // at a time, so a poll holds one participant's JSON text at once.
  const streams: PackedObserverItems["streams"] = [];
  for (const [id, entry] of Object.entries(cursored.streams)) {
    const packed = await gzipOnThreadPool(JSON.stringify(entry), { level: constants.Z_BEST_SPEED });
    streams.push([id, packed.toString("base64")]);
  }
  return JSON.stringify({ data: shell, items: { ...cursored, streams } });
}

function packObserverItems(items: ObserverItems): PackedObserverItems {
  const streams: PackedObserverItems["streams"] = Object.entries(items.streams).map(
    ([id, entry]) => [id, gzipSync(JSON.stringify(entry)).toString("base64")],
  );
  return { ...items, streams };
}

/** JSON that stays inert inside a script element: no `</script>` breakout, no HTML entities. */
export function escapeJsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
