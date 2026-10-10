// A hosted computer-use fan-out whose host sleeps while every participant is in its session, run
// on fake desktops with a host clock the test moves: on wake each participant fails as a frozen
// loop does, and the run names the suspension as the likely cause in its outcome, its review and
// the CLI header, while each participant keeps its own record of how it failed.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatCuaStudyHuman } from "../../../src/cli/commands/study-format.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import type { StudyConfig } from "../../../src/study/types.js";
import { lab, type Patch } from "../../admission/fixtures.js";
import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { E2BDesktopCreateOptions, E2BDesktopModule } from "../../../src/substrates/e2b/sdk.js";
import { makeFanoutModule, scriptedFetch, TWO_TURN_SESSION } from "../../helpers/fanout-desktop.js";
import { fakeHostClock } from "../../helpers/host-clock.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };
const MINUTE = 60_000;
const STALLED =
  "provider turn 2 stalled; its usage is unknown and no maxOutputTokens bounds what it cost";
const OFFLINE = "Unable to connect. Is the computer able to access the url?";
const DEADLINE = "[deadline_exceeded] context deadline exceeded";

function study(patch: Patch): StudyConfig {
  const parsed = parseStudy(lab("cuAppUrl", { mode: "live", ...patch }));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/**
 * A host that sleeps for 6m 5s a minute into the run, once `sessions` participants are in their
 * sessions and `settleMs` of real time has passed for the others to settle. Its wall clock starts
 * now and moves only when it sleeps or beats, so the run starts at T0.
 */
function sleepingHost(sessions: number, settleMs = 0) {
  const T0 = Date.now();
  const host = fakeHostClock(T0);
  let inSession = 0;
  let wake: () => void = () => undefined;
  const woke = new Promise<void>((resolve) => {
    wake = resolve;
  });
  return {
    T0,
    clock: host.clock,
    /** Enter a session and wait for the wake; returns this session's 1-based order. */
    async sleepThrough(): Promise<number> {
      inSession += 1;
      const order = inSession;
      if (inSession === sessions) {
        if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
        host.beat(12);
        host.advance(6 * MINUTE);
        host.beat();
        wake();
      }
      await woke;
      return order;
    },
  };
}

/** The fake desktop module, with the first participant's sandbox create failing. */
function firstCreateFails(message: string): E2BDesktopModule {
  const fake = makeFanoutModule();
  const create = (async (...args: Parameters<E2BDesktopModule["Sandbox"]["create"]>) => {
    const options = args.find((arg): arg is E2BDesktopCreateOptions => typeof arg === "object");
    if (options?.metadata?.participantIndex === "0") throw new Error(message);
    return fake.module.Sandbox.create(...args);
  }) as E2BDesktopModule["Sandbox"]["create"];
  return { Sandbox: { ...fake.module.Sandbox, create } };
}

function headerLines(result: Parameters<typeof formatCuaStudyHuman>[0], config: StudyConfig) {
  const output = formatCuaStudyHuman(result, config.subject);
  return (typeof output === "string" ? output : (output.stdout ?? "")).split("\n");
}

async function runJson(cwd: string, runId: string | undefined): Promise<RunBundle> {
  if (runId === undefined) throw new Error("the run wrote no bundle");
  return JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"),
  ) as RunBundle;
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-host-sleep-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("a hosted fan-out whose host sleeps", () => {
  it("names the suspension as the likely cause of every participant failure after it", async () => {
    const host = sleepingHost(4);
    const config = study({
      participants: { count: 4 },
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 4 },
    });

    const outcome = await runStudyWith(
      config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => makeFanoutModule().module,
        hostClock: host.clock,
        analysis: { run: vi.fn() },
        runSession: async () => {
          const order = await host.sleepThrough();
          throw new Error(order % 2 === 1 ? STALLED : OFFLINE);
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;
    const summary =
      "The host was suspended for 6m 5s at +1m; the 4 participant failures after it are likely its effect.";

    expect(result.ok).toBe(false);
    expect(result.hostSuspension).toEqual({
      summary,
      participantIds: ["lane-01", "lane-02", "lane-03", "lane-04"],
      suspensions: [
        {
          startedAt: new Date(host.T0 + MINUTE).toISOString(),
          endedAt: new Date(host.T0 + 7 * MINUTE + 5_000).toISOString(),
          durationMs: 365_000,
        },
      ],
    });

    const bundle = await runJson(cwd, result.runId);
    // The run outcome leads with the cause; each participant's own failure follows it.
    expect(bundle.outcome?.state).toBe("finished");
    const failures = bundle.outcome?.state === "finished" ? bundle.outcome.execution.failures : [];
    expect(failures[0]).toEqual({ kind: "run", message: summary });
    expect(failures.slice(1).map((failure) => failure.kind)).toEqual([
      "harness",
      "harness",
      "harness",
      "harness",
    ]);
    // The review names it once, in place of four product gaps.
    expect(bundle.review.summary.startsWith(`${summary} `)).toBe(true);
    expect(bundle.review.gaps).toEqual([
      "lane-01, lane-02, lane-03, lane-04: failed after the host was suspended, likely its effect. Each participant's record keeps its own error.",
    ]);
    expect(bundle.events.filter((event) => event.type === "host.suspended")).toHaveLength(1);
    // The participants' own records are as they ended.
    expect(bundle.simulations.map((record) => record.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
    ]);

    expect(headerLines(result, config).slice(0, 4)).toEqual([
      `humanish run ${config.id}: live run failed`,
      "route: computer-use",
      summary,
      `Rerun the participants that did not pass: humanish run ${config.id} --rerun-failed-from ${result.runId}`,
    ]);
  });

  it("leaves a participant whose desktop failed before it to its own error", async () => {
    const host = sleepingHost(3, 100);
    const config = study({
      participants: { count: 4 },
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 4 },
    });
    const outcome = await runStudyWith(
      config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => firstCreateFails(DEADLINE),
        hostClock: host.clock,
        analysis: { run: vi.fn() },
        runSession: async () => {
          await host.sleepThrough();
          throw new Error(STALLED);
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;

    expect(result.hostSuspension?.summary).toBe(
      "The host was suspended for 6m 5s at +1m; the 3 participant failures after it are likely its effect.",
    );
    expect(result.hostSuspension?.participantIds).toEqual(["lane-02", "lane-03", "lane-04"]);
    const bundle = await runJson(cwd, result.runId);
    expect(bundle.review.gaps).toEqual([
      "lane-02, lane-03, lane-04: failed after the host was suspended, likely its effect. Each participant's record keeps its own error.",
      expect.stringMatching(/^lane-01: .*deadline_exceeded/),
    ]);
  });
});

describe("a single participant whose host sleeps", () => {
  it("names the suspension as the likely cause of its failure", async () => {
    const host = sleepingHost(1);
    const config = study({});
    const outcome = await runStudyWith(
      config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => makeFanoutModule().module,
        hostClock: host.clock,
        analysis: { run: vi.fn() },
        runSession: async () => {
          await host.sleepThrough();
          throw new Error(STALLED);
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;
    const summary =
      "The host was suspended for 6m 5s at +1m; the 1 participant failure after it is likely its effect.";

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe(`${summary} ${STALLED}`);
    const bundle = await runJson(cwd, result.runId);
    expect(bundle.outcome?.state === "finished" && bundle.outcome.execution.failures[0]).toEqual({
      kind: "run",
      message: summary,
    });
    expect(bundle.review.summary.startsWith(`${summary} `)).toBe(true);
    expect(bundle.simulations.map((record) => record.status)).toEqual(["failed"]);
    expect(headerLines(result, config).slice(0, 4)).toEqual([
      `humanish run ${config.id}: live run failed`,
      "route: computer-use",
      summary,
      `Run it again: humanish run ${config.id}`,
    ]);
  });
});

describe("a run whose participants come through a host suspension", () => {
  it("records the suspension and still passes", async () => {
    const host = sleepingHost(2);
    const config = study({
      participants: { count: 2 },
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
    });
    const outcome = await runStudyWith(
      config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => makeFanoutModule().module,
        hostClock: host.clock,
        analysis: { run: vi.fn() },
        runSession: async (options: CuaActorSessionOptions) => {
          await host.sleepThrough();
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;
    const summary = "The host was suspended for 6m 5s at +1m; no participant failure followed.";

    expect(result.ok).toBe(true);
    expect(result.hostSuspension?.summary).toBe(summary);
    expect(result.hostSuspension?.participantIds).toEqual([]);
    const bundle = await runJson(cwd, result.runId);
    expect(bundle.outcome).toEqual({
      state: "finished",
      ok: true,
      execution: { succeeded: true, failures: [] },
    });
    expect(bundle.review.summary.startsWith(`${summary} `)).toBe(true);
    expect(bundle.review.gaps.filter((gap) => gap.includes("host was suspended"))).toEqual([]);
    expect(headerLines(result, config).slice(0, 4)).toEqual([
      `humanish run ${config.id}: live run finished`,
      "route: computer-use",
      summary,
      `run: ${result.runId}`,
    ]);
  });
});
