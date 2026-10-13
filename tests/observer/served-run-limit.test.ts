// The Observer server reads run.json, and a saved observer-data.json while a run has no run.json,
// under RUN_ARTIFACT_MAX_BYTES (32 MiB), the most every other reader of a run file reads. Past it
// the server answers 404 with a reason that names the limit.

import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildObserverData } from "../../src/observer/data.js";
import { serveObserverLibrary } from "../../src/observer/serve.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { RUN_ARTIFACT_MAX_BYTES } from "../../src/run/contained-output.js";
import { runDryRun } from "../../src/run/dry-run.js";

const RUN = "synthetic-served-run-limit";

let cwd: string;
let server: { url: string; close(): Promise<void> } | undefined;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-served-run-limit-"));
  expect((await runDryRun({ cwd, dryRun: true, runId: RUN })).ok).toBe(true);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(cwd, { recursive: true, force: true });
});
const runFile = (file: string) => path.join(cwd, ".humanish", "runs", RUN, file);

/** The status and text the library server answers for one of the run's Observer paths. */
async function get(file: string): Promise<{ status: number; text: string }> {
  if (server === undefined) {
    const started = await serveObserverLibrary(cwd, {
      port: 0,
      safe: false,
      expose: false,
      edgeAuthed: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    server = started.server;
  }
  const response = await fetch(new URL(`/_humanish/runs/${RUN}/${file}`, server.url));
  return { status: response.status, text: await response.text() };
}

/** Appends JSON whitespace until the file holds one byte more than the read limit. */
async function padPastLimit(file: string): Promise<void> {
  const size = (await readFile(file)).length;
  await appendFile(file, " ".repeat(RUN_ARTIFACT_MAX_BYTES + 1 - size));
}

describe("the Observer server's read of run.json", () => {
  it("answers 404 naming the read limit for a run.json past it", async () => {
    expect((await get("observer/observer-feed.json")).status).toBe(200);
    await padPastLimit(runFile("run.json"));
    const reason = `Observer data not found: run.json is larger than ${RUN_ARTIFACT_MAX_BYTES} bytes, the most humanish reads of it.`;
    expect(await get("observer/observer-feed.json")).toEqual({ status: 404, text: reason });
    expect(await get("observer/index.html")).toEqual({ status: 404, text: reason });
  });

  it("answers 404 naming the read limit when run.json past it is asked for by name", async () => {
    expect((await get("run.json")).status).toBe(200);
    await padPastLimit(runFile("run.json"));
    const answer = await get("run.json");
    // The status first: a failing read would otherwise diff the whole 32 MiB body.
    expect(answer.status).toBe(404);
    expect(answer.text).toBe(
      `Not found: run.json is larger than ${RUN_ARTIFACT_MAX_BYTES} bytes, the most humanish reads of it.`,
    );
  });
});

describe("the Observer server's read of a saved observer-data.json", () => {
  it("answers 404 naming the read limit for a saved file past it, in a run with no run.json", async () => {
    const stored = JSON.parse(await readFile(runFile("run.json"), "utf8")) as RunBundle;
    // An observer-data.json written before 0.124.0 holds each participant's items.
    const saved = { ...buildObserverData(stored), schema: "humanish.observer-data.v1" };
    await writeFile(runFile("observer/observer-data.json"), JSON.stringify(saved));
    await rm(runFile("run.json"));
    expect((await get("observer/observer-feed.json")).status).toBe(200);
    await padPastLimit(runFile("observer/observer-data.json"));
    expect(await get("observer/observer-feed.json")).toEqual({
      status: 404,
      text: `Observer data not found: observer/observer-data.json is larger than ${RUN_ARTIFACT_MAX_BYTES} bytes, the most humanish reads of it.`,
    });
  });
});
