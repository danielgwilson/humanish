// A computer-use study with a declared schedule, run on fake desktops ($0, real orchestration and
// real time with sub-second offsets): each participant's desktop is created at its start, a
// participant whose start comes while every slot is busy waits, and run.json records each
// participant's scheduled and actual start. A dry run records the offsets.

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
import type { E2BDesktopModule } from "../../../src/substrates/e2b/sdk.js";
import { lab, type Patch } from "../../admission/fixtures.js";
import { makeFanoutModule, scriptedFetch, TWO_TURN_SESSION } from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

function clinic(patch: Patch): StudyConfig {
  const parsed = parseStudy(lab("cuAppUrl", { mode: "live", ...patch }));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** The fan-out fake, with the time of each create and kill. */
function timedModule() {
  const handle = makeFanoutModule();
  const createdAt: number[] = [];
  const killedAt: number[] = [];
  const module: E2BDesktopModule = {
    Sandbox: {
      create: (async (...args: Parameters<E2BDesktopModule["Sandbox"]["create"]>) => {
        createdAt.push(Date.now());
        return handle.module.Sandbox.create(...args);
      }) as E2BDesktopModule["Sandbox"]["create"],
      kill: async (sandboxId, options) => {
        killedAt.push(Date.now());
        return handle.module.Sandbox.kill!(sandboxId, options);
      },
    },
  };
  return { module, createdAt, killedAt };
}

function seams(module: E2BDesktopModule, sessionMs = 50, responses: unknown[] = TWO_TURN_SESSION) {
  return {
    desktopModule: async () => module,
    runSession: async (options: CuaActorSessionOptions) => {
      await new Promise((resolve) => setTimeout(resolve, sessionMs));
      return runCuaActorSession({
        ...options,
        openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(responses) },
      });
    },
    analysis: { run: vi.fn() },
  };
}

async function runJson(cwd: string, runId: string | undefined): Promise<RunBundle> {
  if (runId === undefined) throw new Error("the run wrote no bundle");
  return JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"),
  ) as RunBundle;
}

function arrivals(bundle: RunBundle) {
  return bundle.simulations.map((record) => ({
    offset: record.arrival?.startAfterMs,
    scheduledAt: Date.parse(record.arrival?.scheduledAt ?? ""),
    startedAt: Date.parse(record.arrival?.startedAt ?? ""),
  }));
}

describe("a computer-use study with a declared schedule", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-arrivals-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("creates each desktop at its participant's start and records scheduled and actual starts", async () => {
    const timed = timedModule();
    const outcome = await runStudyWith(
      clinic({
        participants: [
          { id: "nurse" },
          { id: "patient", count: 3, startAfterMs: 300, startEveryMs: 300 },
        ],
      }),
      { cwd, env: KEYS },
      seams(timed.module),
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.plan?.schedule?.lastStartMs).toBe(900);

    const bundle = await runJson(cwd, outcome.result.runId);
    const starts = arrivals(bundle);
    expect(starts.map((start) => start.offset)).toEqual([0, 300, 600, 900]);
    const anchor = starts[0]!.scheduledAt;
    expect(starts.map((start) => start.scheduledAt - anchor)).toEqual([0, 300, 600, 900]);
    // No participant starts, or has a desktop, before its time.
    for (const [index, start] of starts.entries()) {
      expect(start.startedAt).toBeGreaterThanOrEqual(start.scheduledAt);
      expect(timed.createdAt[index]).toBeGreaterThanOrEqual(start.scheduledAt);
    }
  });

  it("holds a participant whose start comes while every slot is busy and records the wait", async () => {
    const timed = timedModule();
    const outcome = await runStudyWith(
      clinic({
        participants: [{ id: "nurse" }, { id: "patient", startAfterMs: 10 }],
        execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 1 },
      }),
      { cwd, env: KEYS },
      seams(timed.module, 200),
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);

    const [nurse, patient] = arrivals(await runJson(cwd, outcome.result.runId));
    expect(patient!.scheduledAt - nurse!.scheduledAt).toBe(10);
    // The patient's desktop is created only after the nurse's is gone, so it starts late.
    expect(timed.createdAt[1]).toBeGreaterThanOrEqual(timed.killedAt[0]!);
    expect(patient!.startedAt - patient!.scheduledAt).toBeGreaterThanOrEqual(150);
  });

  it("reruns a scheduled participant at once, with no schedule", async () => {
    const config = clinic({
      participants: [{ id: "nurse" }, { id: "patient", count: 2, startEveryMs: 3_000 }],
    });
    const first = await runStudyWith(config, { cwd, env: KEYS }, seams(timedModule().module));
    if (first.route !== "computer-use") throw new Error(`ran on ${first.route}`);
    const sourceRunId = first.result.runId;
    if (sourceRunId === undefined) throw new Error("the first run wrote no bundle");

    const timed = timedModule();
    const startedAt = Date.now();
    const rerun = await runStudyWith(
      config,
      { cwd, env: KEYS, rerun: { sourceRunId, participantIds: ["patient-02"] } },
      seams(timed.module),
    );
    if (rerun.route !== "computer-use") throw new Error(`ran on ${rerun.route}`);
    expect(rerun.result.ok).toBe(true);
    expect(rerun.result.plan?.schedule).toBeUndefined();
    // patient-02 was due 3 s into the first run; the rerun creates its desktop right away.
    expect(timed.createdAt[0]! - startedAt).toBeLessThan(3_000);
    const bundle = await runJson(cwd, rerun.result.runId);
    expect(bundle.simulations.map((record) => record.arrival)).toEqual([undefined]);
  });

  it("skips a participant due after the study budget is spent, before its desktop exists", async () => {
    // The first reply reports a million input tokens, which crosses a 1-cent study budget.
    const spending = [
      {
        id: "resp_1",
        output: [
          { type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] },
        ],
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
      {
        id: "resp_2",
        output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ];
    const timed = timedModule();
    const outcome = await runStudyWith(
      clinic({
        participants: [{ id: "nurse" }, { id: "patient", startAfterMs: 1_000 }],
        caps: { maxTotalUsd: 0.01 },
      }),
      { cwd, env: KEYS },
      seams(timed.module, 50, spending),
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;

    // Only the nurse's desktop was created.
    expect(timed.createdAt).toHaveLength(1);
    const patient = result.lanes?.find((lane) => lane.id === "patient");
    expect(patient?.status).toBe("blocked");
    expect(patient?.skippedReason).toContain("caps.maxTotalUsd");
    expect(result.laneSummary?.skipped).toBe(1);
    expect(result.ok).toBe(false);

    const [, patientArrival] = (await runJson(cwd, result.runId)).simulations.map(
      (record) => record.arrival,
    );
    expect(patientArrival?.startAfterMs).toBe(1_000);
    expect(patientArrival?.scheduledAt).toBeDefined();
    expect(patientArrival?.startedAt).toBeUndefined();
  });

  it("records the offsets in a dry run, with no start times", async () => {
    const outcome = await runStudyWith(
      clinic({
        participants: [{ id: "patient", count: 3, startEveryMs: 30_000 }],
      }),
      { cwd, dryRun: true },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);
    const bundle = await runJson(cwd, outcome.result.runId);
    expect(bundle.simulations.map((record) => record.arrival)).toEqual([
      { startAfterMs: 0 },
      { startAfterMs: 30_000 },
      { startAfterMs: 60_000 },
    ]);
    const plan = bundle.events.find((event) => event.type === "cua-lab.fanout.plan");
    expect(plan?.message).toContain("the last at +1m");
  });
});
