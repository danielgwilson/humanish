import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStudyDocument } from "../../src/study/config.js";
import { type StudyConfig } from "../../src/study/types.js";
import { runStudyWith } from "../../src/run-study.js";
import { routeOf } from "../../src/study/plan.js";
import { runTerminalProductStudy } from "../../src/routes/terminal/route.js";
import { runScriptedBrowserStudy } from "../../src/routes/scripted/route.js";
import * as synthetic from "../../src/run/dry-run.js";

const fixtures = JSON.parse(
  await readFile(new URL("../fixtures/task-route-preflight/labs.json", import.meta.url), "utf8"),
) as Array<{
  name: string;
  config: StudyConfig;
  route: string;
}>;
function baseline(raw: StudyConfig): StudyConfig {
  const result = parseStudyDocument(raw);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}
/** Direct callers construct typed runtime configs; no parser call may rescue an inert backend. */
function receiving(config: StudyConfig): StudyConfig {
  return Object.assign(config, { comms: { email: { kind: "real", connection: "mail" } } });
}
const unsupported = fixtures.filter((row) => !["computer-use", "shared-world"].includes(row.route));

describe("real receiving admission on non-receiving backends", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-receiving-admission-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(unsupported)(
    "refuses runStudy $name before runtime hooks or filesystem allocation",
    async ({ config, route }) => {
      const resolved = receiving(baseline(config));
      expect(routeOf(resolved)).toBe(route);
      const forbidden = vi.fn(async () => {
        throw new Error("must not invoke runtime");
      });
      const generic = [vi.spyOn(synthetic, "runDryRun")];
      for (const spy of generic) spy.mockImplementation(forbidden);
      const output = path.join(cwd, "must-not-exist");
      for (const dryRun of [false, true]) {
        const outcome = await runStudyWith(
          resolved,
          { cwd: output, dryRun, env: {} },
          {
            desktopModule: forbidden,
            runSession: forbidden,
            runScriptedSession: forbidden,
            renderObserver: forbidden,
          },
        );
        expect(outcome.route).toBe(routeOf(resolved));
        expect(outcome.result.ok).toBe(false);
        expect(outcome.result.error?.message).toMatch(/Real email receiving is unsupported/);
        if (route === "preview") {
          expect(outcome.result.error?.code).toBe("HUMANISH_STUDY_COMMS_UNSUPPORTED");
        }
      }
      expect(forbidden).not.toHaveBeenCalled();
      for (const spy of generic) expect(spy).not.toHaveBeenCalled();
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(cwd)).toEqual([]);
    },
  );

  it.each([
    ["terminal", runTerminalProductStudy, "HUMANISH_TERMINAL_SUBJECT_INVALID"],
    ["scripted", runScriptedBrowserStudy, "HUMANISH_SCRIPTED_SCENARIO_INVALID"],
  ] as const)(
    "refuses direct %s even when the config describes a supported computer-use route",
    async (_name, runner, code) => {
      const source = fixtures.find((row) => row.name === "cua-openai-computer-use-app-url")!;
      const config = receiving(baseline(source.config));
      const forbidden = vi.fn(async () => {
        throw new Error("must not invoke runtime");
      });
      for (const dryRun of [false, true]) {
        const result = await runner({
          cwd: path.join(cwd, "must-not-exist"),
          config,
          dryRun,
          env: {},
          deps: {
            desktopModule: forbidden,
            runScriptedSession: forbidden,
            renderObserver: forbidden,
          },
        });
        expect(result).toMatchObject({
          ok: false,
          runId: "not-created",
          error: { code, message: expect.stringContaining("Real email receiving is unsupported") },
        });
      }
      expect(forbidden).not.toHaveBeenCalled();
      expect(await readdir(cwd)).toEqual([]);
    },
  );
});
