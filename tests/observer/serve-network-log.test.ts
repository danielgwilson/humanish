// humanish observe serves a participant's network log at /_humanish/runs/<id>/network/<id>.ndjson
// as NDJSON through the generic run file route. Under --safe it is served only while the run's
// verification is share_ready, as every other run file is, and observer-data.json carries the
// log's index and none of its records.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { serveObserverLibrary, type ServeLibraryOptions } from "../../src/observer/serve.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";
import { addNetworkLog } from "../helpers/network-log-run.js";

const RUN = "network-log-run";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * A dry run whose participant p1 carries a network log, its file then changed by `edit`. Returns
 * the working directory, the log's text and the verify grade.
 */
async function runWithNetworkLog(edit?: (text: string) => string) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-serve-network-log-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  expect((await runDryRun({ cwd, dryRun: true, runId: RUN })).ok).toBe(true);
  const { text } = await addNetworkLog(path.join(cwd, ".humanish", "runs", RUN), edit);
  return { cwd, text, grade: (await verifyRun(cwd, RUN)).shareSafety.status };
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
