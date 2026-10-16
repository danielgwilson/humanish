// A finished run whose participant carries a browser network log, built on a dry run: the log the
// reducer writes for a page load and a failed add to cart, indexed on the stream and registered as
// a log, as a hosted participant's teardown leaves it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  reduceBrowserNetwork,
  type BrowserNetworkIndex,
} from "../../src/evidence/browser-network.js";
import { redactText } from "../../src/evidence/redaction.js";
import { traceRedaction } from "../../src/evidence/trace-page.js";
import type { RunBundle } from "../../src/run/bundle.js";

const NETWORK_SITE = "https://app.example.test";

/** A page load and a failed add to cart, as the holder writes them. */
const EVENTS = [
  { e: "start", wallTime: 1_792_116_000 },
  {
    e: "request",
    id: "0:1",
    wallTime: 1_792_116_001,
    timestamp: 1,
    url: `${NETWORK_SITE}/`,
    method: "GET",
    type: "Document",
  },
  { e: "response", id: "0:1", timestamp: 1.02, status: 200 },
  { e: "finished", id: "0:1", timestamp: 1.03 },
  {
    e: "request",
    id: "0:2",
    wallTime: 1_792_116_002,
    timestamp: 2,
    url: `${NETWORK_SITE}/api/cart`,
    method: "POST",
    type: "Fetch",
  },
  { e: "response", id: "0:2", timestamp: 2.05, status: 500 },
  { e: "finished", id: "0:2", timestamp: 2.06 },
]
  .map((line) => `${JSON.stringify(line)}\n`)
  .join("");

/**
 * Give the first participant of the run at `runDir` the id p1 and a network log, its file then
 * changed by `edit`. Returns the log's text and index as written to run.json.
 */
export async function addNetworkLog(
  runDir: string,
  edit: (text: string) => string = (text) => text,
): Promise<{ text: string; index: BrowserNetworkIndex }> {
  const log = reduceBrowserNetwork({
    participantId: "p1",
    origins: [NETWORK_SITE],
    events: EVENTS,
    marks: [{ wallTime: 1_792_116_010, turn: 0 }],
    redact: traceRedaction((text) => text, redactText),
  });
  const { text, index } = log;
  if (text === undefined || index.path === undefined) throw new Error("no log written");
  const file = path.join(runDir, "run.json");
  const bundle = JSON.parse(await readFile(file, "utf8")) as RunBundle;
  const [stream] = bundle.streams;
  if (stream === undefined) throw new Error("the run has no participant");
  stream.laneId = "p1";
  stream.network = index;
  stream.artifacts.push({ label: "network log", path: index.path, kind: "log" });
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`);
  await mkdir(path.join(runDir, "network"), { recursive: true });
  await writeFile(path.join(runDir, index.path), edit(text));
  return { text, index };
}
