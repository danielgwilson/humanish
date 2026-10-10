// A host that sleeps mid-run: the run's heartbeat sees its wall clock jump past the interval and
// records the gap as a host suspension, and a participant failure in flight across the gap reads
// as its likely effect. The clock is a fake the test moves; nothing here sleeps.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { readHostSuspensions, type HostSuspension } from "../../src/run/host-suspension.js";
import { runScope, type RunScope } from "../../src/run/run.js";
import { PASSING_OUTCOME } from "../helpers/finished-run.js";
import { fakeHostClock } from "../helpers/host-clock.js";

const T0 = Date.parse("2026-10-10T09:00:00.000Z");
const at = (offsetMs: number): number => T0 + offsetMs;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

let template: RunBundle;
let templateRoot: string;
let cwd: string;

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(tmpdir(), "humanish-host-template-"));
  expect((await runDryRun({ cwd: templateRoot, dryRun: true, runId: "template" })).ok).toBe(true);
  template = JSON.parse(
    await readFile(path.join(templateRoot, ".humanish", "runs", "template", "run.json"), "utf8"),
  ) as RunBundle;
});

afterAll(async () => {
  await rm(templateRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-host-suspension-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function bundleFor(runId: string): RunBundle {
  return { ...template, runId, artifactRoot: path.join(".humanish", "runs", runId) };
}

async function startOk(scope: RunScope, runId: string, clock: ReturnType<typeof fakeHostClock>) {
  const started = await scope.startRun({
    cwd,
    runId,
    mintRunId: () => "minted",
    mode: "dry-run",
    renderReview: (bundle) => `# Review ${bundle.runId}\n`,
    clock: clock.clock,
  });
  if (!started.ok) throw new Error(started.message);
  return started.run;
}

async function runJson(runId: string): Promise<RunBundle> {
  return JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"),
  ) as RunBundle;
}

const hostEvents = (bundle: RunBundle) =>
  bundle.events.filter((event) => event.type === "host.suspended");

describe("the run's heartbeat", () => {
  it("records a 6 minute wall-clock jump at +1m as one host suspension event", async () => {
    const host = fakeHostClock(T0);
    let seen: readonly HostSuspension[] = [];
    await runScope(async (scope) => {
      const run = await startOk(scope, "slept", host);
      host.beat(12);
      host.advance(6 * MINUTE);
      host.beat();
      seen = run.hostSuspensions();
      await run.finish(bundleFor("slept"), PASSING_OUTCOME);
    });
    expect(seen).toEqual([
      {
        startedAt: "2026-10-10T09:01:00.000Z",
        endedAt: "2026-10-10T09:07:05.000Z",
        durationMs: 365_000,
      },
    ]);
    expect(hostEvents(await runJson("slept"))).toEqual([
      {
        id: "event-host-suspended-001",
        at: "2026-10-10T09:01:00.000Z",
        level: "warn",
        type: "host.suspended",
        message:
          "The host was suspended for 6m 5s, from 2026-10-10T09:01:00.000Z to 2026-10-10T09:07:05.000Z (+1m into the run): the run's heartbeat did not run in that time. A process that was stopped, or a clock set forward, reads the same way.",
      },
    ]);
  });

  it("records nothing for a gap under 30 s or a clock set back", async () => {
    const host = fakeHostClock(T0);
    let seen: readonly HostSuspension[] = [];
    await runScope(async (scope) => {
      const run = await startOk(scope, "awake", host);
      host.beat(3);
      host.advance(20 * SECOND);
      host.tick();
      host.advance(-10 * MINUTE);
      host.tick();
      host.beat(3);
      seen = run.hostSuspensions();
      await run.finish(bundleFor("awake"), PASSING_OUTCOME);
    });
    expect(seen).toEqual([]);
    expect(hostEvents(await runJson("awake"))).toEqual([]);
  });

  it("sees a suspension the run reads before the next tick", async () => {
    const host = fakeHostClock(T0);
    let seen: readonly HostSuspension[] = [];
    await runScope(async (scope) => {
      const run = await startOk(scope, "just-woke", host);
      host.beat(2);
      host.advance(90 * SECOND);
      seen = run.hostSuspensions();
      await run.finish(bundleFor("just-woke"), PASSING_OUTCOME);
    });
    expect(seen).toEqual([
      {
        startedAt: "2026-10-10T09:00:10.000Z",
        endedAt: "2026-10-10T09:01:40.000Z",
        durationMs: 90_000,
      },
    ]);
  });

  it("stops with the run's status cadence", async () => {
    const host = fakeHostClock(T0);
    let during = 0;
    await runScope(async (scope) => {
      const run = await startOk(scope, "stopped", host);
      during = host.running;
      await run.finish(bundleFor("stopped"), PASSING_OUTCOME);
    });
    expect(during).toBe(1);
    expect(host.running).toBe(0);
  });
});

describe("which failures a host suspension explains", () => {
  const suspension: HostSuspension = {
    startedAt: new Date(at(1 * MINUTE)).toISOString(),
    endedAt: new Date(at(7 * MINUTE + 5 * SECOND)).toISOString(),
    durationMs: 365_000,
  };

  it("names every harness failure in flight across it, and the skips that followed", () => {
    const reading = readHostSuspensions(
      [suspension],
      [
        // A provider turn stalled at the wake.
        {
          id: "lane-01",
          failure: "harness",
          startedAtMs: at(0),
          endedAtMs: at(7 * MINUTE + 6 * SECOND),
        },
        // Desktop setup failed after the wake; no session record says when.
        { id: "lane-02", failure: "harness", startedAtMs: at(50 * SECOND) },
        // The session clock ran on through the sleep.
        {
          id: "lane-03",
          failure: "time-limit",
          startedAtMs: at(0),
          endedAtMs: at(7 * MINUTE + 5 * SECOND),
        },
        { id: "lane-04", failure: "skipped" },
      ],
      T0,
    );
    expect(reading).toEqual({
      summary:
        "The host was suspended for 6m 5s at +1m; the 4 participant failures after it are likely its effect.",
      participantIds: ["lane-01", "lane-02", "lane-03", "lane-04"],
      suspensions: [suspension],
    });
  });

  it("leaves a failure that ended before it, the skips after that failure, and a participant's own report", () => {
    const reading = readHostSuspensions(
      [suspension],
      [
        { id: "lane-01", failure: "harness", startedAtMs: at(0), endedAtMs: at(30 * SECOND) },
        {
          id: "lane-02",
          failure: "harness",
          startedAtMs: at(0),
          endedAtMs: at(7 * MINUTE + 6 * SECOND),
        },
        { id: "lane-03", failure: "skipped" },
        // Reported a blocker after the wake: a finding about the app.
        { id: "lane-04", startedAtMs: at(0), endedAtMs: at(9 * MINUTE) },
        // Started after the wake.
        {
          id: "lane-05",
          failure: "harness",
          startedAtMs: at(8 * MINUTE),
          endedAtMs: at(9 * MINUTE),
        },
      ],
      T0,
    );
    expect(reading).toEqual({
      summary:
        "The host was suspended for 6m 5s at +1m; the 1 participant failure after it is likely its effect.",
      participantIds: ["lane-02"],
      suspensions: [suspension],
    });
  });

  it("leaves the skips when only time limits explain the failures", () => {
    const reading = readHostSuspensions(
      [suspension],
      [
        {
          id: "lane-01",
          failure: "time-limit",
          startedAtMs: at(0),
          endedAtMs: at(7 * MINUTE + 5 * SECOND),
        },
        // Skipped for the study's spend cap; no harness error came before it.
        { id: "lane-02", failure: "skipped" },
      ],
      T0,
    );
    expect(reading?.participantIds).toEqual(["lane-01"]);
  });

  it("says so when no failure followed it, and names each of several", () => {
    const later: HostSuspension = {
      startedAt: new Date(at(12 * MINUTE)).toISOString(),
      endedAt: new Date(at(12 * MINUTE + 40 * SECOND)).toISOString(),
      durationMs: 40_000,
    };
    expect(
      readHostSuspensions([suspension, later], [{ id: "lane-01", startedAtMs: at(0) }], T0)
        ?.summary,
    ).toBe(
      "The host was suspended 2 times (6m 5s at +1m, 40s at +12m); no participant failure followed.",
    );
    expect(readHostSuspensions([], [{ id: "lane-01", failure: "harness" }], T0)).toBeUndefined();
  });
});
