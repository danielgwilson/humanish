// What the plan, study check, the run's participant table and the bundle estimate compute from each
// participant's start, end and cap. One roster mixes every kind: a scheduled end from the start of
// the run, a later start with an end and its own wind-down, a session cap, a spread group with no
// end, and a short window. The study's session budget is the fixture's 1 minute, and an app-url
// sandbox adds the 10-minute teardown buffer, so the study sandbox is 11 minutes.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import {
  formatParticipantPlanEntry,
  participantRunsAndPlan,
  scheduledParticipantDeps,
} from "../../src/routes/computer-use/participant-runs.js";
import { describeArrivals, startingWithTheRun } from "../../src/study/arrivals.js";
import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import type { ComputerUsePlan, PlanResult } from "../../src/study/plan-types.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";
import { participantPlanOf } from "../helpers/participant-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const CEILING = "HUMANISH_E2B_MAX_SANDBOX_MINUTES";
const S = 1_000;
const MIN = 60 * S;
const HOURS = 60 * MIN;

const day = {
  participants: [
    { id: "host", endAfterMs: 2 * HOURS },
    { id: "lead", startAfterMs: 10 * MIN, endAfterMs: 40 * MIN, windDownMs: 5 * MIN },
    { id: "quick", maxSessionMs: 8 * MIN },
    { id: "guest", count: 2, startAfterMs: 1 * MIN, startEveryMs: 1 * MIN },
    { id: "brief", startAfterMs: 2 * MIN, endAfterMs: 10 * MIN },
  ],
};

function study(base: BaseName, patch: Patch = {}): StudyConfig {
  const parsed = parseStudy(lab(base, patch));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function plan(config: StudyConfig, env: Record<string, string> = {}): PlanResult {
  return planStudy(config, { cwd: process.cwd(), dryRun: false, env });
}

function computerUse(result: PlanResult): ComputerUsePlan {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  if (result.planned.plan.route !== "computer-use") throw new Error(result.planned.plan.route);
  return result.planned.plan;
}

const allowed = { [CEILING]: "1440" };

describe("a roster of starts, ends and caps", () => {
  it("plans each participant's slot from its own window, cap or the study budget", () => {
    const planned = computerUse(plan(study("cuAppUrl", day), allowed));
    // Slots: host 0 to 2h 5m, quick 0 to 13m, guest-01 1m to 2m, guest-02 2m to 3m, brief 2m to
    // 15m, lead 10m to 45m. At 2m, guest-01's slot frees as brief and guest-02 take theirs: host,
    // quick, guest-02 and brief run; at 10m host, quick, brief and lead do.
    expect(planned.arrivals).toEqual({
      declared: true,
      firstStartMs: 0,
      lastStartMs: 10 * MIN,
      peak: 4,
      waiting: 0,
      longestWaitMs: 0,
      lastEndMs: 2 * HOURS + 5 * MIN,
      sessionMs: 1 * MIN,
      ownBudgets: true,
    });
    expect(describeArrivals(planned.arrivals)).toBe(
      "the first participant starts at +0s and the last at +10m; at most 4 run at once when every session uses its full budget: its own end or cap, or else 1m.",
    );
    expect(planned.warnings).toBeUndefined();
  });

  it("prints each participant's start, end and cap on its plan line", () => {
    const { participantPlan } = participantRunsAndPlan(
      computerUse(plan(study("cuAppUrl", day), allowed)),
    );
    expect(
      participantPlan.lanes.map((entry) =>
        formatParticipantPlanEntry(entry).replace(/ prompt#\w+$/, ""),
      ),
    ).toEqual([
      "host: persona=first-time-visitor end=+2h device=desktop 1440x950",
      "lead: persona=first-time-visitor start=+10m end=+40m device=desktop 1440x950",
      "quick: persona=first-time-visitor cap=8m device=desktop 1440x950",
      "guest-01: persona=first-time-visitor start=+1m device=desktop 1440x950",
      "guest-02: persona=first-time-visitor start=+2m device=desktop 1440x950",
      "brief: persona=first-time-visitor start=+2m end=+10m device=desktop 1440x950",
    ]);
    expect(
      participantPlan.lanes.map(({ id, startAfterMs, endAfterMs, maxSessionMs }) => ({
        id,
        startAfterMs,
        endAfterMs,
        maxSessionMs,
      })),
    ).toEqual([
      { id: "host", startAfterMs: undefined, endAfterMs: 2 * HOURS, maxSessionMs: undefined },
      { id: "lead", startAfterMs: 10 * MIN, endAfterMs: 40 * MIN, maxSessionMs: undefined },
      { id: "quick", startAfterMs: undefined, endAfterMs: undefined, maxSessionMs: 8 * MIN },
      { id: "guest-01", startAfterMs: 1 * MIN, endAfterMs: undefined, maxSessionMs: undefined },
      { id: "guest-02", startAfterMs: 2 * MIN, endAfterMs: undefined, maxSessionMs: undefined },
      { id: "brief", startAfterMs: 2 * MIN, endAfterMs: 10 * MIN, maxSessionMs: undefined },
    ]);
  });

  it("sizes each participant's session, sandbox and end from its window or cap", () => {
    const planned = computerUse(plan(study("cuAppUrl", day), allowed));
    // Sandbox-minutes: host 125 + 10, lead 35 + 10, quick 13 + 10, each guest 1 + 10, brief 13 + 10.
    expect(participantRunsAndPlan(planned).participantPlan.worstCaseSandboxMinutes).toBe(248);
    const anchor = 1_000_000;
    const deps = { timeoutMs: planned.sessionBudgetMs, sandboxMs: planned.sandboxMs };
    const due = [0, 10 * MIN, 0, 1 * MIN, 2 * MIN, 2 * MIN];
    expect(
      planned.runner.participants.map((participant, index) =>
        scheduledParticipantDeps(participant, deps, anchor + due[index]!),
      ),
    ).toEqual([
      // The window plus 5 minutes for the closing report, and the 10-minute buffer on top.
      {
        timeoutMs: 2 * HOURS + 5 * MIN,
        sandboxMs: 2 * HOURS + 15 * MIN,
        end: { kind: "scheduled_end", atMs: anchor + 2 * HOURS, windDownMs: 10 * MIN },
      },
      // Due at +10m and ending at +40m on the run's clock: 30 minutes from its own start.
      {
        timeoutMs: 35 * MIN,
        sandboxMs: 45 * MIN,
        end: { kind: "scheduled_end", atMs: anchor + 40 * MIN, windDownMs: 5 * MIN },
      },
      // A cap counts from the session's start, which the route reads when it comes.
      {
        timeoutMs: 13 * MIN,
        sandboxMs: 23 * MIN,
        end: { kind: "session_cap", afterMs: 8 * MIN, windDownMs: 2 * MIN },
      },
      { timeoutMs: 1 * MIN, sandboxMs: 11 * MIN },
      { timeoutMs: 1 * MIN, sandboxMs: 11 * MIN },
      // An 8-minute window is told the time left for its last quarter.
      {
        timeoutMs: 13 * MIN,
        sandboxMs: 23 * MIN,
        end: { kind: "scheduled_end", atMs: anchor + 10 * MIN, windDownMs: 2 * MIN },
      },
    ]);
  });

  it("refuses the first window whose sandbox would outlive the ceiling, with its arithmetic", () => {
    const result = plan(study("cuAppUrl", day));
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.message).toBe(
      `Participant "host" works from +0s to +2h, so its sandbox needs a 135m deadline: the window, 5m for its closing report and 10m to set up and tear down. A sandbox may not live longer than 60m. Shorten its window. If your E2B plan allows longer sandboxes (Pro allows 1440 minutes), set ${CEILING} to 135 or more.`,
    );
  });

  it("prints every participant's window in study check", async () => {
    const cwd = await makeTestTempDir("humanish-participant-schedule-");
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "day.yaml"),
      stringify(lab("cuAppUrl", { id: "day", ...day })),
    );
    const check = await runStudyPreflight({ cwd, study: "day", env: allowed });
    expect(check.ok).toBe(true);
    expect(check.checks.find((row) => row.name === "windows")?.message).toBe(
      "host from +0s to +2h, told the time left from +1h 50m; lead from +10m to +40m, told the time left from +35m; quick from +0s until it ends itself or for up to 8m, told the time left from 6m into its session; guest-01 from +1m for up to 1m; guest-02 from +2m for up to 1m; brief from +2m to +10m, told the time left from +8m.",
    );
  });

  it("estimates the bundle from each scheduled window and each open or capped session", () => {
    const result = plan(study("cuAppUrl", day), allowed);
    if (!result.ok) throw new Error(result.refusal.message);
    // Turns at one every 10 s: host 720, lead 180 and brief 48 over their windows; quick 18 over
    // 3 minutes of its 8-minute cap; each guest 6 over its 1-minute budget. 978 in all.
    // Files and folders: 20 + 6 x 3 + 978. run.json: 4,400 + 6 x 16,500, whatever the turns, and
    // the 7-byte mission "Try it." once for the run and twice for each participant: 103,491. The
    // host's trace: 4,000 + 720 x 3,500.
    expect(result.planned.bundle).toMatchObject({
      entries: 1_016,
      runFileBytes: 103_491,
      largestTraceBytes: 2_524_000,
      basis: {
        participants: 6,
        scheduled: 3,
        longestWindowMs: 2 * HOURS,
        open: 3,
        openMs: 3 * MIN,
        dwell: false,
      },
    });
  });
});

describe("a rerun of a participant with a start and an end", () => {
  it("starts it with the rerun and keeps its end on the rerun's clock, so its window grows", () => {
    const planned = computerUse(plan(study("cuAppUrl", day), allowed));
    const rerun = planned.runner.participants
      .filter(({ id }) => id === "lead" || id === "brief")
      .map((participant) => ({
        ...participant,
        schedule: startingWithTheRun(participant.schedule),
      }));
    // Worked from origin/main 156358c5d. Its rerun dropped startAfterMs and kept endAfterMs and
    // windDownMs, which the plan had resolved from the first run's window. Its window was then
    // endAfterMs - 0, its session the window plus 5m, and its sandbox the study's 11m minus the
    // study's 1m session plus its own session. Its end came endAfterMs after the rerun started it.
    // lead: 10m to 40m becomes 0 to 40m, wind-down 5m as written; session 45m, sandbox 55m.
    // brief: 2m to 10m becomes 0 to 10m. Its wind-down stays 2m, a quarter of the first run's 8m
    // window, where a quarter of 10m would be 2m 30s; session 15m, sandbox 25m.
    expect(rerun.map(({ id, schedule }) => ({ id, schedule }))).toEqual([
      {
        id: "lead",
        schedule: {
          end: {
            kind: "scheduled_end",
            endAfterMs: 40 * MIN,
            windowMs: 40 * MIN,
            windDownMs: 5 * MIN,
            sessionMs: 45 * MIN,
          },
        },
      },
      {
        id: "brief",
        schedule: {
          end: {
            kind: "scheduled_end",
            endAfterMs: 10 * MIN,
            windowMs: 10 * MIN,
            windDownMs: 2 * MIN,
            sessionMs: 15 * MIN,
          },
        },
      },
    ]);
    const rerunStart = 1_000_000;
    const deps = { timeoutMs: planned.sessionBudgetMs, sandboxMs: planned.sandboxMs };
    expect(
      rerun.map((participant) => scheduledParticipantDeps(participant, deps, rerunStart)),
    ).toEqual([
      {
        timeoutMs: 45 * MIN,
        sandboxMs: 55 * MIN,
        end: { kind: "scheduled_end", atMs: rerunStart + 40 * MIN, windDownMs: 5 * MIN },
      },
      {
        timeoutMs: 15 * MIN,
        sandboxMs: 25 * MIN,
        end: { kind: "scheduled_end", atMs: rerunStart + 10 * MIN, windDownMs: 2 * MIN },
      },
    ]);
  });
});

describe("HUMANISH_CUA_MAX_CONCURRENCY", () => {
  it("lowers the participants a local browser study runs at once, and records the lowering", () => {
    const local = study("cuAppUrl", {
      execution: { target: "local", timeoutMs: 60_000 },
      participants: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    expect(participantPlanOf(local, { env: { HUMANISH_CUA_MAX_CONCURRENCY: "2" } })).toMatchObject({
      concurrency: 2,
      envLoweredConcurrencyFrom: 3,
      waves: 2,
    });
  });

  const spread = {
    participants: [
      { id: "a" },
      { id: "b", startAfterMs: 10 * S },
      { id: "c", startAfterMs: 20 * S },
      { id: "d", startAfterMs: 30 * S },
    ],
  };
  const capped = { HUMANISH_CUA_MAX_CONCURRENCY: "2" };

  it("plans the schedule under the lowered count, and warns that it lowered it", () => {
    const planned = computerUse(plan(study("cuAppUrl", spread), capped));
    expect(planned.concurrency).toBe(2);
    // a 0 to 60 s, b 10 to 70 s; c waits for a's slot from 20 s to 60 s, d for b's from 30 s to
    // 70 s, and d ends at 130 s.
    expect(planned.arrivals).toMatchObject({
      peak: 2,
      waiting: 2,
      longestWaitMs: 40 * S,
      lastEndMs: 130 * S,
    });
    expect(planned.warnings).toEqual([
      "2 participants would start after their time when every session uses its 1m budget, the latest by 40s: the run starts at most 2 at once and holds the next one until a slot frees.",
      "This study's 4 participants run 2 at a time, because HUMANISH_CUA_MAX_CONCURRENCY is 2.",
    ]);
    const { participantPlan } = participantRunsAndPlan(planned);
    expect(participantPlan).toMatchObject({
      concurrency: 2,
      envLoweredConcurrencyFrom: 4,
      waves: 2,
      schedule: planned.arrivals,
    });
  });

  it("shows the lowered schedule in study check", async () => {
    const cwd = await makeTestTempDir("humanish-concurrency-cap-");
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "spread.yaml"),
      stringify(lab("cuAppUrl", { id: "spread", ...spread })),
    );
    const check = await runStudyPreflight({ cwd, study: "spread", env: capped });
    expect(check.checks.find((row) => row.name === "schedule")?.message).toBe(
      "the first participant starts at +0s and the last at +30s; at most 2 run at once when every session uses its 1m budget; 2 participants then start late, waiting for a free slot, the latest by 40s.",
    );
  });

  it("lowers a shared world's participants at once", () => {
    const shared = study("sharedProvisioned", {
      participants: [
        { id: "author", entry: "/a" },
        { id: "reviewer", entry: "/b" },
        { id: "editor", entry: "/c" },
      ],
    });
    const result = plan(shared, capped);
    if (!result.ok) throw new Error(result.refusal.message);
    if (result.planned.plan.route !== "shared-world") throw new Error(result.planned.plan.route);
    expect(result.planned.plan.concurrency).toBe(2);
    expect(result.planned.plan.warnings).toContain(
      "This study's 3 participants run 2 at a time, because HUMANISH_CUA_MAX_CONCURRENCY is 2.",
    );
  });

  it("runs a declared concurrency over the E2B plan's limit when it lowers it under the limit", () => {
    const crowd = study("cuAppUrl", {
      participants: 25,
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 25 },
    });
    // E2B's Hobby limit is 20 when its setting is unset; the run holds at most 5 desktops.
    const planned = computerUse(plan(crowd, { HUMANISH_CUA_MAX_CONCURRENCY: "5" }));
    expect(planned).toMatchObject({ concurrency: 5, envLoweredConcurrencyFrom: 25 });
    expect(planned.warnings).toEqual([
      "This study's 25 participants run 5 at a time, because HUMANISH_CUA_MAX_CONCURRENCY is 5.",
    ]);
  });

  it("names the E2B setting value that runs as many as it leaves, when both lower the count", () => {
    const planned = computerUse(
      plan(study("cuAppUrl", { participants: 30 }), { HUMANISH_CUA_MAX_CONCURRENCY: "25" }),
    );
    // The setting lowers 30 to 25, and E2B Hobby's 20 lowers that to 20; 25 sandboxes run 25.
    expect(planned.concurrency).toBe(20);
    expect(planned.envLoweredConcurrencyFrom).toBeUndefined();
    expect(planned.warnings).toEqual([
      "This study's 30 participants run 20 at a time, because humanish runs at most 20 sandboxes at once, E2B Hobby's limit, when HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES is unset. If your E2B plan runs more (Pro runs 100), set HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES to 25 or more.",
    ]);
  });

  it("runs what it leaves of a declared concurrency in waves when the E2B plan runs fewer", () => {
    const crowd = study("cuAppUrl", {
      participants: 25,
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 25 },
    });
    const planned = computerUse(
      plan(crowd, {
        HUMANISH_CUA_MAX_CONCURRENCY: "5",
        HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES: "3",
      }),
    );
    // The setting lowers 25 to 5, and the E2B plan runs 3 of those; raising it to 5 runs 5.
    expect(planned.concurrency).toBe(3);
    expect(planned.envLoweredConcurrencyFrom).toBeUndefined();
    expect(planned.warnings).toEqual([
      "This study's 25 participants run 3 at a time, because HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES allows 3 sandboxes at once. If your E2B plan runs more (Pro runs 100), set HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES to 5 or more.",
    ]);
  });

  it("refuses a shared world when it allows fewer than the two participants it needs at once", () => {
    const result = plan(study("sharedProvisioned"), { HUMANISH_CUA_MAX_CONCURRENCY: "1" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.message).toBe(
      "This study runs at least 2 participants at once, and HUMANISH_CUA_MAX_CONCURRENCY allows 1. Set it to 2 or more, or unset it.",
    );
  });
});

describe("a participant still waiting for a slot at its scheduled end", () => {
  it("takes no slot in the plan, and the plan warns that the run skips it", () => {
    const planned = computerUse(
      plan(
        study("cuAppUrl", {
          participants: [
            { id: "first" },
            { id: "late", startAfterMs: 30 * S, endAfterMs: 50 * S },
            { id: "after", startAfterMs: 40 * S },
          ],
          execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 1 },
        }),
      ),
    );
    // first holds the one slot from 0 to 60 s. late is due at 30 s and would end at 50 s, before
    // the slot frees, so it takes none; after, due at 40 s, takes it at 60 s and ends at 120 s.
    expect(planned.arrivals).toMatchObject({
      peak: 1,
      waiting: 1,
      longestWaitMs: 20 * S,
      lastEndMs: 120 * S,
    });
    expect(planned.warnings).toEqual([
      "1 participant would start after their time when every session uses its 1m budget, the latest by 20s: the run starts at most 1 at once and holds the next one until a slot frees.",
      'Participant "late" would still be waiting for a free slot at its end (participants[].endAfterMs) when every session uses its 1m budget, so the run would skip it without creating its desktop: the run starts at most 1 at once. Let more participants run at once, or give it a later end.',
    ]);
  });

  it("names every participant the run would skip", () => {
    const planned = computerUse(
      plan(
        study("cuAppUrl", {
          participants: [
            { id: "first" },
            { id: "a", endAfterMs: 30 * S },
            { id: "b", endAfterMs: 30 * S },
          ],
          execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 1 },
        }),
      ),
    );
    expect(planned.warnings).toContain(
      '2 participants ("a", "b") would still be waiting for a free slot at their end (participants[].endAfterMs) when every session uses its 1m budget, so the run would skip them without creating their desktops: the run starts at most 1 at once. Let more participants run at once, or give them a later end.',
    );
  });
});
