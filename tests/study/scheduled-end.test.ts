// A participant may end at a time on the run's clock: `participants[].endAfterMs`, on the same
// clock as `startAfterMs`, with `windDownMs` (default 10 minutes) before it. The plan refuses a
// window that ends before it starts or whose sandbox would outlive the ceiling, sizes each
// participant's sandbox from its own window, and `study check` prints every window.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { participantRunsAndPlan } from "../../src/routes/computer-use/participant-runs.js";
import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import type { PlanResult, StudyPlan } from "../../src/study/plan-types.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const CEILING = "HUMANISH_E2B_MAX_SANDBOX_MINUTES";
const S = 1_000;
const MIN = 60 * S;
const HOURS = 60 * MIN;

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

function plan(config: StudyConfig, env: Record<string, string> = {}): PlanResult {
  return planStudy(config, { cwd: process.cwd(), dryRun: false, env });
}

function planned(result: PlanResult): StudyPlan {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.planned.plan;
}

function refusal(result: PlanResult): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal.message;
}

// A support desk's day: one support agent works four hours while two customers arrive.
const supportDay = {
  participants: [
    { id: "support-agent", endAfterMs: 4 * HOURS },
    { id: "customer", count: 2, startAfterMs: 30 * S, startEveryMs: 30 * S },
  ],
};

describe("declaring when a participant ends", () => {
  it("gives each participant its window, with a wind-down of a quarter of it, at most 10 minutes, unless it declares one", () => {
    const day = planned(
      plan(
        study("cuAppUrl", {
          participants: [
            { id: "support-agent", endAfterMs: 4 * HOURS },
            { id: "lead", endAfterMs: 2 * HOURS, windDownMs: 5 * MIN },
            { id: "customer", startAfterMs: 30 * S },
            { id: "brief", startAfterMs: 2 * MIN, endAfterMs: 10 * MIN },
          ],
        }),
        { [CEILING]: "1440" },
      ),
    );
    if (day.route !== "computer-use") throw new Error(day.route);
    // Each session is its window plus 5 minutes for the closing report.
    expect(day.runner.participants.map(({ id, schedule }) => ({ id, ...schedule }))).toEqual([
      {
        id: "support-agent",
        end: {
          kind: "scheduled_end",
          endAfterMs: 14_400_000,
          windowMs: 14_400_000,
          windDownMs: 600_000,
          sessionMs: 14_700_000,
        },
      },
      {
        id: "lead",
        end: {
          kind: "scheduled_end",
          endAfterMs: 7_200_000,
          windowMs: 7_200_000,
          windDownMs: 300_000,
          sessionMs: 7_500_000,
        },
      },
      { id: "customer", startAfterMs: 30_000 },
      // An 8-minute window is told the time left for its last 2 minutes.
      {
        id: "brief",
        startAfterMs: 120_000,
        end: {
          kind: "scheduled_end",
          endAfterMs: 600_000,
          windowMs: 480_000,
          windDownMs: 120_000,
          sessionMs: 780_000,
        },
      },
    ]);
  });

  it("gives each member of a group the group's end", () => {
    const agents = planned(
      plan(
        study("cuAppUrl", {
          participants: [
            { id: "support-agent", count: 2, startEveryMs: 10 * MIN, endAfterMs: 30 * MIN },
            { id: "customer", startAfterMs: 30 * S },
          ],
        }),
      ),
    );
    if (agents.route !== "computer-use") throw new Error(agents.route);
    // Each member's window runs from its own start to the group's end.
    expect(
      agents.runner.participants.map(({ id, schedule: { end } }) => [
        id,
        end?.kind === "scheduled_end" ? [end.endAfterMs, end.windowMs] : undefined,
      ]),
    ).toEqual([
      ["support-agent-01", [1_800_000, 1_800_000]],
      ["support-agent-02", [1_800_000, 1_200_000]],
      ["customer", undefined],
    ]);
  });

  it.each([
    ["at its start", { startAfterMs: 60 * S, endAfterMs: 60 * S }],
    ["before its start", { startAfterMs: 60 * S, endAfterMs: 30 * S }],
  ])("refuses an end %s, naming the field", (_name, window) => {
    const message = parseRefusal("cuAppUrl", {
      participants: [{ id: "a" }, { id: "b", ...window }],
    });
    expect(message).toContain("participants[1].endAfterMs");
    expect(message).toContain("startAfterMs");
  });

  it.each([
    ["a fractional end", { endAfterMs: 1.5 }],
    ["an end past 24 hours", { endAfterMs: 24 * HOURS + 1 }],
    ["a negative wind-down", { endAfterMs: 60 * S, windDownMs: -1 }],
  ])("refuses %s", (_name, window) => {
    const message = parseRefusal("cuAppUrl", {
      participants: [{ id: "a" }, { id: "b", ...window }],
    });
    expect(message).toContain("participants[1].");
  });

  it("refuses a wind-down without an end", () => {
    const message = parseRefusal("cuAppUrl", {
      participants: [{ id: "a" }, { id: "b", windDownMs: 60 * S }],
    });
    expect(message).toContain("participants[1].windDownMs");
    expect(message).toContain("endAfterMs");
  });

  it("refuses a group whose spread puts a member's start at or past the group's end", () => {
    const message = parseRefusal("cuAppUrl", {
      participants: [
        { id: "support-agent", count: 3, startEveryMs: 15 * MIN, endAfterMs: 30 * MIN },
      ],
    });
    expect(message).toContain("support-agent-03");
    expect(message).toContain("endAfterMs");
  });

  it("refuses an end on a shared world", () => {
    const message = parseRefusal("sharedProvisioned", {
      participants: [{ id: "author", endAfterMs: 30 * MIN }, { id: "reviewer" }],
    });
    expect(message).toContain("endAfterMs");
    expect(message).toContain("shared-world");
  });

  it("refuses an end before the start for a library caller that skipped the parser", () => {
    const config = study("cuAppUrl", { participants: [{ id: "a" }, { id: "b" }] });
    const unparsed: StudyConfig = {
      ...config,
      participants: [{ id: "a" }, { id: "b", startAfterMs: 60 * S, endAfterMs: 60 * S }],
    };
    expect(refusal(plan(unparsed))).toContain("participants[1].endAfterMs");
  });
});

describe("a window and the sandbox ceiling", () => {
  it("refuses an agent's window whose sandbox would outlive the ceiling, naming the setting", () => {
    // The support agent's session is its 4-hour window plus 5 minutes for the closing report, and
    // its sandbox adds the 10-minute teardown buffer: 255 minutes.
    const message = refusal(plan(study("cuAppUrl", supportDay)));
    expect(message).toContain('"support-agent"');
    expect(message).toContain("255m");
    expect(message).toContain("may not live longer than 60m");
    expect(message).toContain(`set ${CEILING} to 255 or more`);
  });

  it("sizes each participant's sandbox from its own window on a plan that allows it", () => {
    const day = planned(plan(study("cuAppUrl", supportDay), { [CEILING]: "1440" }));
    if (day.route !== "computer-use") throw new Error(day.route);
    // The agent holds its slot to 4 h 5 m; the customers' 1-minute sessions end long before.
    expect(day.arrivals).toMatchObject({ peak: 3, waiting: 0, lastEndMs: 4 * HOURS + 5 * MIN });
    const { participantPlan } = participantRunsAndPlan(day);
    // 255 sandbox-minutes for the support agent and 11 for each customer.
    expect(participantPlan.worstCaseSandboxMinutes).toBe(277);
    expect(
      participantPlan.lanes.map(({ id, startAfterMs, endAfterMs }) => [
        id,
        startAfterMs,
        endAfterMs,
      ]),
    ).toEqual([
      ["support-agent", undefined, 14_400_000],
      ["customer-01", 30_000, undefined],
      ["customer-02", 60_000, undefined],
    ]);
  });
});

describe("study check", () => {
  it("prints each participant's window", async () => {
    const cwd = await makeTestTempDir("humanish-scheduled-end-check-");
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "support-desk.yaml"),
      stringify(lab("cuAppUrl", { id: "support-desk", ...supportDay })),
    );
    const check = await runStudyPreflight({
      cwd,
      study: "support-desk",
      env: { [CEILING]: "1440" },
    });
    expect(check.ok).toBe(true);
    expect(check.checks.find((row) => row.name === "windows")?.message).toBe(
      "support-agent from +0s to +4h, told the time left from +3h 50m; customer-01 from +30s for up to 1m; customer-02 from +1m for up to 1m.",
    );
  });
});

describe("a scheduled end on a participant model with no closing request", () => {
  const closingWarning = (result: PlanResult): string[] =>
    (planned(result).warnings ?? []).filter((warning) => warning.includes("closing"));

  it("warns that Claude as a local agent leaves its participants with no closing account", () => {
    const local = study("cuAppUrl", supportDay);
    const result = plan(
      { ...local, actor: { ...local.actor, type: "local-agent", localAgent: "claude" } },
      {
        [CEILING]: "1440",
      },
    );
    expect(closingWarning(result)).toEqual([
      "1 participant has a scheduled end (participants[].endAfterMs), and Claude as a local-agent participant model cannot be asked for a closing report, so it ends with the scheduled end as its reason and no closing account. An API participant (actor.type: computer-use) or Codex (actor.localAgent: codex) writes one.",
    ]);
  });

  it("says nothing for a computer-use model or Codex, which write the closing report", () => {
    const hosted = study("cuAppUrl", supportDay);
    const codex = {
      ...hosted,
      actor: { ...hosted.actor, type: "local-agent", localAgent: "codex" },
    };
    for (const config of [hosted, codex] as StudyConfig[])
      expect(closingWarning(plan(config, { [CEILING]: "1440" }))).toEqual([]);
  });
});
