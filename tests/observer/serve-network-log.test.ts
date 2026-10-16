// humanish observe serves a participant's network log at /_humanish/runs/<id>/network/<id>.ndjson
// as NDJSON through the generic run file route. Under --safe it is served only while the run's
// verification is share_ready, as every other run file is, and observer-data.json carries the
// log's index and none of its records.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { reduceBrowserNetwork } from "../../src/evidence/browser-network.js";
import { redactText } from "../../src/evidence/redaction.js";
import { traceRedaction } from "../../src/evidence/trace-page.js";
import { serveObserverLibrary, type ServeLibraryOptions } from "../../src/observer/serve.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";

const RUN = "network-log-run";
const SITE = "https://app.example.test";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A page load and a failed add to cart, as the holder writes them. */
const EVENTS = [
  { e: "start", wallTime: 1_792_116_000 },
  {
    e: "request",
    id: "0:1",
    wallTime: 1_792_116_001,
    timestamp: 1,
    url: `${SITE}/`,
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
    url: `${SITE}/api/cart`,
    method: "POST",
    type: "Fetch",
  },
  { e: "response", id: "0:2", timestamp: 2.05, status: 500 },
  { e: "finished", id: "0:2", timestamp: 2.06 },
]
  .map((line) => `${JSON.stringify(line)}\n`)
  .join("");

/**
 * A dry run whose participant p1 carries a network log, its file then changed by `edit`. Returns
 * the working directory, the log's text and the verify grade.
 */
async function runWithNetworkLog(edit: (text: string) => string = (text) => text) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-serve-network-log-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  expect((await runDryRun({ cwd, dryRun: true, runId: RUN })).ok).toBe(true);
  const runRoot = path.join(cwd, ".humanish", "runs", RUN);
  const log = reduceBrowserNetwork({
    participantId: "p1",
    origins: [SITE],
    events: EVENTS,
    marks: [{ wallTime: 1_792_116_010, turn: 0 }],
    redact: traceRedaction((text) => text, redactText),
  });
  if (log.text === undefined || log.index.path === undefined) throw new Error("no log written");
  const file = path.join(runRoot, "run.json");
  const bundle = JSON.parse(await readFile(file, "utf8")) as RunBundle;
  const [stream] = bundle.streams;
  if (stream === undefined) throw new Error("the dry run wrote no participant");
  stream.laneId = "p1";
  stream.network = log.index;
  stream.artifacts.push({ label: "network log", path: log.index.path, kind: "log" });
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`);
  await mkdir(path.join(runRoot, "network"), { recursive: true });
  await writeFile(path.join(runRoot, log.index.path), edit(log.text));
  return { cwd, text: log.text, grade: (await verifyRun(cwd, RUN)).shareSafety.status };
}

async function serve(cwd: string, overrides: Partial<ServeLibraryOptions>) {
  const started = await serveObserverLibrary(cwd, {
    port: 0,
    safe: false,
    expose: false,
    edgeAuthed: false,
    ...overrides,
  });
  if (!started.ok) throw new Error(started.error.code);
  cleanups.push(() => started.server.close());
  return async (file: string) => {
    const response = await fetch(new URL(`/_humanish/runs/${RUN}/${file}`, started.server.url));
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      body: await response.text(),
    };
  };
}

describe.each([
  ["serve", { safe: false }],
  ["serve --safe", { safe: true }],
] as Array<[string, Partial<ServeLibraryOptions>]>)("%s on a share_ready run", (_label, mode) => {
  it("serves the network log as NDJSON, and observer-data.json carries only its index", async () => {
    const { cwd, text, grade } = await runWithNetworkLog();
    expect(grade).toBe("share_ready");
    const get = await serve(cwd, mode);

    const log = await get("network/p1.ndjson");
    expect(log).toEqual({ status: 200, type: "application/x-ndjson; charset=utf-8", body: text });

    const data = await get("observer/observer-data.json");
    expect(data.status).toBe(200);
    const observed = JSON.parse(data.body) as { streams: Array<Record<string, unknown>> };
    expect(observed.streams[0]?.network).toMatchObject({
      path: "network/p1.ndjson",
      records: 2,
      failed: 0,
      pending: 0,
    });
    expect(data.body).not.toContain("/api/cart");
  });
});

describe("serve --safe on a run whose network log no longer matches its index", () => {
  it("serves neither the log nor the run", async () => {
    const { cwd, grade } = await runWithNetworkLog((text) =>
      text.replace("/api/cart", "/api/carT"),
    );
    expect(grade).toBe("blocked");
    const get = await serve(cwd, { safe: true });
    expect(await get("network/p1.ndjson")).toMatchObject({ status: 404, body: "Run not found" });
    expect((await get("run.json")).status).toBe(404);
  });
});
