// A participant's clock: `participants[].clock: { timeZone }` overrides `actor.clock` for that
// participant. Its zone is the one each turn gives the time in and, on a hosted desktop, the one its
// browser runs in, so the parser takes only a name Chrome reads the same way Intl does.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CommanderError, type Command } from "commander";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { createProgram } from "../../src/cli/program.js";

import type { CuaExecutor, CuaProvider } from "../../src/actors/computer-use/loop.js";
import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import type { PlanResult, StudyPlan } from "../../src/study/plan-types.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type BaseName, type Patch } from "../admission/fixtures.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

function study(base: BaseName, patch: Patch = {}): StudyConfig {
  const parsed = parseStudy(lab(base, patch));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function plan(config: StudyConfig, options: Record<string, unknown> = {}): PlanResult {
  return planStudy(config, { cwd: process.cwd(), dryRun: false, env: {}, ...options });
}

function planned(result: PlanResult): StudyPlan {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.planned.plan;
}

/** Each participant's id and planned time zone. */
function zones(result: PlanResult): Array<[string, string | undefined]> {
  const studyPlan = planned(result);
  const participants =
    studyPlan.route === "computer-use"
      ? studyPlan.runner.participants
      : studyPlan.route === "shared-world"
        ? studyPlan.plane.participants
        : [];
  return participants.map((participant) => [participant.id, participant.limits.timeZone]);
}

function parseRefusal(base: BaseName, patch: Patch): string {
  const parsed = parseStudy(lab(base, patch));
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.error.message;
}

describe("parsing a participant's clock", () => {
  it("reads a time zone on a participant entry", () => {
    const config = study("cuAppUrl", {
      participants: [
        { id: "london", clock: { timeZone: "Europe/London" } },
        { id: "tokyo", clock: { timeZone: "Asia/Tokyo" } },
        { id: "support-agent" },
      ],
    });
    expect(config.participants).toEqual([
      { id: "london", clock: { timeZone: "Europe/London" } },
      { id: "tokyo", clock: { timeZone: "Asia/Tokyo" } },
      { id: "support-agent" },
    ]);
  });

  it("names the participant entry when its zone is not one", () => {
    expect(
      parseRefusal("cuAppUrl", {
        participants: [{ id: "a" }, { id: "b", clock: { timeZone: "Mars/Olympus_Mons" } }],
      }),
    ).toBe(
      'participants[1].clock must be { timeZone }, with timeZone a time zone name such as "Europe/London": the participant\'s local time, which each turn tells it and its hosted browser runs in.',
    );
  });

  // Intl accepts every value below. Chrome launched with +05:00 as TZ ran in UTC and with
  // europe/london in Etc/Unknown (a local google-chrome 149 read
  // Intl.DateTimeFormat().resolvedOptions().timeZone). Intl spells europe/belfast and etc/utc as a
  // different zone name, and ICU, which reads TZ in the browser, finds a name only with its
  // capitals: with TZ=europe/belfast it reported a UTC offset of 0.
  it.each([
    [
      "+05:00",
      'participants[0].clock.timeZone "+05:00" is a UTC offset, and a browser\'s time zone takes only a time zone name. Write the name of a place in that zone, such as "Asia/Karachi" for +05:00.',
    ],
    [
      "europe/london",
      'participants[0].clock.timeZone "europe/london" must be written with the capitals of a time zone name, such as "Europe/London" for this zone: the browser reads a time zone name only with its capitals.',
    ],
    [
      "europe/belfast",
      'participants[0].clock.timeZone "europe/belfast" must be written with the capitals of a time zone name, such as "Europe/London" for this zone: the browser reads a time zone name only with its capitals.',
    ],
    [
      "etc/utc",
      'participants[0].clock.timeZone "etc/utc" must be written with the capitals of a time zone name, such as "UTC" for this zone: the browser reads a time zone name only with its capitals.',
    ],
  ])("refuses %s, which a browser would not run in", (timeZone, message) => {
    expect(parseRefusal("cuAppUrl", { participants: [{ clock: { timeZone } }] })).toBe(message);
  });

  it("holds actor.clock to the same rule", () => {
    expect(parseRefusal("cuAppUrl", { actor: { clock: { timeZone: "europe/london" } } })).toBe(
      'actor.clock.timeZone "europe/london" must be written with the capitals of a time zone name, such as "Europe/London" for this zone: the browser reads a time zone name only with its capitals.',
    );
  });

  it("takes an alias, an Etc zone and lowercase words inside a part as written", () => {
    const config = study("cuAppUrl", {
      actor: { clock: { timeZone: "Europe/Belfast" } },
      participants: [
        { clock: { timeZone: "Etc/GMT+5" } },
        { clock: { timeZone: "Africa/Dar_es_Salaam" } },
      ],
    });
    expect(config.actor.clock).toEqual({ timeZone: "Europe/Belfast" });
    expect(config.participants).toEqual([
      { clock: { timeZone: "Etc/GMT+5" } },
      { clock: { timeZone: "Africa/Dar_es_Salaam" } },
    ]);
  });
});

describe("planning each participant's time zone", () => {
  it("gives a participant its own zone, else the actor's, else none", () => {
    expect(
      zones(
        plan(
          study("cuAppUrl", {
            actor: { clock: { timeZone: "Europe/London" } },
            participants: [
              { id: "lisbon", clock: { timeZone: "Europe/Lisbon" } },
              { id: "london" },
            ],
          }),
        ),
      ),
    ).toEqual([
      ["lisbon", "Europe/Lisbon"],
      ["london", "Europe/London"],
    ]);
    expect(zones(plan(study("cuAppUrl", { participants: [{ id: "plain" }] })))).toEqual([
      ["plain", undefined],
    ]);
  });

  it("gives every member of a group the group's zone", () => {
    expect(
      zones(
        plan(
          study("cuAppUrl", {
            participants: [{ id: "visitor", count: 2, clock: { timeZone: "Asia/Tokyo" } }],
          }),
        ),
      ),
    ).toEqual([
      ["visitor-01", "Asia/Tokyo"],
      ["visitor-02", "Asia/Tokyo"],
    ]);
  });

  it("gives a shared-world participant its own zone", () => {
    expect(
      zones(
        plan(
          study("sharedExternal", {
            participants: [
              { id: "host", host: true, clock: { timeZone: "Europe/London" } },
              { id: "guest", clock: { timeZone: "Asia/Tokyo" } },
            ],
          }),
        ),
      ),
    ).toEqual([
      ["host", "Europe/London"],
      ["guest", "Asia/Tokyo"],
    ]);
  });
});

describe("refusing a time zone where humanish cannot set the browser's zone", () => {
  function refusal(result: PlanResult): { code: string; message: string } {
    if (result.ok) throw new Error("expected a refusal");
    return { code: result.refusal.code, message: result.refusal.message };
  }

  it("refuses a participant's zone on the local browser runtime", () => {
    expect(
      refusal(
        plan(
          study("cuAppUrl", {
            execution: { target: "local" },
            participants: [{ id: "plain" }, { id: "tokyo", clock: { timeZone: "Asia/Tokyo" } }],
          }),
        ),
      ),
    ).toEqual({
      code: "HUMANISH_COMPUTER_USE_TIME_ZONE_UNSUPPORTED",
      message:
        "Participant tokyo has the time zone Asia/Tokyo, which sets the zone its browser runs in, and humanish sets a browser's zone only on a hosted desktop. This study runs on the local browser runtime. Remove actor.clock and participants[].clock, or set execution.target: e2b-desktop.",
    });
  });

  it("refuses actor.clock on the local browser runtime", () => {
    expect(
      refusal(
        plan(
          study("cuAppUrl", {
            execution: { target: "local" },
            actor: { clock: { timeZone: "Europe/London" } },
          }),
        ),
      ).code,
    ).toBe("HUMANISH_COMPUTER_USE_TIME_ZONE_UNSUPPORTED");
  });

  it("refuses a zone on the in-process route, whose browser is the caller's", () => {
    const executor = {} as CuaExecutor;
    const provider = {} as CuaProvider;
    expect(
      refusal(
        plan(study("cuLocalApp", { actor: { clock: { timeZone: "Europe/London" } } }), {
          inProcess: { executor: async () => executor },
          createProvider: async () => provider,
        }),
      ),
    ).toEqual({
      code: "HUMANISH_COMPUTER_USE_TIME_ZONE_UNSUPPORTED",
      message:
        "Participant lane-01 has the time zone Europe/London, which sets the zone its browser runs in, and humanish sets a browser's zone only on a hosted desktop. This study drives your own browser through RunStudyOptions.inProcess. Remove actor.clock and participants[].clock, and set the zone in that browser yourself, or run on a hosted desktop.",
    });
  });
});

describe("study check and study show", () => {
  const visit = {
    participants: [
      { id: "london", clock: { timeZone: "Europe/London" } },
      { id: "tokyo", clock: { timeZone: "Asia/Tokyo" } },
      { id: "plain" },
    ],
  };

  async function studyDir(patch: Patch): Promise<string> {
    const cwd = await makeTestTempDir("humanish-participant-clock-");
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(path.join(cwd, "package.json"), '{ "name": "clock-fixture" }\n');
    await writeFile(
      path.join(cwd, "humanish", "studies", "visit.yaml"),
      stringify(lab("cuAppUrl", { id: "visit", ...patch })),
    );
    return cwd;
  }

  async function showOutput(cwd: string): Promise<string> {
    const stdout: string[] = [];
    const program = createProgram({
      writeOut: (text) => stdout.push(text),
      writeErr: () => undefined,
      setExitCode: () => undefined,
    });
    const override = (command: Command): void => {
      command.exitOverride();
      command.commands.forEach(override);
    };
    override(program);
    try {
      await program.parseAsync(["node", "humanish", "study", "show", "visit", "--cwd", cwd], {
        from: "node",
      });
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
    }
    return stdout.join("");
  }

  it("prints each participant's zone", async () => {
    const cwd = await studyDir(visit);
    const check = await runStudyPreflight({ cwd, study: "visit", env: {} });
    expect(check.ok).toBe(true);
    expect(check.checks.find((row) => row.name === "time zones")).toEqual({
      name: "time zones",
      ok: true,
      message: "london Europe/London, tokyo Asia/Tokyo, plain none.",
    });
    expect((await showOutput(cwd)).split("\n")).toContain(
      "time zones: london Europe/London, tokyo Asia/Tokyo, plain none.",
    );
  });

  it("prints no zones for a study without any", async () => {
    const cwd = await studyDir({ participants: [{ id: "plain" }] });
    const check = await runStudyPreflight({ cwd, study: "visit", env: {} });
    expect(check.checks.map((row) => row.name)).not.toContain("time zones");
    expect(await showOutput(cwd)).not.toMatch(/^time zones:/m);
  });
});
