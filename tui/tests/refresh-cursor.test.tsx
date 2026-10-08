import React from "react";
import { describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import type { RunDetail } from "../../src/run/detail.js";
import type { RunIndexEntry } from "../../src/run/run-index.js";
import type { StudyListEntry } from "../../src/study/discover.js";
import type { TuiCapabilities, TuiOptions } from "../../src/tui/contract.js";
import { KEY, renderToText } from "../src/testing/render-to-text.js";
import { NOW } from "./fixtures.js";

// The cursor marks the row the person chose, and Enter acts on it. When a refresh reorders the rows
// (a study goes live and sorts first, a run finishes and its actions change), the cursor has to
// follow that row: left on the old row number, Enter acts on a row nobody chose.

/** Long enough for the surface's 2 s refresh to land and the cursor to settle. */
const REFRESH_WAIT_MS = 6_000;

const STUDIES: StudyListEntry[] = [
  {
    id: "alpha",
    source: "app-url",
    origin: "committed",
    path: "humanish/studies/alpha.yaml",
    title: "Alpha",
  },
  {
    id: "beta",
    source: "app-url",
    origin: "committed",
    path: "humanish/studies/beta.yaml",
    title: "Beta",
  },
];

const BETA_RUN_ID = "cua-2026-08-19T11-30-00-000Z-0b0b0b0b";

const BETA_RUNNING: RunIndexEntry = {
  runId: BETA_RUN_ID,
  derivedFrom: "status",
  liveness: "running",
  mode: "live",
  study: { id: "beta" },
  startedAt: new Date(NOW - 60_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
};

const BETA_FINISHED: RunIndexEntry = {
  ...BETA_RUNNING,
  liveness: "finished",
  completedAt: new Date(NOW).toISOString(),
  verdict: "pass",
  participants: { total: 1, reachedGoal: 1 },
  estimatedCostUsd: 0.4,
  durationMs: 60_000,
};

/** Alpha's earlier run, and one started after it that lists above it. */
const ALPHA_EARLIER: RunIndexEntry = {
  runId: "cua-2026-08-19T10-00-00-000Z-0a0a0a01",
  derivedFrom: "status",
  liveness: "finished",
  mode: "live",
  study: { id: "alpha" },
  startedAt: new Date(NOW - 120 * 60_000).toISOString(),
  completedAt: new Date(NOW - 118 * 60_000).toISOString(),
  verdict: "pass",
  participants: { total: 1, reachedGoal: 1 },
  estimatedCostUsd: 0.4,
  durationMs: 120_000,
};

const ALPHA_LATER: RunIndexEntry = {
  runId: "cua-2026-08-19T11-59-00-000Z-0a0a0a02",
  derivedFrom: "status",
  liveness: "running",
  mode: "live",
  study: { id: "alpha" },
  startedAt: new Date(NOW - 60_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
};

const BETA_DETAIL: RunDetail = {
  schema: "humanish.run-detail.v1",
  runId: BETA_RUN_ID,
  observerPath: `.humanish/runs/${BETA_RUN_ID}/observer/index.html`,
  participants: [],
};

/**
 * A project whose run index the test changes between refreshes, recording what Enter asked the
 * capabilities to do.
 */
function project(initialRuns: RunIndexEntry[]) {
  let runs = initialRuns;
  const started: string[] = [];
  const opened: string[] = [];
  const capabilities: TuiCapabilities = {
    readRunIndex: async () => ({
      schema: "humanish.run-index.v1",
      cwd: "/projects/acme-app",
      runs,
      unreadable: [],
    }),
    listStudies: async () => ({
      schema: "humanish.study-list.v1",
      retired: [],
      ok: true,
      cwd: "/projects/acme-app",
      studies: STUDIES,
      warnings: [],
    }),
    startRun: async (request) => {
      started.push(request.study);
      return {
        ok: true,
        run: { pid: 4242, launchedAt: new Date(NOW).toISOString(), logPath: "/tmp/x", command: [] },
      };
    },
    readLaunchLog: async () => "",
    readRunDetail: async (_cwd, runId) => (runId === BETA_RUN_ID ? BETA_DETAIL : null),
    readStudySummary: async () => null,
    readProjectState: () => ({
      schema: "humanish.tui-project.v1" as const,
      initialized: true,
      hasRuntime: true,
    }),
    openObserver: async (_cwd, observerPath) => {
      opened.push(observerPath);
      return { schema: "humanish.tui-action.v1" as const, ok: true, message: "opened" };
    },
    reclaimRun: async () => {
      throw new Error("no run here needs reclaiming");
    },
    stopRun: async () => ({
      schema: "humanish.tui-action.v1" as const,
      ok: true,
      message: "asked the run to stop",
    }),
    initProject: async () => ({
      schema: "humanish.tui-action.v1" as const,
      ok: true,
      message: "initialized",
    }),
  };
  const options: TuiOptions = {
    cwd: "/projects/acme-app",
    version: { cli: "9.9.9" },
    capabilities,
    stdin: process.stdin,
    stdout: process.stdout,
  };
  return {
    options,
    started,
    opened,
    setRuns: (next: RunIndexEntry[]) => {
      runs = next;
    },
  };
}

async function openSurface(options: TuiOptions) {
  return renderToText(<App options={options} now={NOW} tick={0} />, {
    rows: 30,
    until: (frame) => frame.includes("Beta"),
  });
}

/** The line the cursor is on. */
function cursorLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("❯")) ?? "";
}

/** Press a key until the cursor reaches the wanted row, without counting rows in the test. */
async function pressUntil(
  surface: Awaited<ReturnType<typeof openSurface>>,
  key: string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  for (let index = 0; index < 6; index += 1) {
    try {
      return await surface.press(key, predicate, 400);
    } catch {
      // Not on the wanted row yet.
    }
  }
  throw new Error("pressUntil: the cursor never reached the wanted row");
}

/** On the studies list, Beta precedes Alpha only once a refresh has read Beta's live run. */
function betaListedFirst(frame: string): boolean {
  const beta = frame.indexOf("Beta");
  const alpha = frame.indexOf("Alpha");
  return beta >= 0 && alpha >= 0 && beta < alpha;
}

describe("the cursor through a refresh that reorders the rows", () => {
  it("follows the selected study when it goes live and sorts first, and Enter opens it", async () => {
    const lab = project([]);
    const surface = await openSurface(lab.options);
    try {
      await surface.press(KEY.down, (frame) => cursorLine(frame).includes("Beta"));
      lab.setRuns([BETA_RUNNING]);
      const settled = await surface
        .waitFor(
          (frame) => betaListedFirst(frame) && cursorLine(frame).includes("Beta"),
          REFRESH_WAIT_MS,
        )
        .catch(() => surface.frames.filter(betaListedFirst).at(-1) ?? "");
      expect(cursorLine(settled)).toContain("Beta");

      const opened = await surface.press(KEY.enter, (frame) => frame.includes("‹ studies /"));
      expect(opened).toContain("‹ studies / beta");
    } finally {
      surface.unmount();
    }
  }, 20_000);

  it("puts the cursor back on the selected study after Escape when the list reordered meanwhile", async () => {
    const lab = project([]);
    const surface = await openSurface(lab.options);
    try {
      await surface.press(KEY.down, (frame) => cursorLine(frame).includes("Beta"));
      await surface.press(KEY.enter, (frame) => frame.includes("‹ studies / beta"));
      lab.setRuns([BETA_RUNNING]);
      // Beta's screen lists the run once a refresh has read it; the studies list behind it has
      // reordered by then.
      await surface.waitFor(
        (frame) => frame.includes("‹ studies / beta") && frame.includes("starting…"),
        REFRESH_WAIT_MS,
      );

      const back = await surface.press(KEY.escape, betaListedFirst);
      const settled = await surface
        .waitFor((frame) => betaListedFirst(frame) && cursorLine(frame).includes("Beta"), 1_000)
        .catch(() => back);
      expect(cursorLine(settled)).toContain("Beta");

      const opened = await surface.press(KEY.enter, (frame) => frame.includes("‹ studies /"));
      expect(opened).toContain("‹ studies / beta");
    } finally {
      surface.unmount();
    }
  }, 20_000);

  it("follows the selected run on a study's screen when a newer run lists above it", async () => {
    const lab = project([ALPHA_EARLIER]);
    const surface = await openSurface(lab.options);
    try {
      // Alpha has run and Beta has not, so Alpha is the first row.
      await surface.press(KEY.enter, (frame) => frame.includes("‹ studies / alpha"));
      await pressUntil(surface, KEY.down, (frame) =>
        cursorLine(frame).includes("1/1 reached the goal"),
      );
      lab.setRuns([ALPHA_LATER, ALPHA_EARLIER]);
      const newerListed = (frame: string): boolean => frame.includes("starting…");
      const settled = await surface
        .waitFor(
          (frame) => newerListed(frame) && cursorLine(frame).includes("1/1 reached the goal"),
          REFRESH_WAIT_MS,
        )
        .catch(() => surface.frames.filter(newerListed).at(-1) ?? "");
      expect(cursorLine(settled)).toContain("1/1 reached the goal");

      const opened = await surface.press(KEY.enter, (frame) =>
        frame.includes("‹ studies / alpha /"),
      );
      expect(opened).toContain("0a0a0a01");
    } finally {
      surface.unmount();
    }
  }, 20_000);

  it("follows the selected run action when the run finishes, so Enter does not start a new run", async () => {
    const lab = project([BETA_RUNNING]);
    const surface = await openSurface(lab.options);
    try {
      // Beta is live, so it is the first row.
      await surface.press(KEY.enter, (frame) => frame.includes("‹ studies / beta"));
      await pressUntil(surface, KEY.down, (frame) => cursorLine(frame).includes("starting…"));
      await surface.press(KEY.enter, (frame) => frame.includes("Open in Observer"));
      await surface.press(KEY.down, (frame) => cursorLine(frame).includes("Open in Observer"));
      lab.setRuns([BETA_FINISHED]);
      const finished = (frame: string): boolean => frame.includes("Run again");
      const settled = await surface
        .waitFor(
          (frame) => finished(frame) && cursorLine(frame).includes("Open in Observer"),
          REFRESH_WAIT_MS,
        )
        .catch(() => surface.frames.filter(finished).at(-1) ?? "");
      expect(cursorLine(settled)).toContain("Open in Observer");

      await surface.press(KEY.enter, (frame) => frame.includes("opened") || frame.includes("pid"));
      expect(lab.opened).toEqual([BETA_DETAIL.observerPath]);
      expect(lab.started).toEqual([]);
    } finally {
      surface.unmount();
    }
  }, 20_000);
});
