// A participant with a scheduled end that waits for a free slot until its end has passed is
// skipped before its desktop exists, as one due after the study budget is spent is. Run on fake
// desktops ($0, real orchestration and real time with sub-second windows) with one slot: the first
// participant's session takes at least 500 ms, the second is due at 100 ms and ends at 300 ms, and
// the third is due at 200 ms with no end. The run's output and its review name the skip and count
// only the participants that started as having taken part.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import { formatCuaStudyHuman } from "../../../src/cli/commands/study-format.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
} from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

describe("a participant still waiting for a slot at its scheduled end", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-past-end-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** Runs the three participants above and returns the result and the fake desktops. */
  function runWithLateParticipant(duringSession?: () => Promise<void>) {
    return runParticipants(
      [
        { id: "first" },
        { id: "late", startAfterMs: 100, endAfterMs: 300 },
        { id: "after", startAfterMs: 200 },
      ],
      { concurrency: 1, ...(duringSession === undefined ? {} : { duringSession }) },
    );
  }

  /** Runs `participants` on fake desktops; `duringSession` runs as each session starts. */
  async function runParticipants(
    participants: Record<string, unknown>[],
    seams: { concurrency?: number; now?: () => number; duringSession?: () => Promise<void> },
  ) {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        mode: "live",
        participants,
        execution: {
          target: "e2b-desktop",
          timeoutMs: 60_000,
          ...(seams.concurrency === undefined ? {} : { concurrency: seams.concurrency }),
        },
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        ...(seams.now === undefined ? {} : { now: seams.now }),
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          await seams.duringSession?.();
          await new Promise((resolve) => setTimeout(resolve, 500));
          return runCuaActorSession({
            ...options,
            participant: scriptedParticipant(TWO_TURN_SESSION),
          });
        },
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    return { result: outcome.result, handle, subject: parsed.config.subject };
  }

  async function runFile(runId: string | undefined, name: string): Promise<string> {
    if (runId === undefined) throw new Error("the run wrote no bundle");
    return readFile(path.join(cwd, ".humanish", "runs", runId, name), "utf8");
  }

  it("is skipped with its reason and no desktop, and the participant after it still starts", async () => {
    const { result, handle } = await runWithLateParticipant();
    expect(handle.created.map((options) => options.metadata?.participantId)).toEqual([
      "first",
      "after",
    ]);
    const late = result.lanes?.find((lane) => lane.id === "late");
    expect(late?.status).toBe("blocked");
    expect(late?.skippedReason).toBe(
      "skipped: its scheduled end (participants[].endAfterMs) came while it waited to start, so its session would have ended before it began; no desktop was created",
    );
    expect(result.laneSummary?.skipped).toBe(1);
    expect(result.lanes?.find((lane) => lane.id === "after")?.status).toBe("passed");

    const bundle = JSON.parse(await runFile(result.runId, "run.json")) as RunBundle;
    expect(bundle.simulations.map((record) => record.status)).toEqual([
      "passed",
      "blocked",
      "passed",
    ]);
    const lateArrival = bundle.simulations[1]?.arrival;
    expect(lateArrival?.startAfterMs).toBe(100);
    expect(lateArrival?.scheduledAt).toBeDefined();
    expect(lateArrival?.startedAt).toBeUndefined();
    expect(bundle.simulations[2]?.arrival?.startedAt).toBeDefined();
    expect(
      bundle.events.filter((event) => event.type === "study.warning").map((event) => event.message),
    ).toContain(
      'Participant "late" would still be waiting for a free slot at its end (participants[].endAfterMs) when every session uses its 1m budget, so the run would skip it without creating its desktop: the run starts at most 1 at once. Let more participants run at once, or give it a later end.',
    );
  });

  it("ends its run line on the skip reason and counts it apart from those that took part", async () => {
    const { result, subject } = await runWithLateParticipant();
    const output = formatCuaStudyHuman(result, subject);
    const lines = (typeof output === "string" ? output : (output.stdout ?? "")).split("\n");
    expect(lines.filter((line) => line.startsWith("participant late:"))).toEqual([
      "participant late: blocked · skipped: its scheduled end (participants[].endAfterMs) came while it waited to start, so its session would have ended before it began; no desktop was created",
    ]);

    const summary =
      "2 participants took part, each in their own copy of the app: 2/2 reported reaching the goal. 1 participant was skipped before its session started; the gaps say why.";
    const bundle = JSON.parse(await runFile(result.runId, "run.json")) as RunBundle;
    expect(bundle.review.summary).toBe(summary);
    expect(bundle.review.gaps[0]).toBe(
      "late: skipped: its scheduled end (participants[].endAfterMs) came while it waited to start, so its session would have ended before it began; no desktop was created",
    );
    expect((await runFile(result.runId, "review.md")).split("\n")).toContain(
      `- summary: ${summary}`,
    );
  });

  it("does not say a skipped participant is using the app while the run is live", async () => {
    const runs = path.join(cwd, ".humanish", "runs");
    const live: string[] = [];
    await runWithLateParticipant(async () => {
      const [runId] = await readdir(runs);
      const bundle = JSON.parse(await readFile(path.join(runs, runId!, "run.json"), "utf8"));
      live.push((bundle as RunBundle).review.summary);
    });
    // The second session is the participant after the one the run skipped.
    expect(live).toHaveLength(2);
    expect(live[1]).toBe(
      "3 participants are planned, each in their own copy of the app. The run is still going, so nothing here is final.",
    );
  });

  it("leaves the took-part sentence out when every participant's end came before its start", async () => {
    // Each read of this clock is a second after the last, so both 1 ms windows have closed by the
    // time the run checks each participant.
    let clockMs = 1_000_000;
    const { result, handle } = await runParticipants(
      [
        { id: "early", endAfterMs: 1 },
        { id: "brief", endAfterMs: 1 },
      ],
      { now: () => (clockMs += 1_000) },
    );
    expect(handle.created).toEqual([]);
    expect(result.laneSummary?.skipped).toBe(2);

    const bundle = JSON.parse(await runFile(result.runId, "run.json")) as RunBundle;
    expect(bundle.review.summary).toBe(
      "2 participants were skipped before their sessions started; the gaps say why.",
    );
  });
});
