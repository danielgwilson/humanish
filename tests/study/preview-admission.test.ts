// What runStudyWith returns for a preview (this-repo) config it refuses, and which refusal wins when two
// apply. Written against the engine's own admission before the preview route moved onto planStudy;
// the move must keep every envelope.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { runStudyWith } from "../../src/run-study.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { libraryConfig } from "../helpers/library-config.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function preview(extra: Record<string, unknown>): StudyConfig {
  return libraryConfig({
    schema: STUDY_SCHEMA,
    id: "preview-admission",
    route: "preview",
    subject: { source: "this-repo" },
    actor: { type: "synthetic-persona" },
    ...extra,
  });
}

const receiving = { comms: { email: { kind: "real", connection: "team-inbox" } } };
const badAnalysis = { review: { analysis: "yes" } };
const analysis = { review: { analysis: { maxCostUsd: 1 } } };
const tasks = { actor: { type: "synthetic-persona", tasks: [{ id: "t", goal: "g" }] } };

describe("preview admission", () => {
  it.each([
    ["real receiving", receiving, "HUMANISH_STUDY_COMMS_UNSUPPORTED"],
    ["invalid analysis", badAnalysis, "HUMANISH_STUDY_ANALYSIS_INVALID"],
    ["declared analysis", analysis, "HUMANISH_STUDY_ANALYSIS_UNSUPPORTED"],
    ["tasks", tasks, "HUMANISH_STUDY_TASKS_UNSUPPORTED"],
    [
      "receiving wins over analysis",
      { ...receiving, ...badAnalysis },
      "HUMANISH_STUDY_COMMS_UNSUPPORTED",
    ],
    ["analysis wins over tasks", { ...analysis, ...tasks }, "HUMANISH_STUDY_ANALYSIS_UNSUPPORTED"],
  ] as const)("refuses %s before any run", async (_name, extra, code) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-preview-admission-"));
    dirs.push(cwd);
    const outcome = await runStudyWith(preview(extra), { cwd, dryRun: true });
    expect(outcome.route).toBe("preview");
    expect(outcome.result).toEqual({
      schema: "humanish.study-result.v1",
      route: "preview",
      studyId: "preview-admission",
      ok: false,
      cwd: path.resolve(cwd),
      warnings: [],
      error: { code, message: expect.any(String) },
    });
    expect(await readdir(cwd)).toEqual([]);
  });

  it("names the rule in each message", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-preview-admission-"));
    dirs.push(cwd);
    const messages = await Promise.all(
      [receiving, badAnalysis, analysis, tasks].map(
        async (extra) =>
          (await runStudyWith(preview(extra), { cwd, dryRun: true })).result.error?.message,
      ),
    );
    await expect(`${JSON.stringify(messages, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/plans/preview-admission-messages.json",
    );
  });
});
