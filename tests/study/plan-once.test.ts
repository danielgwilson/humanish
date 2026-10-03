// runLab plans each lab once: one planLab call per run, and one call of the route's own planner,
// on every route and on a local browser study, whose desktop and provider are bound first.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({ planLab: 0, route: 0 }));

vi.mock("../../src/study/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/study/plan.js")>();
  return {
    ...actual,
    planLab: (...args: Parameters<typeof actual.planLab>) => {
      counts.planLab += 1;
      return actual.planLab(...args);
    },
  };
});
vi.mock("../../src/routes/terminal/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/terminal/plan.js")>();
  return {
    ...actual,
    planTerminalLab: (...args: Parameters<typeof actual.planTerminalLab>) => {
      counts.route += 1;
      return actual.planTerminalLab(...args);
    },
  };
});
vi.mock("../../src/routes/scripted/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/scripted/plan.js")>();
  return {
    ...actual,
    planScriptedLab: (...args: Parameters<typeof actual.planScriptedLab>) => {
      counts.route += 1;
      return actual.planScriptedLab(...args);
    },
  };
});
vi.mock("../../src/routes/shared-world/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/shared-world/plan.js")>();
  return {
    ...actual,
    planSharedWorldLab: (...args: Parameters<typeof actual.planSharedWorldLab>) => {
      counts.route += 1;
      return actual.planSharedWorldLab(...args);
    },
  };
});
vi.mock("../../src/routes/computer-use/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/computer-use/plan.js")>();
  return {
    ...actual,
    planComputerUseLab: (...args: Parameters<typeof actual.planComputerUseLab>) => {
      counts.route += 1;
      return actual.planComputerUseLab(...args);
    },
  };
});

import { runLab } from "../../src/run-lab.js";
import { routeOf } from "../../src/study/plan.js";
import { parseLabConfig } from "../../src/study/config.js";
import type { LabConfig } from "../../src/study/types.js";
import { lab, SCENARIO_YAML, type BaseName, type Patch } from "../admission/fixtures.js";

function parsed(base: BaseName, patch: Patch = {}): LabConfig {
  const result = parseLabConfig(lab(base, patch));
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

const runs: readonly (readonly [string, () => LabConfig, string, number])[] = [
  ["preview", () => parsed("preview"), "synthetic", 0],
  ["computer use", () => parsed("cuAppUrl"), "cua", 1],
  ["scripted", () => parsed("scriptedAppUrl"), "scripted", 1],
  ["terminal", () => parsed("terminal"), "terminal", 1],
  ["shared world", () => parsed("sharedProvisioned"), "concurrent-shared-world", 1],
  ["local browser study", () => parsed("cuAppUrl", { execution: { target: "local" } }), "cua", 1],
];

describe("runLab plans each lab once", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-plan-once-"));
    await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
    counts.planLab = 0;
    counts.route = 0;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(runs)(
    "%s: one planLab call and one route planner call",
    async (_name, config, _backend, routePlans) => {
      const outcome = await runLab(config(), { cwd, dryRun: true, open: false });
      expect(outcome.route).toBe(routeOf(config()));
      expect((outcome.result as { ok?: boolean }).ok).toBe(true);
      expect(counts.planLab).toBe(1);
      expect(counts.route).toBe(routePlans);
    },
  );
});
