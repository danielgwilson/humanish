// A computer-use study of three participants on fake hosted desktops ($0): one in London, one in
// Tokyo with a session cap, and one with no zone. Each browser launches with TZ set to its
// participant's zone, so every tab runs in it from the first page load; each turn's clock hint and
// the cap's notice give the time in that zone; and run.json records each participant's zone. The
// desktop's panel clock and a desktop-cli participant's terminal are set to the zone too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { CuaProvider, CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import { makeFanoutModule, type FanoutModuleOptions } from "../../helpers/fanout-desktop.js";

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

/**
 * Runs a two-participant app-url study, tokyo in Asia/Tokyo and plain with no zone, on fake hosted
 * desktops whose commands `onCommand` sees, and returns the run's warnings.
 */
async function runTokyoAndPlain(
  cwd: string,
  onCommand: NonNullable<FanoutModuleOptions["commandHandler"]>,
): Promise<string[]> {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      participants: [
        { id: "tokyo", instruction: "Tokyo visit.", clock: { timeZone: "Asia/Tokyo" } },
        { id: "plain", instruction: "Plain visit." },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const handle = makeFanoutModule({ commandHandler: onCommand });
  const outcome = await runStudyWith(
    parsed.config,
    { cwd, env: KEYS },
    {
      desktopModule: async () => handle.module,
      runSession: async (options: CuaActorSessionOptions) =>
        runCuaActorSession({ ...options, provider: participant(1, []) }),
      analysis: { run: vi.fn() },
    },
  );
  if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
  expect(outcome.result.ok).toBe(true);
  return outcome.result.warnings;
}

/**
 * Runs a desktop-cli terminal launch script on this machine's bash, with a stand-in
 * x-terminal-emulator first on the search path, and returns the TZ the stand-in started with
 * ("unset" for none).
 */
async function terminalZoneOnBash(script: string, dir: string): Promise<string> {
  const bin = path.join(dir, "bin");
  const seen = path.join(dir, "tz.txt");
  await mkdir(bin, { recursive: true });
  const terminal = path.join(bin, "x-terminal-emulator");
  await writeFile(terminal, `#!/bin/sh\nprintf '%s' "\${TZ-unset}" > '${seen}'\n`);
  await chmod(terminal, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  delete env.TZ;
  await promisify(execFile)("bash", ["-c", script], { env, timeout: 15_000 });
  return readFile(seen, "utf8");
}

/** The UTC hour at `atMs` moved by `hours`, as the two digits a clock hint shows. */
function hourAt(atMs: number, hours: number): string {
  return String((new Date(atMs).getUTCHours() + hours + 24) % 24).padStart(2, "0");
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-participant-clock-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("participants in different time zones", () => {
  it("runs each browser and each clock hint in its participant's zone", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        mode: "live",
        participants: [
          { id: "london", instruction: "London visit.", clock: { timeZone: "Europe/London" } },
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
    const seen = { london: [] as Seen[], tokyo: [] as Seen[], plain: [] as Seen[] };
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          const id = options.instructions.includes("London")
            ? "london"
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
      "Europe/London",
      "Asia/Tokyo",
      undefined,
    ]);

    // The clock hint. Tokyo is UTC+9 all year; London changes with daylight saving time, so only
    // its zone name is checked.
    expect(seen.london[0]?.hint).toMatch(/^The local time is \d\d:\d\d \(Europe\/London\)\.$/);
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
      ["london", "Europe/London"],
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

describe("the hosted desktop around a participant with a time zone", () => {
  // The stock template's XFCE panel shows a clock above the browser. Live, setting the clock
  // plugin's timezone property through xfconf-query moved it from 02:12 UTC to 11:12 Asia/Tokyo
  // and then to another zone without a restart.
  it("sets the desktop's panel clock to the participant's zone", async () => {
    const panelCommands: Array<[number, string]> = [];
    const warnings = await runTokyoAndPlain(cwd, (laneIndex, command) => {
      if (command.includes("xfconf-query")) panelCommands.push([laneIndex, command]);
      return undefined;
    });
    expect(panelCommands.map(([laneIndex]) => laneIndex)).toEqual([0]);
    expect(panelCommands[0]?.[1]).toContain("'Asia/Tokyo'");
    expect(warnings.filter((warning) => warning.includes("panel clock"))).toEqual([]);
  });

  it("warns, and runs the participant, when the panel clock cannot be set", async () => {
    const warnings = await runTokyoAndPlain(cwd, (_laneIndex, command) =>
      command.includes("xfconf-query")
        ? { stdout: "", exitCode: 1, stderr: "Property does not exist" }
        : undefined,
    );
    expect(warnings).toContain(
      "The desktop's panel clock for participant tokyo could not be set to Asia/Tokyo and shows UTC: Property does not exist",
    );
  });

  // A desktop-cli participant works in the terminal humanish opens: the product under test, `date`
  // and any browser started from that terminal inherit its environment.
  it("opens a desktop-cli participant's terminal in its zone", async () => {
    const parsed = parseStudy(
      lab("cuDesktopCli", {
        mode: "live",
        participants: [
          { id: "tokyo", instruction: "Tokyo visit.", clock: { timeZone: "Asia/Tokyo" } },
          { id: "plain", instruction: "Plain visit." },
        ],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule({
      commandHandler: (_laneIndex, command) =>
        command.includes("/status") ? { stdout: "0" } : undefined,
    });
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) =>
          runCuaActorSession({ ...options, provider: participant(1, []) }),
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);
    const terminalScript = (laneIndex: number): string => {
      const at = handle.created.findIndex(
        (created) => created.metadata?.participantIndex === String(laneIndex),
      );
      const written = handle.files.get(handle.createdIds[at] ?? "");
      const script = [...(written?.entries() ?? [])].find(([file]) =>
        file.endsWith("/desktop-cli-terminal/command.sh"),
      )?.[1];
      if (script === undefined) throw new Error(`participant ${laneIndex} opened no terminal`);
      return script.toString("utf8");
    };
    expect([
      await terminalZoneOnBash(terminalScript(0), path.join(cwd, "tokyo")),
      await terminalZoneOnBash(terminalScript(1), path.join(cwd, "plain")),
    ]).toEqual(["Asia/Tokyo", "unset"]);
  });
});
