// A hosted fan-out whose first participant fails to start, run on fake desktops ($0, real
// orchestration). On an app-url subject each participant only opens the app, so a participant whose
// desktop fails is its own failure and every other participant runs. On a clone subject every
// participant builds the same app in its own sandbox, so the first to start goes alone: a subject
// that fails to build there blocks the rest, and a desktop that never came up passes the first
// start to the next participant.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import type { StudyConfig } from "../../../src/study/types.js";
import type { E2BDesktopCreateOptions, E2BDesktopModule } from "../../../src/substrates/e2b/sdk.js";
import { lab, type BaseName } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedFetch,
  TWO_TURN_SESSION,
  type FanoutModuleHandle,
  type FanoutModuleOptions,
} from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

function study(base: BaseName, participants: number, concurrency = 3): StudyConfig {
  const parsed = parseStudy(
    lab(base, {
      mode: "live",
      participants,
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/**
 * Answers each detached step's exit status and the readiness probe, so every participant's subject
 * builds, except at `failCloneAt`, whose first step, the clone, exits 128.
 */
function cloneCommands(failCloneAt?: number): NonNullable<FanoutModuleOptions["commandHandler"]> {
  return (index, command) => {
    if (command.includes("/status")) return { stdout: index === failCloneAt ? "128" : "0" };
    if (command.includes("curl")) return { stdout: "READY" };
    return undefined;
  };
}

/**
 * The fan-out fake, whose create throws `errors` in turn for the first participant before it
 * creates. `log` records each create by participant index, in order.
 */
function failingFirstCreate(handle: FanoutModuleHandle, errors: Error[], log: string[]) {
  let attempts = 0;
  const module: E2BDesktopModule = {
    Sandbox: {
      create: (async (...args: Parameters<E2BDesktopModule["Sandbox"]["create"]>) => {
        const options = (
          typeof args[0] === "string" ? args[1] : args[0]
        ) as E2BDesktopCreateOptions;
        const index = options.metadata?.participantIndex;
        if (index === "0") {
          attempts += 1;
          const error = errors.shift();
          if (error !== undefined) throw error;
        }
        log.push(`create:${index}`);
        return handle.module.Sandbox.create(...args);
      }) as E2BDesktopModule["Sandbox"]["create"],
      kill: handle.module.Sandbox.kill!,
    },
  };
  return { module, attempts: () => attempts };
}

function seams(module: E2BDesktopModule, log: string[] = []) {
  return {
    desktopModule: async () => module,
    runSession: async (options: CuaActorSessionOptions) => {
      log.push("session");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return runCuaActorSession({
        ...options,
        openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
      });
    },
    subjectPhaseSink: () => undefined,
    analysis: { run: vi.fn() },
  };
}

async function runJson(cwd: string, runId: string | undefined): Promise<RunBundle> {
  if (runId === undefined) throw new Error("the run wrote no bundle");
  return JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"),
  ) as RunBundle;
}

// Not transient by the provider retry's rule, so the create fails at once.
const DESKTOP_DID_NOT_START = new Error("desktop did not start: the display server exited");

describe("a hosted fan-out whose first participant fails to start", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-startup-failure-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs the other 10 of 11 app-url participants when the first desktop is never created", async () => {
    const handle = makeFanoutModule();
    const failing = failingFirstCreate(handle, [DESKTOP_DID_NOT_START], []);
    const outcome = await runStudyWith(
      study("cuAppUrl", 11),
      { cwd, env: KEYS },
      seams(failing.module),
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;

    expect(result.laneSummary).toMatchObject({ passed: 10, skipped: 0, harnessErrors: 1 });
    expect(result.lanes?.[0]?.status).toBe("failed");
    expect(result.lanes?.slice(1).map((lane) => lane.status)).toEqual(Array(10).fill("passed"));
    expect(handle.created).toHaveLength(10);
    expect([...handle.killed].sort()).toEqual([...handle.createdIds].sort());
    const bundle = await runJson(cwd, result.runId);
    expect(bundle.events.some((event) => event.type === "cua-lab.fanout.fail-fast")).toBe(false);
  });

  it("runs the other 10 of 11 app-url participants when the first desktop fails after it was created", async () => {
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      study("cuAppUrl", 11),
      {
        cwd,
        env: KEYS,
        prepareDesktop: async (_desktop, target) => {
          if (target.kind === "participant" && target.participant.index === 0)
            throw new Error("the desktop's browser profile could not be written");
        },
      },
      seams(handle.module),
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;

    expect(result.laneSummary).toMatchObject({ passed: 10, skipped: 0, harnessErrors: 1 });
    expect(result.lanes?.[0]?.status).toBe("failed");
    expect(handle.created).toHaveLength(11);
    expect([...handle.killed].sort()).toEqual([...handle.createdIds].sort());
  });

  // At concurrency 3 the next participant is already waiting at the gate; at 1 it arrives after.
  it.each([3, 1])(
    "passes a clone study's first start to the next participant when the first desktop is never created (concurrency %i)",
    async (concurrency) => {
      const handle = makeFanoutModule({ commandHandler: cloneCommands() });
      const log: string[] = [];
      const failing = failingFirstCreate(handle, [DESKTOP_DID_NOT_START], log);
      const outcome = await runStudyWith(
        study("cuClone", 4, concurrency),
        { cwd, env: KEYS },
        seams(failing.module, log),
      );
      if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
      const { result } = outcome;

      expect(result.laneSummary).toMatchObject({ passed: 3, skipped: 0, harnessErrors: 1 });
      // The second participant built the app and started its session before any other desktop
      // was created.
      expect(log.slice(0, 2)).toEqual(["create:1", "session"]);
      expect(handle.created).toHaveLength(3);
    },
  );

  it("blocks the rest of a clone study when the first participant's subject fails to build", async () => {
    const handle = makeFanoutModule({ commandHandler: cloneCommands(0) });
    const outcome = await runStudyWith(
      study("cuClone", 4),
      { cwd, env: KEYS },
      seams(handle.module),
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;

    expect(result.ok).toBe(false);
    // Only the first participant's sandbox was created, and it was torn down by id.
    expect(handle.created).toHaveLength(1);
    expect(handle.created[0]?.metadata?.participantIndex).toBe("0");
    expect(handle.killed).toEqual(handle.createdIds);
    expect(result.laneSummary).toMatchObject({ passed: 0, skipped: 3, harnessErrors: 1 });
    const first = result.lanes?.[0]?.id;
    for (const lane of result.lanes?.slice(1) ?? []) {
      expect(lane.status).toBe("blocked");
      expect(lane.skippedReason).toBe(
        `skipped: participant ${first} failed to provision its world (pipeline gate)`,
      );
    }
  });

  it("retries the first participant's create once on a transient provider error and runs the clone study", async () => {
    const handle = makeFanoutModule({ commandHandler: cloneCommands() });
    const failing = failingFirstCreate(
      handle,
      [new Error("12: [unimplemented] HTTP 404: sandbox not routable yet")],
      [],
    );
    const outcome = await runStudyWith(
      study("cuClone", 4),
      { cwd, env: KEYS },
      seams(failing.module),
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;

    expect(failing.attempts()).toBe(2);
    expect(result.laneSummary).toMatchObject({ passed: 4, skipped: 0, harnessErrors: 0 });
    expect(
      result.warnings.filter((warning) =>
        warning.includes("retried once after a transient provider error"),
      ),
    ).toHaveLength(1);
  });
});
