// A computer-use study with a declared schedule, run on fake desktops ($0, real orchestration and
// real time with sub-second offsets): each participant's desktop is created at its start, a
// participant whose start comes while every slot is busy waits, and run.json records each
// participant's scheduled and actual start. One participant's harness error ends only that
// participant. A dry run records the offsets.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import { ComputerUseExecutorError } from "../../../src/actors/computer-use/executor-error.js";
import { formatCuaStudyHuman } from "../../../src/cli/commands/study-format.js";
import type { RunBundle, RunEvent } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import type { StudyConfig } from "../../../src/study/types.js";
import type { E2BDesktopModule } from "../../../src/substrates/e2b/sdk.js";
import { lab, type Patch } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
} from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

function supportDesk(patch: Patch): StudyConfig {
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
        participant: scriptedParticipant(responses),
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

async function runEvents(cwd: string, runId: string | undefined): Promise<RunEvent[]> {
  if (runId === undefined) throw new Error("the run wrote no bundle");
  const text = await readFile(path.join(cwd, ".humanish", "runs", runId, "events.ndjson"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
}

function arrivals(bundle: RunBundle) {
  return bundle.simulations.map((record) => ({
    offset: record.arrival?.startAfterMs,
    scheduledAt: Date.parse(record.arrival?.scheduledAt ?? ""),
    startedAt: Date.parse(record.arrival?.startedAt ?? ""),
  }));
}

/** The first reply reports a million input tokens, which crosses a 1-cent study budget. */
const SPENDING = [
  {
    id: "resp_1",
    output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }],
    usage: { input_tokens: 1_000_000, output_tokens: 0 },
  },
  {
    id: "resp_2",
    output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
];

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
      supportDesk({
        participants: [
          { id: "support-agent" },
          { id: "customer", count: 3, startAfterMs: 300, startEveryMs: 300 },
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
      supportDesk({
        participants: [{ id: "support-agent" }, { id: "customer", startAfterMs: 10 }],
        execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 1 },
      }),
      { cwd, env: KEYS },
      seams(timed.module, 200),
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);

    const [agent, customer] = arrivals(await runJson(cwd, outcome.result.runId));
    expect(customer!.scheduledAt - agent!.scheduledAt).toBe(10);
    // The customer's desktop is created only after the support agent's is gone, so it starts late.
    expect(timed.createdAt[1]).toBeGreaterThanOrEqual(timed.killedAt[0]!);
    expect(customer!.startedAt - customer!.scheduledAt).toBeGreaterThanOrEqual(150);
  });

  it("reruns a scheduled participant at once, with no schedule", async () => {
    const config = supportDesk({
      participants: [{ id: "support-agent" }, { id: "customer", count: 2, startEveryMs: 3_000 }],
    });
    const first = await runStudyWith(config, { cwd, env: KEYS }, seams(timedModule().module));
    if (first.route !== "computer-use") throw new Error(`ran on ${first.route}`);
    const sourceRunId = first.result.runId;
    if (sourceRunId === undefined) throw new Error("the first run wrote no bundle");

    const timed = timedModule();
    const startedAt = Date.now();
    const rerun = await runStudyWith(
      config,
      { cwd, env: KEYS, rerun: { sourceRunId, participantIds: ["customer-02"] } },
      seams(timed.module),
    );
    if (rerun.route !== "computer-use") throw new Error(`ran on ${rerun.route}`);
    expect(rerun.result.ok).toBe(true);
    expect(rerun.result.plan?.schedule).toBeUndefined();
    // customer-02 was due 3 s into the first run; the rerun creates its desktop right away.
    expect(timed.createdAt[0]! - startedAt).toBeLessThan(3_000);
    const bundle = await runJson(cwd, rerun.result.runId);
    expect(bundle.simulations.map((record) => record.arrival)).toEqual([undefined]);
  });

  /** A support agent whose spend crosses the study budget, then a customer due a second later. */
  async function runPastBudget() {
    const timed = timedModule();
    const config = supportDesk({
      participants: [{ id: "support-agent" }, { id: "customer", startAfterMs: 1_000 }],
      caps: { maxTotalUsd: 0.01 },
    });
    const outcome = await runStudyWith(
      config,
      { cwd, env: KEYS },
      seams(timed.module, 50, SPENDING),
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    return { result: outcome.result, timed, subject: config.subject };
  }

  it("skips a participant due after the study budget is spent, before its desktop exists", async () => {
    const { result, timed } = await runPastBudget();

    // Only the support agent's desktop was created.
    expect(timed.createdAt).toHaveLength(1);
    const customer = result.lanes?.find((lane) => lane.id === "customer");
    expect(customer?.status).toBe("blocked");
    expect(customer?.skippedReason).toContain("caps.maxTotalUsd");
    expect(result.laneSummary?.skipped).toBe(1);
    expect(result.ok).toBe(false);

    const [, customerArrival] = (await runJson(cwd, result.runId)).simulations.map(
      (record) => record.arrival,
    );
    expect(customerArrival?.startAfterMs).toBe(1_000);
    expect(customerArrival?.scheduledAt).toBeDefined();
    expect(customerArrival?.startedAt).toBeUndefined();
  });

  it("ends a budget-skipped participant's run line on its reason and counts it apart", async () => {
    const { result, subject } = await runPastBudget();
    // 1M input tokens in one gpt-6.1-sol request: $2 per 1M, doubled past 272K input tokens.
    const reason =
      "skipped: study budget reached before this participant started: the run's estimated model spend $4 crossed caps.maxTotalUsd=$0.01; no desktop was created";
    const output = formatCuaStudyHuman(result, subject);
    const lines = (typeof output === "string" ? output : (output.stdout ?? "")).split("\n");
    expect(lines.filter((line) => line.startsWith("participant customer:"))).toEqual([
      `participant customer: blocked · ${reason}`,
    ]);

    const bundle = await runJson(cwd, result.runId);
    expect(bundle.review.summary).toBe(
      "1 participant took part, in its own copy of the app: 0/1 recorded completions, 1 interrupted (study spend limit); the gaps say why. 1 participant was skipped before its session started.",
    );
    expect(bundle.review.gaps).toContain(`customer: ${reason}`);
  });

  it("records the offsets in a dry run, with no start times", async () => {
    const outcome = await runStudyWith(
      supportDesk({
        participants: [{ id: "customer", count: 3, startEveryMs: 30_000 }],
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

describe("a computer-use study whose participant fails partway through the schedule", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-arrivals-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("starts every later arrival on time when one participant's desktop stalls 10 minutes in", async () => {
    // One minute of the schedule is 20 ms here: customers arrive at +5, +15, +25 and +35 minutes,
    // and the support agent's desktop stops answering 10 minutes into its session.
    const minute = 20;
    const stall = "desktop executor error: deadline_exceeded; disposition: outcome_uncertain";
    let stalledAt: number | undefined;
    const timed = timedModule();
    const passing = seams(timed.module);
    const outcome = await runStudyWith(
      supportDesk({
        participants: [
          { id: "support-agent", persona: "power-user" },
          { id: "customer", count: 4, startAfterMs: 5 * minute, startEveryMs: 10 * minute },
        ],
        execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 5 },
      }),
      { cwd, env: KEYS },
      {
        ...passing,
        runSession: async (options: CuaActorSessionOptions) => {
          if (options.persona.id !== "power-user") return passing.runSession(options);
          return runCuaActorSession({
            ...options,
            executor: {
              observe: () => options.executor!.observe(),
              execute: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10 * minute));
                stalledAt = Date.now();
                throw new ComputerUseExecutorError("deadline_exceeded", "outcome_uncertain");
              },
            },
            participant: scriptedParticipant(TWO_TURN_SESSION),
          });
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;

    expect(result.laneSummary).toMatchObject({ passed: 4, skipped: 0, harnessErrors: 1 });
    expect(result.lanes?.map((lane) => [lane.id, lane.status])).toEqual([
      ["support-agent", "failed"],
      ["customer-01", "passed"],
      ["customer-02", "passed"],
      ["customer-03", "passed"],
      ["customer-04", "passed"],
    ]);
    expect(result.lanes?.[0]?.error?.message).toBe(
      `Computer-use session ended with a harness error: ${stall}`,
    );
    expect(timed.createdAt).toHaveLength(5);

    const bundle = await runJson(cwd, result.runId);
    const starts = arrivals(bundle);
    // The schedule ran past the stall: at least two customers were due after it.
    expect(starts.filter((start) => start.scheduledAt > stalledAt!).length).toBeGreaterThan(1);
    for (const start of starts) expect(start.startedAt).toBeGreaterThanOrEqual(start.scheduledAt);
    // One gap line per participant that did not pass, then the review's fixed provenance line.
    expect(bundle.review.gaps.filter((gap) => /^(support-agent|customer)/.test(gap))).toEqual([
      `support-agent: ${stall}`,
    ]);

    const events = await runEvents(cwd, result.runId);
    const agent = bundle.simulations[0]!.id;
    expect(
      events
        .filter((event) => event.simId === agent && event.type.startsWith("cua-lab.session."))
        .map((event) => [event.type, event.message]),
    ).toEqual([["cua-lab.session.harness_error", `Participant support-agent failed: ${stall}`]]);
    expect(events.filter((event) => event.type === "cua-lab.session.blocked")).toEqual([]);
  });
});

describe("the live bundle of a computer-use study with a declared schedule", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-arrivals-live-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("writes a scheduled participant queued, then running, then its outcome while others run", async () => {
    let bundlePath = "";
    const read = async () => {
      const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as RunBundle;
      return {
        statuses: bundle.streams.map((stream) => stream.status),
        running: bundle.events.filter((event) => event.type === "cua-lab.session.running").length,
        // An ended participant's items stay in its live file until the final bundle.
        live: bundle.streams.map((stream) => stream.liveActor !== undefined && !stream.actor),
      };
    };
    const seen: Awaited<ReturnType<typeof read>>[] = [];
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const base = seams(timedModule().module);
    let sessions = 0;
    const outcome = await runStudyWith(
      supportDesk({
        participants: [{ id: "support-agent" }, { id: "customer", startAfterMs: 300 }],
      }),
      {
        cwd,
        env: KEYS,
        onObserverReady: async (observer) => {
          bundlePath = observer.bundlePath ?? "";
          seen.push(await read());
        },
      },
      {
        ...base,
        runSession: async (options: CuaActorSessionOptions) => {
          sessions += 1;
          // The support agent works for 3 s; the customer starts at +300 ms and ends first.
          if (sessions === 1) {
            await wait(3_000);
            seen.push(await read());
            return base.runSession(options);
          }
          const result = await base.runSession(options);
          // The customer's first items were written at once, with no write before them.
          await wait(200);
          seen.push(await read());
          return result;
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);
    expect(seen).toEqual([
      { statuses: ["running", "queued"], running: 1, live: [false, false] },
      { statuses: ["running", "running"], running: 2, live: [false, true] },
      { statuses: ["running", "passed"], running: 1, live: [false, true] },
    ]);
  });
});
