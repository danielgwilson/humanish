// Chrome's singleton socket under a long `TMPDIR`. chromeLaunchEnv gives Chrome /tmp when the
// caller's `TMPDIR` is too long for the socket path, and chromeLaunchError names the cause when
// Chrome still aborts on it. The session cases launch a fake browser through playwright-core: a
// script that records the `TMPDIR` it was given and aborts with Chrome's message when the socket
// path would not fit, as Chrome does.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runScriptedBrowserSession } from "../../../src/actors/scripted-browser/actor.js";
import {
  chromeLaunchEnv,
  chromeLaunchError,
} from "../../../src/actors/scripted-browser/launch-env.js";
import {
  browserSurfaces,
  type BrowserPersonaJourney,
} from "../../../src/actors/scripted-browser/types.js";

/** Past the longest `TMPDIR` Chrome's socket allows on Linux (62 bytes) and macOS (58). */
const LONG = 120;

describe("chromeLaunchEnv", () => {
  it("leaves an unset or short temp directory alone", async () => {
    expect(await chromeLaunchEnv({ HOME: "/home/synthetic" })).toBeUndefined();
    expect(await chromeLaunchEnv({ TMPDIR: "/tmp/short/" })).toBeUndefined();
  });

  it("gives Chrome /tmp under a temp directory too long for its socket and keeps the rest", async () => {
    const env = { HOME: "/home/synthetic", TMPDIR: `/${"d".repeat(LONG)}` };
    expect(await chromeLaunchEnv(env)).toEqual({ HOME: "/home/synthetic", TMPDIR: "/tmp" });
  });

  it("measures the temp directory in bytes", async () => {
    // 41 characters, 81 bytes: too long only when counted in bytes.
    expect(await chromeLaunchEnv({ TMPDIR: `/${"é".repeat(40)}` })).toMatchObject({
      TMPDIR: "/tmp",
    });
  });
});

describe("chromeLaunchError", () => {
  const aborted = new Error(
    [
      "browserType.launch: Target page, context or browser has been closed",
      "Browser logs:",
      "[pid=1][err] [1:1:0101/000000.000000:FATAL:chrome/browser/process_singleton_posix.cc:313] Socket path too long: /long/com.google.Chrome.abcdef/SingletonSocket.",
    ].join("\n"),
  );

  it("names the temp directory and its length when Chrome aborted on its socket path", () => {
    const error = chromeLaunchError(aborted, { TMPDIR: `/${"d".repeat(LONG)}` });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Chrome could not start: .*`TMPDIR` \(121 bytes\)/);
  });

  it("returns any other launch error as it is", () => {
    const other = new Error("browserType.launch: Executable doesn't exist");
    expect(chromeLaunchError(other, {})).toBe(other);
  });
});

describe("the scripted browser's Chrome launch under a long temp directory", () => {
  const journey: BrowserPersonaJourney = {
    goal: "Load the app.",
    scenarioId: "launch-env",
    scenarioTitle: "Launch under a long temp directory",
    source: "humanish/scenarios/launch-env.yaml",
    sourceDigest: "abcd1234abcd",
    startPath: "/",
    steps: [{ action: "goto", id: "step-01-load", label: "Load the app", path: "/" }],
  };
  let root: string;
  let saved: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "humanish-launch-env-"));
    saved = process.env.TMPDIR;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    await rm(root, { recursive: true, force: true });
  });

  /** A browser that records its `TMPDIR`, aborts as Chrome does when the socket path is too long
   *  (always, with `alwaysAbort`), and otherwise exits before Playwright can connect. */
  async function fakeChrome(alwaysAbort: boolean) {
    const seen = path.join(root, "seen-tmpdir");
    const command = path.join(root, "fake-chrome");
    const limit = alwaysAbort ? 0 : 107;
    await writeFile(
      command,
      [
        "#!/bin/sh",
        `printf '%s' "$TMPDIR" > '${seen}'`,
        'socket="${TMPDIR:-/tmp}/com.google.Chrome.abcdef/SingletonSocket"',
        `if [ \${#socket} -gt ${limit} ]; then`,
        '  echo "[1:1:0101/000000.000000:FATAL:chrome/browser/process_singleton_posix.cc:313] Socket path too long: $socket." >&2',
        "  exit 134",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    await chmod(command, 0o755);
    return { command, seen };
  }

  async function launchUnderLongTmpdir(command: string) {
    const long = path.join(root, "t".repeat(LONG));
    await mkdir(long);
    process.env.TMPDIR = long;
    const artifactRoot = path.join(root, "run");
    await mkdir(artifactRoot);
    return runScriptedBrowserSession({
      appUrl: "http://127.0.0.1:9/",
      journey,
      surface: browserSurfaces[0]!,
      persona: { id: "scripted-journey", traitsApplied: [], promptDigest: "abcd1234abcd1234" },
      timeoutMs: 10_000,
      artifactRoot,
      browserCommand: command,
    });
  }

  it("launches Chrome with /tmp as its temp directory", async () => {
    const { command, seen } = await fakeChrome(false);
    const result = await launchUnderLongTmpdir(command);
    expect(await readFile(seen, "utf8")).toBe("/tmp");
    // The fake cannot speak to Playwright, so the launch fails, but not on the socket path.
    expect(result.completionReason).toBe("harness_error");
    expect(result.reason).not.toMatch(/Socket path too long|singleton socket/);
  });

  it("names the cause and the fix when Chrome still aborts on its socket path", async () => {
    const { command } = await fakeChrome(true);
    const result = await launchUnderLongTmpdir(command);
    expect(result.completionReason).toBe("harness_error");
    expect(result.reason).toMatch(
      /^Scripted browser launch failed: Chrome could not start: its singleton socket path under `TMPDIR`/,
    );
  });
});
