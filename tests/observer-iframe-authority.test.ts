import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildObserverData, type ObserverData } from "../src/observer-data.js";
import { attachObserverRuntimeStreamUrls, renderObserver, serveObserver, withRuntimeStreamUrls, type ObserverServer } from "../src/observer.js";
import { serveObserverLibrary, type ServeLibraryServer } from "../src/observer-serve.js";
import { runDryRun } from "../src/run.js";
import { RUN_STATUS_SCHEMA } from "../src/run-status.js";

const roots: string[] = [];
const servers: Array<ObserverServer | ServeLibraryServer> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-frame-authority-"));
  roots.push(cwd);
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  for (const runId of ["attached", "other"]) expect((await runDryRun({ cwd, dryRun: true, runId })).ok).toBe(true);
  const runRoot = path.join(cwd, ".humanish", "runs", "attached");
  const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8"));
  const streamId = bundle.streams[0].id as string;
  const rendered = await renderObserver(cwd, "attached", { open: false });
  expect(rendered.ok).toBe(true);
  const server = await serveObserver(rendered, { open: false, port: 0 });
  servers.push(server);
  return { cwd, runRoot, bundle, streamId, rendered, server };
}

const served = async (url: URL) => await (await fetch(url)).json() as ObserverData;

describe("runtime desktop iframe authority", () => {
  it("discards persisted grants in static projections and only grants valid active runtime URLs", async () => {
    const { bundle, streamId } = await fixture();
    bundle.streams[0].embed = { kind: "iframe", url: "https://untrusted.example/", runtimeDesktop: true };
    const data = buildObserverData(bundle);
    expect(data.streams[0]?.embed?.runtimeDesktop).toBeUndefined();
    data.streams[0]!.embed = { ...data.streams[0]!.embed!, runtimeDesktop: true };
    expect(withRuntimeStreamUrls(data, []).streams[0]?.embed?.runtimeDesktop).toBeUndefined();
    const runtime = [{ streamId, url: "https://desktop.example/view" }];
    const attached = withRuntimeStreamUrls(data, runtime);
    expect(attached.streams[0]?.embed).toMatchObject({ kind: "iframe", url: runtime[0]!.url, runtimeDesktop: true });
    expect(withRuntimeStreamUrls(attached, [{ ...runtime[0]!, ended: true }]).streams[0]?.embed?.runtimeDesktop).toBeUndefined();
    for (const url of ["javascript:alert(1)", "data:text/html,synthetic", "https://user:password" + "@desktop.example/", "https://desktop.example/\nview"]) {
      expect(withRuntimeStreamUrls(data, [{ streamId, url }]).streams[0]?.embed?.runtimeDesktop).toBeUndefined();
    }
  });

  it("does not grant fallback JSON or another run with colliding stream ids", async () => {
    const { cwd, runRoot, bundle, streamId, rendered, server } = await fixture();
    const otherPath = path.join(cwd, ".humanish", "runs", "other", "run.json");
    const other = JSON.parse(await readFile(otherPath, "utf8"));
    other.streams[0].id = streamId;
    await writeFile(otherPath, JSON.stringify(other));
    attachObserverRuntimeStreamUrls(rendered, [{ streamId, url: "https://desktop.example/attached" }]);
    expect((await served(new URL("observer-data.json", server.url))).streams[0]?.embed?.runtimeDesktop).toBe(true);
    const crossRun = await served(new URL("/_humanish/runs/other/observer/observer-data.json", server.url));
    expect(crossRun.streams[0]?.embed?.runtimeDesktop).toBeUndefined();
    expect(JSON.stringify(crossRun)).not.toContain("https://desktop.example/attached");
    attachObserverRuntimeStreamUrls(rendered, []);
    const fallback = buildObserverData(bundle);
    fallback.streams[0]!.embed = { kind: "iframe", url: "https://untrusted.example/", runtimeDesktop: true };
    await writeFile(path.join(runRoot, "observer", "observer-data.json"), JSON.stringify(fallback));
    await writeFile(path.join(runRoot, "run.json"), "{");
    expect((await served(new URL("observer-data.json", server.url))).streams[0]?.embed?.runtimeDesktop).toBeUndefined();
    const library = await serveObserverLibrary(cwd, { port: 0, safe: false, expose: false, edgeAuthed: false });
    if (!library.ok) throw new Error(library.error.message);
    servers.push(library.server);
    const libraryData = await served(new URL("/_humanish/runs/attached/observer/observer-data.json", library.server.url));
    expect(libraryData.streams[0]?.embed?.runtimeDesktop).toBeUndefined();
  });

  it("refuses framing for every local response including raw HTML, redirects, JSON and errors", async () => {
    const { runRoot, server } = await fixture();
    await writeFile(path.join(runRoot, "synthetic.html"), "<!doctype html><title>Synthetic artifact</title>");
    for (const pathname of ["/", "/observer/index.html", "/observer/observer-data.json", "/synthetic.html", "/missing", "/_humanish/runs/attached/synthetic.html"]) {
      const response = await fetch(new URL(pathname, server.url), { redirect: "manual" });
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    }
  });

  it("keeps history's outcome while adding the current runtime state for running filters", async () => {
    const { runRoot, server, bundle } = await fixture();
    const now = new Date().toISOString();
    await writeFile(path.join(runRoot, "status.json"), JSON.stringify({ schema: RUN_STATUS_SCHEMA, runId: "attached", state: "running", mode: "dry-run", pid: 999999, startedAt: now, updatedAt: now }));
    const history = await (await fetch(new URL("/_humanish/history.json", server.url))).json() as { runs: Array<{ runId: string; status: string; runtimeState?: string }> };
    expect(history.runs.find((run) => run.runId === "attached")).toMatchObject({ status: bundle.review.verdict, runtimeState: "running" });
  });
});
