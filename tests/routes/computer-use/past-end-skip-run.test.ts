// A participant with a scheduled end that waits for a free slot until its end has passed is
// skipped before its desktop exists, as one due after the study budget is spent is. Run on fake
// desktops ($0, real orchestration and real time with sub-second windows) with one slot: the first
// participant's session takes at least 500 ms, the second is due at 100 ms and ends at 300 ms, and
// the third is due at 200 ms with no end.

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
import { lab } from "../../admission/fixtures.js";
import { makeFanoutModule, scriptedFetch, TWO_TURN_SESSION } from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

describe("a participant still waiting for a slot at its scheduled end", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-past-end-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("is skipped with its reason and no desktop, and the participant after it still starts", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        mode: "live",
        participants: [
          { id: "first" },
          { id: "late", startAfterMs: 100, endAfterMs: 300 },
          { id: "after", startAfterMs: 200 },
        ],
        execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 1 },
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;
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

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId!, "run.json"), "utf8"),
    ) as RunBundle;
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
});
