// How an Observer page carries a run's data: observer-data.json's content as JSON, and every
// participant's trace items gzip-compressed in base64, which a file:// page decodes without a
// fetch. The items are most of a long run's bytes and compress about eight times.

import { gzipSync } from "node:zlib";

import type { ObserverData } from "./data.js";
import { splitObserverData } from "./participant-items.js";

/** The page's data elements for `data`, in place of the built page's data slot. */
export function observerDataElements(data: ObserverData): string {
  const { shell, items } = splitObserverData(data);
  const packed = gzipSync(JSON.stringify(items)).toString("base64");
  return (
    `<script id="observer-data" type="application/json">${escapeJsonScript(shell)}</script>` +
    `<script id="observer-items" type="application/octet-stream" data-encoding="gzip">${packed}</script>`
  );
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
