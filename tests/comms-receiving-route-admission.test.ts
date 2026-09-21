import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import { runSharedWorldLab } from "../src/shared-world-lab.js";
import { runTerminalProductLab } from "../src/e2b-terminal-lab.js";
import { runScriptedBrowserLab } from "../src/scripted-browser-lab.js";
import * as synthetic from "../src/run.js";
import * as smoke from "../src/oss-lab.js";
import * as meta from "../src/oss-meta-lab.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/task-route-preflight/labs.json", import.meta.url), "utf8")) as Array<{
  name: string; config: LabConfig; backend: string;
}>;
function baseline(raw: LabConfig): LabConfig {
  const result = parseLabConfig(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}
/** Direct callers construct typed runtime configs; no parser call may rescue an inert backend. */
function receiving(config: LabConfig): LabConfig {
  return Object.assign(config, { comms: { email: { kind: "real", connection: "mail" } } });
}
const unsupported = fixtures.filter(row => !["cua", "concurrent-shared-world"].includes(row.backend));

describe("real receiving admission on non-receiving backends", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-receiving-admission-")); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(cwd, { recursive: true, force: true }); });

  it.each(unsupported)("refuses runLab $name before runtime hooks or filesystem allocation", async ({ config, backend }) => {
    const resolved = receiving(baseline(config));
    expect(selectLabBackend(resolved)).toBe(backend);
    const forbidden = vi.fn(async () => { throw new Error("must not invoke runtime"); });
    const generic = [vi.spyOn(synthetic, "runDryRun"), vi.spyOn(smoke, "runOssLab"), vi.spyOn(meta, "runOssMetaLab")];
    for (const spy of generic) spy.mockImplementation(forbidden);
    const hooks = { env: {}, loadDesktopModule: forbidden, runSession: forbidden, renderObserverFn: forbidden };
    const output = path.join(cwd, "must-not-exist");
    for (const dryRun of [false, true]) {
      const outcome = await runLab(resolved, { cwd: output, dryRun, sharedWorldHooks: hooks, terminalHooks: hooks, scriptedHooks: hooks });
      expect(outcome.backend).toBe(backend);
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.error?.message).toMatch(/Real email receiving is unsupported/);
      if (["synthetic", "smoke", "meta"].includes(backend)) {
        expect(outcome.result.error?.code).toBe("HUMANISH_LAB_COMMS_UNSUPPORTED");
      }
    }
    expect(forbidden).not.toHaveBeenCalled();
    for (const spy of generic) expect(spy).not.toHaveBeenCalled();
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each([
    ["sequential shared-world", runSharedWorldLab, "HUMANISH_SHARED_WORLD_LAB_INVALID"],
    ["terminal", runTerminalProductLab, "HUMANISH_TERMINAL_LAB_SUBJECT_INVALID"],
    ["scripted", runScriptedBrowserLab, "HUMANISH_SCRIPTED_LAB_SCENARIO_INVALID"]
  ] as const)("refuses direct %s even when the config describes a supported CUA route", async (_name, runner, code) => {
    const source = fixtures.find(row => row.name === "cua-openai-computer-use-app-url")!;
    const config = receiving(baseline(source.config));
    const forbidden = vi.fn(async () => { throw new Error("must not invoke runtime"); });
    for (const dryRun of [false, true]) {
      const result = await runner({ cwd: path.join(cwd, "must-not-exist"), config, dryRun,
        hooks: { env: {}, loadDesktopModule: forbidden, runSession: forbidden, renderObserverFn: forbidden } });
      expect(result).toMatchObject({ ok: false, runId: "not-created", error: { code, message: expect.stringContaining("Real email receiving is unsupported") } });
    }
    expect(forbidden).not.toHaveBeenCalled();
    expect(await readdir(cwd)).toEqual([]);
  });
});
