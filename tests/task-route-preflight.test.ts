import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import { runCuaActorLab } from "../src/cua-actor-lab.js";
import { runSharedWorldLab } from "../src/shared-world-lab.js";
import { runConcurrentSharedWorld } from "../src/concurrent-shared-world-lab.js";
import { runTerminalProductLab } from "../src/e2b-terminal-lab.js";
import { runScriptedBrowserLab } from "../src/scripted-browser-lab.js";
import * as synthetic from "../src/run.js";
import * as smoke from "../src/oss-lab.js";
import * as meta from "../src/oss-meta-lab.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/task-route-preflight/labs.json", import.meta.url), "utf8")) as Array<{
  name: string; config: LabConfig; supported: boolean; backend: string;
}>;
const tasks = [{ id: "inspect", goal: "TASK_ONLY_SENTINEL", success: { any: [{ textIncludes: "HIDDEN_SUCCESS_SENTINEL" }] } }];
function validConfig(raw: LabConfig): LabConfig {
  const parsed = parseLabConfig(raw);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("declared task protocol admission", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-task-preflight-")); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(cwd, { recursive: true, force: true }); });

  it.each(fixtures)("preserves mission-only $name and enforces its actual protocol support", ({ config, supported, backend }) => {
    expect(selectLabBackend(validConfig(config))).toBe(backend);
    const declared = structuredClone(config);
    declared.actors[0]!.tasks = tasks;
    const result = parseLabConfig(declared);
    expect(result.ok, JSON.stringify(result)).toBe(supported);
    if (result.ok) expect(result.config.actors[0]!.tasks).toEqual(tasks);
    else {
      expect(result.error.code).toBe("HUMANISH_LAB_INVALID");
      expect(result.error.message).toContain("actors[0].tasks is unsupported");
      expect(result.error.message).not.toMatch(/TASK_ONLY_SENTINEL|HIDDEN_SUCCESS_SENTINEL/);
    }
  });

  it.each(fixtures.filter(({ supported }) => !supported))("refuses live runLab $name before any runner side effect", async ({ config, backend }) => {
    const parsed = validConfig(config);
    parsed.actors[0]!.tasks = tasks; // Direct library caller bypasses parse.
    const forbidden = vi.fn(async () => { throw new Error("provider/user hook forbidden"); });
    const generic = [vi.spyOn(synthetic, "runDryRun"), vi.spyOn(smoke, "runOssLab"), vi.spyOn(meta, "runOssMetaLab")];
    for (const spy of generic) spy.mockImplementation(forbidden);
    const output = path.join(cwd, "must-not-exist");
    const hooks = { env: {}, loadDesktopModule: forbidden, runSession: forbidden, buildExecutor: forbidden,
      buildProvider: forbidden, renderObserverFn: forbidden };
    const outcome = await runLab(parsed, { cwd: output, dryRun: false,
      cuaHooks: hooks, sharedWorldHooks: hooks, terminalHooks: hooks, scriptedHooks: hooks });
    expect(outcome.backend).toBe(backend);
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toMatchObject({ code: "HUMANISH_LAB_TASKS_UNSUPPORTED" });
    expect(JSON.stringify(outcome.result)).not.toMatch(/TASK_ONLY_SENTINEL|HIDDEN_SUCCESS_SENTINEL/);
    expect(forbidden).not.toHaveBeenCalled();
    for (const spy of generic) expect(spy).not.toHaveBeenCalled();
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each([
    ["shared-world", runSharedWorldLab], ["concurrent-shared-world", runConcurrentSharedWorld],
    ["terminal", runTerminalProductLab], ["scripted", runScriptedBrowserLab]
  ] as const)("direct %s entry refuses tasks even when given a CUA-shaped config", async (_backend, runner) => {
    const config = validConfig(fixtures.find((row) => row.supported)!.config);
    config.actors[0]!.tasks = tasks;
    const result = await runner({ cwd: path.join(cwd, "must-not-exist"), config, dryRun: false });
    expect(result.error?.code).toBe("HUMANISH_LAB_TASKS_UNSUPPORTED");
    await expect(access(path.join(cwd, "must-not-exist"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("rejects ignored later-actor tasks at parse and direct CUA admission", async () => {
    const config = validConfig(fixtures.find((row) => row.supported)!.config);
    config.actors.push({ type: "openai-computer-use", tasks });
    const parsed = parseLabConfig(config);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("Multiple actors are not supported");
    const result = await runCuaActorLab({ cwd: path.join(cwd, "must-not-exist"), config, dryRun: false });
    expect(result.error).toMatchObject({ code: "HUMANISH_LAB_TASKS_UNSUPPORTED", message: expect.stringContaining("actors[1].tasks") });
    await expect(access(path.join(cwd, "must-not-exist"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(cwd)).toEqual([]);
  });
});
