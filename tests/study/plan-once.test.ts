// runStudyWith plans each lab once: one planStudy call per run, and one call of the route's own planner,
// on every route and on a local browser study, whose desktop and provider are bound first.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({ planStudy: 0, route: 0 }));

vi.mock("../../src/study/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/study/plan.js")>();
  return {
    ...actual,
    planStudy: (...args: Parameters<typeof actual.planStudy>) => {
      counts.planStudy += 1;
      return actual.planStudy(...args);
    },
  };
});
vi.mock("../../src/routes/terminal/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/terminal/plan.js")>();
  return {
    ...actual,
    planTerminalStudy: (...args: Parameters<typeof actual.planTerminalStudy>) => {
      counts.route += 1;
      return actual.planTerminalStudy(...args);
    },
  };
});
vi.mock("../../src/routes/scripted/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/scripted/plan.js")>();
  return {
    ...actual,
    planScriptedStudy: (...args: Parameters<typeof actual.planScriptedStudy>) => {
      counts.route += 1;
      return actual.planScriptedStudy(...args);
    },
  };
});
vi.mock("../../src/routes/shared-world/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/shared-world/plan.js")>();
  return {
    ...actual,
    planSharedWorldStudy: (...args: Parameters<typeof actual.planSharedWorldStudy>) => {
      counts.route += 1;
      return actual.planSharedWorldStudy(...args);
    },
  };
});
vi.mock("../../src/routes/computer-use/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/computer-use/plan.js")>();
  return {
    ...actual,
    planComputerUseStudy: (...args: Parameters<typeof actual.planComputerUseStudy>) => {
      counts.route += 1;
      return actual.planComputerUseStudy(...args);
    },
  };
});

import { runStudyWith } from "../../src/run-study.js";
import { routeOf } from "../../src/study/plan.js";
import { parseStudyDocument } from "../../src/study/config.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, SCENARIO_YAML, type BaseName, type Patch } from "../admission/fixtures.js";

function parsed(base: BaseName, patch: Patch = {}): StudyConfig {
  const result = parseStudyDocument(lab(base, patch));
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

const runs: readonly (readonly [string, () => StudyConfig, string, number])[] = [
  ["preview", () => parsed("preview"), "synthetic", 0],
  ["computer use", () => parsed("cuAppUrl"), "cua", 1],
  ["scripted", () => parsed("scriptedAppUrl"), "scripted", 1],
  ["terminal", () => parsed("terminal"), "terminal", 1],
  ["shared world", () => parsed("sharedProvisioned"), "concurrent-shared-world", 1],
  ["local browser study", () => parsed("cuAppUrl", { execution: { target: "local" } }), "cua", 1],
];

describe("runStudy plans each study once", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-plan-once-"));
    await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
    counts.planStudy = 0;
    counts.route = 0;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(runs)(
    "%s: one planLab call and one route planner call",
    async (_name, config, _backend, routePlans) => {
      const outcome = await runStudyWith(config(), { cwd, dryRun: true, open: false });
      expect(outcome.route).toBe(routeOf(config()));
      expect((outcome.result as { ok?: boolean }).ok).toBe(true);
      expect(counts.planStudy).toBe(1);
      expect(counts.route).toBe(routePlans);
    },
  );
});
