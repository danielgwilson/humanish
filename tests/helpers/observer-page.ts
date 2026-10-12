import { gunzipSync } from "node:zlib";

import type { ObserverData } from "../../src/observer/data.js";
import {
  joinObserverData,
  type ObserverItems,
  type ObserverShell,
} from "../../src/observer/participant-items.js";

/**
 * The run data an Observer page carries, read the way docs/contracts/observer-data.md describes the
 * page: the data slot's JSON, joined with the gzip-compressed items element.
 */
export function readObserverPage(html: string): ObserverData {
  const shell = /<script id="observer-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  const items =
    /<script id="observer-items" type="application\/octet-stream" data-encoding="gzip">([A-Za-z0-9+/=]*)<\/script>/.exec(
      html,
    )?.[1];
  if (shell === undefined || items === undefined) throw new Error("not an Observer page");
  return joinObserverData(
    JSON.parse(shell) as ObserverShell,
    JSON.parse(gunzipSync(Buffer.from(items, "base64")).toString("utf8")) as ObserverItems,
  );
}
