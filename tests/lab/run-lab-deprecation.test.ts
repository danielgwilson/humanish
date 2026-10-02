import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { parseLabConfig } from "../../src/lab/config.js";
import { routeOf } from "../../src/lab/plan.js";
import { normalizeRunLabOptions } from "../../src/lab/run-lab-options.js";
import type { LabConfig } from "../../src/lab/types.js";
import { runPackageLab, type RunLabOptions } from "../../src/run-lab.js";
import { lab } from "../admission/fixtures.js";

// rerun.laneIds warns once per process. This file runs in its own worker, so the
// once-per-process record starts empty here. The route hook bags were removed from the package's
// RunLabOptions: its runLab refuses them, and only tests set them on the internal options.

function config(): LabConfig {
  const parsed = parseLabConfig(lab("cuAppUrl"));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

type WarningSpy = { mock: { calls: unknown[][] } };

const deprecations = (spy: WarningSpy): string[] =>
  spy.mock.calls
    .filter(([, options]) => {
      const code = (options as { code?: unknown } | undefined)?.code;
      return code === "HUMANISH_RUN_LAB_OPTION_DEPRECATED";
    })
    .map(([message]) => String(message));

describe("rerun.laneIds", () => {
  let emitWarning: WarningSpy & { mockRestore: () => void };
  beforeEach(() => {
    emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  });
  afterEach(() => {
    emitWarning.mockRestore();
  });

  it("warns once per process, naming its home", () => {
    const labConfig = config();
    for (let i = 0; i < 2; i += 1)
      normalizeRunLabOptions(labConfig, routeOf(labConfig), {
        cwd: "/tmp/x",
        rerun: { sourceRunId: "r", laneIds: ["lane-01"] },
      });
    expect(deprecations(emitWarning)).toEqual([
      "RunLabOptions.rerun.laneIds is deprecated and is removed in the next minor. Use RunLabOptions.rerun.participantIds.",
    ]);
  });

  it("is the only field that warns: the typed options are silent", () => {
    const labConfig = config();
    normalizeRunLabOptions(labConfig, routeOf(labConfig), {
      cwd: "/tmp/x",
      env: {},
      prepareDesktop: async () => undefined,
    });
    expect(deprecations(emitWarning)).toEqual([]);
  });
});

describe("the package's runLab", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-lab-removed-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each([
    [
      "cuaHooks",
      "Use scorer, createProvider, inProcess, prepareDesktop, env, onEvent and onStream.",
    ],
    ["scriptedHooks", "Use prepareDesktop and env."],
    ["terminalHooks", "Use scorer and env."],
    ["sharedWorldHooks", "Use scorer, prepareDesktop, env, onEvent and onStream."],
    ["automaticAnalysis", "Use onEvent (analysis-started, analysis-finished) and analysisSignal."],
    ["lab", "The humanish CLI sets it."],
    ["scorerProvenance", "The humanish CLI sets it."],
  ])("refuses %s in the route's envelope before anything runs", async (field, home) => {
    const options = { cwd, dryRun: true, [field]: {} } as unknown as RunLabOptions;
    const outcome = await runPackageLab(config(), options);
    expect(outcome.route).toBe("computer-use");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toEqual({
      code: "HUMANISH_LAB_OPTION_UNSUPPORTED",
      message: `RunLabOptions.${field} was removed. ${home} See docs/contracts/schemas.md, "Library options".`,
    });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("runs a lab given only the typed options", async () => {
    const outcome = await runPackageLab(config(), { cwd, dryRun: true });
    expect(outcome.route).toBe("computer-use");
    expect(outcome.result.ok).toBe(true);
  });

  it("is the runLab src/index.ts exports", async () => {
    const humanish = await import("../../src/index.js");
    expect(humanish.runLab).toBe(runPackageLab);
  });
});

describe("the CLI uses only the new homes", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-lab-deprecation-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("a scored lab run emits no deprecation warning", async () => {
    await cp(path.resolve("humanish"), path.join(cwd, "humanish"), { recursive: true });
    await mkdir(path.join(cwd, "scorers"), { recursive: true });
    await writeFile(
      path.join(cwd, "scorers", "score.mjs"),
      `export function score() {
  return { schema: "humanish.adapter-score.v1", namespace: "cli", status: "pass", score: 1, summary: "ok" };
}
`,
    );
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let out = "";
    try {
      const program = createProgram({
        writeOut: (text) => {
          out += text;
        },
        writeErr: () => undefined,
        setExitCode: () => undefined,
      });
      await program.parseAsync(
        [
          "node",
          "humanish",
          "lab",
          "run",
          "fanout-demo",
          "--dry-run",
          "--scorer",
          "scorers/score.mjs",
          "--cwd",
          cwd,
          "--json",
        ],
        { from: "node" },
      );
      expect(deprecations(emitWarning)).toEqual([]);
    } finally {
      emitWarning.mockRestore();
    }
    expect(JSON.parse(out).ok).toBe(true);
  });
});
