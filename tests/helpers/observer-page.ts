import { gunzipSync } from "node:zlib";

import type { ObserverData } from "../../src/observer/data.js";
import {
  joinObserverData,
  type ObserverItems,
  type ObserverShell,
  type PackedObserverItems,
} from "../../src/observer/participant-items.js";

/**
 * The run data an Observer page carries, read the way docs/architecture/observer.md describes the
 * page: the data slot's JSON, joined with the items element, whose entry for each participant is
 * gzip-compressed JSON in base64.
 */
export function readObserverPage(html: string): ObserverData {
  const shell = /<script id="observer-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  const items = /<script id="observer-items" type="application\/json">([^<]*)<\/script>/.exec(
    html,
  )?.[1];
  if (shell === undefined || items === undefined) throw new Error("not an Observer page");
  return joinObserverData(
    JSON.parse(shell) as ObserverShell,
    unpackItems(JSON.parse(items) as PackedObserverItems),
  );
}

/** observer-feed.json's body with each participant's entry decoded. */
export function readFeedBody(text: string): { data: unknown; items: ObserverItems } {
  const body = JSON.parse(text) as { data: unknown; items: PackedObserverItems };
  return { data: body.data, items: unpackItems(body.items) };
}

/** Packed items with each participant's entry decoded. */
export function unpackItems(packed: PackedObserverItems): ObserverItems {
  const streams = Object.create(null) as ObserverItems["streams"];
  for (const [id, entry] of packed.streams)
    streams[id] = JSON.parse(
      gunzipSync(Buffer.from(entry, "base64")).toString("utf8"),
    ) as ObserverItems["streams"][string];
  return { ...packed, streams };
}
