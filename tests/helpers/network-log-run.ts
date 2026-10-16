// A finished run whose participant carries a browser network log, built on a dry run: a page load
// and a failed add to cart written as the log's records, indexed on the stream and registered as a
// log, as a hosted participant's teardown leaves them. The records and index are literals, so a
// test using this helper exercises the reader and never the writer.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BrowserNetworkIndex } from "../../src/evidence/browser-network.js";
import type { RunBundle } from "../../src/run/bundle.js";

const NETWORK_SITE = "https://app.example.test";
const NETWORK_PATH = "network/p1.ndjson";

const TEXT = [
  {
    at: "2026-10-16T02:00:01.000Z",
    turn: 0,
    method: "GET",
    origin: NETWORK_SITE,
    path: "/",
    type: "document",
    status: 200,
    ms: 30,
  },
  {
    at: "2026-10-16T02:00:02.000Z",
    turn: 0,
    method: "POST",
    origin: NETWORK_SITE,
    path: "/api/cart",
    type: "fetch",
    status: 500,
    ms: 60,
  },
]
  .map((record) => `${JSON.stringify(record)}\n`)
  .join("");

/**
 * Give the first participant of the run at `runDir` the id p1 and a network log, its file then
 * changed by `edit`. Returns the log's text and index as written to run.json.
 */
export async function addNetworkLog(
  runDir: string,
  edit: (text: string) => string = (text) => text,
): Promise<{ text: string; index: BrowserNetworkIndex }> {
  const bytes = Buffer.from(TEXT, "utf8");
  const index: BrowserNetworkIndex = {
    schema: "humanish.browser-network.v1",
    path: NETWORK_PATH,
    records: 2,
    failed: 0,
    pending: 0,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    startedAt: "2026-10-16T02:00:00.000Z",
    origins: [NETWORK_SITE],
    complete: true,
    omitted: { otherOrigin: 0, overCap: 0, invalid: 0 },
  };
  const file = path.join(runDir, "run.json");
  const bundle = JSON.parse(await readFile(file, "utf8")) as RunBundle;
  const [stream] = bundle.streams;
  if (stream === undefined) throw new Error("the run has no participant");
  stream.laneId = "p1";
  stream.network = index;
  stream.artifacts.push({ label: "network log", path: NETWORK_PATH, kind: "log" });
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`);
  await mkdir(path.join(runDir, "network"), { recursive: true });
  await writeFile(path.join(runDir, NETWORK_PATH), edit(TEXT));
  return { text: TEXT, index };
}
