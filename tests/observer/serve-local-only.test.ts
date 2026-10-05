// serve never hands out a run's local-only files: sandbox-receipts.ndjson, which holds the raw
// sandbox ids, and status.json, which holds the recording pid. A share_ready run keeps both, since
// verify exempts the receipts from the raw-id check, so --safe admission alone would serve them.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { serveObserverLibrary, type ServeLibraryOptions } from "../../src/observer/serve.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";

const RUN = "local-only-run";
// Shaped like an E2B id and built at run time.
const RAW_ID = ["i", "k3w8q2m7z4", "v9n1p6x5b"].join("");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function shareReadyRunWithReceipts(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-serve-local-only-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  expect((await runDryRun({ cwd, dryRun: true, runId: RUN })).ok).toBe(true);
  const runRoot = path.join(cwd, ".humanish", "runs", RUN);
  await writeFile(
    path.join(runRoot, "sandbox-receipts.ndjson"),
    `${JSON.stringify({ at: "t", laneId: "participant-1", provider: "e2b", sandboxId: RAW_ID })}\n`,
  );
  await writeFile(
    path.join(runRoot, "status.json"),
    `${JSON.stringify({ schema: "humanish.run-status.v1", runId: RUN, state: "finished", pid: 4242 })}\n`,
  );
  expect((await verifyRun(cwd, RUN)).shareSafety.status).toBe("share_ready");
  return cwd;
}

const modes: Array<[string, Partial<ServeLibraryOptions>]> = [
  ["serve", { safe: false }],
  ["serve --safe", { safe: true }],
  [
    "serve --expose --safe",
    { safe: true, expose: true, publicOrigin: "https://observer.example.com" },
  ],
];

describe.each(modes)("%s on a share_ready run", (_label, overrides) => {
  it("answers a local-only file with the 404 of a file that does not exist", async () => {
    const cwd = await shareReadyRunWithReceipts();
    const started = await serveObserverLibrary(cwd, {
      port: 0,
      safe: false,
      expose: false,
      edgeAuthed: false,
      ...overrides,
    });
    if (!started.ok) throw new Error(started.error.code);
    cleanups.push(() => started.server.close());
    const get = async (file: string) => {
      const response = await fetch(new URL(`/_humanish/runs/${RUN}/${file}`, started.server.url));
      return { status: response.status, body: await response.text() };
    };

    expect((await get("run.json")).status).toBe(200);
    const missing = await get("no-such-file.json");
    expect(missing.status).toBe(404);
    for (const file of [
      "sandbox-receipts.ndjson",
      "SANDBOX-RECEIPTS.NDJSON",
      "%73andbox-receipts.ndjson",
      "observer/../sandbox-receipts.ndjson",
      "status.json",
    ]) {
      const response = await get(file);
      expect(response, file).toEqual(missing);
      expect(response.body.includes(RAW_ID), file).toBe(false);
    }
  });
});
