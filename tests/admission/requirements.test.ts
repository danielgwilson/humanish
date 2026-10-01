// Every key a live plan lists in plan.requirements is checked before its run starts: a run without
// that key is refused, writes no run directory and loads no desktop or sandbox module. The routes
// check keys on their own, so this compares each route's checks with what its plan declares.

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { parseLabConfig } from "../../src/lab/config.js";
import { planLab } from "../../src/lab/plan.js";
import type { Requirement } from "../../src/lab/plan-types.js";
import { runLab, type RunLabOptions } from "../../src/run-lab.js";
import { lab, SCENARIO_YAML, type RawLab } from "./fixtures.js";

const live = { scenario: { mode: "live" } };

// Each live plan shape whose requirements list a key. A local-agent participant is left out: its
// sign-in probe runs the agent's CLI, which a test machine may not have.
const shapes: Record<string, RawLab> = {
  "computer-use app-url": lab("cuAppUrl", live),
  "computer-use clone": lab("cuClone", live),
  "computer-use local-tree": lab("cuLocalTree", live),
  "computer-use desktop-cli": lab("cuDesktopCli", live),
  "scripted clone": lab("scriptedClone", live),
  terminal: lab("terminal", live),
  "shared-world provisioned": lab("sharedProvisioned", live),
  "shared-world external": lab("sharedExternal", live),
};

const ALL_KEYS = {
  OPENAI_API_KEY: "test-openai-value",
  CODEX_API_KEY: "test-codex-value",
  E2B_API_KEY: "test-e2b-value",
  DATABASE_URL: "test-database-value",
};

const cleanup: string[] = [];

afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-requirements-"));
  cleanup.push(dir);
  await writeFile(path.join(dir, "package.json"), '{ "name": "requirements-fixture" }\n');
  await mkdir(path.join(dir, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(dir, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  return dir;
}

function keyNames(requirement: Requirement): readonly string[] {
  if (requirement.kind === "key") return [requirement.name];
  if (requirement.kind === "key-one-of") return requirement.names;
  return [];
}

function options(cwd: string, env: Record<string, string>, loads: { count: number }) {
  const load = async (): Promise<never> => {
    loads.count += 1;
    throw new Error("a key refusal must come before any desktop or sandbox module loads");
  };
  const launchBrowser = async (): Promise<never> => {
    loads.count += 1;
    throw new Error("a key refusal must come before the browser launches");
  };
  return {
    cwd,
    cuaHooks: { env, loadDesktopModule: load },
    scriptedHooks: { env, loadDesktopModule: load, launchBrowser },
    terminalHooks: { env, loadModule: load },
    sharedWorldHooks: { env, loadDesktopModule: load },
  } satisfies RunLabOptions;
}

describe("plan.requirements keys", () => {
  it.each(Object.entries(shapes))(
    "%s refuses a live run without each required key",
    async (_name, raw) => {
      const parsed = parseLabConfig(raw);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const cwd = await projectDir();
      const planned = planLab(parsed.config, options(cwd, ALL_KEYS, { count: 0 }));
      if (!planned.ok) throw new Error(planned.refusal.message);
      const required = planned.planned.plan.requirements
        .map(keyNames)
        .filter((names) => names.length);
      expect(required.length).toBeGreaterThan(0);

      for (const names of required) {
        const env = Object.fromEntries(
          Object.entries(ALL_KEYS).filter(([name]) => !names.includes(name)),
        );
        const loads = { count: 0 };
        const outcome = await runLab(parsed.config, options(cwd, env, loads));
        const runs = await readdir(path.join(cwd, ".humanish", "runs")).catch(() => []);
        expect({ without: names, ok: outcome.result.ok, runs, loads: loads.count }).toEqual({
          without: names,
          ok: false,
          runs: [],
          loads: 0,
        });
        expect(outcome.result.error?.code).toMatch(/_(KEYS|RUNTIME_AUTH)_MISSING$/);
      }
    },
    60_000,
  );
});
