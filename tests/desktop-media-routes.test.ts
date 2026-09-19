import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { desktopMediaValidationReason, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runCuaActorLab } from "../src/cua-actor-lab.js";
import { runSharedWorldLab } from "../src/shared-world-lab.js";
import { runConcurrentSharedWorld } from "../src/concurrent-shared-world-lab.js";
import { runScriptedBrowserLab } from "../src/scripted-browser-lab.js";
import { runTerminalProductLab } from "../src/e2b-terminal-lab.js";

const base: LabConfig = {
  schema: "humanish.lab.v2", id: "camera-route",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actors: [{ type: "openai-computer-use" }],
  execution: { target: "e2b-desktop", desktop: { browser: "chrome", media: { camera: { source: "synthetic" } } } },
  scenario: { mode: "live" }, review: { analysis: false }
};
const cases: Array<[string, (config: LabConfig) => void, string]> = [
  ["shared world", c => {
    c.subject = { source: "clone", topology: "shared-world", repos: ["example-org/collab-app"],
      serve: { start: "npm start", url: "http://127.0.0.1:3000/" }, state: { checkpoint: [{ name: "count", command: "echo 0" }] } };
    c.actors[0]!.lanes = [{ id: "author", instruction: "Create a note." }, { id: "reader", instruction: "Read a note." }];
    c.execution!.concurrency = 1;
  }, "shared-world routes"],
  ["Firefox", c => { c.execution!.desktop!.browser = "firefox"; }, "requires Chrome or Chromium"],
  ["desktop CLI", c => { c.subject = { source: "desktop-cli", product: { name: "sample-cli", publicSurfaces: ["https://example.com/docs"] } }; }, "hosted computer-use browser lanes"],
  ["in-process app", c => { c.subject.source = "local-app"; c.execution!.target = "local"; }, "hosted computer-use browser lanes"],
  ["scripted browser", c => { c.actors[0]!.type = "scripted-browser"; c.execution!.target = "local"; c.scenario!.ref = "scripted-first-run"; }, "hosted computer-use browser lanes"],
  ["terminal", c => { c.subject = { source: "terminal-product", product: { name: "sample-cli", publicSurfaces: ["https://example.com/docs"] } }; c.actors[0]!.type = "codex-exec"; c.execution!.target = "e2b-terminal"; }, "hosted computer-use browser lanes"]
];

describe("declared camera capabilities must reach an implemented route", () => {
  it.each(cases)("rejects %s during manifest parsing", (_label, change, reason) => {
    const config = structuredClone(base); change(config);
    const withoutMedia = structuredClone(config); delete withoutMedia.execution!.desktop!.media;
    const baseline = parseLabConfig(withoutMedia);
    expect(baseline.ok, baseline.ok ? undefined : baseline.error.message).toBe(true);
    expect(desktopMediaValidationReason(config)).toContain(reason);
    const parsed = parseLabConfig(config);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? undefined : parsed.error.message).toContain(reason);
  });

  it("keeps supported Chrome/Chromium and camera-free routes unchanged", () => {
    expect(desktopMediaValidationReason(base)).toBeUndefined();
    for (const [, change] of cases) {
      const config = structuredClone(base); change(config); delete config.execution!.desktop!.media;
      expect(desktopMediaValidationReason(config)).toBeUndefined();
    }
    const config = structuredClone(base); config.execution!.desktop!.browser = "chromium";
    expect(parseLabConfig(config).ok).toBe(true);
  });

  it("rechecks direct backend calls before desktop creation or participant dispatch", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-media-routes-"));
    const loadDesktopModule = vi.fn(async () => { throw new Error("must not create a desktop"); });
    const runSession = vi.fn(async () => { throw new Error("must not dispatch participant"); });
    const hooks = { env: {}, loadDesktopModule, runSession };
    try {
      const firefox = structuredClone(base); firefox.execution!.desktop!.browser = "firefox";
      const shared = structuredClone(base); shared.subject.topology = "shared-world";
      const scripted = structuredClone(base); scripted.actors[0]!.type = "scripted-browser";
      const terminal = structuredClone(base); terminal.subject.source = "terminal-product";
      const outcomes = await Promise.all([
        runCuaActorLab({ cwd, config: firefox, dryRun: false, hooks }),
        runCuaActorLab({ cwd, config: base, dryRun: false, hooks: { ...hooks, buildExecutor: async () => { throw new Error("must not build executor"); } } }),
        runSharedWorldLab({ cwd, config: shared, dryRun: false, hooks }),
        runConcurrentSharedWorld({ cwd, config: shared, dryRun: false, hooks }),
        runScriptedBrowserLab({ cwd, config: scripted, dryRun: false, hooks }),
        runTerminalProductLab({ cwd, config: terminal, dryRun: false, hooks })
      ]);
      for (const result of outcomes) {
        expect(result.ok).toBe(false);
        expect(result.runId).toBe("not-created");
        expect(result.error?.message).toContain("execution.desktop.media");
      }
      expect(loadDesktopModule).not.toHaveBeenCalled();
      expect(runSession).not.toHaveBeenCalled();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
