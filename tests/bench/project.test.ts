import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../../bench/lib/humanish-cli.js";
import { BRAINS } from "../../bench/lib/plan.js";
import {
  DEFAULT_PERSONA_FILE,
  checkStudy,
  fixtureDigests,
  sha256,
  studyId,
  writeProject,
} from "../../bench/lib/project.js";
import { MISSIONS } from "../../bench/taskly/missions.js";
import { DEFAULT_MISSION } from "../../src/routes/computer-use/participant-prompt.js";

const brains = [BRAINS["openai-computer-use"]];

function servedDigests(storage: "memory" | "local"): Record<string, string> {
  const project = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-project-"));
  try {
    writeProject(project, brains, MISSIONS.neutral, 0.6, DEFAULT_PERSONA_FILE, storage);
    const digest = (file: string): string => sha256(readFileSync(path.join(project, file)));
    return {
      plantedAppJs: digest("build-a/app.js"),
      cleanAppJs: digest("build-b/app.js"),
      plantedIndex: digest("build-a/index.html"),
      cleanIndex: digest("build-b/index.html"),
    };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

describe("the benchmark project", () => {
  it("serves the localStorage builds when the storage is local, with the same index.html", () => {
    const memory = servedDigests("memory");
    const local = servedDigests("local");
    const digests = fixtureDigests(DEFAULT_PERSONA_FILE, "local");
    expect(local.plantedAppJs).toBe(digests.plantedAppJs);
    expect(local.cleanAppJs).toBe(digests.cleanAppJs);
    expect(local.plantedAppJs).not.toBe(memory.plantedAppJs);
    expect(local.cleanAppJs).not.toBe(memory.cleanAppJs);
    expect(local.plantedIndex).toBe(memory.plantedIndex);
    expect(local.cleanIndex).toBe(digests.indexHtml);
  });

  it("serves the in-memory builds by default", () => {
    const memory = servedDigests("memory");
    const digests = fixtureDigests(DEFAULT_PERSONA_FILE);
    expect(memory.plantedAppJs).toBe(digests.plantedAppJs);
    expect(memory.cleanAppJs).toBe(digests.cleanAppJs);
  });
});

describe("the CLI's dry run of a generated study", () => {
  const runId = "cua-2026-11-16T09-00-00-000Z-0a1b2c3d";

  /** A CLI whose dry run answers `json` and writes a bundle whose streams record `missions`. */
  function dryRunCli(
    project: string,
    missions: string[],
    json: Record<string, unknown>,
  ): typeof runCli {
    return async () => {
      const runDir = path.join(project, ".humanish", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      const streams = missions.map((mission, index) => ({
        id: `stream-${index}`,
        assignment: { mission },
      }));
      writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId, streams }));
      return { code: 0, timedOut: false, json };
    };
  }

  function check(missions: string[], json: Record<string, unknown>) {
    const project = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-check-"));
    const target = {
      cliPath: "unused-cli",
      projectDir: project,
      logFile: path.join(project, "cli.log"),
      studyId: "bench-taskly-a-x",
    };
    return checkStudy(target, dryRunCli(project, missions, json)).finally(() =>
      rmSync(project, { recursive: true, force: true }),
    );
  }

  it("reports the mission the CLI's dry-run bundle recorded and its worst-case desktop minutes", async () => {
    const result = await check(["Open the fictional greenhouse planner and plan one bed."], {
      ok: true,
      runId,
      plan: { worstCaseSandboxMinutes: 12 },
    });
    expect(result).toEqual({
      ok: true,
      mission: "Open the fictional greenhouse planner and plan one bed.",
      worstCaseSandboxMinutes: 12,
    });
  });

  it("reports no mission when the bundle's participants recorded different ones", async () => {
    const result = await check(["Plan one bed.", "Book one lesson."], {
      ok: true,
      runId,
      plan: {},
    });
    expect(result).toEqual({ ok: true, mission: null, worstCaseSandboxMinutes: null });
  });

  it("is refused when the CLI refuses the study", async () => {
    const result = await check([], { ok: false, error: { code: "HUMANISH_STUDY_INVALID" } });
    expect(result).toEqual({ ok: false, reason: "refused" });
  });

  it("names a missing bundle when the CLI answers ok but wrote no dry-run bundle", async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-check-"));
    try {
      const target = {
        cliPath: "unused-cli",
        projectDir: project,
        logFile: path.join(project, "cli.log"),
        studyId: "bench-taskly-a-x",
      };
      const silent: typeof runCli = async () => ({
        code: 0,
        timedOut: false,
        json: { ok: true, runId, plan: {} },
      });
      expect(await checkStudy(target, silent)).toEqual({ ok: false, reason: "no_bundle" });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

it("records this checkout's built-in mission from a real dry run of a study with no mission line", async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-default-"));
  try {
    const brain = BRAINS["openai-computer-use"];
    writeProject(project, [brain], MISSIONS.default, 0.6);
    const fromSource: typeof runCli = (cliPath, args, options) =>
      runCli(cliPath, args, { ...options, nodeArgs: ["--import", import.meta.resolve("tsx")] });
    const target = {
      cliPath: path.resolve("src/cli.ts"),
      projectDir: project,
      logFile: path.join(project, "cli.log"),
      studyId: studyId(brain, "planted"),
    };
    expect(await checkStudy(target, fromSource)).toMatchObject({
      ok: true,
      mission: DEFAULT_MISSION,
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
  // The CLI starts from source, about 9 s on an idle machine.
}, 60_000);
