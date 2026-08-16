import { cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { symlinkSync, unlinkSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";
import { attachObserverRuntimeStreamUrls, renderObserver, serveObserver } from "../src/observer.js";
import { OBSERVER_DATA_SCHEMA, buildObserverData } from "../src/observer-data.js";
import { runDryRun, type RunBundle, type RunCostSummary } from "../src/run.js";
import { syntheticPng1x1 } from "./image-fixtures.js";

const PNG_1X1 = syntheticPng1x1();

async function withRunBundle<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-observer-fixture-"));
  const tempApp = path.join(tempRoot, "minimal-app");

  try {
    await cp(path.resolve("fixtures/minimal-app"), tempApp, { recursive: true });
    await runDryRun({
      cwd: tempApp,
      dryRun: true,
      runId: "observer-proof"
    });
    return await callback(tempApp);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function attachScreenshotToObserverProofRun(cwd: string, screenshotPath: string): Promise<void> {
  await mkdir(path.join(cwd, ".humanish/runs/observer-proof/screenshots"), { recursive: true });
  await writeFile(path.join(cwd, ".humanish/runs/observer-proof", screenshotPath), PNG_1X1);

  const bundlePath = path.join(cwd, ".humanish/runs/observer-proof/run.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
    streams: Array<{
      artifacts: Array<{ label: string; path: string; kind: string }>;
      embed?: { kind: string; url?: string; title?: string };
      ui?: { screenshotUrl?: string };
    }>;
  };
  const stream = bundle.streams[0];
  if (!stream) throw new Error("observer fixture has no stream");

  stream.embed = { kind: "screenshot", url: screenshotPath, title: "Synthetic screenshot evidence" };
  stream.ui = { ...(stream.ui ?? {}), screenshotUrl: screenshotPath };
  stream.artifacts.push({ label: "synthetic screenshot evidence", path: screenshotPath, kind: "screenshot" });
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    }
  });

  await program.parseAsync(["node", "humanish", ...args], { from: "node" });

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join("")
  };
}









describe("observer rendering", () => {
  it("renders a static observer from a verified bundle", async () => {
    await withRunBundle(async (cwd) => {
      const result = await renderObserver(cwd, "latest");

      expect(result.ok).toBe(true);
      expect(result.observerPath).toBe(".humanish/runs/observer-proof/observer/index.html");
      const observerPath = result.observerPath;
      if (!observerPath) {
        throw new Error("observerPath missing");
      }
      await expect(stat(path.join(cwd, observerPath))).resolves.toBeTruthy();

      const html = await readFile(path.join(cwd, observerPath), "utf8");
      // The workspace artifact with this run's snapshot injected (no placeholder left,
      // no network references — the durability property the rebuild exists for).
      expect(html).toContain("<title>Humanish Observer — observer-proof</title>");
      expect(html).toContain('id="observer-data"');
      expect(html).toContain("contract_proof_only");
      expect(html).not.toContain("__HUMANISH_OBSERVER_DATA__");
      expect(html).not.toContain("fonts.googleapis");

      const data = JSON.parse(
        await readFile(path.join(cwd, ".humanish/runs/observer-proof/observer/observer-data.json"), "utf8")
      ) as {
        schema: string;
        streams: Array<{ kind: string; kindLabel: string }>;
      };
      expect(data.schema).toBe(OBSERVER_DATA_SCHEMA);
      expect(data.streams).toHaveLength(1);
      expect(data.streams[0]).toMatchObject({ kind: "ui", kindLabel: "UI" });
    });
  });

  it("serves observer artifacts over a live localhost server", async () => {
    await withRunBundle(async (cwd) => {
      const screenshotPath = "screenshots/observer-proof.png";
      await attachScreenshotToObserverProofRun(cwd, screenshotPath);
      const rendered = await renderObserver(cwd, "latest");
      await writeFile(
        path.join(cwd, ".humanish/runs/observer-proof/observer/observer-data.json"),
        `${JSON.stringify({
          schema: OBSERVER_DATA_SCHEMA,
          run: { runId: "observer-proof" },
          streams: [{
            id: "stream-001",
            embed: { kind: "screenshot", url: "screenshots/stale-missing.png" },
            ui: { screenshotUrl: "screenshots/stale-missing.png" }
          }]
        }, null, 2)}\n`,
        "utf8"
      );
      const server = await serveObserver(rendered, { port: 0 });

      try {
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
        const html = await (await fetch(server.url)).text();
        expect(html).toContain("Humanish Observer");
        expect(html).toContain("statusbar");

        const dataUrl = new URL("observer-data.json", server.url);
        const data = await (await fetch(dataUrl)).json() as {
          schema: string;
          streams: Array<{ ui?: { screenshotUrl?: string } }>;
        };
        expect(data.schema).toBe(OBSERVER_DATA_SCHEMA);
        expect(data.streams[0]?.ui?.screenshotUrl).toBe(screenshotPath);

        const screenshotUrl = new URL(`../${screenshotPath}`, server.url);
        const screenshotResponse = await fetch(screenshotUrl);
        expect(screenshotResponse.status).toBe(200);
        expect(screenshotResponse.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await screenshotResponse.arrayBuffer()).subarray(0, 8))
          .toEqual(PNG_1X1.subarray(0, 8));
      } finally {
        await server.close();
      }
    });
  });

  it("hydrates runtime stream URLs after the observer server is already open", async () => {
    await withRunBundle(async (cwd) => {
      const rendered = await renderObserver(cwd, "latest");
      const server = await serveObserver(rendered, { port: 0 });

      try {
        const dataUrl = new URL("observer-data.json", server.url);
        const before = await (await fetch(dataUrl)).json() as {
          streams: Array<{ embed?: { kind: string; url?: string }; id: string; url?: string }>;
        };
        const streamId = before.streams[0]?.id;
        expect(streamId).toBeTruthy();
        expect(before.streams[0]?.url).toBeUndefined();

        attachObserverRuntimeStreamUrls(rendered, [{
          streamId: streamId!,
          url: "https://stream.example/live-desktop"
        }]);

        const after = await (await fetch(dataUrl)).json() as {
          streams: Array<{ embed?: { kind: string; url?: string }; id: string; transport: string; url?: string }>;
        };
        expect(after.streams[0]).toMatchObject({
          embed: { kind: "iframe", url: "https://stream.example/live-desktop" },
          transport: "sse",
          url: "https://stream.example/live-desktop"
        });
      } finally {
        await server.close();
      }
    });
  });

  it("exposed mode enforces a Host allowlist (421) and sends security headers; addPublicOrigin admits the tunnel host", async () => {
    await withRunBundle(async (cwd) => {
      const rendered = await renderObserver(cwd, "latest");
      const server = await serveObserver(rendered, { port: 0, exposed: true });
      const rawGet = (headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
        new Promise((resolve, reject) => {
          const request = http.request(
            { host: "127.0.0.1", port: server.port, path: "/observer/index.html", method: "GET", headers },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () => resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString("utf8")
              }));
            }
          );
          request.on("error", reject);
          request.end();
        });

      try {
        // Loopback Host is admitted, and carries the shared security headers.
        const loopback = await rawGet({ host: `127.0.0.1:${server.port}` });
        expect(loopback.status).toBe(200);
        expect(loopback.headers["x-frame-options"]).toBe("DENY");
        expect(loopback.headers["referrer-policy"]).toBe("no-referrer");
        expect(loopback.headers["x-content-type-options"]).toBe("nosniff");
        expect(loopback.headers["cache-control"]).toBe("no-store");

        // An undeclared Host is a DNS-rebinding attempt: 421, no bundle bytes.
        const evil = await rawGet({ host: "evil.example" });
        expect(evil.status).toBe(421);
        expect(evil.body).toBe("Misdirected Request");

        // Declaring the tunnel origin admits its Host.
        server.addPublicOrigin("https://observer.example.com");
        const declared = await rawGet({ host: "observer.example.com" });
        expect(declared.status).toBe(200);
      } finally {
        await server.close();
      }
    });
  });

  it("loopback (non-exposed) mode stays permissive: any Host is served and no allowlist applies", async () => {
    await withRunBundle(async (cwd) => {
      const rendered = await renderObserver(cwd, "latest");
      const server = await serveObserver(rendered, { port: 0 });
      try {
        const response = await new Promise<number>((resolve, reject) => {
          const request = http.request(
            { host: "127.0.0.1", port: server.port, path: "/observer/index.html", headers: { host: "anything.example" } },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            }
          );
          request.on("error", reject);
          request.end();
        });
        // The permissive local-dev server never consults a Host allowlist.
        expect(response).toBe(200);
        // addPublicOrigin is a no-op in loopback mode.
        server.addPublicOrigin("https://observer.example.com");
      } finally {
        await server.close();
      }
    });
  });

  it("exposed watch is scoped to the attached run: only it is listed and reachable; loopback still serves the whole library", async () => {
    await withRunBundle(async (cwd) => {
      // A second, UNATTACHED run lives alongside the attached one in .humanish/runs/.
      await runDryRun({ cwd, dryRun: true, runId: "other-run" });

      const rawGet = (
        port: number,
        requestPath: string
      ): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          const request = http.request(
            { host: "127.0.0.1", port, path: requestPath, method: "GET", headers: { host: `127.0.0.1:${port}` } },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () => resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8")
              }));
            }
          );
          request.on("error", reject);
          request.end();
        });

      // Attach to the FIRST run explicitly (result.run === "observer-proof").
      const rendered = await renderObserver(cwd, "observer-proof");
      expect(rendered.run).toBe("observer-proof");

      // (exposed) Only the attached run is listed, reachable, and admitted.
      const exposedServer = await serveObserver(rendered, { port: 0, exposed: true });
      try {
        const history = JSON.parse((await rawGet(exposedServer.port, "/_humanish/history.json")).body) as {
          latestRunId: string | null;
          runs: Array<{ runId: string }>;
        };
        expect(history.runs.map((run) => run.runId)).toEqual(["observer-proof"]);
        expect(history.latestRunId).toBe("observer-proof");

        // Another real run 404s byte-identically to a nonexistent run (no cross-run access, no oracle).
        const other = await rawGet(exposedServer.port, "/_humanish/runs/other-run/observer/index.html");
        const nonexistent = await rawGet(exposedServer.port, "/_humanish/runs/nonexistent-run/observer/index.html");
        expect(other.status).toBe(404);
        expect(other.body).toBe("Run not found");
        expect(other).toEqual(nonexistent);

        // The attached run stays fully reachable on every route shape.
        const own = await rawGet(exposedServer.port, "/_humanish/runs/observer-proof/observer/index.html");
        expect(own.status).toBe(200);
        const pageIndex = await rawGet(exposedServer.port, "/observer/index.html");
        expect(pageIndex.status).toBe(200);
        const pageData = await rawGet(exposedServer.port, "/observer/observer-data.json");
        expect(pageData.status).toBe(200);
        expect(() => JSON.parse(pageData.body)).not.toThrow();
      } finally {
        await exposedServer.close();
      }

      // (loopback) The full library is still served, byte-identical to today: other runs listed AND reachable.
      const loopbackServer = await serveObserver(rendered, { port: 0 });
      try {
        const history = JSON.parse((await rawGet(loopbackServer.port, "/_humanish/history.json")).body) as {
          runs: Array<{ runId: string }>;
        };
        expect(history.runs.map((run) => run.runId).sort()).toEqual(["observer-proof", "other-run"]);
        const other = await rawGet(loopbackServer.port, "/_humanish/runs/other-run/observer/index.html");
        expect(other.status).toBe(200);
      } finally {
        await loopbackServer.close();
      }
    });
  });

  it("keeps a live Observer pinned to its original physical roots after a cwd alias retarget", async () => {
    await withRunBundle(async (physicalCwd) => {
      const tempRoot = path.dirname(physicalCwd);
      const aliasCwd = path.join(tempRoot, "observer-cwd-alias");
      const decoyCwd = path.join(tempRoot, "retargeted-app");
      await cp(path.resolve("fixtures/minimal-app"), decoyCwd, { recursive: true });
      await runDryRun({ cwd: decoyCwd, dryRun: true, runId: "observer-proof" });
      await runDryRun({ cwd: decoyCwd, dryRun: true, runId: "retargeted-b-only" });

      for (const [cwd, title] of [
        [physicalCwd, "PINNED-A-MARKER"],
        [decoyCwd, "RETARGETED-B-SECRET"]
      ] as const) {
        const bundlePath = path.join(cwd, ".humanish", "runs", "observer-proof", "run.json");
        const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as { scenario: { title: string } };
        bundle.scenario.title = title;
        await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      }

      await symlink(physicalCwd, aliasCwd, "dir");
      const rendered = await renderObserver(aliasCwd, "latest");
      const server = await serveObserver(rendered, { port: 0 });
      try {
        await unlink(aliasCwd);
        await symlink(decoyCwd, aliasCwd, "dir");

        for (const url of [
          server.url,
          new URL("/_humanish/runs/observer-proof/observer/index.html", server.url).href
        ]) {
          const response = await fetch(url);
          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain("PINNED-A-MARKER");
          expect(body).not.toContain("RETARGETED-B-SECRET");
        }

        const history = await (await fetch(new URL("/_humanish/history.json", server.url))).json() as {
          runs: Array<{ runId: string }>;
        };
        expect(history.runs.map((run) => run.runId)).toContain("observer-proof");
        expect(history.runs.map((run) => run.runId)).not.toContain("retargeted-b-only");
      } finally {
        await server.close();
        await unlink(aliasCwd).catch(() => undefined);
      }
    });
  });

  it("retains the original runs-root token when a latest-pointer read retargets the cwd alias", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-observer-latest-bind-"));
    const physicalA = path.join(tempRoot, "physical-a");
    const physicalB = path.join(tempRoot, "physical-b");
    const aliasCwd = path.join(tempRoot, "cwd-alias");
    const originalJsonParse = JSON.parse;
    let retargeted = false;

    try {
      await cp(path.resolve("fixtures/minimal-app"), physicalA, { recursive: true });
      await cp(path.resolve("fixtures/minimal-app"), physicalB, { recursive: true });
      await runDryRun({ cwd: physicalA, dryRun: true, runId: "latest-a" });
      await runDryRun({ cwd: physicalB, dryRun: true, runId: "latest-b" });
      await symlink(physicalA, aliasCwd, "dir");
      JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
        const value = originalJsonParse(text, reviver);
        if (
          !retargeted
          && typeof value === "object"
          && value !== null
          && (value as { runId?: unknown }).runId === "latest-a"
          && (value as { path?: unknown }).path === ".humanish/runs/latest-a"
        ) {
          unlinkSync(aliasCwd);
          symlinkSync(physicalB, aliasCwd, "dir");
          retargeted = true;
        }
        return value;
      }) as typeof JSON.parse;

      const rendered = await renderObserver(aliasCwd, "latest");
      expect(retargeted).toBe(true);
      expect(rendered.ok).toBe(true);
      expect(rendered.run).toBe("latest-a");
      expect(await stat(path.join(physicalA, ".humanish", "runs", "latest-a", "observer", "index.html")))
        .toMatchObject({});
      await expect(stat(path.join(physicalB, ".humanish", "runs", "latest-a", "observer", "index.html")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const server = await serveObserver(rendered, { open: false });
      try {
        const response = await fetch(server.url);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("latest-a");
      } finally {
        await server.close();
      }
    } finally {
      JSON.parse = originalJsonParse;
      await unlink(aliasCwd).catch(() => undefined);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("refuses to render over a hardlinked Observer output leaf", async () => {
    await withRunBundle(async (cwd) => {
      const observerDir = path.join(cwd, ".humanish", "runs", "observer-proof", "observer");
      const externalSentinel = path.join(path.dirname(cwd), "observer-output-sentinel.html");
      await mkdir(observerDir, { recursive: true });
      await writeFile(externalSentinel, "OUTSIDE-SENTINEL", "utf8");
      await link(externalSentinel, path.join(observerDir, "index.html"));

      const rendered = await renderObserver(cwd, "latest");
      expect(rendered).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_INVALID_RUN_BUNDLE" }
      });
      expect(await readFile(externalSentinel, "utf8")).toBe("OUTSIDE-SENTINEL");
    });
  });

  it("rejects hardlinked Observer artifact leaves created after server pinning", async () => {
    await withRunBundle(async (cwd) => {
      const rendered = await renderObserver(cwd, "latest");
      const server = await serveObserver(rendered, { port: 0 });
      const externalSecret = path.join(path.dirname(cwd), "hardlink-secret.txt");
      const linkedArtifact = path.join(cwd, ".humanish", "runs", "observer-proof", "hardlink-secret.txt");
      try {
        await writeFile(externalSecret, "HARDLINK-SECRET", "utf8");
        await link(externalSecret, linkedArtifact);

        const response = await fetch(new URL("../hardlink-secret.txt", server.url));
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("HARDLINK-SECRET");
      } finally {
        await server.close();
      }
    });
  });

  it("exposes watch --no-open through the Commander CLI", async () => {
    await withRunBundle(async (cwd) => {
      const result = await runCli(["watch", "--run", "latest", "--cwd", cwd, "--no-open", "--json"]);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        observerDataPath: string;
        observerPath: string;
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.observerPath).toBe(".humanish/runs/observer-proof/observer/index.html");
      expect(envelope.observerDataPath).toBe(".humanish/runs/observer-proof/observer/observer-data.json");
    });
  });

  it("rejects an out-of-range observe port before binding a server", async () => {
    await withRunBundle(async (cwd) => {
      const result = await runCli(["observe", "--run", "latest", "--cwd", cwd, "--port", "99999", "--no-open", "--json"]);

      expect(result.exitCode).toBe(2);
      const envelope = JSON.parse(result.stdout) as { error?: { code: string }; ok: boolean };
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe("HUMANISH_INVALID_PORT");
    });
  });

  it("fails observe with a structured error when the run is missing", async () => {
    await withRunBundle(async (cwd) => {
      const result = await runCli(["observe", "--run", "no-such-run", "--cwd", cwd, "--no-open", "--json"]);

      expect(result.exitCode).toBe(2);
      const envelope = JSON.parse(result.stdout) as { error?: { code: string }; ok: boolean };
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe("HUMANISH_RUN_NOT_FOUND");
    });
  });

  it("can start a fresh four-sim run and render the observer with the default watch command", async () => {
    await withRunBundle(async (cwd) => {
      const result = await runCli([
        "watch",
        "--run-id",
        "watch-sims-proof",
        "--cwd",
        cwd,
        "--no-open",
        "--json"
      ]);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        opened: boolean;
        observerPath: string;
        observerUrl: string;
        run: string;
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.run).toBe("watch-sims-proof");
      expect(envelope.opened).toBe(false);
      expect(envelope.observerPath).toBe(".humanish/runs/watch-sims-proof/observer/index.html");
      expect(envelope.observerUrl).toMatch(/^file:/);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish/runs/watch-sims-proof/run.json"), "utf8")
      ) as {
        simCount: number;
        simulations: Array<{ id: string; status: string; streamKind: string }>;
        streams: Array<{ id: string; kind: string; transport: string }>;
      };
      expect(bundle.simCount).toBe(4);
      expect(bundle.simulations).toHaveLength(4);
      expect(bundle.simulations.map((sim) => sim.id)).toEqual(["sim-01", "sim-02", "sim-03", "sim-04"]);
      expect(bundle.simulations.map((sim) => sim.streamKind)).toEqual(["ui", "terminal", "tui", "codex-ui"]);
      expect(bundle.streams.map((stream) => stream.kind)).toEqual(["ui", "terminal", "tui", "codex-ui"]);
      expect(bundle.streams.map((stream) => stream.transport)).toEqual(["polling", "snapshot", "pty", "app-server"]);

      const observerData = JSON.parse(
        await readFile(path.join(cwd, ".humanish/runs/watch-sims-proof/observer/observer-data.json"), "utf8")
      ) as {
        streams: Array<{ kindLabel: string }>;
      };
      expect(observerData.streams.map((stream) => stream.kindLabel)).toEqual(["UI", "CLI", "TUI", "Codex UI"]);
    });
  });

  it("fails closed when watch mixes fresh-run and existing-run options", async () => {
    await withRunBundle(async (cwd) => {
      const result = await runCli([
        "watch",
        "--run",
        "latest",
        "--sims",
        "4",
        "--cwd",
        cwd,
        "--json"
      ]);

      expect(result.exitCode).toBe(2);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("HUMANISH_WATCH_OPTION_CONFLICT");
      expect(envelope.error.message).toContain("Use either --run");
    });
  });
});

describe("observer cost estimate (always labeled)", () => {
  const labeledCost: RunCostSummary = {
    schema: "humanish.run-cost-summary.v1",
    currency: "usd",
    estimatedTotalUsd: 11.60,
    ratesAsOf: "2026-08-01",
    fullyEstimated: false,
    placeholder: true,
    breakdown: [
      { kind: "model-tokens", laneId: "lane-1", modelId: "gpt-5.5", estimatedCostUsd: 11.60, ratesAsOf: "2026-08-01", source: "openai.com/api/pricing", placeholder: true },
      { kind: "desktop-minutes", estimatedCostUsd: null, reason: "no_duration", ratesAsOf: null }
    ],
    tokenUsage: { input: 3843523, output: 5869, total: 3849392 },
    desktopMinutes: null,
    note: "Estimated 11.6 USD total (LOWER BOUND); includes PLACEHOLDER rate(s)."
  };


  it("buildObserverData projects bundle.cost straight through to ObserverData.cost", () => {
    const bundle = {
      schema: "humanish.run-bundle.v1",
      runId: "cost-observer",
      mode: "live",
      simCount: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      cwd: "[target-cwd]",
      artifactRoot: ".humanish/runs/cost-observer",
      source: { packageName: "humanish", humanishSource: "present", git: { schema: "humanish.git-state.v1", status: "missing" } },
      persona: { id: "p", name: "P", source: "lab:x", sourceDigest: "d" },
      scenario: { id: "s", title: "S", goal: "g", source: "lab:x", sourceDigest: "d" },
      lifecycle: [],
      simulations: [],
      streams: [],
      events: [],
      redaction: { status: "passed", notes: "" },
      artifacts: { run: "run.json", reviewJson: "review.json", reviewMarkdown: "review.md", observerData: "observer/observer-data.json", events: "events.ndjson" },
      review: { schema: "humanish.review.v1", verdict: "pass", summary: "", gaps: [] },
      feedbackCandidates: [],
      cost: labeledCost
    } as unknown as RunBundle;
    const data = buildObserverData(bundle);
    expect(data.cost).toEqual(labeledCost);

    const noCost = buildObserverData({ ...bundle, cost: undefined } as unknown as RunBundle);
    expect(noCost.cost).toBeUndefined();
  });

});
