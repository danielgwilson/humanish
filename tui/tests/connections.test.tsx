import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { COMMS_PROVIDERS, type CommsSetupStatus } from "../../src/comms-connections.js";
import type { TuiCapabilities, TuiOptions } from "../../src/tui-contract.js";
import type { CommsCheckResult } from "../../src/comms-setup.js";
import type { CommsRecoveryEntry } from "../../src/comms-receiving.js";
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

function receivingOptions(capabilities: Partial<NonNullable<TuiCapabilities["comms"]>> = {}): TuiOptions {
  const opts = options(async () => setup({ connections: [{ name: "agentmail", provider: "agentmail", apiKeyEnv: "AGENTMAIL_API_KEY" }],
    credential: { present: true, source: "~/.config/humanish/keys.env", stored: true, strict: false, explicitlyEmpty: false } }));
  opts.initialScreen = "connections";
  opts.capabilities.comms = { ...opts.capabilities.comms!,
    check: async () => ({ schema: "humanish.comms-check.v1", ok: true, connection: "agentmail", online: true, credentialPresent: true, authenticated: true, ready: null,
      permissions: "unknown", capacity: "unknown", checkedAt: "2026-09-20T12:00:00Z", code: "authenticated", message: "Authentication passed. Inbox permissions, capacity and delivery are still untested. No resources were created." }),
    labs: async () => [{ title: "Signup", path: "humanish/labs/signup.yaml" }],
    configure: async (_lab, apply) => ({ schema: "humanish.comms-configure.v1", ok: true, applied: apply, message: apply ? "Saved." : "Preview.", path: ".humanish/local/labs/signup-receiving.yaml", planToken: "safe-plan-token", connection: "agentmail" }),
    recovery: async () => [], recover: async () => ({ ok: true, message: "Cleanup completed." }), ...capabilities };
  return opts;
}
function recoveryEntry(overrides: Partial<CommsRecoveryEntry> = {}): CommsRecoveryEntry {
  return { id: "journal-local", runId: "study-20260920-a", connectionName: "agentmail", status: "unresolved", participantCount: 2, unresolvedCount: 2, activeOwner: false, ...overrides };
}
function readable(frame: string, columns: number): void {
  const lines = normalizeFrame(frame).split("\n");
  expect(lines.every(line => line.length <= columns)).toBe(true);
  expect(lines.length).toBeLessThanOrEqual(24);
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

describe("Receiving setup and cleanup", () => {
  it("shows the host's cached authentication result after hidden key entry without another network check", async () => {
    const opts = receivingOptions();
    const result = await opts.capabilities.comms!.check!();
    const priorRead = opts.capabilities.comms!.read;
    opts.capabilities.comms!.read = async () => ({ ...await priorRead(), authentication: result });
    const check = vi.fn(opts.capabilities.comms!.check!); opts.capabilities.comms!.check = check;
    opts.connectionNotice = "Key saved. Authentication passed.";
    const surface = await renderToText(<App options={opts} />, { columns: 45, until: frame => frame.includes("Provider authentication: passed") });
    try { readable(surface.last, 45); expect(check).not.toHaveBeenCalled(); }
    finally { surface.unmount(); }
  });
  it.each([80, 45])("checks authentication explicitly and keeps acquisition claims separate at %i columns", async columns => {
    const base = receivingOptions();
    const check = vi.fn(base.capabilities.comms!.check!);
    const opts = receivingOptions({ check });
    const surface = await renderToText(<App options={opts} />, { columns, until: frame => frame.includes("Use real email in a lab") });
    try {
      expect(check).not.toHaveBeenCalled();
      await golden(`connections-receiving-${columns}`, surface.last); readable(surface.last, columns);
      await surface.press(KEY.down, frame => frame.includes("❯ Test authentication"));
      const frame = await surface.press(KEY.enter, frame => frame.includes("Authentication: passed") && !frame.includes("Working…"));
      await golden(`connections-check-${columns}`, frame); readable(frame, columns);
      expect(check).toHaveBeenCalledOnce(); expect(frame).toContain("permissions: unknown"); expect(frame).toContain("delivery: untested");
      expect(frame).not.toContain("ready");
      await surface.press(KEY.escape, frame => frame.includes("Provider authentication: passed"));
    } finally { surface.unmount(); }
  });

  it.each([80, 45])("previews and saves the exact selected path with the host plan token at %i columns", async columns => {
    const base = receivingOptions();
    const configure = vi.fn(base.capabilities.comms!.configure!);
    const opts = receivingOptions({ configure });
    const surface = await renderToText(<App options={opts} />, { columns, until: frame => frame.includes("Use real email in a lab") });
    const realNow = Date.now.bind(Date); let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      await surface.press(KEY.down); await surface.press(KEY.down, frame => frame.includes("❯ Use real email"));
      await surface.press(KEY.enter, frame => frame.includes("Choose a lab"));
      const preview = await surface.press(KEY.enter, frame => frame.includes("Save email-enabled lab") && !frame.includes("Working…"));
      await golden(`connections-preview-${columns}`, preview); readable(preview, columns);
      expect(configure).toHaveBeenCalledExactlyOnceWith("humanish/labs/signup.yaml", false);
      expect(preview).toContain("Mail is hosted."); expect(preview).toContain("restricted for sharing");
      expect(preview).not.toContain("safe-plan-token");
      offset = 500;
      const saved = await surface.press(KEY.enter, frame => frame.includes("Email lab saved") && !frame.includes("Working…"));
      await golden(`connections-applied-${columns}`, saved); readable(saved, columns);
      expect(configure).toHaveBeenLastCalledWith("humanish/labs/signup.yaml", true, "safe-plan-token");
      expect(normalizeFrame(saved).replaceAll("\n", "")).toContain(".humanish/local/labs/signup-receiving.yaml");
    } finally { clock.mockRestore(); surface.unmount(); }
  });

  it("does not write a lab on cancel and forces a new preview after stale-plan failure", async () => {
    const configure = vi.fn(receivingOptions().capabilities.comms!.configure!);
    const opts = receivingOptions({ configure });
    const surface = await renderToText(<App options={opts} />, { until: frame => frame.includes("Use real email in a lab") });
    const realNow = Date.now.bind(Date); let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      await surface.press(KEY.down); await surface.press(KEY.down); await surface.press(KEY.enter, frame => frame.includes("Choose a lab"));
      await surface.press(KEY.enter, frame => frame.includes("Save email-enabled lab"));
      await surface.press(KEY.escape, frame => frame.includes("Choose a lab"));
      expect(configure.mock.calls.every(call => call[1] === false)).toBe(true);
      await surface.press(KEY.enter, frame => frame.includes("Save email-enabled lab"));
      configure.mockResolvedValueOnce({ schema: "humanish.comms-configure.v1", ok: false, applied: false, message: "Files changed. Preview again." });
      offset = 500;
      await surface.press(KEY.enter, frame => frame.includes("Files changed. Preview again."));
      expect(surface.frames.at(-1)).not.toContain("Save lab copy");
      await surface.press(KEY.enter, frame => frame.includes("Save email-enabled lab"));
      expect(configure).toHaveBeenLastCalledWith("humanish/labs/signup.yaml", false);
    } finally { clock.mockRestore(); surface.unmount(); }
  });

  it.each([true, null])("blocks cleanup when ownership is %s and does not expose resource identities", async activeOwner => {
    const recover = vi.fn(async () => ({ ok: true, message: "should not run" }));
    const opts = receivingOptions({ recovery: async () => [recoveryEntry({ activeOwner })], recover });
    const surface = await renderToText(<App options={opts} />, { columns: 45, until: frame => frame.includes("Review inbox cleanup") });
    try {
      await surface.press(KEY.down); await surface.press(KEY.down); await surface.press(KEY.down, frame => frame.includes("❯ Review inbox cleanup"));
      await surface.press(KEY.enter, frame => frame.includes("2 pending"));
      const frame = await surface.press(KEY.enter, frame => frame.includes(activeOwner === true ? "active owner" : "Ownership is unknown"));
      readable(frame, 45);
      expect(frame).not.toContain("Release study inboxes"); expect(frame).not.toContain("journal-local");
      await surface.press(KEY.enter, frame => frame.includes("Inbox cleanup"));
      expect(recover).not.toHaveBeenCalled();
    } finally { surface.unmount(); }
  });

  it.each([80, 45])("shows pending cleanup and applies only the selected run and connection at %i columns", async columns => {
    const entry = recoveryEntry(); let completed = false;
    const recover = vi.fn(async () => { completed = true; return { ok: true, message: "Cleanup confirmed; two inboxes are absent." }; });
    const recovery = vi.fn(async () => completed ? [{ ...entry, unresolvedCount: 0, status: "closed" as const }] : [entry]);
    const opts = receivingOptions({ recovery, recover });
    const surface = await renderToText(<App options={opts} />, { columns, until: frame => frame.includes("Review inbox cleanup") });
    const realNow = Date.now.bind(Date); let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      await surface.press(KEY.down); await surface.press(KEY.down); await surface.press(KEY.down);
      const listed = await surface.press(KEY.enter, frame => frame.includes("2 pending") && !frame.includes("Working…"));
      await golden(`connections-cleanup-${columns}`, listed); readable(listed, columns);
      const review = await surface.press(KEY.enter, frame => frame.includes("Release study inboxes") && !frame.includes("Working…"));
      await golden(`connections-recover-${columns}`, review); readable(review, columns);
      expect(recover).not.toHaveBeenCalled(); offset = 500;
      await surface.press(KEY.enter, frame => frame.includes("No pending inbox cleanup"));
      expect(recover).toHaveBeenCalledExactlyOnceWith("study-20260920-a", "agentmail");
      expect(recovery).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); surface.unmount(); }
  });

  it("keeps unavailable authentication unknown and never prints thrown diagnostic payloads", async () => {
    const result = await receivingOptions().capabilities.comms!.check!();
    const check = vi.fn(async (): Promise<CommsCheckResult> => ({ ...result, ok: false, authenticated: null, ready: null, code: "network", message: "The check could not complete. The saved key was kept." }));
    const surface = await renderToText(<App options={receivingOptions({ check })} />, { until: frame => frame.includes("Test authentication") });
    try {
      await surface.press(KEY.down); await surface.press(KEY.enter, frame => frame.includes("Authentication: unknown"));
      check.mockRejectedValueOnce(new Error("PRIVATE_DIAGNOSTIC_CANARY"));
      const frame = await surface.press(KEY.enter, frame => frame.includes("could not complete"));
      expect(frame).not.toContain("PRIVATE_DIAGNOSTIC_CANARY"); expect(frame).not.toContain("rejected");
    } finally { surface.unmount(); }
  });

  it("ignores repeated confirmation input while selected cleanup is pending", async () => {
    const entry = recoveryEntry(); let completed = false;
    let resolveCleanup: ((value: { ok: boolean; message: string }) => void) | undefined;
    const recover = vi.fn(() => new Promise<{ ok: boolean; message: string }>(resolve => { resolveCleanup = resolve; }));
    const recovery = async () => completed ? [] : [entry];
    const surface = await renderToText(<App options={receivingOptions({ recover, recovery })} />, { until: frame => frame.includes("Review inbox cleanup") });
    const realNow = Date.now.bind(Date); let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      await surface.press(KEY.down); await surface.press(KEY.down); await surface.press(KEY.down);
      await surface.press(KEY.enter, frame => frame.includes("2 pending"));
      await surface.press(KEY.enter, frame => frame.includes("Release study inboxes") && !frame.includes("Working…"));
      offset = 500;
      await surface.press(KEY.enter, frame => frame.includes("Working…"));
      const repeated = surface.press(KEY.enter + KEY.enter, frame => frame.includes("No pending inbox cleanup"));
      expect(recover).toHaveBeenCalledOnce();
      completed = true;
      resolveCleanup!({ ok: true, message: "Cleanup confirmed." }); await repeated;
      expect(recover).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); surface.unmount(); }
  });

  it("windows long lab lists and keeps exact selected paths visible", async () => {
    const labs = Array.from({ length: 30 }, (_, i) => ({ title: `Very long readable study label ${i}`, path: `.humanish/local/labs/study-${i}.yaml` }));
    const surface = await renderToText(<App options={receivingOptions({ labs: async () => labs })} />, { columns: 45, until: frame => frame.includes("Use real email") });
    try {
      await surface.press(KEY.down); await surface.press(KEY.down); const frame = await surface.press(KEY.enter, frame => frame.includes("Choose a lab"));
      expect(frame).toContain("more"); readable(frame, 45);
      for (let i = 1; i <= 18; i++) await surface.press(KEY.down, frame => frame.includes(`study-${i}.yaml`));
      const last = surface.frames.filter(frame => frame.includes("study-18.yaml")).at(-1)!; readable(last, 45);
      expect(last).toContain("↑");
    } finally { surface.unmount(); }
  });
});
