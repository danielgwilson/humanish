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
    });
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
    // run.json: 4,400 + 6 x 16,500 + 978 x 225. The host's trace: 5,400 + 720 x 4,700.
    expect(result.planned.bundle).toMatchObject({
      runFileBytes: 323_450,
      largestTraceBytes: 3_389_400,
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
});
