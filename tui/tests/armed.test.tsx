import React from "react";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/app.js";
import type { RunDetail } from "../../src/run/detail.js";
import type { TuiCapabilities, TuiOptions } from "../../src/tui/contract.js";
import { KEY, renderToText, type RenderedFrames } from "../src/testing/render-to-text.js";
import { LABS, NOW, RUNS } from "./fixtures.js";

// Five actions take two Enters, because each spends money, ends work already paid for, or writes
// into the operator's directory. The second Enter confirms only while the cursor is still on the
// armed action, the screen has not changed and the window has not passed. Each case arms, goes
// somewhere else, comes back and presses Enter past the auto-repeat floor: that Enter arms again
// and does nothing.

const RUNNING = RUNS[0]!;

/** Past the floor that turns away a held Enter, so only the arming decides what Enter does. */
const FLOOR_WAIT_MS = 450;

interface Project {
  options: TuiOptions;
  /** Every call that would have spent money, ended work or written into the directory. */
  acted: string[];
}

function project({
  initialized = true,
  analysis = false,
}: { initialized?: boolean; analysis?: boolean } = {}): Project {
  const acted: string[] = [];
  const detail = (runId: string): RunDetail => ({
    schema: "humanish.run-detail.v1",
    runId,
    observerPath: `.humanish/runs/${runId}/observer/index.html`,
    participants: [],
    ...(analysis && runId === RUNNING.runId
      ? {
          automaticAnalysis: {
            state: "queued" as const,
            analysisId: null,
            reason: null,
            updatedAt: new Date(NOW).toISOString(),
          },
        }
      : {}),
  });
  const capabilities: TuiCapabilities = {
    readRunIndex: async () => ({
      schema: "humanish.run-index.v1",
      cwd: "/projects/acme-app",
      runs: initialized ? RUNS : [],
      unreadable: [],
    }),
    listStudies: async () => ({
      schema: "humanish.study-list.v1",
      retired: [],
      ok: true,
      cwd: "/projects/acme-app",
      studies: initialized ? LABS : [],
      warnings: [],
    }),
    startRun: async (launch) => {
      acted.push(`start ${launch.mode}`);
      return {
        ok: true,
        run: { pid: 4242, launchedAt: new Date(NOW).toISOString(), logPath: "/tmp/x", command: [] },
      };
    },
    readLaunchLog: async () => "",
    readRunDetail: async (_cwd, runId) => detail(runId),
    readStudySummary: async () => null,
    readProjectState: () => ({ schema: "humanish.tui-project.v1", initialized, hasRuntime: true }),
    openObserver: async () => ({ schema: "humanish.tui-action.v1", ok: true, message: "opened" }),
    reclaimRun: async () => ({
      schema: "humanish.reclaim-result.v1",
      ok: true,
      state: "clean",
      mode: "kill",
      tagSearch: { status: "done", found: 0 },
      createsInFlight: 0,
      cwd: "/projects/acme-app",
      runId: "r",
      receiptCount: 0,
      outcomes: [],
      warnings: [],
    }),
    stopRun: async (_cwd, _runId, intent = "run") => {
      acted.push(`stop ${intent}`);
      return { schema: "humanish.tui-action.v1", ok: true, message: "asked the run to stop" };
    },
    initProject: async () => {
      acted.push("init");
      return { schema: "humanish.tui-action.v1", ok: true, message: "set up humanish" };
    },
  };
  return {
    acted,
    options: {
      cwd: "/projects/acme-app",
      version: { cli: "9.9.9" },
      capabilities,
      stdin: process.stdin,
      stdout: process.stdout,
    },
  };
}

function cursorLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("❯")) ?? "";
}

const onRow =
  (text: string) =>
  (frame: string): boolean =>
    cursorLine(frame).includes(text);

/** Press `key` until the cursor reaches the row, at most `limit` times. */
async function pressUntil(
  surface: RenderedFrames,
  key: string,
  until: (frame: string) => boolean,
  limit = 6,
): Promise<string> {
  for (let index = 0; index < limit; index += 1) {
    const frame = await surface.press(key);
    if (until(frame)) return frame;
  }
  return surface.waitFor(until);
}

/** Signup flow has the running run, so it lists first and Enter opens it. */
async function openStudy(surface: RenderedFrames): Promise<void> {
  await surface.press(KEY.enter, onRow("Start a dry run"));
}

async function openRun(surface: RenderedFrames, row: string, action: string): Promise<void> {
  await openStudy(surface);
  await pressUntil(surface, KEY.down, onRow(row));
  await surface.press(KEY.enter, (frame) => frame.includes(action));
}

interface Case {
  name: string;
  project: () => Project;
  /** From the first frame to the frame with the cursor on the action. */
  reach: (surface: RenderedFrames) => Promise<void>;
  /** What the frame says while the action is armed. */
  prompt: string;
  /** Keys that go somewhere else, each with the frame it lands on. */
  away: [string, (frame: string) => boolean][];
  /** Keys that come back, ending on the frame with the cursor on the action again. */
  back: [string, (frame: string) => boolean][];
}

const CASES: Case[] = [
  {
    name: "Stop this run",
    project: () => project(),
    reach: (surface) => openRun(surface, "starting…", "❯ Stop this run"),
    prompt: "stop this run?",
    away: [[KEY.down, onRow("Open in Observer")]],
    back: [[KEY.up, onRow("Stop this run")]],
  },
  {
    name: "Cancel analysis",
    project: () => project({ analysis: true }),
    reach: async (surface) => {
      await openRun(surface, "starting…", "Cancel analysis");
      await surface.press(KEY.down, onRow("Cancel analysis"));
    },
    prompt: "cancel analysis?",
    away: [[KEY.up, onRow("Open in Observer")]],
    back: [[KEY.down, onRow("Cancel analysis")]],
  },
  {
    name: "Start a live run",
    project: () => project(),
    reach: async (surface) => {
      await openStudy(surface);
      await surface.press(KEY.down, onRow("Start a live run"));
    },
    prompt: "start a live run?",
    away: [[KEY.up, onRow("Start a dry run")]],
    back: [[KEY.down, onRow("Start a live run")]],
  },
  {
    name: "Run again on a live run",
    project: () => project(),
    reach: async (surface) => {
      await openRun(surface, "2/2 reached the goal", "Run again");
      await surface.press(KEY.down, onRow("Run again"));
    },
    prompt: "run again live?",
    away: [["g", onRow("Open in Observer")]],
    back: [["G", onRow("Run again")]],
  },
  {
    name: "Set up humanish here",
    project: () => project({ initialized: false }),
    reach: (surface) => surface.waitFor(onRow("Set up humanish here")).then(() => undefined),
    prompt: "⏎ again to confirm",
    away: [["?", (frame) => frame.includes("Keyboard shortcuts")]],
    back: [[KEY.escape, onRow("Set up humanish here")]],
  },
];

async function render(options: TuiOptions): Promise<RenderedFrames> {
  return renderToText(<App options={options} now={NOW} tick={0} />, {
    columns: 80,
    rows: 30,
    until: (frame) => frame.trim().length > 0 && !frame.includes("reading project"),
  });
}

describe("an armed action", () => {
  it.each(CASES)(
    "$name: Enter after going somewhere else and coming back arms again and does nothing",
    async ({ project: makeProject, reach, prompt, away, back }) => {
      const { options, acted } = makeProject();
      const surface = await render(options);
      try {
        await reach(surface);
        await surface.press(KEY.enter, (frame) => frame.includes(prompt));
        for (const [key, until] of away) await surface.press(key, until);
        let returned = "";
        for (const [key, until] of back) returned = await surface.press(key, until);
        expect(returned).not.toContain(prompt);

        await new Promise((resolve) => setTimeout(resolve, FLOOR_WAIT_MS));
        const pressed = await surface.press(
          KEY.enter,
          (frame) => frame.includes(prompt) || acted.length > 0,
        );
        expect(acted).toEqual([]);
        expect(pressed).toContain(prompt);
      } finally {
        surface.unmount();
      }
    },
    20_000,
  );

  it("disarms when its window passes, so a later Enter arms again", async () => {
    // Timers advance with the real clock, so the surface still renders and the waits still expire.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const { options, acted } = project();
    const surface = await render(options);
    try {
      await openRun(surface, "starting…", "❯ Stop this run");
      await surface.press(KEY.enter, (frame) => frame.includes("stop this run?"));
      // Someone armed Stop and walked away for a minute.
      const from = surface.frames.length;
      vi.advanceTimersByTime(60_000);
      await vi.waitFor(() =>
        expect(
          surface.frames
            .slice(from)
            .some(
              (frame) => frame.includes("❯ Stop this run") && !frame.includes("stop this run?"),
            ),
        ).toBe(true),
      );

      const pressed = await surface.press(
        KEY.enter,
        (frame) => frame.includes("stop this run?") || acted.length > 0,
      );
      expect(acted).toEqual([]);
      expect(pressed).toContain("stop this run?");
    } finally {
      vi.useRealTimers();
      surface.unmount();
    }
  }, 20_000);

  it("still confirms on the second Enter when nothing came between", async () => {
    const { options, acted } = project();
    const surface = await render(options);
    try {
      await openRun(surface, "2/2 reached the goal", "Run again");
      await surface.press(KEY.down, onRow("Run again"));
      await surface.press(KEY.enter, (frame) => frame.includes("run again live?"));
      await new Promise((resolve) => setTimeout(resolve, FLOOR_WAIT_MS));
      await surface.press(KEY.enter, (frame) => frame.includes("started"));
      expect(acted).toEqual(["start live"]);
    } finally {
      surface.unmount();
    }
  }, 20_000);
});
