import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { COMMS_PROVIDERS, type CommsSetupStatus } from "../../src/comms-connections.js";
import type { TuiOptions } from "../../src/tui-contract.js";
import { App } from "../src/app.js";
import { KEY, normalizeFrame, renderToText } from "../src/testing/render-to-text.js";

function setup(overrides: Partial<CommsSetupStatus> = {}): CommsSetupStatus {
  return { schema: "humanish.comms-setup.v1", ok: true, configPath: ".humanish/local/comms.yaml", providers: COMMS_PROVIDERS,
    connections: [], credential: { present: false, source: null, stored: false, strict: false, explicitlyEmpty: false },
    message: "Checks are local. Authentication has not been verified.", ...overrides };
}
function options(read = async () => setup(), save = async () => ({ ok: true, message: "Connection saved." })): TuiOptions {
  return { cwd: "/projects/example-app", version: { cli: "9.9.9" }, stdin: process.stdin, stdout: process.stdout,
    capabilities: {
      comms: { read, save },
      readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/example-app", runs: [], unreadable: [] }),
      listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/example-app", labs: [], warnings: [] }),
      readProjectState: () => ({ schema: "humanish.tui-project.v1", initialized: true, hasRuntime: false }),
      readLabSummary: async () => null, readRunDetail: async () => null, readLaunchLog: async () => "",
      startRun: async () => ({ ok: false, error: { code: "HUMANISH_LAUNCH_FAILED", message: "not used" } }),
      openObserver: async () => ({ schema: "humanish.tui-action.v1", ok: true, message: "not used" }),
      stopRun: async () => ({ schema: "humanish.tui-action.v1", ok: true, message: "not used" }),
      initProject: async () => ({ schema: "humanish.tui-action.v1", ok: true, message: "not used" }),
      reclaimRun: async () => ({ schema: "humanish.reclaim-result.v1", ok: true, cwd: "/x", runId: "r", receiptCount: 0, outcomes: [], warnings: [] })
    } };
}

async function golden(name: string, frame: string) {
  const file = path.join(import.meta.dirname, "golden", `${name}.txt`);
  const text = normalizeFrame(frame);
  if (process.env.UPDATE_TUI_GOLDENS === "1") await writeFile(file, text + "\n");
  expect(text).toBe((await readFile(file, "utf8")).trimEnd());
}

describe("Connections", () => {
  it.each([80, 45])("is discoverable, readable and returns to the prior screen at %i columns", async columns => {
    const keyEntry = vi.fn();
    const surface = await renderToText(<App options={options()} onKeyEntry={keyEntry} />, { columns, until: frame => frame.includes("c connections") });
    try {
      const frame = await surface.press("c", frame => frame.includes("Add API key"));
      await golden(`connections-missing-${columns}`, frame);
      expect(normalizeFrame(frame).split("\n").every(line => line.length <= columns)).toBe(true);
      expect(frame).toMatch(/not available\s+yet/);
      await surface.press(KEY.escape, frame => frame.includes("no labs here yet"));
      expect(keyEntry).not.toHaveBeenCalled();
    } finally { surface.unmount(); }
  });
  it.each([80, 45])("resumes with saved setup and truthful provider status at %i columns", async columns => {
    const opts = options(async () => setup({ connections: [{ name: "agentmail", provider: "agentmail", apiKeyEnv: "AGENTMAIL_API_KEY" }],
      credential: { present: true, source: "~/.config/humanish/keys.env", stored: true, strict: false, explicitlyEmpty: false } }));
    opts.initialScreen = "connections";
    opts.connectionNotice = "Key stored. Project connection saved.";
    const surface = await renderToText(<App options={opts} />, { columns, until: frame => frame.includes("Replace stored key") });
    try {
      await golden(`connections-saved-${columns}`, surface.last);
      expect(normalizeFrame(surface.last).split("\n").length).toBeLessThanOrEqual(24);
      expect(surface.last).toContain("authentication: not checked");
      expect(surface.last).not.toContain("Env and project keys");
    } finally { surface.unmount(); }
  });
  it("requests host-owned key entry without accepting a credential through the view", async () => {
    const keyEntry = vi.fn();
    const opts = { ...options(), initialScreen: "connections" as const };
    const surface = await renderToText(<App options={opts} onKeyEntry={keyEntry} />, { until: frame => frame.includes("Add API key") });
    try {
      await surface.press(KEY.enter, () => keyEntry.mock.calls.length === 1);
      expect(keyEntry).toHaveBeenCalledOnce();
      expect(keyEntry).toHaveBeenCalledWith();
    } finally { surface.unmount(); }
  });
  it("uses an existing credential without requesting or rewriting its value", async () => {
    const save = vi.fn(async () => ({ ok: true, message: "Connection saved." }));
    const keyEntry = vi.fn();
    const opts = options(async () => setup({ credential: { present: true, source: "process env", stored: false, strict: false, explicitlyEmpty: false } }), save);
    opts.initialScreen = "connections";
    const surface = await renderToText(<App options={opts} onKeyEntry={keyEntry} />, { until: frame => frame.includes("Use this key") });
    try {
      await surface.press(KEY.down, frame => frame.includes("❯ Use this key"));
      await surface.press(KEY.enter, frame => frame.includes("Connection saved."));
      expect(save).toHaveBeenCalledOnce();
      expect(keyEntry).not.toHaveBeenCalled();
    } finally { surface.unmount(); }
  });
  it("shows strict-mode and empty-env explanations instead of claiming a saved key is active", async () => {
    for (const explicitlyEmpty of [false, true]) {
      const opts = options(async () => setup({ credential: { present: false, source: null, stored: true, strict: true, explicitlyEmpty } }));
      opts.initialScreen = "connections";
      const surface = await renderToText(<App options={opts} />, { columns: 45, until: frame => frame.includes("Replace stored key") });
      try { expect(surface.last).toContain(explicitlyEmpty ? "empty AGENTMAIL_API_KEY" : "Strict key mode"); }
      finally { surface.unmount(); }
    }
  });
  it("keeps malformed configuration visible and offers recheck without a writing action", async () => {
    const keyEntry = vi.fn();
    const opts = options(async () => setup({ ok: false, message: "Could not read connection setup." }));
    opts.initialScreen = "connections";
    const surface = await renderToText(<App options={opts} onKeyEntry={keyEntry} />, { until: frame => frame.includes("Could not read connection") });
    try {
      expect(surface.last).not.toContain("Add API key");
      expect(surface.last).toContain("Recheck local setup");
      expect(keyEntry).not.toHaveBeenCalled();
    } finally { surface.unmount(); }
  });
});
