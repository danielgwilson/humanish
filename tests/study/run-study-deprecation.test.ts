import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { routeOf } from "../../src/study/plan.js";
import { normalizeRunStudyOptions } from "../../src/study/run-study-options.js";
import type { StudyConfig } from "../../src/study/types.js";
import { runStudy, type RunStudyOptions } from "../../src/run-study.js";
import { lab } from "../admission/fixtures.js";
import { studyConfig } from "../helpers/study-file.js";

// The package's runStudyWith refuses the RunStudyOptions fields it no longer has, and the typed options
// emit no deprecation warning. Only tests set the internal options.

function config(): StudyConfig {
  return studyConfig(lab("cuAppUrl"));
}

type WarningSpy = { mock: { calls: unknown[][] } };

/** The humanish warning codes `spy` saw, in either emitWarning form. */
const humanishWarnings = (spy: WarningSpy): string[] =>
  spy.mock.calls
    .map(([, options, code]) => (options as { code?: unknown } | undefined)?.code ?? code)
    .filter((code): code is string => typeof code === "string" && code.startsWith("HUMANISH_"));

describe("the typed options", () => {
  it("emit no deprecation warning", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      const labConfig = config();
      normalizeRunStudyOptions(labConfig, routeOf(labConfig), {
        cwd: "/tmp/x",
        env: {},
        prepareDesktop: async () => undefined,
        rerun: { sourceRunId: "r", participantIds: ["lane-01"] },
      });
      expect(humanishWarnings(emitWarning)).toEqual([]);
    } finally {
      emitWarning.mockRestore();
    }
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
    const options = { cwd, dryRun: true, [field]: {} } as unknown as RunStudyOptions;
    const outcome = await runStudy(config(), options);
    expect(outcome.route).toBe("computer-use");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toEqual({
      code: "HUMANISH_STUDY_OPTION_UNSUPPORTED",
      message: `RunLabOptions.${field} was removed. ${home} See docs/contracts/schemas.md, "Library options".`,
    });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("refuses rerun.laneIds, whose rerun would otherwise select every failed participant", async () => {
    const options = {
      cwd,
      dryRun: true,
      rerun: { sourceRunId: "prior", laneIds: ["lane-01"] },
    } as unknown as RunStudyOptions;
    const outcome = await runStudy(config(), options);
    expect(outcome.result.error).toEqual({
      code: "HUMANISH_STUDY_OPTION_UNSUPPORTED",
      message:
        'RunLabOptions.rerun.laneIds was removed. Use rerun.participantIds. See docs/contracts/schemas.md, "Library options".',
    });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("runs a lab given only the typed options", async () => {
    const outcome = await runStudy(config(), { cwd, dryRun: true });
    expect(outcome.route).toBe("computer-use");
    expect(outcome.result.ok).toBe(true);
  });

  it("is the runLab src/index.ts exports", async () => {
    const humanish = await import("../../src/index.js");
    expect(humanish.runLab).toBe(runStudy);
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
      expect(humanishWarnings(emitWarning)).toEqual([]);
    } finally {
      emitWarning.mockRestore();
    }
    expect(JSON.parse(out).ok).toBe(true);
  });
});
