// What runLab returns for a preview (this-repo) config it refuses, and which refusal wins when two
// apply. Written against the engine's own admission before the preview route moved onto planLab;
// the move must keep every envelope.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { runLab } from "../../src/lab/engine.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function preview(extra: Record<string, unknown>): LabConfig {
  return {
    schema: LAB_CONFIG_SCHEMA,
    id: "preview-admission",
    subject: { source: "this-repo" },
    actors: [{ type: "synthetic-persona" }],
    ...extra,
  } as unknown as LabConfig;
}

const receiving = { comms: { email: { kind: "real", connection: "team-inbox" } } };
const badAnalysis = { review: { analysis: "yes" } };
const analysis = { review: { analysis: { maxCostUsd: 1 } } };
const tasks = { actors: [{ type: "synthetic-persona", tasks: [{ id: "t", goal: "g" }] }] };

describe("preview admission", () => {
  it.each([
    ["real receiving", receiving, "HUMANISH_LAB_COMMS_UNSUPPORTED"],
    ["invalid analysis", badAnalysis, "HUMANISH_LAB_ANALYSIS_INVALID"],
    ["declared analysis", analysis, "HUMANISH_LAB_ANALYSIS_UNSUPPORTED"],
    ["tasks", tasks, "HUMANISH_LAB_TASKS_UNSUPPORTED"],
    [
      "receiving wins over analysis",
      { ...receiving, ...badAnalysis },
      "HUMANISH_LAB_COMMS_UNSUPPORTED",
    ],
    ["analysis wins over tasks", { ...analysis, ...tasks }, "HUMANISH_LAB_ANALYSIS_UNSUPPORTED"],
  ] as const)("refuses %s before any run", async (_name, extra, code) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-preview-admission-"));
    dirs.push(cwd);
    const outcome = await runLab(preview(extra), { cwd, dryRun: true });
    expect(outcome.backend).toBe("synthetic");
    expect(outcome.result).toEqual({
      schema: "humanish.run-result.v1",
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
          (await runLab(preview(extra), { cwd, dryRun: true })).result.error?.message,
      ),
    );
    await expect(`${JSON.stringify(messages, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/plans/preview-admission-messages.json",
    );
  });
});
