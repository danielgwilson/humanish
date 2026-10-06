// Each recorded route starts its run in the run scope from its plan and its input: the run id (the
// caller's, or one minted from the route's prefix), the mode, the study, the study's warnings, the
// Observer's open flag and renderer, and the source captured when the run starts. These tests pin
// what each route records from them. The goldens mask the id as [run] and every time as [ts].

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { RunBundle } from "../../src/run/bundle.js";
import type { RunStudyProvenance } from "../../src/run/study-provenance.js";
import { renderObserver } from "../../src/observer/render.js";
import type { StudyDeps } from "../../src/study/study-deps.js";
import { lab, SCENARIO_YAML, type BaseName } from "../admission/fixtures.js";
import { libraryConfig } from "../helpers/library-config.js";
import { runComputerUse, runScripted, runSharedWorld, runTerminal } from "../helpers/route-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { passingRun, terminalConfig } from "../helpers/terminal-live-fake.js";

const STUDY: RunStudyProvenance = {
  id: "run-start-proof",
  path: "humanish/studies/run-start-proof.yaml",
  origin: "committed",
};
const WARNING = "run-start-proof: a warning about the study's own fields";
const FIELDS = { study: STUDY, warnings: [WARNING] };
/** A clock four seconds after the epoch, so a createdAt read from it cannot be the wall clock. */
const EPOCH_CLOCK = () => 4_000;
const EPOCH_CREATED_AT = new Date(4_000).toISOString();

interface RouteInput {
  cwd: string;
  runId?: string;
  open: boolean;
  deps: StudyDeps;
}

interface Case {
  name: string;
  prefix: string;
  mode: "dry-run" | "live";
  /** status.json's `sandboxes`, which only a scripted app-url run sets. */
  sandboxes?: "none";
  /** Whether createdAt follows the input's `deps.now`; only the live terminal run passes it. */
  clocked: boolean;
  run(input: RouteInput): Promise<{ ok: boolean; runId?: string }>;
}

const dryConfig = (base: BaseName) => libraryConfig(lab(base));

const cases: Case[] = [
  {
    name: "computer use",
    prefix: "cua",
    mode: "dry-run",
    clocked: false,
    run: (input) =>
      runComputerUse({ ...input, config: dryConfig("cuAppUrl"), dryRun: true, env: {} }, FIELDS),
  },
  {
    name: "shared world",
    prefix: "concurrent-shared-world",
    mode: "dry-run",
    clocked: false,
    run: (input) =>
      runSharedWorld(
        { ...input, config: dryConfig("sharedExternal"), dryRun: true, env: {} },
        FIELDS,
      ),
  },
  {
    name: "scripted app-url",
    prefix: "scripted",
    mode: "dry-run",
    sandboxes: "none",
    clocked: false,
    run: (input) =>
      runScripted({ ...input, config: dryConfig("scriptedAppUrl"), dryRun: true, env: {} }, FIELDS),
  },
  {
    name: "scripted clone",
    prefix: "scripted",
    mode: "dry-run",
    clocked: false,
    run: (input) =>
      runScripted({ ...input, config: dryConfig("scriptedClone"), dryRun: true, env: {} }, FIELDS),
  },
  {
    name: "terminal dry run",
    prefix: "terminal",
    mode: "dry-run",
    clocked: false,
    run: (input) =>
      runTerminal({ ...input, config: dryConfig("terminal"), dryRun: true, env: {} }, FIELDS),
  },
  {
    name: "terminal live",
    prefix: "terminal",
    mode: "live",
    clocked: true,
    run: (input) => {
      const live = passingRun({ deps: input.deps });
      return runTerminal({ ...input, ...live, config: terminalConfig(), dryRun: false }, FIELDS);
    },
  },
];

/** A project with the scenario the scripted studies name. */
async function project(): Promise<string> {
  const cwd = await makeTestTempDir("humanish-run-start-");
  await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
  await writeFile(path.join(cwd, "humanish", "scenarios", "adm-journey.yaml"), SCENARIO_YAML);
  return cwd;
}

/** The real renderer with `open` forced off, recording what the run asked it for. */
function observerSpy(): {
  calls: Array<{ cwd: string; runId: string; open: boolean | undefined }>;
  render: typeof renderObserver;
} {
  const calls: Array<{ cwd: string; runId: string; open: boolean | undefined }> = [];
  const render: typeof renderObserver = async (cwd, runId, options) => {
    calls.push({ cwd, runId, open: options?.open });
    return renderObserver(cwd, runId, { ...options, open: false });
  };
  return { calls, render };
}

async function started(
  routeCase: Case,
  runId?: string,
): Promise<{
  cwd: string;
  runId: string;
  calls: ReturnType<typeof observerSpy>["calls"];
  before: number;
  after: number;
}> {
  const cwd = await project();
  const spy = observerSpy();
  const before = Date.now();
  const result = await routeCase.run({
    cwd,
    ...(runId === undefined ? {} : { runId }),
    open: true,
    deps: { renderObserver: spy.render, now: EPOCH_CLOCK },
  });
  const after = Date.now();
  if (!result.ok || result.runId === undefined) {
    throw new Error(`${routeCase.name} did not run: ${JSON.stringify(result)}`);
  }
  return { cwd, runId: result.runId, calls: spy.calls, before, after };
}

async function readJson<T>(cwd: string, runId: string, file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", runId, file), "utf8")) as T;
}

/** The wall-clock time a minted id's stamp names. */
function stampTime(stamp: string): number {
  return Date.parse(stamp.replace(/^(.{13})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z"));
}

describe.each(cases)("$name starts its run from its plan and input", (routeCase) => {
  it("mints `<prefix>-<wall-clock stamp>-<8 hex>` when the caller names no run id", async () => {
    const run = await started(routeCase);
    const pattern = new RegExp(
      `^${routeCase.prefix}-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z)-[0-9a-f]{8}$`,
    );
    const match = pattern.exec(run.runId);
    expect(match, run.runId).not.toBeNull();
    // The stamp reads the wall clock even where createdAt reads the input's clock.
    const stamp = stampTime(match![1]!);
    expect(stamp).toBeGreaterThanOrEqual(run.before);
    expect(stamp).toBeLessThanOrEqual(run.after);
  });

  it("uses the caller's run id", async () => {
    const run = await started(routeCase, "run-start-caller-id");
    expect(run.runId).toBe("run-start-caller-id");
    const status = await readJson<{ runId: string }>(run.cwd, run.runId, "status.json");
    expect(status.runId).toBe("run-start-caller-id");
  });

  it("records the plan's mode, study and warnings, and the source at the run's start", async () => {
    const run = await started(routeCase);
    const status = await readJson<Record<string, unknown>>(run.cwd, run.runId, "status.json");
    const bundle = await readJson<RunBundle>(run.cwd, run.runId, "run.json");
    expect(status.mode).toBe(routeCase.mode);
    expect(status.study).toEqual(STUDY);
    expect(status.sandboxes).toBe(routeCase.sandboxes);
    expect(bundle.mode).toBe(routeCase.mode);
    expect(bundle.study).toEqual(STUDY);
    expect(
      bundle.events.filter((event) => event.type === "study.warning").map((event) => event.message),
    ).toEqual([WARNING]);
    expect(bundle.source).toEqual({
      packageName: "humanish",
      humanishSource: "present",
      git: expect.objectContaining({ capturedAt: bundle.createdAt }),
    });
    if (routeCase.clocked) expect(bundle.createdAt).toBe(EPOCH_CREATED_AT);
    else expect(Date.parse(bundle.createdAt)).toBeGreaterThanOrEqual(run.before);
  });

  it("renders its Observer through the input's renderer with the input's open flag", async () => {
    const run = await started(routeCase);
    expect(run.calls).toEqual([{ cwd: await realpath(run.cwd), runId: run.runId, open: true }]);
  });
});
