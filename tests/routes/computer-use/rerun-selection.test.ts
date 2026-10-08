// A rerun of `latest` in a project with no runs says so; one whose latest run cannot be read
// names the run and the command that lists the project's runs.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCuaRerunSelection } from "../../../src/routes/computer-use/rerun-selection.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

const INSTEAD =
  "To run every participant of fanout-proof instead, leave out --rerun-failed-from: humanish watch fanout-proof or humanish run fanout-proof.";

async function refusal(cwd: string, sourceRunId: string): Promise<string | undefined> {
  const selection = await resolveCuaRerunSelection({
    cwd,
    studyId: "fanout-proof",
    sandboxMs: 60_000,
    sourceRunId,
    participantRuns: [],
    participantPlan: {
      strategy: "per-lane-worlds",
      laneCount: 0,
      concurrency: 1,
      waves: 0,
      perLaneSessionBudgetMs: 60_000,
      worstCaseSandboxMinutes: 0,
      dryRun: true,
      lanes: [],
    },
  });
  return selection.ok ? undefined : selection.message;
}

describe("a rerun with no run to read", () => {
  it("says the project has no runs when it has no latest run", async () => {
    const cwd = await makeTestTempDir("humanish-rerun-none-");
    expect(await refusal(cwd, "latest")).toBe(
      `--rerun-failed-from latest found no run: this project has no runs yet, and a rerun repeats the failed participants of an earlier live run. ${INSTEAD}`,
    );
  });

  it("names the run when the latest pointer leads to no readable run", async () => {
    const cwd = await makeTestTempDir("humanish-rerun-gone-");
    await mkdir(path.join(cwd, ".humanish", "runs"), { recursive: true });
    await writeFile(
      path.join(cwd, ".humanish", "runs", "latest.json"),
      `${JSON.stringify({ runId: "removed-run", path: ".humanish/runs/removed-run" })}\n`,
    );
    const expected = `names no run humanish can read in this project. humanish runs lists its runs. ${INSTEAD}`;
    expect(await refusal(cwd, "latest")).toBe(`--rerun-failed-from latest ${expected}`);
    expect(await refusal(cwd, "removed-run")).toBe(`--rerun-failed-from removed-run ${expected}`);
  });
});
