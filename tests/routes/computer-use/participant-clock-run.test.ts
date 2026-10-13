// A computer-use study of three participants on fake hosted desktops ($0): one in Chicago, one in
// Tokyo with a session cap, and one with no zone. Each browser launches with TZ set to its
// participant's zone, so every tab runs in it from the first page load; each turn's clock hint and
// the cap's notice give the time in that zone; and run.json records each participant's zone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { CuaProvider, CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import { makeFanoutModule } from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

interface Seen {
  hint: string | undefined;
  /** When the turn was requested: the hint was written just before. */
  atMs: number;
}

/** A participant that clicks once per turn and ends its own session on turn `endsOn`, if any. */
function participant(endsOn: number | undefined, seen: Seen[]): CuaProvider {
  return {
    id: "clock-reader",
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: true,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "open",
    },
    async nextTurn(request: CuaTurnRequest) {
      seen.push({ hint: request.contextHint, atMs: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (seen.length === endsOn)
        return { actions: [], pendingSafetyChecks: [], done: true, message: "REACHED THE GOAL." };
      return {
        actions: [{ kind: "click", x: 10 + seen.length, y: 20 }],
        pendingSafetyChecks: [],
        done: false,
        message: "Checking the time again.",
      };
    },
    async debrief() {
      return {
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        closingReport: { summary: "I watched the clock.", frictionReports: [] },
      };
    },
  };
}

/** The UTC hour at `atMs` moved by `hours`, as the two digits a clock hint shows. */
function hourAt(atMs: number, hours: number): string {
  return String((new Date(atMs).getUTCHours() + hours + 24) % 24).padStart(2, "0");
}

describe("participants in different time zones", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-participant-clock-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs each browser and each clock hint in its participant's zone", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        mode: "live",
        participants: [
          { id: "chicago", instruction: "Chicago visit.", clock: { timeZone: "America/Chicago" } },
          {
            id: "tokyo",
            instruction: "Tokyo visit.",
            clock: { timeZone: "Asia/Tokyo" },
            maxSessionMs: 1_500,
            windDownMs: 1_000,
          },
          { id: "plain", instruction: "Plain visit." },
        ],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const seen = { chicago: [] as Seen[], tokyo: [] as Seen[], plain: [] as Seen[] };
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          const id = options.instructions.includes("Chicago")
            ? "chicago"
            : options.instructions.includes("Tokyo")
              ? "tokyo"
              : "plain";
          return runCuaActorSession({
            ...options,
            provider: participant(id === "tokyo" ? undefined : 2, seen[id]),
          });
        },
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);

    // The browser launch: TZ for a participant with a zone, none for one without.
    const launchTz = (laneIndex: number) =>
      handle.browserLaunches.find((launch) => launch.laneIndex === laneIndex)?.env?.TZ;
    expect([launchTz(0), launchTz(1), launchTz(2)]).toEqual([
      "America/Chicago",
      "Asia/Tokyo",
      undefined,
    ]);

    // The clock hint. Tokyo is UTC+9 all year; Chicago changes with daylight saving time, so only
    // its zone name is checked.
    expect(seen.chicago[0]?.hint).toMatch(/^The local time is \d\d:\d\d \(America\/Chicago\)\.$/);
    const tokyoFirst = seen.tokyo[0]!;
    expect(tokyoFirst.hint).toMatch(
      new RegExp(`^The local time is ${hourAt(tokyoFirst.atMs, 9)}:\\d\\d \\(Asia/Tokyo\\)\\.$`),
    );
    expect(seen.plain.map((turn) => turn.hint)).toEqual([undefined, undefined]);
    // The cap's notice gives its end in the participant's zone: without one it would end in UTC.
    // The end is rounded to the minute, so its hour is not checked against the turn's.
    expect(seen.tokyo.at(-1)?.hint).toMatch(
      /^The local time is \d\d:\d\d \(Asia\/Tokyo\)\. Your session ends at \d\d:\d\d at the latest, in 1 minute\./,
    );

    // run.json records each participant's zone on its stream.
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId!);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect(bundle.streams.map((stream) => [stream.laneId, stream.timeZone])).toEqual([
      ["chicago", "America/Chicago"],
      ["tokyo", "Asia/Tokyo"],
      ["plain", undefined],
    ]);
  });

  it("launches a lone participant's browser in actor.clock's zone and records it", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", { mode: "live", actor: { clock: { timeZone: "Europe/London" } } }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const seen: Seen[] = [];
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) =>
          runCuaActorSession({ ...options, provider: participant(1, seen) }),
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);
    expect(handle.browserLaunches.map((launch) => launch.env?.TZ)).toEqual(["Europe/London"]);
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId!);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect(bundle.streams.map((stream) => stream.timeZone)).toEqual(["Europe/London"]);
  });
});
