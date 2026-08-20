import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import React from "react";
import { describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import type { RunDetail } from "../../src/run-detail.js";
import type { TuiCapabilities, TuiOptions } from "../../src/tui-contract.js";
import { KEY, normalizeFrame, renderToText } from "../src/testing/render-to-text.js";
import { LABS, NOW, RUNS } from "./fixtures.js";

// The screen someone actually watches while a study is running.
//
// Daniel's steer, verbatim: "running has an over-emphasis on cost vs. the details of the persona
// (abbreviated / truncated) and the current train of thought". So these assert the ORDER of the
// frame as much as its content — a participant and their thinking above the money.
//
// The detail shape mirrors a real computer-use run (`humanish.actor-trace.v1`), read off an actual
// run rather than invented.

const GOLDEN_DIR = path.join(import.meta.dirname, "golden");

async function expectGolden(name: string, actual: string): Promise<void> {
  const file = path.join(GOLDEN_DIR, `${name}.txt`);
  if (process.env.UPDATE_TUI_GOLDENS === "1") {
    await writeFile(file, `${actual}\n`, "utf8");
    return;
  }
  const expected = await readFile(file, "utf8");
  expect(actual).toBe(expected.replace(/\n$/, ""));
}

const LIVE_DETAIL: RunDetail = {
  schema: "humanish.run-detail.v1",
  runId: "cua-2026-08-19T11-30-00-000Z-aa11bb22",
  observerPath: ".humanish/runs/cua-2026-08-19T11-30-00-000Z-aa11bb22/observer/index.html",
  participants: [
    {
      id: "stream-001",
      label: "CUA browser — signup flow",
      personaId: "synthetic-new-user",
      traits: ["patience:medium", "skill:medium", "accessibility:clear_terminal_output"],
      status: "running",
      turns: 12,
      actions: 31,
      thought: {
        text: "**Connecting fields for relationships**\n\nI'm thinking about connecting fields to establish relationships between the notes and projects. The naming of owner_id seems a bit off.",
        title: "reasoning turn 12",
        at: "2026-08-19T11:58:00.000Z"
      }
    }
  ]
};

function options(detail: RunDetail | null, runs = RUNS): TuiOptions {
  const capabilities: TuiCapabilities = {
    readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs, unreadable: [] }),
    listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: LABS, warnings: [] }),
    startRun: async () => ({ ok: true, run: { pid: 1, launchedAt: new Date(NOW).toISOString(), logPath: "/tmp/x", command: [] } }),
    readLaunchLog: async () => "",
    readRunDetail: async () => detail,
    readLabSummary: async () => null,
      readProjectState: () => ({ schema: "humanish.tui-project.v1" as const, initialized: true, hasRuntime: true }),
      openObserver: async () => ({ schema: "humanish.tui-action.v1" as const, ok: true, message: "opened" }),
      reclaimRun: async () => ({ schema: "humanish.reclaim-result.v1" as const, ok: true, cwd: "/x", runId: "r", receiptCount: 0, outcomes: [], warnings: [] })
  };
  return {
    cwd: "/projects/acme-app",
    version: { cli: "9.9.9" },
    capabilities,
    stdin: process.stdin,
    stdout: process.stdout
  };
}

/** Open the first lab, then its live run (the newest, top of the history list). */
async function openLiveRun(detail: RunDetail | null, columns = 80) {
  const surface = await renderToText(<App options={options(detail)} now={NOW} tick={0} />, {
    columns,
    rows: 30,
    until: (frame) => frame.trim().length > 0 && !frame.includes("reading project")
  });
  await surface.press(KEY.enter, (frame) => frame.includes("❯ Start"));
  // Past the Start action to the newest run, which is the live one.
  for (let index = 0; index < 3; index += 1) {
    const frame = await surface.press(KEY.down);
    if (/❯[^\n]*(starting|synthetic-new-user|CUA browser)/.test(frame)) break;
  }
  // Wait for the DETAIL-bearing frame: entering the run screen renders its own facts first and the
  // participants a moment later, so matching the status line alone captures the frame before the
  // thing under test has arrived.
  const frame = await surface.press(
    KEY.enter,
    (candidate) => candidate.includes(detail === null ? "starting…" : "Connecting fields")
  );
  return { surface, frame };
}

describe("watching a run", () => {
  it("leads with the participant and their thinking, not the money", async () => {
    const { surface, frame } = await openLiveRun(LIVE_DETAIL);
    surface.unmount();
    const lines = frame.split("\n").filter((line) => line.trim().length > 0);

    const participant = lines.findIndex((line) => line.includes("is working"));
    const thought = lines.findIndex((line) => line.includes("Connecting fields"));
    const cost = lines.findIndex((line) => line.includes("estimated") || line.includes("cost"));

    expect(participant).toBeGreaterThan(-1);
    expect(thought).toBeGreaterThan(participant);
    // The ordering IS the requirement: who is in there and what they are thinking, then the money.
    expect(cost === -1 || cost > thought).toBe(true);
  });

  it("shows how far the participant has got, in their own units", async () => {
    const { surface, frame } = await openLiveRun(LIVE_DETAIL);
    surface.unmount();
    expect(frame).toContain("12 turns");
  });

  it("quotes the thought — never paraphrased, and with the markdown lead dropped", async () => {
    const { surface, frame } = await openLiveRun(LIVE_DETAIL);
    surface.unmount();
    expect(frame).toContain("Connecting fields for relationships");
    expect(frame).not.toContain("**");
  });

  it("offers no actions while a run is still going", async () => {
    // Nothing on this card is safe or meaningful yet: the Observer artifact is not written until
    // the run ends, and "Run again" while it is still running is a way to spend twice by accident.
    // The thinking is what this screen is for while it runs.
    const { surface, frame } = await openLiveRun(LIVE_DETAIL);
    surface.unmount();
    expect(frame).not.toContain("Open in Observer");
    expect(frame).not.toContain("Run again");
    expect(frame).toContain("Connecting fields");
  });

  it("names nobody when the run has not written a participant record yet", async () => {
    // A run that has just started has no bundle. The card says "starting…" rather than a sentence
    // with a hole where the person goes, and it does not invent one from the lane or the lab.
    const { surface, frame } = await openLiveRun(null);
    surface.unmount();
    expect(frame).toContain("starting…");
    expect(frame).not.toContain("is working");
  });

  it("renders the live frame", async () => {
    const { surface, frame } = await openLiveRun(LIVE_DETAIL);
    surface.unmount();
    await expectGolden("run-live-80", normalizeFrame(frame));
  });

  it("renders the live frame on a phone-width terminal without overflowing", async () => {
    const { surface, frame } = await openLiveRun(LIVE_DETAIL, 45);
    surface.unmount();
    const normalized = normalizeFrame(frame);
    for (const line of normalized.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(45);
    }
    await expectGolden("run-live-45", normalized);
  });
});

describe("the interrupted card", () => {
  const interrupted = {
    runId: "cua-2026-08-18T08-00-00-000Z-99887766",
    derivedFrom: "directory" as const,
    liveness: "interrupted" as const,
    mode: "live" as const,
    lab: { id: "diagram-editor" },
    startedAt: new Date(NOW - 40 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 35 * 60_000).toISOString(),
    estimatedCostUsd: 0.62
  };

  it("says what it spent and offers the action that stops the bleeding", async () => {
    // An interrupted run may have left sandboxes running, and those cost money until something
    // stops them. This card is not an apology — it is the place that says so and does something.
    const capabilities: TuiCapabilities = {
      readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: [interrupted], unreadable: [] }),
      listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: LABS, warnings: [] }),
      startRun: async () => ({ ok: true, run: { pid: 1, launchedAt: new Date(NOW).toISOString(), logPath: "/t", command: [] } }),
      readLaunchLog: async () => "",
      readRunDetail: async () => null,
      readLabSummary: async () => null,
      readProjectState: () => ({ schema: "humanish.tui-project.v1", initialized: true, hasRuntime: true }),
      openObserver: async () => ({ schema: "humanish.tui-action.v1", ok: true, message: "opened" }),
      reclaimRun: async () => ({ schema: "humanish.reclaim-result.v1", ok: true, cwd: "/x", runId: "r", receiptCount: 2, outcomes: [], warnings: [] })
    };
    const options: TuiOptions = {
      cwd: "/projects/acme-app",
      version: { cli: "9.9.9" },
      capabilities,
      stdin: process.stdin,
      stdout: process.stdout
    };
    const surface = await renderToText(<App options={options} now={NOW} tick={0} />, {
      columns: 80,
      rows: 26,
      until: (frame) => frame.includes("diagram-editor")
    });
    await surface.press(KEY.enter, (frame) => frame.includes("❯ Start"));
    await surface.press(KEY.down, (frame) => /❯[^\n]*⚑/.test(frame));
    const card = await surface.press(KEY.enter, (frame) => frame.includes("interrupted"));

    expect(card).toContain("interrupted — no outcome recorded");
    // It spent real money before dying, and says so rather than reporting nothing.
    expect(card).toContain("~$0.62");
    expect(card).toContain("sandboxes");
    expect(card).toContain("Reclaim");

    const done = await surface.press(KEY.enter, (frame) => frame.includes("reclaimed"));
    surface.unmount();
    // The action reports what it did. One that fires and says nothing is indistinguishable from
    // one that is broken.
    expect(done).toContain("reclaimed 2 recorded resources");
  }, 20_000);
});
