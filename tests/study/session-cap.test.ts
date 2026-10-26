// A participant may leave when it is done, but no later than a cap: `participants[].maxSessionMs`,
// counted from the start of its own session, with `windDownMs` (default 10 minutes) before it. The
// plan refuses a cap beside `endAfterMs`, on a shared world, or with a sandbox that would outlive
// the ceiling, sizes each capped participant's session and sandbox from its cap, and `study check`
// prints every window.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { participantRunsAndPlan } from "../../src/routes/computer-use/participant-runs.js";
import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import type { PlanResult, StudyPlan } from "../../src/study/plan-types.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const CEILING = "HUMANISH_E2B_MAX_SANDBOX_MINUTES";
const S = 1_000;
const MIN = 60 * S;

function study(base: BaseName, patch: Patch = {}): StudyConfig {
  const parsed = parseStudy(lab(base, patch));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function parseRefusal(base: BaseName, patch: Patch): string {
  const parsed = parseStudy(lab(base, patch));
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.error.message;
}

function refusal(result: PlanResult): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal.message;
}

function plan(config: StudyConfig, env: Record<string, string> = {}): PlanResult {
  return planStudy(config, { cwd: process.cwd(), dryRun: false, env });
}

function planned(result: PlanResult): StudyPlan {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.planned.plan;
}

describe("declaring a session cap", () => {
  it("gives each participant its cap, with a wind-down of a quarter of it unless it declares one", () => {
    const visit = planned(
      plan(
        study("cuAppUrl", {
          participants: [
            { id: "quick", maxSessionMs: 10 * MIN },
            { id: "slow", maxSessionMs: 20 * MIN, windDownMs: 2 * MIN },
            { id: "support-agent" },
          ],
        }),
      ),
    );
    if (visit.route !== "computer-use") throw new Error(visit.route);
    // Each capped session is its cap plus 5 minutes for the closing report.
    expect(visit.runner.participants.map(({ id, schedule }) => ({ id, ...schedule }))).toEqual([
      {
        id: "quick",
        end: { kind: "session_cap", windowMs: 600_000, windDownMs: 150_000, sessionMs: 900_000 },
      },
      {
        id: "slow",
        end: {
          kind: "session_cap",
          windowMs: 1_200_000,
          windDownMs: 120_000,
          sessionMs: 1_500_000,
        },
      },
      { id: "support-agent" },
    ]);
  });

  it("gives every member of a group the group's cap, whatever its start", () => {
    const visitors = planned(
      plan(
        study("cuAppUrl", {
          participants: [
            { id: "visitor", count: 3, startEveryMs: 15 * MIN, maxSessionMs: 20 * MIN },
          ],
        }),
      ),
    );
    if (visitors.route !== "computer-use") throw new Error(visitors.route);
    expect(
      visitors.runner.participants.map(({ id, schedule }) => [
        id,
        schedule.startAfterMs,
        schedule.end?.windowMs,
      ]),
    ).toEqual([
      ["visitor-01", 0, 1_200_000],
      ["visitor-02", 900_000, 1_200_000],
      ["visitor-03", 1_800_000, 1_200_000],
    ]);
  });
});

describe("what a session cap combines with", () => {
  it("refuses a cap beside a scheduled end on one participant, naming both fields", () => {
    const message = parseRefusal("cuAppUrl", {
      participants: [{ id: "a" }, { id: "b", endAfterMs: 30 * MIN, maxSessionMs: 10 * MIN }],
    });
    expect(message).toContain("participants[1]");
    expect(message).toContain("endAfterMs");
    expect(message).toContain("maxSessionMs");
  });

  it.each([
    ["a cap of 0", 0],
    ["a fractional cap", 1.5],
    ["a cap past 24 hours", 24 * 60 * MIN + 1],
    ["a cap that is not a number", "10m"],
  ])("refuses %s, naming the field", (_name, maxSessionMs) => {
    const message = parseRefusal("cuAppUrl", {
      participants: [{ id: "a" }, { id: "b", maxSessionMs }],
    });
    expect(message).toContain("participants[1].maxSessionMs");
  });

  it("refuses a cap on a shared world", () => {
    const message = parseRefusal("sharedProvisioned", {
      participants: [{ id: "author", maxSessionMs: 10 * MIN }, { id: "reviewer" }],
    });
    expect(message).toContain("maxSessionMs");
    expect(message).toContain("shared-world");
  });

  it("refuses a cap beside an end for a library caller that skipped the parser", () => {
    const config = study("cuAppUrl", { participants: [{ id: "a" }, { id: "b" }] });
    const unparsed: StudyConfig = {
      ...config,
      participants: [{ id: "a" }, { id: "b", endAfterMs: 30 * MIN, maxSessionMs: 10 * MIN }],
    };
    expect(refusal(plan(unparsed))).toContain("maxSessionMs");
  });
});

describe("a session cap and the plan", () => {
  it("sizes a capped participant's session, slot and sandbox from its cap", () => {
    const visit = planned(
      plan(
        study("cuAppUrl", {
          participants: [{ id: "quick", maxSessionMs: 10 * MIN }, { id: "support-agent" }],
        }),
      ),
    );
    if (visit.route !== "computer-use") throw new Error(visit.route);
    // The capped session is its 10-minute cap plus 5 minutes for the closing report; the other
    // participant keeps the study's 1-minute execution.timeoutMs.
    expect(visit.arrivals).toMatchObject({ peak: 2, lastEndMs: 15 * MIN });
    const { participantPlan } = participantRunsAndPlan(visit);
    // 25 sandbox-minutes for the capped participant (its session and the 10-minute teardown
    // buffer) and 11 for the other.
    expect(participantPlan.worstCaseSandboxMinutes).toBe(36);
    expect(participantPlan.lanes.map(({ id, maxSessionMs }) => [id, maxSessionMs])).toEqual([
      ["quick", 600_000],
      ["support-agent", undefined],
    ]);
  });

  it("holds each group member's slot for its own cap from its own start", () => {
    const visitors = planned(
      plan(
        study("cuAppUrl", {
          participants: [
            { id: "visitor", count: 3, startEveryMs: 15 * MIN, maxSessionMs: 20 * MIN },
          ],
        }),
      ),
    );
    if (visitors.route !== "computer-use") throw new Error(visitors.route);
    // visitor-03 starts at 30 minutes and may hold its slot to 30 + 20 + 5.
    expect(visitors.arrivals).toMatchObject({ peak: 2, waiting: 0, lastEndMs: 55 * MIN });
  });

  it("refuses a cap whose sandbox would outlive the ceiling, naming the setting", () => {
    // 50 minutes, 5 for the closing report and the 10-minute teardown buffer: 65 minutes.
    const message = refusal(
      plan(
        study("cuAppUrl", { participants: [{ id: "slow", maxSessionMs: 50 * MIN }, { id: "b" }] }),
      ),
    );
    expect(message).toContain('"slow"');
    expect(message).toContain("65m");
    expect(message).toContain("may not live longer than 60m");
    expect(message).toContain(`set ${CEILING} to 65 or more`);
  });

  it("runs the same cap on a plan whose ceiling allows it", () => {
    const visit = planned(
      plan(
        study("cuAppUrl", { participants: [{ id: "slow", maxSessionMs: 50 * MIN }, { id: "b" }] }),
        { [CEILING]: "65" },
      ),
    );
    expect(visit.route).toBe("computer-use");
  });
});

describe("study check and the estimates", () => {
  const visit = {
    participants: [
      { id: "quick", maxSessionMs: 10 * MIN },
      { id: "slow", maxSessionMs: 20 * MIN, windDownMs: 2 * MIN },
      { id: "support-agent" },
    ],
  };

  it("prints each participant's window", async () => {
    const cwd = await makeTestTempDir("humanish-session-cap-check-");
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "visit.yaml"),
      stringify(lab("cuAppUrl", { id: "visit", ...visit })),
    );
    const check = await runStudyPreflight({ cwd, study: "visit", env: {} });
    expect(check.ok).toBe(true);
    expect(check.checks.find((row) => row.name === "windows")?.message).toBe(
      "quick from +0s until it ends itself or for up to 10m, told the time left from 7m 30s into its session; slow from +0s until it ends itself or for up to 20m, told the time left from 18m into its session; support-agent from +0s for up to 1m.",
    );
  });

  it("counts a capped participant in the bundle estimate as one that ends itself within its cap", () => {
    const result = plan(
      study("cuAppUrl", {
        participants: [
          { id: "brief", maxSessionMs: 2 * MIN },
          { id: "long", maxSessionMs: 10 * MIN },
          { id: "support-agent" },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.refusal.message);
    // A participant that ends itself is counted for 3 minutes at most, or its budget when shorter:
    // 2 minutes, 3 minutes and the study's 1 minute, at a turn every 10 s, are 12 + 18 + 6 turns.
    // Files and folders: 20 + 3 x 3 + 36. The longest trace: 4,000 + 18 x 3,500 bytes.
    expect(result.planned.bundle?.entries).toBe(65);
    expect(result.planned.bundle?.largestTraceBytes).toBe(67_000);
    expect(result.planned.bundle?.basis).toMatchObject({ scheduled: 0, open: 3, openMs: 3 * MIN });
  });

  it("warns that Claude as a local agent leaves a capped participant with no closing account", () => {
    const hosted = study("cuAppUrl", visit);
    const warnings = (config: StudyConfig): string[] =>
      (planned(plan(config)).warnings ?? []).filter((warning) => warning.includes("closing"));
    expect(
      warnings({
        ...hosted,
        actor: { ...hosted.actor, type: "local-agent", localAgent: "claude" },
      }),
    ).toEqual([
      "2 participants have a session cap (participants[].maxSessionMs), and Claude as a local-agent participant model cannot be asked for a closing report, so each that reaches its cap ends with the cap as its reason and no closing account. An API participant (actor.type: computer-use) or Codex (actor.localAgent: codex) writes one.",
    ]);
    const codex = {
      ...hosted,
      actor: { ...hosted.actor, type: "local-agent", localAgent: "codex" },
    } as StudyConfig;
    for (const config of [hosted, codex]) expect(warnings(config)).toEqual([]);
  });
});
