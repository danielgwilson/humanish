import { gzipSync } from "node:zlib";

import type { ObserverData } from "../../src/observer/data";
import { observerFeedBody } from "../../src/observer/page-data";

/** The body a serving process answers observer-feed.json with: the run's data and its items. */
export function feed(data: ObserverData): string {
  return observerFeedBody(data);
}

/**
 * A feed body recorded with each participant's entry decoded (tests/golden/observer-feed/), as the
 * server sends it: each entry gzip-compressed JSON in base64.
 */
export function packed(body: {
  data: unknown;
  items: { streams: Record<string, unknown> };
}): string {
  const streams = Object.entries(body.items.streams).map(([id, entry]) => [
    id,
    gzipSync(JSON.stringify(entry)).toString("base64"),
  ]);
  return JSON.stringify({ ...body, items: { ...body.items, streams } });
}
