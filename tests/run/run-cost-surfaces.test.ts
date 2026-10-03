import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LoadedAnalysis } from "../../src/analysis/types.js";
import type { ObserverData } from "../../src/observer/data.js";
import type { LibraryHistory } from "../../src/observer/library.js";
import { renderObserver } from "../../src/observer/render.js";
import { serveObserverLibrary, type ServeLibraryServer } from "../../src/observer/serve.js";
import { readRunIndex } from "../../src/run/run-index.js";
import { indexedRunCost, runCost, runCostLabel, runCostParts } from "../../src/run/run-cost.js";
import { computeStats } from "../../src/run/stats.js";
import {
  ONE_ANALYSIS_RUN,
  TWO_ATTEMPTS_RUN,
  writePre109Status,
  writeRunCostFixtures,
} from "../helpers/run-cost-fixtures.js";

// Every surface that shows one run's cost, on the same two runs: stats, the run index the TUI
// reads, the Observer's data and cost line, and the library row. They read one analysis reader
// and one cost function, so they must agree to the cent.

const EXPECTED = {
  [ONE_ANALYSIS_RUN]: {
    analysisCost: { requests: 1, estimatedUsd: 0.529005, complete: true, providers: ["openai"] },
    statsTotal: 0.545128,
    parts: [
      "Participants + desktops: est. ~$0.02 plus unpriced usage (rates as of 2026-09-05)",
      "Analysis: est. ~$0.53 (OpenAI API key)",
      "Total: est. ~$0.55 plus unpriced usage",
    ],
    label: "~$0.55 est. plus unpriced usage, with analysis",
  },
  [TWO_ATTEMPTS_RUN]: {
    analysisCost: { requests: 2, estimatedUsd: 1.043096, complete: true, providers: ["openai"] },
    statsTotal: 1.059219,
    parts: [
      "Participants + desktops: est. ~$0.02 plus unpriced usage (rates as of 2026-09-05)",
      "2 analyses: est. ~$1.04 (OpenAI API key)",
      "Total: est. ~$1.06 plus unpriced usage",
    ],
    label: "~$1.06 est. plus unpriced usage, with 2 analyses",
  },
};
const RUNS = [ONE_ANALYSIS_RUN, TWO_ATTEMPTS_RUN] as const;

let cwd: string;
let library: ServeLibraryServer | undefined;
beforeAll(async () => {
  cwd = await writeRunCostFixtures();
});
afterAll(async () => {
  await library?.close();
  await rm(path.dirname(cwd), { recursive: true, force: true });
});

describe.each(RUNS)("the cost of %s", (runId) => {
  const expected = EXPECTED[runId];

  it("is the same in stats as the participants and desktops plus every analysis", async () => {
    const stats = await computeStats(cwd);
    if (!stats.ok) throw new Error(stats.error.message);
    const row = stats.costsByRun.find((candidate) => candidate.runId === runId);
    expect(row?.costs.estimatedTotalUsd).toBe(expected.statsTotal);
    expect(row?.costs.runEstimatedUsd).toBe(0.016123);
    expect(row?.costs.analysisEstimatedUsd).toBe(expected.analysisCost.estimatedUsd);
  });

  it("is in the run index the terminal UI reads, beside the unchanged participants-and-desktops figure", async () => {
    const entry = (await readRunIndex(cwd)).runs.find((candidate) => candidate.runId === runId);
    expect(entry?.derivedFrom).toBe("status");
    expect(entry?.estimatedCostUsd).toBe(0.016123);
    expect(entry?.estimatedCostComplete).toBe(false);
    expect(entry?.analysisCost).toEqual(expected.analysisCost);
    // What the terminal UI shows for the run, from the index alone.
    const cost = indexedRunCost(entry!);
    expect(cost.total?.usd).toBe(expected.statsTotal);
    expect(runCostLabel(cost)).toBe(expected.label);
  });

  it("is in the Observer's companion analysis record and its cost line", async () => {
    expect((await renderObserver(cwd, runId)).ok).toBe(true);
    const observer = path.join(cwd, ".humanish", "runs", runId, "observer");
    const data = JSON.parse(
      await readFile(path.join(observer, "observer-data.json"), "utf8"),
    ) as ObserverData;
    const analysis = JSON.parse(
      await readFile(path.join(observer, "study-analysis.json"), "utf8"),
    ) as LoadedAnalysis;
    expect(analysis.spend).toEqual(expected.analysisCost);
    const cost = runCost(data.cost, analysis.spend);
    expect(cost.total?.usd).toBe(expected.statsTotal);
    expect(runCostParts(cost)).toEqual(expected.parts);
    expect(runCostLabel(cost)).toBe(expected.label);
  });

  it("is on the library row", async () => {
    if (!library) {
      const started = await serveObserverLibrary(cwd, {
        port: 0,
        safe: false,
        expose: false,
        edgeAuthed: false,
      });
      if (!started.ok) throw new Error(started.error.message);
      library = started.server;
    }
    const history = (await (
      await fetch(new URL("/_humanish/history.json", library.url))
    ).json()) as LibraryHistory;
    const row = history.runs.find((candidate) => candidate.runId === runId);
    expect(row?.estimatedCostUsd).toBe(0.016123);
    expect(row?.costLabel).toBe(expected.label);
  });
});

describe("a run whose status record predates estimatedCostComplete", () => {
  let oldCwd: string;
  beforeAll(async () => {
    oldCwd = await writeRunCostFixtures();
    await writePre109Status(oldCwd, ONE_ANALYSIS_RUN);
  });
  afterAll(async () => {
    await rm(path.dirname(oldCwd), { recursive: true, force: true });
  });

  it("makes no completeness claim where the status record is the source", async () => {
    const entry = (await readRunIndex(oldCwd)).runs.find(
      (candidate) => candidate.runId === ONE_ANALYSIS_RUN,
    );
    expect(entry?.derivedFrom).toBe("status");
    expect(entry?.estimatedCostComplete).toBeUndefined();
    const cost = indexedRunCost(entry!);
    expect(cost.total).toEqual({ usd: 0.545128, complete: null });
    // Neither "plus unpriced usage" nor a claim that the figure is whole.
    expect(runCostLabel(cost)).toBe("~$0.55 est., with analysis");
  });

  it("leaves the Observer and the library on the bundle's own completeness", async () => {
    expect((await renderObserver(oldCwd, ONE_ANALYSIS_RUN)).ok).toBe(true);
    const observer = path.join(oldCwd, ".humanish", "runs", ONE_ANALYSIS_RUN, "observer");
    const data = JSON.parse(
      await readFile(path.join(observer, "observer-data.json"), "utf8"),
    ) as ObserverData;
    const analysis = JSON.parse(
      await readFile(path.join(observer, "study-analysis.json"), "utf8"),
    ) as LoadedAnalysis;
    expect(runCostLabel(runCost(data.cost, analysis.spend))).toBe(EXPECTED[ONE_ANALYSIS_RUN].label);
  });
});
