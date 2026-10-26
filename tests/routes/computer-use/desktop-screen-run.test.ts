// The hosted desktop's screen saver on the computer-use route, on fake hosted desktops ($0). The
// stock template's XFCE session starts with three writers of the X screen saver timeout:
// xfce4-screensaver sets 300 s, xfce4-power-manager sets 600 s, and an autostart entry runs
// `xset s off`. The last one wins, and a timeout of 300 s turns a waiting participant's screen
// black after 5 minutes without input. humanish turns the screen saver off once the participant's
// browser has opened and its page has loaded, or, as on these fakes, the desktop has waited 8 s.

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
  type FanoutModuleOptions,
} from "../../helpers/fanout-desktop.js";
import { makeTestTempDir } from "../../helpers/temp-dir.js";

const ENV = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

/**
 * Runs a two-participant app-url study on fake hosted desktops built with `fakes`, and returns the
 * run's warnings.
 */
async function runTwo(fakes: FanoutModuleOptions) {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      participants: [
        { id: "first", instruction: "First visit." },
        { id: "second", instruction: "Second visit." },
      ],
      review: { analysis: false },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const handle = makeFanoutModule(fakes);
  const outcome = await runStudyWith(
    parsed.config,
    { cwd: await makeTestTempDir("humanish-desktop-screen-"), env: ENV, open: false },
    {
      desktopModule: async () => handle.module,
      subjectPhaseSink: () => undefined,
      runSession: async (session) =>
        runCuaActorSession({
          ...session,
          participant: scriptedParticipant(TWO_TURN_SESSION),
        }),
    },
  );
  if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
  expect(outcome.result.ok).toBe(true);
  return outcome.result.warnings;
}

/**
 * Runs a desktop command on this machine's bash, with no display variable set and one folder under
 * `dir` as the whole search path, holding a stand-in xset when `withXset`. Returns each xset call's
 * display and arguments.
 */
async function xsetCallsOnBash(script: string, dir: string, withXset: boolean): Promise<string[]> {
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "xset-calls.txt");
  await mkdir(bin, { recursive: true });
  await writeFile(calls, "");
  if (withXset) {
    const xset = path.join(bin, "xset");
    await writeFile(
      xset,
      `#!/bin/bash\nprintf 'DISPLAY=%s %s\\n' "\${DISPLAY-unset}" "$*" >> '${calls}'\n`,
    );
    await chmod(xset, 0o755);
  }
  await promisify(execFile)("/bin/bash", ["-c", script], {
    env: { PATH: bin, HOME: dir },
    timeout: 15_000,
  });
  return (await readFile(calls, "utf8")).split("\n").filter((line) => line !== "");
}

describe("the hosted desktop's screen saver", () => {
  it("is turned off on each participant's desktop after its browser opens and settles", async () => {
    const steps: Array<[number, string]> = [];
    const screenCommands: string[] = [];
    const warnings = await runTwo({
      commandHandler: (laneIndex, command) => {
        if (/^target_url=/m.test(command)) steps.push([laneIndex, "browser"]);
        else if (command.includes("xset")) {
          steps.push([laneIndex, "screen saver"]);
          screenCommands.push(command);
        }
        return undefined;
      },
      onWait: (laneIndex, ms) => steps.push([laneIndex, `wait ${ms} ms`]),
    });
    const stepsOf = (index: number) =>
      steps.filter(([laneIndex]) => laneIndex === index).map(([, step]) => step);
    // Nothing waits for the XFCE writers. On 16 fresh desktops their last write came within 2.5 s
    // of a command sent as soon as the desktop was created, so this 8 s settle keeps the screen
    // saver call after it.
    expect(stepsOf(0)).toEqual(["browser", "wait 8000 ms", "screen saver"]);
    expect(stepsOf(1)).toEqual(["browser", "wait 8000 ms", "screen saver"]);
    const dir = await makeTestTempDir("humanish-desktop-screen-bash-");
    const script = screenCommands[0]!;
    expect(await xsetCallsOnBash(script, path.join(dir, "with"), true)).toEqual([
      "DISPLAY=:0 s off",
    ]);
    // A desktop without xset is left as it is.
    expect(await xsetCallsOnBash(script, path.join(dir, "without"), false)).toEqual([]);
    expect(warnings.filter((warning) => warning.includes("screen saver"))).toEqual([]);
  });

  it("warns without the run's keys, and runs the participant, when the screen saver cannot be turned off", async () => {
    const warnings = await runTwo({
      commandHandler: (laneIndex, command) => {
        if (!command.includes("xset")) return undefined;
        if (laneIndex === 0)
          return { stdout: "", exitCode: 1, stderr: 'xset:  unable to open display ":0"' };
        throw new Error(`401: Invalid API key ${ENV.E2B_API_KEY}`);
      },
    });
    expect(warnings).toContain(
      'The desktop\'s screen saver for participant first could not be turned off, so its screen may go black after 5 minutes without input: xset:  unable to open display ":0"',
    );
    expect(warnings).toContain(
      "The desktop's screen saver for participant second could not be turned off, so its screen may go black after 5 minutes without input: 401: Invalid API key [REDACTED_SECRET]",
    );
  });
});
