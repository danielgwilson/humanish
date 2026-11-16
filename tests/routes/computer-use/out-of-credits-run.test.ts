// A computer-use run whose OpenAI account runs out of credits partway: the second participant's
// first request gets the captured 429 body, and the run starts nobody after it, though the
// account would answer the next requests with 200. The last participant is due ten minutes in,
// so a run that still waited for it would time this test out. Fake desktops, the real OpenAI
// provider on a fake fetch, one slot.

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { FetchLike } from "../../../src/actors/computer-use/provider-http.js";
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
const exhaustedBody = readFileSync(
  new URL("../../fixtures/openai-out-of-credits/credit-balance-exhausted.json", import.meta.url),
  "utf8",
);
const outOfCredits: FetchLike = async () => ({
  ok: false,
  status: 429,
  text: async () => exhaustedBody,
  json: async () => JSON.parse(exhaustedBody) as unknown,
});

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-out-of-credits-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Runs four participants one at a time; the second session's account is out of credits. */
async function runOutOfCreditsStudy() {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      participants: [
        { id: "first" },
        { id: "second" },
        { id: "third" },
        { id: "late", startAfterMs: 600_000 },
      ],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 1 },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const handle = makeFanoutModule();
  let sessions = 0;
  const outcome = await runStudyWith(
    parsed.config,
    { cwd, env: KEYS },
    {
      desktopModule: async () => handle.module,
      runSession: async (options: CuaActorSessionOptions) => {
        sessions += 1;
        const participant =
          sessions === 2
            ? {
                vendor: "openai" as const,
                options: { apiKey: KEYS.OPENAI_API_KEY, fetchFn: outOfCredits },
              }
            : scriptedParticipant(TWO_TURN_SESSION);
        return runCuaActorSession({ ...options, participant });
      },
      analysis: { run: vi.fn() },
    },
  );
  if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
  const bundle = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId!, "run.json"), "utf8"),
  ) as RunBundle;
  return { result: outcome.result, handle, bundle, subject: parsed.config.subject };
}

describe("a computer-use run whose account runs out of credits", () => {
  it("starts no participant after the one that got the error", async () => {
    const { result, handle, bundle } = await runOutOfCreditsStudy();
    expect(handle.created.map((options) => options.metadata?.participantId)).toEqual([
      "first",
      "second",
    ]);
    expect(result.lanes?.map((lane) => [lane.id, lane.status, lane.session?.stopCause])).toEqual([
      ["first", "passed", undefined],
      ["second", "failed", "provider_out_of_credits"],
      ["third", "blocked", undefined],
      ["late", "blocked", undefined],
    ]);
    const notStarted =
      "not started: the model provider account ran out of credits during this run; no desktop was created";
    expect(result.lanes?.slice(2).map((lane) => lane.skippedReason)).toEqual([
      notStarted,
      notStarted,
    ]);
    expect(bundle.simulations.map((record) => record.arrival?.startedAt === undefined)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("says in its output and its summary that it did not finish, why, and what to do", async () => {
    const { result, bundle, subject } = await runOutOfCreditsStudy();
    const cause =
      "The model provider account ran out of credits during this run: 2 of 4 participants ran and 2 were not started. Add credits to the account, then run the study again.";
    expect(result.ok).toBe(false);
    expect(bundle.outcome?.ok).toBe(false);
    expect(bundle.review.verdict).toBe("fail");
    expect(result.error?.message.startsWith(`${cause} `)).toBe(true);
    expect(bundle.review.summary.startsWith(`${cause} `)).toBe(true);
    const output = formatCuaStudyHuman(result, subject);
    expect(typeof output === "string" ? undefined : output.error?.message).toBe(
      result.error?.message,
    );
  });
});
