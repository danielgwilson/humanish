import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibraryHistory } from "../../src/observer/library.js";
import { pinDirectory } from "../../src/observer/pinned-files.js";
import {
  createServeRequestHandler,
  createShareSafetyAdmission,
  serveObserverLibrary,
  type ServeLibraryOptions,
  type ServeLibraryServer,
} from "../../src/observer/serve.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";

// Concatenated so this file never holds a secret-shaped literal.
const SECRET = "sk-" + "syntheticvalue1234567890abcdef";
const SECRET_LINE = `OPENAI_API_KEY=${SECRET}\n`;
const RUN = "admitted-run";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function admittedRun(): Promise<{ cwd: string; runRoot: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-safe-inventory-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  expect((await runDryRun({ cwd, dryRun: true, runId: RUN })).ok).toBe(true);
  expect((await verifyRun(cwd, RUN)).shareSafety.status).toBe("share_ready");
  return { cwd, runRoot: path.join(cwd, ".humanish", "runs", RUN) };
}

async function startSafe(
  cwd: string,
  overrides: Partial<ServeLibraryOptions>,
): Promise<ServeLibraryServer> {
  const started = await serveObserverLibrary(cwd, {
    port: 0,
    safe: true,
    expose: false,
    edgeAuthed: false,
    ...overrides,
  });
  if (!started.ok) throw new Error(started.error.code);
  cleanups.push(() => started.server.close());
  return started.server;
}

async function get(base: string, route: string): Promise<{ status: number; body: string }> {
  const response = await fetch(new URL(route, base));
  return { status: response.status, body: await response.text() };
}

const runPath = (file: string): string => `/_humanish/runs/${RUN}/${file}`;

// `serve --expose --safe` without edge auth runs this same loopback server behind the tunnel.
const modes: Array<[string, Partial<ServeLibraryOptions>]> = [
  ["serve --safe", {}],
  ["serve --expose --safe", { expose: true, publicOrigin: "https://observer.example.com" }],
];

describe.each(modes)("%s after admission", (_label, overrides) => {
  it("does not serve a file added to an admitted run", async () => {
    const { cwd, runRoot } = await admittedRun();
    const verify = vi.fn(verifyRun);
    const server = await startSafe(cwd, { ...overrides, verifyImpl: verify });
    expect(server.shareReadyCount).toBe(1);
    expect((await get(server.url, runPath("observer/index.html"))).status).toBe(200);
    expect((await get(server.url, runPath("review.md"))).status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);

    await writeFile(path.join(runRoot, "notes.txt"), SECRET_LINE);

    const added = await get(server.url, runPath("notes.txt"));
    expect(added.status).toBe(404);
    expect(added.body).toBe("Run not found");
    expect((await get(server.url, runPath("review.md"))).status).toBe(404);
    expect((await get(server.url, runPath("observer/index.html"))).status).toBe(404);
    const history = JSON.parse((await get(server.url, "/_humanish/history.json")).body);
    expect((history as LibraryHistory).runs).toEqual([]);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("does not serve a file modified after admission", async () => {
    const { cwd, runRoot } = await admittedRun();
    const server = await startSafe(cwd, overrides);
    expect((await get(server.url, runPath("review.md"))).status).toBe(200);

    await appendFile(path.join(runRoot, "review.md"), SECRET_LINE);

    const modified = await get(server.url, runPath("review.md"));
    expect(modified.status).toBe(404);
    expect(modified.body.includes(SECRET)).toBe(false);
    expect((await get(server.url, runPath("observer/index.html"))).status).toBe(404);
  });
});

describe("a change that lands after the admission walk", () => {
  // The handler is given the inventory taken before the change, as when a write lands between a
  // request's walk and its read.
  it("serves only inventoried files with their admitted identity", async () => {
    const { cwd, runRoot } = await admittedRun();
    const inventory = await createShareSafetyAdmission(cwd).admit(RUN);
    expect(inventory?.entries.has("review.md")).toBe(true);

    const hosts = new Set<string>();
    const handler = createServeRequestHandler({
      proofRoot: await pinDirectory(path.join(cwd, ".humanish", "runs")),
      safe: true,
      admit: async () => inventory,
      hostAllowlist: hosts,
      renderLibrary: () => "",
    });
    const server: Server = createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server has no address");
    hosts.add(`127.0.0.1:${address.port}`);
    const base = `http://127.0.0.1:${address.port}/`;

    expect((await get(base, runPath("review.json"))).status).toBe(200);

    await writeFile(path.join(runRoot, "notes.txt"), SECRET_LINE);
    await appendFile(path.join(runRoot, "review.md"), SECRET_LINE);
    await appendFile(path.join(runRoot, "run.json"), SECRET_LINE);

    expect((await get(base, runPath("notes.txt"))).status).toBe(404);
    const modified = await get(base, runPath("review.md"));
    expect(modified.status).toBe(404);
    expect(modified.body.includes(SECRET)).toBe(false);
    expect((await get(base, runPath("run.json"))).status).toBe(404);
    expect((await get(base, runPath("review.json"))).status).toBe(200);
    // The page falls back from the changed run.json to the admitted observer-data.json.
    const page = await get(base, runPath("observer/index.html"));
    expect(page.status).toBe(200);
    expect(page.body.includes(SECRET)).toBe(false);
  });
});
