import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";
import { renderObserver, serveObserver } from "../src/observer.js";
import { OBSERVER_DATA_SCHEMA } from "../src/observer-data.js";
import { runDryRun } from "../src/run.js";

async function withRunBundle<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-observer-fixture-"));
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

  await program.parseAsync(["node", "mimetic", ...args], { from: "node" });

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
      expect(result.observerPath).toBe(".mimetic/runs/observer-proof/observer/index.html");
      const observerPath = result.observerPath;
      if (!observerPath) {
        throw new Error("observerPath missing");
      }
      await expect(stat(path.join(cwd, observerPath))).resolves.toBeTruthy();

      const html = await readFile(path.join(cwd, observerPath), "utf8");
      expect(html).toContain("Mimetic Observer");
      expect(html).toContain("contract_proof_only");
      expect(html).toContain("Mimetic - Observer");
      expect(html).toContain("tile-grid");
      expect(html).toContain("focus-rail");
      expect(html).toContain("history-panel");
      expect(html).toContain("synthetic-browser");
      expect(html).toContain("terminal-surface");

      const data = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/observer-proof/observer/observer-data.json"), "utf8")
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
      const rendered = await renderObserver(cwd, "latest");
      const server = await serveObserver(rendered, { port: 0 });

      try {
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
        const html = await (await fetch(server.url)).text();
        expect(html).toContain("Mimetic - Observer");
        expect(html).toContain("tile-grid");

        const dataUrl = new URL("observer-data.json", server.url);
        const data = await (await fetch(dataUrl)).json() as { schema: string };
        expect(data.schema).toBe(OBSERVER_DATA_SCHEMA);
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
      expect(envelope.observerPath).toBe(".mimetic/runs/observer-proof/observer/index.html");
      expect(envelope.observerDataPath).toBe(".mimetic/runs/observer-proof/observer/observer-data.json");
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
      expect(envelope.observerPath).toBe(".mimetic/runs/watch-sims-proof/observer/index.html");
      expect(envelope.observerUrl).toMatch(/^file:/);

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/watch-sims-proof/run.json"), "utf8")
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
        await readFile(path.join(cwd, ".mimetic/runs/watch-sims-proof/observer/observer-data.json"), "utf8")
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
      expect(envelope.error.code).toBe("MIMETIC_WATCH_OPTION_CONFLICT");
      expect(envelope.error.message).toContain("Use either --run");
    });
  });
});
