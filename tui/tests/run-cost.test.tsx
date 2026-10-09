import { rm } from "node:fs/promises";
import path from "node:path";

import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import type { TuiOptions } from "../../src/tui/contract.js";
import { readRunIndex } from "../../src/run/run-index.js";
import { KEY, renderToText } from "../src/testing/render-to-text.js";
import {
  FIXTURE_STUDY,
  ONE_ANALYSIS_RUN,
  writePre109Status,
  writeRunCostFixtures,
} from "../../tests/helpers/run-cost-fixtures.js";

// The TUI's past-run rows on the two runs every cost surface is pinned on
// (tests/run/run-cost-surfaces.test.ts), read through the real run index.

let cwd: string;
beforeAll(async () => {
  cwd = await writeRunCostFixtures();
});
afterAll(async () => {
  await rm(path.dirname(cwd), { recursive: true, force: true });
});

const options = (): TuiOptions => ({
  cwd,
  version: { cli: "9.9.9" },
  capabilities: {
    readRunIndex: async () => readRunIndex(cwd),
    listStudies: async () => ({
      schema: "humanish.study-list.v1",
      ok: true,
      cwd,
      studies: [
        {
          id: FIXTURE_STUDY,
          source: "app-url",
          origin: "committed",
          path: `humanish/studies/${FIXTURE_STUDY}.yaml`,
        },
      ],
      warnings: [],
    }),
    startRun: async () => ({ ok: true, run: { pid: 4242, logPath: "/tmp/x.log", command: [] } }),
    readLaunchLog: async () => "",
    readRunDetail: async () => null,
    readStudySummary: async () => null,
    readProjectState: () => ({
      schema: "humanish.tui-project.v1" as const,
      initialized: true,
      hasRuntime: true,
    }),
    openObserver: async () => ({
      schema: "humanish.tui-action.v1" as const,
      ok: true,
      message: "opened",
    }),
    reclaimRun: async () => ({
      schema: "humanish.reclaim-result.v1" as const,
      ok: true,
      state: "clean" as const,
      mode: "kill" as const,
      tagSearch: { status: "done" as const, found: 0 },
      createsInFlight: 0,
      cwd,
      runId: "r",
      receiptCount: 0,
      outcomes: [],
      warnings: [],
    }),
    stopRun: async () => ({
      schema: "humanish.tui-action.v1" as const,
      ok: true,
      message: "asked the run to stop",
    }),
  },
  stdin: process.stdin,
  stdout: process.stdout,
});

describe("a study's past runs", () => {
  it("show each run's cost with its analyses, as every other surface does", async () => {
    const surface = await renderToText(
      <App options={options()} now={Date.parse("2026-10-03T07:00:00.000Z")} tick={0} />,
      {
        columns: 140,
        until: (frame) => frame.includes(FIXTURE_STUDY) && !frame.includes("reading project"),
      },
    );
    const study = await surface.press(KEY.enter, (frame) => frame.includes("with 2 analyses"));
    surface.unmount();
    expect(study).toContain("run ~$0.55 est. plus unpriced usage, with analysis");
    expect(study).toContain("run ~$1.06 est. plus unpriced usage, with 2 analyses");
    expect(study).not.toContain("excl. analysis");
  });

  it("give the study a median over the same costs, analyses included", async () => {
    const surface = await renderToText(
      <App options={options()} now={Date.parse("2026-10-03T07:00:00.000Z")} tick={0} />,
      {
        columns: 140,
        until: (frame) => frame.includes(FIXTURE_STUDY) && !frame.includes("reading project"),
      },
    );
    const study = await surface.press(KEY.enter, (frame) => frame.includes("with 2 analyses"));
    surface.unmount();
    // The two runs cost $0.545128 and $1.059219 with their analyses; the median of two is their
    // mean, $0.802174. Participants and desktops alone are $0.016123 each.
    expect(study).toContain("~$0.80 median · 2 runs");
  });

  it("make no completeness claim for a status record written before 0.109", async () => {
    await writePre109Status(cwd, ONE_ANALYSIS_RUN);
    const surface = await renderToText(
      <App options={options()} now={Date.parse("2026-10-03T07:00:00.000Z")} tick={0} />,
      {
        columns: 140,
        until: (frame) => frame.includes(FIXTURE_STUDY) && !frame.includes("reading project"),
      },
    );
    const study = await surface.press(KEY.enter, (frame) => frame.includes("with 2 analyses"));
    surface.unmount();
    expect(study).toContain("run ~$0.55 est., with analysis");
    expect(study).toContain("run ~$1.06 est. plus unpriced usage, with 2 analyses");
  });
});
