import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ObserverData } from "../../src/observer/data";
import { renderObserver } from "../../src/observer/render";
import {
  ONE_ANALYSIS_RUN,
  TWO_ATTEMPTS_RUN,
  writeRunCostFixtures,
} from "../../tests/helpers/run-cost-fixtures";
import { gridSummary } from "../components/study-grid";
import { parseStudyAnalysis } from "../lib/study-analysis";

// The Observer's cost line on the two runs every cost surface is pinned on
// (tests/run/run-cost-surfaces.test.ts): rendered by the CLI, read as the app reads it.

let cwd: string;
beforeAll(async () => {
  cwd = await writeRunCostFixtures();
});
afterAll(async () => {
  await rm(path.dirname(cwd), { recursive: true, force: true });
});

/** The run's cost line as the app shows it: its data and companion analysis, parsed as it parses them. */
async function costLine(runId: string): Promise<string> {
  expect((await renderObserver(cwd, runId)).ok).toBe(true);
  const observer = path.join(cwd, ".humanish", "runs", runId, "observer");
  const data = JSON.parse(
    await readFile(path.join(observer, "observer-data.json"), "utf8"),
  ) as ObserverData;
  const analysis = parseStudyAnalysis(
    JSON.parse(await readFile(path.join(observer, "study-analysis.json"), "utf8")),
    data,
  );
  return gridSummary(data, undefined, analysis.spend);
}

describe("the Observer's cost line", () => {
  it("shows one analysis and the total with it", async () => {
    const line = await costLine(ONE_ANALYSIS_RUN);
    expect(line).toContain(
      "Participants + desktops: est. ~$0.02 plus unpriced usage (rates as of 2026-09-05) · Analysis: est. ~$0.53 (OpenAI API key) · Total: est. ~$0.55 plus unpriced usage",
    );
  });

  it("counts both attempts of a run that analyzed twice", async () => {
    const line = await costLine(TWO_ATTEMPTS_RUN);
    expect(line).toContain(
      "2 analyses: est. ~$1.04 (OpenAI API key) · Total: est. ~$1.06 plus unpriced usage",
    );
  });
});
