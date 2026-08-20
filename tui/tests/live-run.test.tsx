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
      readProjectState: () => ({ schema: "humanish.tui-project.v1" as const, initialized: true, hasRuntime: true })
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
  const surface = await renderToText(<App options={options(detail)} now={NOW} />, {
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
    (candidate) => candidate.includes("patience:medium") || candidate.includes("no participant record yet")
  );
  return { surface, frame };
}

describe("watching a run", () => {
  it("leads with the participant and their thinking, not the money", async () => {
    const { surface, frame } = await openLiveRun(LIVE_DETAIL);
    surface.unmount();
    const lines = frame.split("\n").filter((line) => line.trim().length > 0);

    const participant = lines.findIndex((line) => line.includes("CUA browser"));
    const traits = lines.findIndex((line) => line.includes("patience:medium"));
    const thought = lines.findIndex((line) => line.includes("Connecting fields"));
    const cost = lines.findIndex((line) => line.startsWith("cost"));

    expect(participant).toBeGreaterThan(-1);
    expect(traits).toBe(participant + 1);
    expect(thought).toBeGreaterThan(traits);
    // The ordering IS the requirement: who is in there and what they are thinking, then the money.
    expect(cost === -1 || cost > thought).toBe(true);
  });

  it("shows how far the participant has got, in their own units", async () => {
    const { surface, frame } = await openLiveRun(LIVE_DETAIL);
    surface.unmount();
    expect(frame).toContain("turn 12");
    expect(frame).toContain("31 actions");
  });

  it("quotes the thought — never paraphrased, and with the markdown lead dropped", async () => {
    const { surface, frame } = await openLiveRun(LIVE_DETAIL);
    surface.unmount();
    expect(frame).toContain("Connecting fields for relationships");
    expect(frame).not.toContain("**");
  });

  it("points at the Observer, because a terminal cannot show the screenshots", async () => {
    const { surface, frame } = await openLiveRun(LIVE_DETAIL);
    surface.unmount();
    // The path WRAPS rather than truncating: a cut path cannot be opened, so it would be a value
    // that looks actionable and is not. Unwrap before asserting the whole thing survived.
    const unwrapped = frame.replace(/\n\s+/g, "");
    expect(unwrapped).toContain(".humanish/runs/cua-2026-08-19T11-30-00-000Z-aa11bb22/observer/index.html");
  });

  it("says a run has no participant record yet instead of pretending it has none", async () => {
    // A run that has just started has no bundle. "Not written yet" and "nobody is in this run" are
    // different facts and the screen must not merge them.
    const { surface, frame } = await openLiveRun(null);
    surface.unmount();
    expect(frame).toContain("no participant record yet");
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
