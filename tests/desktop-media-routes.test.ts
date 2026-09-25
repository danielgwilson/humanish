import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { concurrentSharedWorldValidationReason, desktopMediaValidationReason, parseLabConfig, sharedWorldValidationReason, type LabConfig } from "../src/lab-config.js";
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
  ["desktop CLI", c => { c.subject = { source: "desktop-cli", product: { name: "sample-cli", publicSurfaces: ["https://example.com/docs"] } }; }, "computer-use browser lanes"],
  ["in-process app", c => { c.subject.source = "local-app"; c.execution!.target = "local"; }, "computer-use browser lanes"],
  ["scripted browser", c => { c.actors[0]!.type = "scripted-browser"; c.execution!.target = "local"; c.scenario!.ref = "scripted-first-run"; }, "computer-use browser lanes"],
  ["terminal", c => { c.subject = { source: "terminal-product", product: { name: "sample-cli", publicSurfaces: ["https://example.com/docs"] } }; c.actors[0]!.type = "codex-exec"; c.execution!.target = "e2b-terminal"; }, "computer-use browser lanes"]
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

  it.each(["sequential", "concurrent"] as const)("rejects camera declarations in the direct %s shared backend without a topology declaration", async (route) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-media-direct-shared-"));
    const config = structuredClone(base);
    config.subject = {
      source: "clone", repos: ["example-org/collab-app"], exposure: "synthetic",
      serve: { start: "npm start -- --host 0.0.0.0", url: "http://127.0.0.1:3000/" },
      state: { checkpoint: [{ name: "count", command: "echo 0" }] }
    };
    config.actors[0]!.lanes = [{ id: "author", instruction: "Create a note." }, { id: "reader", instruction: "Read a note." }];
    config.execution!.concurrency = route === "concurrent" ? 2 : 1;
    const validate = route === "concurrent" ? concurrentSharedWorldValidationReason : sharedWorldValidationReason;
    const run = route === "concurrent" ? runConcurrentSharedWorld : runSharedWorldLab;
    const loadDesktopModule = vi.fn(async () => { throw new Error("must not create a desktop"); });
    const runSession = vi.fn(async () => { throw new Error("must not dispatch participant"); });
    try {
      // The config is valid for a hosted CUA lane, and all shared-backend structural
      // checks pass. Rejection must come from the actual backend's media support.
      expect(config.subject.topology).toBeUndefined();
      expect(desktopMediaValidationReason(config)).toBeUndefined();
      expect(validate(config)).toBeNull();
      const result = await run({ cwd, config, dryRun: false, hooks: { env: {}, loadDesktopModule, runSession } });
      expect(result.ok).toBe(false);
      expect(result.runId).toBe("not-created");
      expect(result.error?.message).toContain("execution.desktop.media");
      expect(loadDesktopModule).not.toHaveBeenCalled();
      expect(runSession).not.toHaveBeenCalled();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
