// Pins what each library entry point does today with a config that breaks one admission rule, or
// needs something it lacks: the parser, runLab, and the route's exported runner. The planLab
// migration (handoffs PLAN-DESIGN.md) must keep this golden byte-identical except for changes its
// compatibility contract lists. Every refusal is also checked for side effects: no run directory,
// no desktop module, no caller executor or provider, and no subprocess.

import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { parseLabConfig } from "../../src/lab/config.js";
import {
  resolveLabDryRun,
  runLab,
  selectLabBackend,
  type LabBackend,
} from "../../src/lab/engine.js";
import type { LabConfig } from "../../src/lab/types.js";
import { runCuaActorLab } from "../../src/routes/computer-use/route.js";
import { runScriptedBrowserLab } from "../../src/routes/scripted-browser/route.js";
import { runConcurrentSharedWorld } from "../../src/routes/shared-world/route.js";
import { runTerminalProductLab } from "../../src/routes/terminal/route.js";
import { lab, SCENARIO_YAML } from "./fixtures.js";
import { parserCases, type AdmissionCase, type AdmissionOptions } from "./parser-cases.js";
import { routeCases } from "./route-cases.js";

const subprocess = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:child_process", async (importOriginal) =>
  (await import("./subprocess-spy.js")).countedChildProcess(await importOriginal(), subprocess),
);

type Entry = "runLab" | "runner";
type Json = unknown;

interface Calls {
  desktop: number;
  executor: number;
  provider: number;
  subprocess: number;
}

const records: Record<string, Record<string, Json>> = {};
const cleanup: string[] = [];

afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "humanish-admission-"));
  cleanup.push(dir);
  await writeFile(path.join(dir, "package.json"), '{ "name": "admission-fixture" }\n');
  await mkdir(path.join(dir, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(dir, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  return dir;
}

function hookEnv(env: AdmissionOptions["env"]): Record<string, string> {
  if (env === "keys") return { OPENAI_API_KEY: "sk-test-openai", E2B_API_KEY: "e2b-test-key" };
  if (env === "e2b") return { E2B_API_KEY: "e2b-test-key" };
  return {};
}

function hooksFor(options: AdmissionOptions, calls: Calls) {
  const env = hookEnv(options.env);
  const loadDesktopModule = async (): Promise<never> => {
    calls.desktop += 1;
    throw new Error("admission cases must not load a desktop module");
  };
  const cuaHooks = {
    env,
    loadDesktopModule,
    ...(options.hooks === "executor" || options.hooks === "executor+provider"
      ? {
          buildExecutor: async (): Promise<never> => {
            calls.executor += 1;
            throw new Error("admission cases must not build an executor");
          },
        }
      : {}),
    ...(options.hooks === "provider" || options.hooks === "executor+provider"
      ? {
          buildProvider: async (): Promise<never> => {
            calls.provider += 1;
            throw new Error("admission cases must not build a provider");
          },
        }
      : {}),
  };
  return {
    cuaHooks,
    scriptedHooks: { env, loadDesktopModule },
    terminalHooks: { env, loadModule: loadDesktopModule },
    sharedWorldHooks: { env, loadDesktopModule },
  };
}

async function runEntry(
  entry: Entry,
  config: LabConfig,
  options: AdmissionOptions,
): Promise<Record<string, Json>> {
  const cwd = await projectDir();
  if (options.isolateBrowser) {
    vi.stubEnv("PATH", path.join(cwd, "no-bin"));
    vi.stubEnv("HUMANISH_BROWSER_COMMAND", "");
  }
  const calls: Calls = { desktop: 0, executor: 0, provider: 0, subprocess: 0 };
  const hooks = hooksFor(options, calls);
  const backend: LabBackend | "none" =
    options.runner ?? (entry === "runner" ? selectLabBackend(config) : "none");
  const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
  const rerun = options.rerun === undefined ? {} : { rerun: options.rerun };
  subprocess.calls = 0;
  let result: Json;
  try {
    if (entry === "runLab") {
      const outcome = await runLab(config, {
        cwd,
        ...hooks,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.count === undefined ? {} : { count: options.count }),
        ...rerun,
      });
      result = { backend: outcome.backend, ...outcome.result };
    } else if (backend === "cua") {
      result = await runCuaActorLab({
        cwd,
        config,
        dryRun,
        hooks: hooks.cuaHooks,
        ...(options.count === undefined ? {} : { countOverride: options.count }),
        ...rerun,
      });
    } else if (backend === "scripted") {
      result = await runScriptedBrowserLab({ cwd, config, dryRun, hooks: hooks.scriptedHooks });
    } else if (backend === "terminal") {
      result = await runTerminalProductLab({ cwd, config, dryRun, hooks: hooks.terminalHooks });
    } else if (backend === "concurrent-shared-world") {
      result = await runConcurrentSharedWorld({
        cwd,
        config,
        dryRun,
        hooks: hooks.sharedWorldHooks,
      });
    } else {
      // The preview runner (runDryRun) takes no config, so there is nothing to pin.
      return { runner: backend };
    }
  } catch (error) {
    result = { threw: error instanceof Error ? error.message : String(error) };
  }
  calls.subprocess = subprocess.calls;
  const runs = (await readdir(path.join(cwd, ".humanish", "runs")).catch(() => [])).length > 0;
  const physical = await realpath(cwd);
  return {
    ...(entry === "runner" ? { runner: backend } : {}),
    runs,
    ...(runs ? { result: summary(result) } : { calls, result: normalize(result, [physical, cwd]) }),
  };
}

/** A run that started writes timestamps and ids; pin only what decides admission. */
function summary(result: Json): Json {
  const value = result as {
    backend?: string;
    ok?: boolean;
    error?: { code?: string };
    plan?: { laneCount?: number; concurrency?: number; waves?: number; lanes?: { id: string }[] };
  };
  return {
    ...(value.backend === undefined ? {} : { backend: value.backend }),
    ok: value.ok,
    ...(value.error?.code === undefined ? {} : { error: value.error.code }),
    ...(value.plan === undefined
      ? {}
      : {
          plan: {
            laneCount: value.plan.laneCount,
            concurrency: value.plan.concurrency,
            waves: value.plan.waves,
            lanes: value.plan.lanes?.map((lane) => lane.id),
          },
        }),
  };
}

/** The runner usually returns what runLab returned; say so instead of repeating it. */
function sameAsRunLab(runner: Record<string, Json>, runLabRecord: Json): Record<string, Json> {
  if (runLabRecord === undefined) return runner;
  const { runner: name, ...rest } = runner;
  const strip = (record: Json): string => {
    const value = structuredClone(record) as { result?: Record<string, Json> };
    if (value.result) delete value.result.backend;
    return JSON.stringify(value);
  };
  return strip(rest) === strip(runLabRecord) ? { runner: name, sameAsRunLab: true } : runner;
}

function normalize(value: Json, paths: string[]): Json {
  let text = JSON.stringify(value);
  for (const dir of paths) text = text.split(dir).join("[cwd]");
  return JSON.parse(text) as Json;
}

async function pin(testCase: AdmissionCase): Promise<void> {
  const options = testCase.options ?? {};
  const parsed = parseLabConfig(testCase.raw);
  if (testCase.parser === "accepts") {
    expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
  } else {
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain(testCase.parser);
  }
  const record: Record<string, Json> = {
    parser: parsed.ok ? { ok: true } : parsed.error,
  };
  const config = (
    options.parsed && parsed.ok ? parsed.config : (testCase.typed ?? testCase.raw)
  ) as LabConfig;
  for (const entry of testCase.entries ?? (["runLab", "runner"] as const)) {
    const pinned = await runEntry(entry, config, options);
    if (pinned.runs === false) {
      const calls = pinned.calls as Calls;
      expect(calls.desktop + calls.executor + calls.provider).toBe(0);
    }
    record[entry] = entry === "runner" ? sameAsRunLab(pinned, record.runLab) : pinned;
  }
  records[testCase.name] = record;
}

describe("library admission today", () => {
  it.each([...parserCases, ...routeCases].map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    async (_name, testCase) => {
      await pin(testCase);
      expect(records[testCase.name]).toBeDefined();
    },
    60_000,
  );

  // Browser discovery also probes a fixed macOS application path, so this case stays out of the
  // platform-independent golden.
  it.skipIf(process.platform === "darwin")(
    "refuses a live scripted run with no browser before any side effect",
    async () => {
      const raw = lab("scriptedAppUrl", { scenario: { mode: "live", ref: "adm-journey" } });
      for (const entry of ["runLab", "runner"] as const) {
        expect(
          await runEntry(entry, raw as unknown as LabConfig, { isolateBrowser: true }),
        ).toMatchObject({
          runs: false,
          calls: { desktop: 0, executor: 0, provider: 0 },
          result: { error: { code: "HUMANISH_SCRIPTED_LAB_BROWSER_MISSING" } },
        });
      }
    },
  );

  it("matches the pinned golden", async () => {
    expect(Object.keys(records)).toHaveLength(parserCases.length + routeCases.length);
    await expect(`${JSON.stringify(records, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/admission/library.json",
    );
  });
});
