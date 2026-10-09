// A study may say when each participant starts: `participants[].startAfterMs` from the moment the
// run starts its participants, and `startEveryMs` on a group to spread its members. The plan
// reports the schedule, holds participants whose time comes while every slot is busy, and checks
// the sandboxes a late start keeps alive against the sandbox ceiling.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import type { PlanResult, StudyPlan } from "../../src/study/plan-types.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const CONCURRENT = "HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES";
const CEILING = "HUMANISH_E2B_MAX_SANDBOX_MINUTES";
const S = 1_000;
const HOURS = 60 * 60 * S;

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

function participantStarts(result: StudyPlan): [string, number | undefined][] {
  const participants =
    result.route === "computer-use"
      ? result.runner.participants
      : result.route === "shared-world"
        ? result.plane.participants
        : [];
  return participants.map((participant) => [participant.id, participant.startAfterMs]);
}

describe("declaring when participants start", () => {
  it("gives each roster entry the offset it declares", () => {
    const clinic = study("cuAppUrl", {
      participants: [
        { id: "nurse" },
        { id: "patient-a", startAfterMs: 30 * S },
        { id: "patient-b", startAfterMs: 90 * S },
      ],
    });
    expect(participantStarts(planned(plan(clinic)))).toEqual([
      ["nurse", undefined],
      ["patient-a", 30_000],
      ["patient-b", 90_000],
    ]);
  });

  it("spreads a group's members at its interval from the group's own start", () => {
    const clinic = study("cuAppUrl", {
      participants: [
        { id: "staff", count: 2 },
        { id: "patient", count: 4, startAfterMs: 60 * S, startEveryMs: 30 * S },
      ],
    });
    expect(participantStarts(planned(plan(clinic)))).toEqual([
      ["staff-01", undefined],
      ["staff-02", undefined],
      ["patient-01", 60_000],
      ["patient-02", 90_000],
      ["patient-03", 120_000],
      ["patient-04", 150_000],
    ]);
  });

  it("gives shared-world participants their offsets too", () => {
    const ward = study("sharedProvisioned", {
      participants: [{ id: "author" }, { id: "reviewer", startAfterMs: 45 * S }],
    });
    expect(participantStarts(planned(plan(ward)))).toEqual([
      ["author", undefined],
      ["reviewer", 45_000],
    ]);
  });

  it.each([
    ["a negative offset", { startAfterMs: -1 }],
    ["a fractional offset", { startAfterMs: 1.5 }],
    ["a duration string", { startAfterMs: "30s" }],
    ["an offset past 24 hours", { startAfterMs: 24 * HOURS + 1 }],
  ])("refuses %s, naming the field and its range", (_name, late) => {
    const message = parseRefusal("cuAppUrl", { participants: [{ id: "a" }, { id: "b", ...late }] });
    expect(message).toContain("participants[1].startAfterMs");
    expect(message).toContain("86400000");
  });

  it("refuses an interval on an entry that is not a group", () => {
    const message = parseRefusal("cuAppUrl", {
      participants: [{ id: "a" }, { id: "b", startEveryMs: 30 * S }],
    });
    expect(message).toContain("participants[1].startEveryMs");
    expect(message).toContain("count");
  });

  it("refuses an interval of 0", () => {
    const message = parseRefusal("cuAppUrl", {
      participants: [{ id: "patient", count: 3, startEveryMs: 0 }],
    });
    expect(message).toContain("participants[0].startEveryMs");
  });

  it("refuses a group whose last member would start past 24 hours", () => {
    const message = parseRefusal("cuAppUrl", {
      participants: [{ id: "patient", count: 3, startEveryMs: 12 * HOURS + 1 }],
    });
    expect(message).toContain("patient-03");
    expect(message).toContain("86400000");
  });

  it("refuses a schedule for a single participant", () => {
    const message = parseRefusal("cuAppUrl", {
      participants: [{ id: "solo", startAfterMs: 30 * S }],
    });
    expect(message).toContain("startAfterMs");
    expect(message).toContain("two or more participants");
  });

  it("refuses a late start for the host of an external public app", () => {
    const message = parseRefusal("sharedExternal", {
      participants: [
        { id: "host", host: true, startAfterMs: 30 * S },
        { id: "guest", startAfterMs: 30 * S },
      ],
    });
    expect(message).toContain("startAfterMs");
    expect(message).toContain('host participant "host"');
  });
});

describe("the plan's schedule", () => {
  it("says when the first and last participant start and how many run at once", () => {
    const day = study("cuAppUrl", {
      participants: [{ id: "patient", count: 8, startEveryMs: 30 * S }],
      execution: { target: "e2b-desktop", timeoutMs: 120 * S },
    });
    const result = planned(plan(day));
    expect(result.route === "computer-use" && result.arrivals).toEqual({
      declared: true,
      firstStartMs: 0,
      lastStartMs: 210_000,
      peak: 4,
      waiting: 0,
      longestWaitMs: 0,
      lastEndMs: 330_000,
      sessionMs: 120_000,
    });
  });

  it("holds participants past the E2B plan's limit until a slot frees and names the setting", () => {
    // 24 participants a second apart with 1-minute sessions would have all 24 live at 23 s.
    const rush = study("cuAppUrl", {
      participants: [{ id: "patient", count: 24, startEveryMs: 1 * S }],
    });
    const atDefault = planned(plan(rush));
    if (atDefault.route !== "computer-use") throw new Error(atDefault.route);
    expect(atDefault.concurrency).toBe(20);
    // patient-21 is due at 20 s and starts when patient-01 ends at 60 s; the last starts at 63 s.
    expect(atDefault.arrivals).toMatchObject({
      peak: 20,
      waiting: 4,
      longestWaitMs: 40_000,
      lastEndMs: 123_000,
    });
    expect(atDefault.warnings?.join("\n")).toContain(CONCURRENT);

    const onPro = planned(plan(rush, { [CONCURRENT]: "100" }));
    if (onPro.route !== "computer-use") throw new Error(onPro.route);
    expect(onPro.concurrency).toBe(24);
    expect(onPro.arrivals).toMatchObject({ peak: 24, waiting: 0, lastEndMs: 83_000 });
    expect(onPro.warnings?.join("\n") ?? "").not.toContain(CONCURRENT);
  });

  it("does not warn about waves when the schedule never needs more slots than the plan runs", () => {
    const spread = study("cuAppUrl", {
      participants: [{ id: "patient", count: 24, startEveryMs: 30 * S }],
    });
    const result = planned(plan(spread));
    expect(result.route === "computer-use" && result.arrivals?.peak).toBe(2);
    expect(result.warnings?.join("\n") ?? "").not.toContain(CONCURRENT);
  });
});

describe("study check", () => {
  it("prints the schedule and does not call a scheduled roster under a concurrency cap waves", async () => {
    const cwd = await makeTestTempDir("humanish-arrivals-check-");
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "clinic.yaml"),
      stringify(
        lab("cuAppUrl", {
          id: "clinic",
          participants: [{ id: "patient", count: 8, startEveryMs: 30 * S }],
          execution: { target: "e2b-desktop", timeoutMs: 120 * S, concurrency: 3 },
        }),
      ),
    );
    const check = await runStudyPreflight({ cwd, study: "clinic", env: {} });
    expect(check.ok).toBe(true);
    // With 3 slots the fourth patient, due at 90 s, waits for the first to end at 120 s; each
    // later one waits too, and the seventh and eighth by a minute (due 180 s, start 240 s).
    expect(check.checks.find((row) => row.name === "schedule")?.message).toBe(
      "the first participant starts at +0s and the last at +3m 30s; at most 3 run at once when every session uses its 2m budget; 5 participants then start late, waiting for a free slot, the latest by 1m.",
    );
    expect(check.warnings.join("\n")).not.toContain("waves");
  });
});

describe("a late start and the sandbox ceiling", () => {
  const lateArrival = { participants: [{ id: "early" }, { id: "late", startAfterMs: 3 * HOURS }] };

  it("admits a computer-use participant at 3 h under a 1-hour ceiling: its desktop starts with it", () => {
    const result = planned(plan(study("cuAppUrl", lateArrival)));
    if (result.route !== "computer-use") throw new Error(result.route);
    // Each participant's sandbox lives its 1-minute session plus the 10-minute buffer.
    expect(result.sandboxMs).toBe(660_000);
    expect(result.arrivals?.lastStartMs).toBe(3 * HOURS);
  });

  it("refuses a shared world whose app would have to serve past the ceiling, naming the setting", () => {
    const ward = study("sharedProvisioned", {
      participants: [{ id: "author" }, { id: "reviewer", startAfterMs: 3 * HOURS }],
    });
    // The app serves 3 h + the 1-minute session, plus 45 m to provision, seed (one 5-minute step)
    // and tear down: 226 m.
    const refused = plan(ward);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
    expect(refused.refusal.message).toContain("226m");
    expect(refused.refusal.message).toContain("may not live longer than 60m");
    expect(refused.refusal.message).toContain(`set ${CEILING} to 226 or more`);

    const onPro = planned(plan(ward, { [CEILING]: "1440" }));
    expect(onPro.route === "shared-world" && onPro.arrivals.lastEndMs).toBe(3 * HOURS + 60 * S);
  });

  it("counts the waves of a shared world past the E2B plan's limit in the app's deadline", () => {
    // 40 members with 15-minute sessions run 19 at a time beside the app: three waves, 45 m.
    const crowd = study("sharedProvisioned", {
      participants: [{ id: "member", count: 40 }],
      execution: { target: "e2b-desktop", timeoutMs: 15 * 60 * S },
    });
    const refused = plan(crowd);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.message).toContain("90m");
    const onPro = planned(plan(crowd, { [CONCURRENT]: "100" }));
    expect(onPro.route === "shared-world" && onPro.arrivals.lastEndMs).toBe(15 * 60 * S);
  });
});
