import React from "react";
import { describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import type { LaunchRunOptions } from "../../src/tui-launch.js";
import type { TuiCapabilities, TuiOptions } from "../../src/tui-contract.js";
import { KEY, renderToText } from "../src/testing/render-to-text.js";
import { LABS, NOW, RUNS } from "./fixtures.js";

// Starting a run is the only thing this surface does that spends money, so the interaction is
// pinned rather than left to a golden: what is armed, what commits, and what cancels.

function harness(overrides: Partial<TuiCapabilities> = {}) {
  const started: Omit<LaunchRunOptions, "spawn" | "cliPath" | "now">[] = [];
  const capabilities: TuiCapabilities = {
    readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: RUNS, unreadable: [] }),
    listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: LABS, warnings: [] }),
    startRun: async (launch) => {
      started.push(launch);
      return { ok: true, run: { pid: 4242, launchedAt: new Date(NOW).toISOString(), logPath: "/tmp/x.log", command: [] } };
    },
    readLaunchLog: async () => "",
    ...overrides
  };
  const options: TuiOptions = {
    cwd: "/projects/acme-app",
    version: { cli: "9.9.9" },
    capabilities,
    stdin: process.stdin,
    stdout: process.stdout
  };
  return { started, options };
}

/**
 * Returns the surface AND the frame the keypress produced. `surface.last` is the frame from
 * construction, so reading it after pressing a key asserts against the previous screen.
 */
async function openLab(options: TuiOptions) {
  const surface = await renderToText(<App options={options} now={NOW} />, {
    columns: 80,
    until: (frame) => frame.trim().length > 0 && !frame.includes("reading project")
  });
  // The first lab is selected by default; Enter opens it.
  const frame = await surface.press(KEY.enter, (candidate) => candidate.includes("Start a dry run"));
  return { surface, frame };
}

describe("starting a run", () => {
  it("a dry run starts on one keypress, because it cannot cost anything", async () => {
    const { started, options } = harness();
    const { surface } = await openLab(options);
    await surface.press(KEY.enter, (frame) => frame.length >= 0);
    surface.unmount();

    expect(started).toHaveLength(1);
    expect(started[0]?.mode).toBe("dry-run");
    // Started by the HANDLE that `humanish lab run` resolves, never by the declared id — those are
    // different strings whenever a manifest's filename differs from the id inside it.
    expect(started[0]?.lab).toBe("signup-flow");
  });

  it("a live run is armed first and commits on the second press, restating the cost", async () => {
    const { started, options } = harness();
    const { surface } = await openLab(options);
    await surface.press(KEY.down, (frame) => frame.includes("› Start a live run"));

    const armed = await surface.press(KEY.enter, (frame) => frame.includes("start a live run?"));
    // A person reads the prompt before pressing again. Confirming faster than a human can read is
    // key auto-repeat, and the surface refuses it — see the auto-repeat test below.
    await new Promise((resolve) => setTimeout(resolve, 450));
    // Nothing has been spent yet, and the prompt repeats the cost rather than assuming the row
    // above was read.
    expect(started).toHaveLength(0);
    expect(armed).toContain("~$1.20 median");
    expect(armed).toContain("enter to confirm, esc to cancel");

    await surface.press(KEY.enter, (frame) => frame.length >= 0);
    surface.unmount();
    expect(started).toHaveLength(1);
    expect(started[0]?.mode).toBe("live");
  });

  it("escape cancels an armed live run instead of leaving the screen", async () => {
    // The nearer meaning of "no" wins: a confirmation must never be dismissed by accidentally
    // navigating away, which would leave the operator unsure whether they had just spent money.
    const { started, options } = harness();
    const { surface } = await openLab(options);
    await surface.press(KEY.down, (frame) => frame.includes("› Start a live run"));
    await surface.press(KEY.enter, (frame) => frame.includes("start a live run?"));

    // Asserts what the frame CONTAINS, not only what it lacks: Ink writes blank control frames, and
    // a bare negation matches those trivially.
    const cancelled = await surface.press(
      KEY.escape,
      (frame) => frame.includes("Start a live run") && !frame.includes("start a live run?")
    );
    surface.unmount();
    expect(started).toHaveLength(0);
    // Still on the lab, not thrown back to the labs list.
    expect(cancelled).toContain("Start a live run");
  });

  it("shows why a launch failed rather than looking like nothing happened", async () => {
    const { options } = harness({
      startRun: async () => ({
        ok: false,
        error: { code: "HUMANISH_LAUNCH_FAILED", message: "EACCES: permission denied" }
      })
    });
    const { surface } = await openLab(options);
    const failed = await surface.press(KEY.enter, (frame) => frame.includes("EACCES"));
    surface.unmount();
    expect(failed).toContain("EACCES: permission denied");
  });

  it("offers no way to start a lab that has no manifest here", async () => {
    // Its runs are still readable evidence, but there is no file to run — so the action is absent
    // rather than present and failing.
    const { started, options } = harness({
      listLabs: async () => ({ schema: "humanish.lab-list.v1", ok: true, cwd: "/projects/acme-app", labs: [], warnings: [] })
    });
    const surface = await renderToText(<App options={options} now={NOW} />, {
      columns: 80,
      until: (frame) => frame.trim().length > 0 && !frame.includes("reading project")
    });
    const lab = await surface.press(KEY.enter, (frame) => frame.includes("no manifest"));
    expect(lab).not.toContain("Start a");
    await surface.press(KEY.enter, (frame) => frame.length >= 0);
    surface.unmount();
    expect(started).toHaveLength(0);
  });
});

describe("what a lab may claim about a live run", () => {
  it("never quotes dry-run history beside a control that spends money", async () => {
    // The defect this pins, found on a real run: a lab whose only history is dry runs showed
    // "0s · 1 run" next to Start a live run — which reads as "a live run is free and instant".
    const dryOnly = [
      {
        runId: "dryrun-1",
        derivedFrom: "status" as const,
        liveness: "finished" as const,
        mode: "dry-run" as const,
        lab: { id: "signup-flow" },
        startedAt: "2026-08-19T11:00:00.000Z",
        completedAt: "2026-08-19T11:00:00.008Z",
        durationMs: 8,
        estimatedCostUsd: 0,
        verdict: "contract_proof_only"
      }
    ];
    const { options } = harness({
      readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: dryOnly, unreadable: [] })
    });
    const { surface, frame } = await openLab(options);
    surface.unmount();

    const liveRow = frame.split("\n").find((line) => line.includes("Start a live run")) ?? "";
    expect(liveRow).toContain("no live runs yet");
    expect(liveRow).not.toContain("0s");
    expect(liveRow).not.toContain("$");
  });

  it("quotes live history when there is some, and only live history", async () => {
    const mixed = [
      {
        runId: "dryrun-1",
        derivedFrom: "status" as const,
        liveness: "finished" as const,
        mode: "dry-run" as const,
        lab: { id: "signup-flow" },
        durationMs: 8,
        estimatedCostUsd: 0
      },
      {
        runId: "live-1",
        derivedFrom: "status" as const,
        liveness: "finished" as const,
        mode: "live" as const,
        lab: { id: "signup-flow" },
        durationMs: 120_000,
        estimatedCostUsd: 1.2
      }
    ];
    const { options } = harness({
      readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: mixed, unreadable: [] })
    });
    const { surface, frame } = await openLab(options);
    surface.unmount();

    const liveRow = frame.split("\n").find((line) => line.includes("Start a live run")) ?? "";
    // The live run's own figures, undiluted by the dry run beside it — a median over both would
    // report $0.60 and a minute, neither of which anything ever cost or took.
    expect(liveRow).toContain("~$1.20 median");
    expect(liveRow).toContain("1 run");
    expect(liveRow).not.toContain("2 runs");
  });
});


// Defects found by an adversarial review of this launch path and reproduced against the real
// component. Each is pinned here because each was invisible to every test that existed.

describe("what the surface says about the run it just started", () => {
  const startedRun = {
    runId: "cua-2026-08-19T12-00-01-000Z-newrun",
    derivedFrom: "status" as const,
    liveness: "running" as const,
    mode: "dry-run" as const,
    pid: 4242,
    lab: { id: "signup-flow" },
    startedAt: new Date(NOW + 1_000).toISOString()
  };

  it("shows the run, instead of reporting it as no longer on disk", async () => {
    // The poll read the index into a local and navigated without publishing it, so the run screen
    // looked the new run up in the PRE-LAUNCH snapshot and reported the run it had just read as
    // missing — on every single start, and on a live run that is the frame right after committing
    // real spend, which invites starting it again.
    let launched = false;
    const { options } = harness({
      startRun: async () => {
        launched = true;
        return { ok: true, run: { pid: 4242, launchedAt: new Date(NOW).toISOString(), logPath: "/tmp/x.log", command: [] } };
      },
      readRunIndex: async () => ({
        schema: "humanish.run-index.v1",
        cwd: "/projects/acme-app",
        runs: launched ? [startedRun, ...RUNS] : RUNS,
        unreadable: []
      })
    });
    const { surface } = await openLab(options);
    const frame = await surface.press(KEY.enter, (candidate) => candidate.includes("newrun") || candidate.includes("no longer on disk"));
    surface.unmount();

    expect(frame).not.toContain("no longer on disk");
    expect(frame).toContain("cua-2026-08-19T12-00-01-000Z-newrun");
  });

  it("does not adopt a stale run that merely shares the recycled pid", async () => {
    // A pid is not an identity. Pids are recycled, and a finished run keeps its pid in status.json
    // forever, so a week-old record can carry the pid the kernel just handed this child — and the
    // surface would present that old failed run as the study just started.
    const stale = {
      runId: "cua-2026-08-12T09-00-00-000Z-deadbeef",
      derivedFrom: "status" as const,
      liveness: "finished" as const,
      mode: "live" as const,
      pid: 4242,
      lab: { id: "diagram-editor" },
      startedAt: "2026-08-12T09:00:00.000Z",
      completedAt: "2026-08-12T09:04:00.000Z",
      verdict: "fail",
      estimatedCostUsd: 3.5
    };
    const { options } = harness({
      readRunIndex: async () => ({ schema: "humanish.run-index.v1", cwd: "/projects/acme-app", runs: [stale, ...RUNS], unreadable: [] })
    });
    const { surface } = await openLab(options);
    // The launch never resolves to a record, so it ends in the honest "has not reported in" branch
    // rather than opening a week-old failed run of a different lab and calling it this one.
    const frame = await surface.press(
      KEY.enter,
      (candidate) => candidate.includes("has not reported in") || candidate.includes("deadbeef"),
      // The launch waits the full record timeout before concluding nothing reported in.
      8_000
    );
    surface.unmount();

    expect(frame).not.toContain("deadbeef");
    expect(frame).not.toContain("$3.50");
    expect(frame).toContain("has not reported in");
    // Deliberately outlasts the real record timeout rather than mocking it: the point is that the
    // surface waits and then tells the truth, not that it gives up quickly.
  }, 20_000);

  it("keeps one lab's launch state off another lab's screen", async () => {
    const { options } = harness({
      startRun: async () => ({ ok: false, error: { code: "HUMANISH_LAUNCH_FAILED", message: "EACCES: denied" } })
    });
    const { surface } = await openLab(options);
    await surface.press(KEY.enter, (candidate) => candidate.includes("EACCES"));
    // Leave, and open a different lab: its screen must say nothing about the other lab's failure.
    await surface.press(KEY.escape, (candidate) => candidate.includes("never-run-lab"));
    await pressUntilFrame(surface, KEY.down, (candidate) => /›[^\n]*diagram-editor/.test(candidate));
    const other = await surface.press(KEY.enter, (candidate) => candidate.includes("Start a dry run"));
    surface.unmount();

    expect(other).not.toContain("EACCES");
  });
});

/** Local copy of the intent-based navigation helper (this file predates the shared one). */
async function pressUntilFrame(
  surface: { press: (key: string, until?: (frame: string) => boolean) => Promise<string> },
  key: string,
  predicate: (frame: string) => boolean,
  limit = 8
): Promise<string> {
  let frame = "";
  for (let index = 0; index < limit; index += 1) {
    frame = await surface.press(key);
    if (predicate(frame)) return frame;
  }
  throw new Error(`never reached the wanted row. Last frame:\n${frame}`);
}
