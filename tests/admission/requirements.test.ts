// Every key a live plan lists in plan.requirements is checked before its run starts: a run without
// that key is refused, writes no run directory and loads no desktop or sandbox module. The routes
// check keys on their own, so this compares each route's checks with what its plan declares.

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import type { Requirement } from "../../src/study/plan-types.js";
import type { StudyDeps } from "../../src/study/study-deps.js";
import { runStudyWith, type InternalRunStudyOptions } from "../../src/run-study.js";
import { lab, SCENARIO_YAML, type RawLab } from "./fixtures.js";
import { planComputerUseStudy } from "../../src/routes/computer-use/plan.js";
import { runComputerUse } from "../helpers/route-run.js";

const live = { mode: "live" };

// Each live plan shape whose requirements list a key. The test env has no `PATH`, so a local-agent
// shape's sign-in probe finds no CLI and spawns nothing; its key checks come first anyway.
const localAgent = { type: "local-agent", localAgent: "codex" };
const shapes: Record<string, RawLab> = {
  "computer-use app-url": lab("cuAppUrl", live),
  "computer-use clone": lab("cuClone", live),
  "computer-use local-tree": lab("cuLocalTree", live),
  "computer-use desktop-cli": lab("cuDesktopCli", live),
  "scripted clone": lab("scriptedClone", live),
  terminal: lab("terminal", live),
  "shared-world provisioned": lab("sharedProvisioned", live),
  "shared-world external": lab("sharedExternal", live),
  "shared-world provisioned local-agent": lab("sharedProvisioned", live, localAgent),
  "shared-world external local-agent": lab("sharedExternal", live, localAgent),
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

function options(cwd: string, env: Record<string, string>) {
  return { cwd, env } satisfies InternalRunStudyOptions;
}

/** The terminal and scripted routes' seams: an E2B module load or a browser launch counts too. */
function deps(loads: { count: number }): StudyDeps {
  return {
    desktopModule: async (): Promise<never> => {
      loads.count += 1;
      throw new Error("a key refusal must come before any desktop or sandbox module loads");
    },
    launchBrowser: async (): Promise<never> => {
      loads.count += 1;
      throw new Error("a key refusal must come before the browser launches");
    },
  };
}

describe("plan.requirements keys", () => {
  it.each(Object.entries(shapes))(
    "%s refuses a live run without each required key",
    async (_name, raw) => {
      const parsed = parseStudy(raw);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const cwd = await projectDir();
      const planned = planStudy(parsed.config, options(cwd, ALL_KEYS));
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
        const outcome = await runStudyWith(parsed.config, options(cwd, env), deps(loads));
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

  it.each(Object.entries(shapes))(
    "%s refuses no live run that has every declared key for a missing key",
    async (_name, raw) => {
      const parsed = parseStudy(raw);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const cwd = await projectDir();
      const planned = planStudy(parsed.config, options(cwd, ALL_KEYS));
      if (!planned.ok) throw new Error(planned.refusal.message);
      const requirements = planned.planned.plan.requirements;
      // Only what the plan declares: its keys and its subject env names.
      const declared = new Set([
        ...requirements.flatMap(keyNames),
        ...requirements.flatMap((requirement) =>
          requirement.kind === "subject-env" ? requirement.names : [],
        ),
      ]);
      const env = Object.fromEntries(
        Object.entries(ALL_KEYS).filter(([name]) => declared.has(name)),
      );
      const outcome = await runStudyWith(parsed.config, options(cwd, env), deps({ count: 0 }));
      expect(outcome.result.error?.code ?? "").not.toMatch(/_(KEYS|RUNTIME_AUTH)_MISSING$/);
    },
    60_000,
  );
});

// What each live shape must refuse, written out by hand rather than read from plan.requirements, so
// a requirement a planner stops listing still fails here once the routes check what the plan lists.
// Each key group is one obligation: a run missing every name in it is refused; a terminal run needs
// one of CODEX_API_KEY and OPENAI_API_KEY. A local-agent shape's sign-in probe refuses before its
// subject env is checked (`agentFirst`), so its subject env refusal is not run here.
const withEnv = { subject: { env: ["DATABASE_URL"] } };
const obligations: Record<
  string,
  {
    raw: RawLab;
    keys: readonly (readonly string[])[];
    subjectEnv: readonly string[];
    agentFirst?: true;
  }
> = {
  "computer-use app-url": {
    raw: lab("cuAppUrl", live),
    keys: [["OPENAI_API_KEY"], ["E2B_API_KEY"]],
    subjectEnv: [],
  },
  "computer-use clone": {
    raw: lab("cuClone", { ...live, ...withEnv }),
    keys: [["OPENAI_API_KEY"], ["E2B_API_KEY"]],
    subjectEnv: ["DATABASE_URL"],
  },
  "computer-use local-tree": {
    raw: lab("cuLocalTree", { ...live, ...withEnv }),
    keys: [["OPENAI_API_KEY"], ["E2B_API_KEY"]],
    subjectEnv: ["DATABASE_URL"],
  },
  "computer-use desktop-cli": {
    raw: lab("cuDesktopCli", live),
    keys: [["OPENAI_API_KEY"], ["E2B_API_KEY"]],
    subjectEnv: [],
  },
  "computer-use local-agent clone": {
    raw: lab("cuClone", { ...live, ...withEnv }, localAgent),
    keys: [["E2B_API_KEY"]],
    subjectEnv: ["DATABASE_URL"],
    agentFirst: true,
  },
  "scripted clone": {
    raw: lab("scriptedClone", { ...live, ...withEnv }),
    keys: [["E2B_API_KEY"]],
    subjectEnv: ["DATABASE_URL"],
  },
  terminal: {
    raw: lab("terminal", live),
    keys: [["CODEX_API_KEY", "OPENAI_API_KEY"], ["E2B_API_KEY"]],
    subjectEnv: [],
  },
  "shared-world provisioned": {
    raw: lab("sharedProvisioned", live),
    keys: [["OPENAI_API_KEY"], ["E2B_API_KEY"]],
    subjectEnv: ["DATABASE_URL"],
  },
  "shared-world external": {
    raw: lab("sharedExternal", live),
    keys: [["OPENAI_API_KEY"], ["E2B_API_KEY"]],
    subjectEnv: [],
  },
  "shared-world provisioned local-agent": {
    raw: lab("sharedProvisioned", live, localAgent),
    keys: [["E2B_API_KEY"]],
    subjectEnv: ["DATABASE_URL"],
    agentFirst: true,
  },
  "shared-world external local-agent": {
    raw: lab("sharedExternal", live, localAgent),
    keys: [["OPENAI_API_KEY"], ["E2B_API_KEY"]],
    subjectEnv: [],
    agentFirst: true,
  },
};

/** Runs `raw` live with `env` and returns its refusal code, run directories and module loads. */
async function liveRun(raw: RawLab, env: Record<string, string>) {
  const parsed = parseStudy(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const cwd = await projectDir();
  const loads = { count: 0 };
  const outcome = await runStudyWith(parsed.config, options(cwd, env), deps(loads));
  const runs = await readdir(path.join(cwd, ".humanish", "runs")).catch(() => []);
  return { code: outcome.result.error?.code ?? "", runs, loads: loads.count };
}

const without = (names: readonly string[]) =>
  Object.fromEntries(Object.entries(ALL_KEYS).filter(([name]) => !names.includes(name)));

describe("route obligations, independent of plan.requirements", () => {
  it.each(Object.entries(obligations))(
    "%s refuses a live run missing each required key group",
    async (_name, { raw, keys }) => {
      for (const group of keys) {
        const run = await liveRun(raw, without(group));
        expect({
          without: group,
          ...run,
          code: /_(KEYS|RUNTIME_AUTH)_MISSING$/.test(run.code),
        }).toEqual({
          without: group,
          code: true,
          runs: [],
          loads: 0,
        });
      }
    },
    60_000,
  );

  it.each(
    Object.entries(obligations).filter(
      ([, { subjectEnv, agentFirst }]) => subjectEnv.length > 0 && agentFirst === undefined,
    ),
  )(
    "%s refuses a live run missing each declared subject env name",
    async (_name, { raw, subjectEnv }) => {
      for (const name of subjectEnv) {
        const run = await liveRun(raw, without([name]));
        expect({ without: name, ...run, code: run.code.endsWith("_SUBJECT_ENV_MISSING") }).toEqual({
          without: name,
          code: true,
          runs: [],
          loads: 0,
        });
      }
    },
    60_000,
  );

  it.each(Object.entries(obligations))(
    "%s refuses no live run for a missing key or subject env when its obligations hold",
    async (_name, { raw, keys, subjectEnv }) => {
      // One name per key group: a terminal run holds its runtime key with CODEX_API_KEY alone.
      const held = new Set([...keys.map((group) => group[0]!), ...subjectEnv]);
      const env = Object.fromEntries(Object.entries(ALL_KEYS).filter(([name]) => held.has(name)));
      const run = await liveRun(raw, env);
      expect(run.code).not.toMatch(/_(KEYS|RUNTIME_AUTH|SUBJECT_ENV)_MISSING$/);
    },
    60_000,
  );

  it.each(Object.entries(obligations))(
    "%s lists exactly its obligations in plan.requirements",
    async (_name, { raw, keys, subjectEnv }) => {
      const parsed = parseStudy(raw);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const planned = planStudy(parsed.config, options(await projectDir(), ALL_KEYS));
      if (!planned.ok) throw new Error(planned.refusal.message);
      const { requirements } = planned.planned.plan;
      expect(requirements.map(keyNames).filter((names) => names.length > 0)).toEqual(
        expect.arrayContaining(keys.map((group) => [...group])),
      );
      expect(requirements.flatMap(keyNames).length).toBe(keys.flat().length);
      expect(
        requirements.flatMap((requirement) =>
          requirement.kind === "subject-env" ? requirement.names : [],
        ),
      ).toEqual(subjectEnv);
    },
  );
});

describe("requirements with a local study's desktop and a caller's provider", () => {
  // A local browser lab runs on the local VM study's desktop, so it needs no E2B_API_KEY, and a
  // caller's createProvider drives it, so it needs no OPENAI_API_KEY.
  it("lists neither key, and preflight refuses neither", async () => {
    const parsed = parseStudy(lab("cuAppUrl", { ...live, execution: { target: "local" } }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const cwd = await projectDir();
    let desktopReached = false;
    const createProvider = async (): Promise<never> => {
      throw new Error("the provider is not reached in this test");
    };
    const localVm = {
      desktop: () => {
        desktopReached = true;
        throw new Error("the local study's desktop was reached");
      },
      analysisRefusal: () => undefined,
    };
    const planned = planComputerUseStudy(parsed.config, {
      dryRun: false,
      driving: { inProcess: false, createProvider: true },
    });
    if (!planned.ok) throw new Error(planned.refusal.message);
    expect(planned.plan.requirements.flatMap(keyNames)).toEqual([]);
    // Past preflight, the run asks the study for a desktop, and its throw ends the run.
    const code = await runComputerUse({
      cwd,
      config: parsed.config,
      dryRun: false,
      env: {},
      createProvider,
      localVm,
    }).then(
      (result) => result.error?.code ?? "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(code).not.toMatch(/_KEYS_MISSING$/);
    expect(desktopReached).toBe(true);
  });
});
