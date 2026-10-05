import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStudy } from "../../src/study/config.js";
import type { StudyConfig } from "../../src/study/types.js";
import { runStudyWith } from "../../src/run-study.js";
import { routeOf } from "../../src/study/plan.js";
import * as synthetic from "../../src/run/dry-run.js";
import { runScripted, runSharedWorld, runTerminal } from "../helpers/route-run.js";

const fixtures = JSON.parse(
  await readFile(new URL("../fixtures/task-route-preflight/labs.json", import.meta.url), "utf8"),
) as Array<{
  name: string;
  config: Record<string, unknown>;
  supported: boolean;
  route: string;
}>;
const tasks = [
  {
    id: "inspect",
    goal: "TASK_ONLY_SENTINEL",
    success: { any: [{ textIncludes: "HIDDEN_SUCCESS_SENTINEL" }] },
  },
];
function validConfig(raw: Record<string, unknown>): StudyConfig {
  const parsed = parseStudy(raw);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("declared task protocol admission", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-task-preflight-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(fixtures)(
    "preserves mission-only $name and enforces its actual protocol support",
    ({ config, supported, route }) => {
      expect(routeOf(validConfig(config))).toBe(route);
      const declared = structuredClone(config);
      (declared.actor as Record<string, unknown>).tasks = tasks;
      const result = parseStudy(declared);
      expect(result.ok, JSON.stringify(result)).toBe(supported);
      if (result.ok) expect(result.config.actor.tasks).toEqual(tasks);
      else {
        expect(result.error.code).toBe("HUMANISH_STUDY_INVALID");
        expect(result.error.message).toContain("actor.tasks is unsupported");
        expect(result.error.message).not.toMatch(/TASK_ONLY_SENTINEL|HIDDEN_SUCCESS_SENTINEL/);
      }
    },
  );

  it.each(fixtures.filter(({ supported }) => !supported))(
    "refuses live runStudy $name before any runner side effect",
    async ({ config }) => {
      const parsed = validConfig(config);
      parsed.actor.tasks = tasks; // Direct library caller bypasses parse.
      const forbidden = vi.fn(async () => {
        throw new Error("provider/user hook forbidden");
      });
      const generic = [vi.spyOn(synthetic, "runDryRun")];
      for (const spy of generic) spy.mockImplementation(forbidden);
      const output = path.join(cwd, "must-not-exist");
      const outcome = await runStudyWith(
        parsed,
        { cwd: output, dryRun: false, env: {} },
        {
          desktopModule: forbidden,
          runSession: forbidden,
          runScriptedSession: forbidden,
          renderObserver: forbidden,
        },
      );
      expect(outcome.route).toBe(routeOf(parsed));
      expect(outcome.result.ok).toBe(false);
      expect(outcome.result.error).toMatchObject({ code: "HUMANISH_STUDY_TASKS_UNSUPPORTED" });
      expect(JSON.stringify(outcome.result)).not.toMatch(
        /TASK_ONLY_SENTINEL|HIDDEN_SUCCESS_SENTINEL/,
      );
      expect(forbidden).not.toHaveBeenCalled();
      for (const spy of generic) expect(spy).not.toHaveBeenCalled();
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(cwd)).toEqual([]);
    },
  );

  it.each([
    ["shared-world", runSharedWorld],
    ["terminal", runTerminal],
    ["scripted", runScripted],
  ] as const)(
    "direct %s entry refuses tasks even when given a CUA-shaped config",
    async (_route, runner) => {
      const config = validConfig(fixtures.find((row) => row.supported)!.config);
      config.actor.tasks = tasks;
      const result = await runner({ cwd: path.join(cwd, "must-not-exist"), config, dryRun: false });
      expect(result.error?.code).toBe("HUMANISH_STUDY_TASKS_UNSUPPORTED");
      await expect(access(path.join(cwd, "must-not-exist"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(cwd)).toEqual([]);
    },
  );
});
