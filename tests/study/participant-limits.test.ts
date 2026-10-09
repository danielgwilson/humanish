// A study may have up to 100 participants. How many of them run at once is the E2B plan's limit
// (HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES, 20 when unset), and automatic analysis, which reads at
// most 16 participants, says so when a study has more.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { runStudyWith } from "../../src/run-study.js";
import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import type { PlanResult, StudyPlan } from "../../src/study/plan-types.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const SETTING = "HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES";

function study(base: BaseName, patch: Patch = {}): StudyConfig {
  const parsed = parseStudy(lab(base, patch));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function plan(
  config: StudyConfig,
  env: Record<string, string> = {},
  options: { count?: number; dryRun?: boolean } = {},
): PlanResult {
  return planStudy(config, {
    cwd: process.cwd(),
    dryRun: options.dryRun ?? false,
    env,
    ...(options.count === undefined ? {} : { count: options.count }),
  });
}

function planned(result: PlanResult): StudyPlan {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.planned.plan;
}

function refusal(result: PlanResult): { code: string; message: string } {
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal;
}

const participants = (count: number) => ({ participants: count });
// A shared world of `count` members, written as one group the parser expands to member-01...
const members = (count: number) => ({ participants: [{ id: "member", count }] });

describe("how many participants a study may have", () => {
  it.each([17, 40, 100])("plans a computer-use study of %i participants", (count) => {
    const result = planned(plan(study("cuAppUrl", participants(count)), { [SETTING]: "100" }));
    expect(result.route === "computer-use" && result.runner.participants.length).toBe(count);
  });

  it("refuses 101 at parse time and names the limit", () => {
    const parsed = parseStudy(lab("cuAppUrl", participants(101)));
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.error.message).toContain("at most 100 participants");
    expect(parsed.error.message).toContain("has 101");
  });

  it("refuses a --count of 101 the same way", () => {
    const refused = refusal(plan(study("cuAppUrl"), {}, { count: 101 }));
    expect(refused.code).toBe("HUMANISH_COMPUTER_USE_FANOUT_INVALID");
    expect(refused.message).toContain("at most 100 participants");
  });

  it("refuses a group count over the limit before expanding it", () => {
    const started = Date.now();
    const parsed = parseStudy(lab("cuAppUrl", { participants: [{ id: "crowd", count: 1e9 }] }));
    expect(Date.now() - started).toBeLessThan(1_000);
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.error.message).toContain("at most 100 participants");
  });

  it("plans a shared world of 40 members and refuses one of 101", () => {
    const forty = planned(plan(study("sharedProvisioned", members(40)), { [SETTING]: "100" }));
    expect(forty.route === "shared-world" && forty.plane.participants.length).toBe(40);
    const parsed = parseStudy(lab("sharedProvisioned", members(101)));
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.error.message).toContain("at most 100 participants");
  });

  it("refuses real email receiving for more participants than it can lease inboxes for", () => {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        ...participants(65),
        comms: { email: { kind: "real", connection: "inbox" } },
      }),
    );
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.error.message).toContain("64");
  });
});

describe("how many computer-use participants run at once", () => {
  const concurrency = (result: PlanResult) => {
    const value = planned(result);
    return value.route === "computer-use" ? value.concurrency : undefined;
  };

  it("runs every participant at once when the plan allows that many", () => {
    expect(concurrency(plan(study("cuAppUrl", participants(17))))).toBe(17);
  });

  it("runs 20 at a time by default, the E2B Hobby limit, and says which setting raises it", () => {
    const result = planned(plan(study("cuAppUrl", participants(24))));
    expect(result.route === "computer-use" && result.concurrency).toBe(20);
    expect(result.warnings?.join("\n")).toContain(SETTING);
  });

  it("runs all 24 at once when the setting allows 100", () => {
    const result = planned(plan(study("cuAppUrl", participants(24)), { [SETTING]: "100" }));
    expect(result.route === "computer-use" && result.concurrency).toBe(24);
    expect(result.warnings?.join("\n") ?? "").not.toContain(SETTING);
  });

  it("refuses an explicit concurrency the plan cannot run, naming the value that admits it", () => {
    const config = study("cuAppUrl", {
      ...participants(24),
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 24 },
    });
    const refused = refusal(plan(config));
    expect(refused.code).toBe("HUMANISH_COMPUTER_USE_FANOUT_INVALID");
    expect(refused.message).toContain(`set ${SETTING} to 24 or more`);
    expect(concurrency(plan(config, { [SETTING]: "100" }))).toBe(24);
  });

  it("keeps an explicit concurrency the plan can run", () => {
    const config = study("cuAppUrl", {
      ...participants(40),
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 8 },
    });
    expect(concurrency(plan(config))).toBe(8);
  });

  it("refuses a setting it cannot read", () => {
    const refused = refusal(plan(study("cuAppUrl", participants(2)), { [SETTING]: "lots" }));
    expect(refused.code).toBe("HUMANISH_COMPUTER_USE_FANOUT_INVALID");
    expect(refused.message).toContain(SETTING);
  });

  it("leaves a local desktop study to its own capacity rules", () => {
    const local = study("cuAppUrl", {
      ...participants(24),
      execution: { target: "local", timeoutMs: 60_000 },
    });
    expect(concurrency(plan(local, { [SETTING]: "lots" }))).toBe(24);
  });
});

describe("how many shared-world participants run at once", () => {
  const concurrency = (result: PlanResult) => {
    const value = planned(result);
    return value.route === "shared-world" ? value.concurrency : undefined;
  };

  it("counts the app's own sandbox against the plan's limit", () => {
    expect(concurrency(plan(study("sharedProvisioned", members(24))))).toBe(19);
    expect(concurrency(plan(study("sharedProvisioned", members(24)), { [SETTING]: "100" }))).toBe(
      24,
    );
  });

  it("runs an external public app's members 20 at a time by default", () => {
    const external = study("sharedExternal", {
      participants: [
        { id: "host", host: true },
        { id: "guest", count: 23 },
      ],
    });
    expect(concurrency(plan(external))).toBe(20);
  });

  it("refuses an explicit concurrency the plan cannot run", () => {
    const config = study("sharedProvisioned", {
      ...members(24),
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 24 },
    });
    const refused = refusal(plan(config));
    expect(refused.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
    expect(refused.message).toContain(`set ${SETTING} to 25 or more`);
  });
});

describe("automatic analysis of a study over 16 participants", () => {
  it("is planned to run for 17 participants, as for 16", () => {
    for (const count of [16, 17]) {
      const analysis = planned(plan(study("cuAppUrl", participants(count)))).analysis;
      expect(analysis?.config.model).toBe("gpt-6-astra");
      expect(analysis?.skip).toBeUndefined();
    }
  });

  it("says in study check's analysis line that 17 participants are analysed in two cohorts", async () => {
    const cwd = await makeTestTempDir("humanish-participant-limits-");
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "crowd.yaml"),
      stringify(lab("cuAppUrl", { mode: "live", ...participants(17) })),
    );
    const check = await runStudyPreflight({ cwd, study: "crowd", env: {} });
    expect(check.analysis?.expectedCostUsd).toBeDefined();
    let stdout = "";
    const program = createProgram({
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: () => {},
      setExitCode: () => {},
    });
    await program.parseAsync(["node", "humanish", "study", "check", "crowd", "--cwd", cwd]);
    const line = stdout.split("\n").find((text) => text.startsWith("After live runs:"));
    expect(line).toMatch(/for 17 participants, analysed in 2 cohorts of at most 16/);
  });
});

describe("a dry run of 40 participants", () => {
  it("finishes ok with every participant planned", async () => {
    const cwd = await makeTestTempDir("humanish-participant-limits-");
    const outcome = await runStudyWith(study("cuAppUrl", participants(40)), {
      cwd,
      dryRun: true,
      env: { [SETTING]: "100" },
    });
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.laneSummary?.total).toBe(40);
    expect(outcome.result.laneSummary?.concurrency).toBe(40);
  });
});
