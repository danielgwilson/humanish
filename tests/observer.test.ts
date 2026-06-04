import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { observerClientJs } from "../src/observer-assets.js";
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

function renderObserverClientForTest(data: unknown): { click: (action: string) => void; html: () => string } {
  let html = "";
  let clickHandler:
    | ((event: {
        preventDefault: () => void;
        target: { closest: (selector: string) => { getAttribute: (name: string) => string | null; tagName: string } | null };
      }) => void)
    | null = null;

  const app = {
    get innerHTML(): string {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    querySelector: () => null,
    addEventListener: (event: string, handler: typeof clickHandler) => {
      if (event === "click") clickHandler = handler;
    },
    contains: () => true
  };
  const location = {
    hash: "",
    href: "file:///tmp/mimetic/observer/index.html",
    protocol: "file:"
  };
  const sandbox = {
    document: {
      activeElement: null,
      addEventListener: () => {},
      documentElement: {
        setAttribute: () => {},
        style: { setProperty: () => {} }
      },
      getElementById: (id: string) => {
        if (id === "app") return app;
        if (id === "observer-data") return { textContent: JSON.stringify(data) };
        return null;
      }
    },
    location,
    window: {
      addEventListener: () => {},
      history: { replaceState: () => {} },
      localStorage: { getItem: () => null, setItem: () => {} },
      location
    },
    URL
  };

  runInNewContext(observerClientJs(), sandbox);

  return {
    click: (action: string) => {
      const target = {
        getAttribute: (name: string) => (name === "data-action" ? action : null),
        tagName: "BUTTON"
      };
      clickHandler?.({
        preventDefault: () => {},
        target: { closest: () => target }
      });
    },
    html: () => html
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
      // Title + brand of the redesigned mission-control shell.
      expect(html).toContain("Mimetic Observer");
      // Embedded observer-data carries the lane status verbatim.
      expect(html).toContain("contract_proof_only");
      expect(html).toContain('id="observer-data"');
      // Structural markers of the redesigned surfaces (rendered by the client).
      expect(html).toContain("focus-rail");
      expect(html).toContain("statusbar");
      expect(html).toContain("Run console");
      expect(html).toContain("tile-surface");

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

  it("renders multi-surface browser lab metadata without hiding live and screenshot modes", () => {
    const terminalTail = "$ npx mimetic verify\nnested observer: ready";
    const client = renderObserverClientForTest({
      run: {
        createdAt: "2026-06-03T12:00:00.000Z",
        lifecycle: [],
        mode: "oss-meta-lab",
        persona: { name: "Synthetic Lab Operator" },
        runId: "multi-surface-proof",
        scenario: { goal: "Watch nested Observer evidence.", title: "OSS Observer-of-Observers" },
        status: "pass"
      },
      events: [],
      streams: [
        {
          id: "lane-01",
          simId: "sim-01",
          kind: "browser",
          kindLabel: "Browser",
          label: "CorentinTh/it-tools desktop",
          status: "running",
          statusLabel: "Running",
          transport: "sse",
          updatedAt: "2026-06-03T12:00:05.000Z",
          url: "https://stream.example/it-tools",
          embed: { kind: "iframe", url: "https://stream.example/it-tools" },
          viewport: { width: 1440, height: 900 },
          ui: {
            appUrl: "https://app.example/it-tools",
            nestedObserverUrl: "https://observer.example/nested/index.html",
            route: "e2b://desktop/it-tools",
            screenshotUrl: "../screenshots/oss-01-desktop.png",
            state: "bootstrap terminal launched"
          },
          terminal: {
            format: "plain",
            stdin: "sent",
            tail: terminalTail,
            title: "Codex TUI bootstrap - CorentinTh/it-tools"
          },
          terminalPlain: terminalTail,
          completion: {
            checkedAt: "2026-06-03T12:00:06.000Z",
            nestedObserverPresent: true,
            reason: "Bootstrap terminal launched.",
            status: "running"
          },
          artifacts: [
            { label: "desktop screenshot", path: "screenshots/oss-01-desktop.png", kind: "screenshot" },
            { label: "nested observer", path: "observer/nested/index.html", kind: "observer" },
            { label: "setup quality", path: "setup-quality/oss-01-desktop-setup-quality.json", kind: "filesystem" },
            { label: "events", path: "events.ndjson", kind: "events" }
          ],
          sim: {
            currentStep: "watching nested Observer",
            id: "sim-01",
            index: 1,
            mode: "browser-sim",
            personaId: "operator",
            progress: 50,
            scenarioId: "oss-meta-lab",
            startedAt: "2026-06-03T12:00:00.000Z",
            status: "running",
            streamIds: ["lane-01"],
            streamKind: "browser",
            summary: "Headed desktop lane",
            updatedAt: "2026-06-03T12:00:05.000Z"
          },
          timeline: []
        }
      ]
    });

    expect(client.html()).toContain('src="https://stream.example/it-tools"');
    expect(client.html()).toContain('data-kind="app"');
    expect(client.html()).toContain('data-kind="observer"');
    expect(client.html()).toContain('data-kind="completion"');
    expect(client.html()).toContain('data-kind="terminal"');
    expect(client.html()).toContain('data-kind="screenshot"');
    expect(client.html()).toContain('data-kind="artifact"');
    expect(client.html()).toContain("nested observer: ready");

    client.click("media:screenshot");

    expect(client.html()).toContain('src="../screenshots/oss-01-desktop.png"');
    expect(client.html()).toContain("viewing fallback");

    client.click("open:lane-01");
    client.click("tab:files");

    expect(client.html()).toContain("setup quality");
    expect(client.html()).toContain("setup-quality/oss-01-desktop-setup-quality.json");
    expect(client.html()).toContain("Static file view cannot hydrate artifacts inline");
  });

  it("serves observer artifacts over a live localhost server", async () => {
    await withRunBundle(async (cwd) => {
      const rendered = await renderObserver(cwd, "latest");
      const server = await serveObserver(rendered, { port: 0 });

      try {
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
        const html = await (await fetch(server.url)).text();
        expect(html).toContain("Mimetic Observer");
        expect(html).toContain("statusbar");

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
