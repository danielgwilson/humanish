import { cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { observerClientJs, observerCss } from "../src/observer-assets.js";
import { createProgram } from "../src/program.js";
import { attachObserverRuntimeStreamUrls, renderObserver, serveObserver } from "../src/observer.js";
import { OBSERVER_DATA_SCHEMA } from "../src/observer-data.js";
import { runDryRun } from "../src/run.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lp9J1wAAAABJRU5ErkJggg==",
  "base64"
);

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

function renderObserverClientForTest(data: unknown, hash = ""): { click: (action: string) => void; html: () => string; key: (key: string) => void } {
  let html = "";
  let clickHandler:
    | ((event: {
        preventDefault: () => void;
        target: { closest: (selector: string) => { getAttribute: (name: string) => string | null; tagName: string } | null };
      }) => void)
    | null = null;
  let keyHandler:
    | ((event: {
        key: string;
        preventDefault: () => void;
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
    hash,
    href: `file:///tmp/humanish/observer/index.html${hash}`,
    protocol: "file:"
  };
  const sandbox = {
    document: {
      activeElement: null,
      addEventListener: (event: string, handler: typeof keyHandler) => {
        if (event === "keydown") keyHandler = handler;
      },
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
    html: () => html,
    key: (key: string) => {
      keyHandler?.({
        key,
        preventDefault: () => {}
      });
    }
  };
}

function browserLabObserverData(): Record<string, unknown> {
  const terminalTail = "$ npx humanish verify\nnested observer: ready";
  const actorLogTail = "$ npx --no-install humanish init --yes\n$ npx --no-install humanish run --app-url http://localhost:5173 --sims 2\nobserved product friction: none observed";
  return {
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
          screenshotUrl: "screenshots/oss-01-desktop.png",
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
          actorLastMessageTail: "Created app-specific personas and scenarios, then opened the nested Observer.",
          actorLogTail,
          checkedAt: "2026-06-03T12:00:06.000Z",
          logTail: "== bootstrap complete ==\napp_status=running",
          meaningfulUse: {
            schema: "humanish.meaningful-use-score.v1",
            status: "partial",
            score: 78,
            summary: "Meaningful-use partial (78/100): needs stronger feedback quality.",
            hardFailures: [],
            components: [
              {
                id: "setup-correctness",
                label: "Setup correctness",
                status: "partial",
                score: 8,
                detail: "One setup check still needs review."
              },
              {
                id: "feedback-quality",
                label: "Feedback quality",
                status: "partial",
                score: 10,
                detail: "Study-quality rating was ceremonial."
              }
            ]
          },
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
  };
}

function codexAppServerTraceObserverData(): Record<string, unknown> {
  return {
    run: {
      createdAt: "2026-06-05T16:00:00.000Z",
      lifecycle: [],
      mode: "codex-app-server-fixture",
      persona: { name: "Synthetic Codex Operator" },
      runId: "codex-app-server-trace-proof",
      scenario: { goal: "Inspect public-safe Codex trace metadata.", title: "Codex App Server Trace" },
      status: "pass"
    },
    events: [],
    streams: [
      {
        id: "codex-lane-01",
        simId: "sim-codex-01",
        kind: "codex-ui",
        kindLabel: "Codex UI",
        label: "Codex app-server trace",
        status: "running",
        statusLabel: "Running",
        transport: "app-server",
        updatedAt: "2026-06-05T16:00:05.000Z",
        url: "https://codex.example/session/public-safe",
        viewport: { width: 1280, height: 900 },
        ui: {
          route: "/codex/session/public-safe",
          state: "watching synthetic app-server trace"
        },
        terminal: {
          format: "plain",
          stdin: "disabled",
          tail: "codex-app-server trace connected\nstatus: responding",
          title: "Codex app-server"
        },
        terminalPlain: "codex-app-server trace connected\nstatus: responding",
        codex: {
          provider: "codex-app-server",
          sessionId: "session-public-safe-01",
          state: "watching",
          contract: "Observer renders Codex app-server trace metadata without private transcript content.",
          trace: {
            status: "responding",
            threadId: "thread-public-safe-01",
            turnId: "turn-public-safe-02",
            model: "gpt-5-codex-test",
            service: "codex-app-server",
            events: [
              {
                at: "2026-06-05T16:00:01.000Z",
                kind: "message",
                role: "user",
                text: "Synthetic request to inspect a public fixture."
              },
              {
                at: "2026-06-05T16:00:02.000Z",
                kind: "reasoning",
                summary: "Planning a bounded observer projection check."
              },
              {
                at: "2026-06-05T16:00:03.000Z",
                kind: "tool",
                toolName: "read_fixture",
                status: "complete",
                text: "Loaded synthetic trace metadata."
              },
              {
                at: "2026-06-05T16:00:04.000Z",
                kind: "file",
                action: "linked",
                path: "traces/codex-app-server-public-trace.json"
              },
              {
                at: "2026-06-05T16:00:05.000Z",
                kind: "command",
                command: "pnpm vitest run tests/observer.test.ts",
                status: "passed"
              }
            ]
          }
        },
        artifacts: [
          { label: "codex trace", path: "traces/codex-app-server-public-trace.json", kind: "trace" },
          { label: "event log", path: "events.ndjson", kind: "events" }
        ],
        sim: {
          currentStep: "Watching Codex app-server trace metadata",
          id: "sim-codex-01",
          index: 1,
          mode: "codex-app-sim",
          personaId: "synthetic-codex-operator",
          progress: 60,
          scenarioId: "codex-app-server-trace",
          startedAt: "2026-06-05T16:00:00.000Z",
          status: "running",
          streamIds: ["codex-lane-01"],
          streamKind: "codex-ui",
          summary: "Codex app-server trace lane",
          updatedAt: "2026-06-05T16:00:05.000Z"
        },
        timeline: []
      }
    ]
  };
}

function codexNoTraceObserverData(): Record<string, unknown> {
  const data = codexAppServerTraceObserverData();
  const stream = (data.streams as Array<Record<string, unknown>>)[0]!;
  stream.status = "contract_proof_only";
  stream.statusLabel = "Contract proof";
  stream.url = undefined;
  stream.terminalPlain = "codex-app-server session contract\nstate: not_connected\nembed: pending provider URL\nreceipts: planned";
  stream.terminal = {
    format: "plain",
    stdin: "disabled",
    tail: stream.terminalPlain,
    title: "Codex UI"
  };
  stream.codex = {
    provider: "codex-app-server",
    state: "not_connected",
    contract: "Observer accepts an app-server embed URL, session id, status feed, terminal receipt feed, and artifact links."
  };
  stream.artifacts = [
    { label: "run bundle", path: "run.json", kind: "bundle" },
    { label: "review", path: "review.md", kind: "review" },
    { label: "event log", path: "events.ndjson", kind: "events" }
  ];
  stream.sim = {
    ...(stream.sim as Record<string, unknown>),
    currentStep: "App-server embed contract captured",
    progress: 100,
    status: "contract_proof_only",
    summary: "Codex UI lane reserved for app-server sessions that can be watched beside terminal evidence."
  };
  return data;
}

interface FakeLiveFrame {
  parentNode: { children?: Array<{ innerHTML?: string }>; parentNode: unknown } | null;
  src: string;
  srcSetCount: number;
}

function renderObserverClientWithDomForTest(data: unknown): {
  click: (action: string) => void;
  html: () => string;
  iframes: FakeLiveFrame[];
} {
  class FakeElement {
    attrs: Record<string, string> = {};
    children: FakeElement[] = [];
    parentNode: FakeElement | null = null;
    rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    style: Record<string, string> = {};
    className = "";
    innerHTML = "";
    tagName: string;
    srcSetCount = 0;
    srcValue = "";

    constructor(tagName: string, rect?: FakeElement["rect"]) {
      this.tagName = tagName.toUpperCase();
      this.rect = rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }

    appendChild(child: FakeElement): FakeElement {
      if (child.parentNode && child.parentNode !== this) child.parentNode.removeChild(child);
      if (!this.children.includes(child)) this.children.push(child);
      child.parentNode = this;
      return child;
    }

    removeChild(child: FakeElement): FakeElement {
      this.children = this.children.filter((candidate) => candidate !== child);
      child.parentNode = null;
      return child;
    }

    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
    }

    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }

    getBoundingClientRect(): FakeElement["rect"] {
      return this.rect;
    }

    set src(value: string) {
      this.srcValue = value;
      this.srcSetCount += 1;
    }

    get src(): string {
      return this.srcValue;
    }
  }

  let html = "";
  let clickHandler:
    | ((event: {
        preventDefault: () => void;
        target: { closest: (selector: string) => { getAttribute: (name: string) => string | null; tagName: string } | null };
      }) => void)
    | null = null;

  const iframes: FakeLiveFrame[] = [];
  const stage = new FakeElement("main", { left: 0, top: 100, right: 1000, bottom: 780, width: 1000, height: 680 });
  const body = new FakeElement("body");
  const app = new FakeElement("div");

  function mountsFromHtml(): FakeElement[] {
    const mounts: FakeElement[] = [];
    const re = /data-live-stream-id="([^"]+)" data-live-stream-url="([^"]+)" data-live-stream-title="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
      const mount = new FakeElement("div", { left: 120, top: 160, right: 760, bottom: 520, width: 640, height: 360 });
      mount.setAttribute("data-live-stream-id", match[1] ?? "");
      mount.setAttribute("data-live-stream-url", match[2] ?? "");
      mount.setAttribute("data-live-stream-title", match[3] ?? "");
      mounts.push(mount);
    }
    return mounts;
  }

  Object.defineProperty(app, "innerHTML", {
    get: () => html,
    set: (value: string) => {
      html = value;
    }
  });
  Object.assign(app, {
    addEventListener: (event: string, handler: typeof clickHandler) => {
      if (event === "click") clickHandler = handler;
    },
    contains: () => true,
    querySelector: (selector: string) => (selector === ".stage" ? stage : null),
    querySelectorAll: (selector: string) => (selector === "[data-live-stream-id]" ? mountsFromHtml() : [])
  });

  const documentElement = new FakeElement("html");
  Object.assign(documentElement, {
    setAttribute: () => {},
    style: { setProperty: () => {} }
  });

  const location = {
    hash: "",
    href: "file:///tmp/humanish/observer/index.html",
    protocol: "file:"
  };
  const sandbox = {
    document: {
      activeElement: null,
      addEventListener: () => {},
      body,
      createElement: (tagName: string) => {
        const element = new FakeElement(tagName);
        if (tagName === "iframe") iframes.push(element as FakeLiveFrame);
        return element;
      },
      documentElement,
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
      innerHeight: 900,
      innerWidth: 1200,
      localStorage: { getItem: () => null, setItem: () => {} },
      location,
      requestAnimationFrame: (callback: () => void) => {
        callback();
        return 1;
      },
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      }
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
    html: () => html,
    iframes
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
      // Title + brand of the redesigned mission-control shell.
      expect(html).toContain("Humanish Observer");
      // Embedded observer-data carries the lane status verbatim.
      expect(html).toContain("contract_proof_only");
      expect(html).toContain('id="observer-data"');
      // Structural markers of the redesigned surfaces (rendered by the client).
      expect(html).toContain("focus-rail");
      expect(html).toContain("statusbar");
      expect(html).toContain("Run console");
      expect(html).toContain("tile-surface");

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

  it("renders multi-surface browser lab metadata without hiding live and screenshot modes", () => {
    const client = renderObserverClientForTest(browserLabObserverData());

    expect(client.html()).toContain('data-live-stream-id="lane-01"');
    expect(client.html()).toContain('data-live-stream-url="https://stream.example/it-tools"');
    expect(client.html()).toContain("connecting live stream");
    expect(client.html()).not.toContain("<iframe");

    client.click("media:screenshot");

    expect(client.html()).toContain('src="../screenshots/oss-01-desktop.png"');
    expect(client.html()).not.toContain('class="bw-lab-dock"');

    client.click("open:lane-01");

    expect(client.html()).toContain("viewing fallback");
    expect(client.html()).toContain('data-kind="app"');
    expect(client.html()).toContain('data-kind="observer"');
    expect(client.html()).toContain('data-kind="completion"');
    expect(client.html()).toContain('data-kind="meaningful-use"');
    expect(client.html()).toContain('data-kind="terminal"');
    expect(client.html()).toContain('data-kind="screenshot"');
    expect(client.html()).toContain('data-kind="artifact"');
    expect(client.html()).toContain("nested observer: ready");

    client.click("tab:files");

    expect(client.html()).toContain("setup quality");
    expect(client.html()).toContain("setup-quality/oss-01-desktop-setup-quality.json");
    expect(client.html()).toContain("Static file view cannot hydrate artifacts inline");
  });

  it("renders generic lane grouping metadata in the toolbar", () => {
    const client = renderObserverClientForTest({
      ...browserLabObserverData(),
      laneGroups: [
        { roleId: "role-a", simId: "sim-01", streamId: "lane-01", status: "passed", actorType: "viewer", surface: "review-queue", caseGroup: "case-001" },
        { roleId: "role-b", simId: "sim-02", streamId: "lane-02", status: "passed", actorType: "viewer", surface: "review-queue", caseGroup: "case-001" },
        { roleId: "role-c", simId: "sim-03", streamId: "lane-03", status: "blocked", actorType: "manager", surface: "dashboard", caseGroup: "case-001" }
      ]
    });

    expect(client.html()).toContain('class="lane-groups"');
    expect(client.html()).toContain('data-lane-group="actorType"');
    expect(client.html()).toContain('title="actorType: viewer (2)"');
    expect(client.html()).toContain('title="surface: review-queue (2)"');
    expect(client.html()).toContain('title="caseGroup: case-001 (3)"');
    expect(client.html()).toContain("manager");
    expect(client.html()).not.toContain("provider");
    expect(client.html()).not.toContain("patient");
  });

  it("projects Codex app-server trace metadata into chips, event lanes, and artifact links", () => {
    const client = renderObserverClientForTest(codexAppServerTraceObserverData(), "#focus=codex-lane-01");

    expect(client.html()).toContain('data-cx-chip="status"');
    expect(client.html()).toContain("responding");
    expect(client.html()).toContain('data-cx-chip="thread"');
    expect(client.html()).toContain("thread-public-safe-01");
    expect(client.html()).toContain('data-cx-chip="turn"');
    expect(client.html()).toContain("turn-public-safe-02");
    expect(client.html()).toContain('data-cx-chip="model"');
    expect(client.html()).toContain("gpt-5-codex-test");
    expect(client.html()).toContain('data-cx-chip="service"');
    expect(client.html()).toContain("codex-app-server");

    expect(client.html()).toContain('data-cx-kind="message"');
    expect(client.html()).toContain('data-cx-kind="reasoning"');
    expect(client.html()).toContain('data-cx-kind="tool"');
    expect(client.html()).toContain('data-cx-kind="file"');
    expect(client.html()).toContain('data-cx-kind="command"');
    expect(client.html()).toContain("Synthetic request to inspect a public fixture.");
    expect(client.html()).toContain("Planning a bounded observer projection check.");
    expect(client.html()).toContain("read_fixture");
    expect(client.html()).toContain("pnpm vitest run tests/observer.test.ts");

    expect(client.html()).toContain('class="cx-artifact"');
    expect(client.html()).toContain('href="../traces/codex-app-server-public-trace.json"');
  });

  it("keeps Codex UI fallback receipts when no app-server trace metadata exists", () => {
    const client = renderObserverClientForTest(codexNoTraceObserverData(), "#focus=codex-lane-01");

    expect(client.html()).toContain("codex-app-server session contract");
    expect(client.html()).toContain("state: not_connected");
    expect(client.html()).toContain("receipts: planned");
    expect(client.html()).toContain('data-cx-chip="status"');
    expect(client.html()).toContain('data-cx-chip="service"');
    expect(client.html()).not.toContain('class="cx-lanes"');
  });

  it("keeps live stream iframe parents stable across observer rerenders", () => {
    const client = renderObserverClientWithDomForTest(browserLabObserverData());

    expect(client.iframes).toHaveLength(1);
    const frame = client.iframes[0]!;
    const frameParent = frame.parentNode;
    const host = frameParent?.parentNode;

    client.click("toggle-console");
    client.click("open:lane-01");
    client.click("toggle-side");
    client.click("toggle-tweaks");

    expect(client.iframes).toHaveLength(1);
    expect(client.iframes[0]).toBe(frame);
    expect(frame.parentNode).toBe(frameParent);
    expect(frameParent?.parentNode).toBe(host);
    expect(frame.src).toBe("https://stream.example/it-tools");
    expect(frame.srcSetCount).toBe(1);
    const overlay = frameParent?.children?.[1];
    expect(overlay?.innerHTML).toContain('data-kind="app"');
    expect(overlay?.innerHTML).toContain('data-kind="observer"');
    expect(overlay?.innerHTML).toContain('data-kind="screenshot"');
  });

  it("keeps focus details reachable on constrained viewports", () => {
    const css = observerCss();

    expect(css).toContain("@media (max-width: 860px)");
    expect(css).toContain(".focus { display: block; height: 100%; min-height: 0; overflow-y: auto; }");
    expect(css).toContain(".focus-side {");
    expect(css).toContain("position: relative; left: auto; right: auto; bottom: auto; top: auto;");
    expect(css).toContain('.focus[data-side="collapsed"] .focus-side { display: none; }');
    expect(css).toContain('.focus-side[data-sheet="open"], .focus-side[data-sheet="closed"] { transform: none; }');
  });

  it("opens focus view directly from a focus hash", () => {
    const client = renderObserverClientForTest(browserLabObserverData(), "#focus=lane-01");

    expect(client.html()).toContain('class="focus"');
    expect(client.html()).toContain('class="focus-stage"');
    expect(client.html()).toContain('class="focus-side"');
    expect(client.html()).toContain("Agent Logs");
    expect(client.html()).toContain("Codex agent log");
    expect(client.html()).toContain("Created app-specific personas");
    expect(client.html()).toContain("Meaningful Use");
    expect(client.html()).toContain("partial 78/100");
    expect(client.html()).toContain("Study-quality rating was ceremonial.");
    expect(client.html()).toContain("Lifecycle");
    expect(client.html()).toContain("Scenario");
    expect(client.html()).not.toContain("<span class=\"eyebrow\">Goal</span>");
    expect(client.html()).not.toContain("Filter lanes");
    expect(client.html()).toContain("focus-toolbar");
  });

  it("collapses focus sidebars with keyboard shortcuts when not typing", () => {
    const client = renderObserverClientForTest(browserLabObserverData(), "#focus=lane-01");

    client.key("[");
    expect(client.html()).toContain('data-rail="collapsed"');

    client.key("]");
    expect(client.html()).toContain('data-side="collapsed"');
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
        expect(Buffer.from(await screenshotResponse.arrayBuffer()).subarray(0, 8)).toEqual(PNG_1X1.subarray(0, 8));
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
