// Computer-use runs whose OpenAI account runs out of credits partway. The participant that runs
// out gets the captured 429 body; the others' sessions succeed, so a later 200 is always on offer.
// A participant due ten minutes in would time a test out if the run still waited for it. Fake
// desktops, the real OpenAI provider on a fake fetch.

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
import type { E2BDesktopCreateOptions, E2BDesktopModule } from "../../../src/substrates/e2b/sdk.js";
import { lab } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedFetch,
  TWO_TURN_SESSION,
  type FanoutModuleHandle,
} from "../../helpers/fanout-desktop.js";
import { writePersonaFiles } from "../../helpers/persona-files.js";

/** The personas this file's studies name, which need their files to run. */
const STUDY_PERSONAS = [
  "autonomous-creative-agent",
  "first-time-visitor",
  "persona-1",
  "persona-2",
] as const;

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };
const exhaustedBody = readFileSync(
  new URL("../../fixtures/openai-out-of-credits/credit-balance-exhausted.json", import.meta.url),
  "utf8",
);
const NOT_STARTED =
  "not started: the model provider account ran out of credits during this run; no desktop was created";

/** Answers the first `ok.length` requests from `ok`, then every later one with the 429 body. */
function exhaustedAfter(ok: unknown[], onExhausted = () => {}): FetchLike {
  const succeed = scriptedFetch(ok);
  let requests = 0;
  return async (...args) => {
    requests += 1;
    if (requests <= ok.length) return succeed(...args);
    onExhausted();
    return {
      ok: false,
      status: 429,
      text: async () => exhaustedBody,
      json: async () => JSON.parse(exhaustedBody) as unknown,
    };
  };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-out-of-credits-"));
  await writePersonaFiles(cwd, ...STUDY_PERSONAS);
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/**
 * Runs `participants` on fake desktops. Session `n` (from 1, in the order sessions start) sends
 * its requests through `fetchFor(n)`, or gets a two-turn success.
 */
async function runStudy(args: {
  participants: Record<string, unknown>[];
  concurrency: number;
  fetchFor: (session: number) => FetchLike | undefined;
  module?: (handle: FanoutModuleHandle) => E2BDesktopModule;
  now?: () => number;
  /** Runs after session `n` returns. */
  afterSession?: (session: number) => void;
}) {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      participants: args.participants,
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: args.concurrency },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const handle = makeFanoutModule();
  const module = args.module?.(handle) ?? handle.module;
  let sessions = 0;
  const outcome = await runStudyWith(
    parsed.config,
    { cwd, env: KEYS },
    {
      ...(args.now === undefined ? {} : { now: args.now }),
      desktopModule: async () => module,
      runSession: async (options: CuaActorSessionOptions) => {
        sessions += 1;
        const session = sessions;
        const fetchFn = args.fetchFor(session) ?? scriptedFetch(TWO_TURN_SESSION);
        const ended = await runCuaActorSession({
          ...options,
          participant: {
            vendor: "openai",
            options: { ...options.participant?.options, apiKey: KEYS.OPENAI_API_KEY, fetchFn },
          },
        });
        args.afterSession?.(session);
        return ended;
      },
      analysis: { run: vi.fn() },
    },
  );
  if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
  const bundle = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId!, "run.json"), "utf8"),
  ) as RunBundle;
  const created = () => handle.created.map((options) => options.metadata?.participantId);
  return { result: outcome.result, created, bundle, subject: parsed.config.subject, sessions };
}

/** Four participants one at a time; the second's first request gets the 429 body. */
function runSecondOutOfCredits() {
  return runStudy({
    participants: [
      { id: "first" },
      { id: "second" },
      { id: "third" },
      { id: "late", startAfterMs: 600_000 },
    ],
    concurrency: 1,
    fetchFor: (session) => (session === 2 ? exhaustedAfter([]) : undefined),
  });
}

describe("a computer-use run whose account runs out of credits", () => {
  it("starts no participant after the one that got the error", async () => {
    const { result, created, bundle } = await runSecondOutOfCredits();
    expect(created()).toEqual(["first", "second"]);
    expect(result.lanes?.map((lane) => [lane.id, lane.status, lane.session?.stopCause])).toEqual([
      ["first", "passed", undefined],
      ["second", "failed", "provider_out_of_credits"],
      ["third", "blocked", undefined],
      ["late", "blocked", undefined],
    ]);
    expect(result.lanes?.slice(2).map((lane) => lane.skippedReason)).toEqual([
      NOT_STARTED,
      NOT_STARTED,
    ]);
    expect(bundle.simulations.map((record) => record.arrival?.startedAt === undefined)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(result.observer?.ok).toBe(true);
  });

  it("says in its output and its summary that it did not finish, why, and what to do", async () => {
    const { result, bundle, subject } = await runSecondOutOfCredits();
    const cause =
      "The model provider account ran out of credits during this run: 2 of 4 participants ran and 2 were not started. Add credits to the account, then run the study again.";
    expect(result.ok).toBe(false);
    expect(result.observer?.ok).toBe(true);
    expect(bundle.outcome?.ok).toBe(false);
    expect(bundle.review.verdict).toBe("fail");
    expect(result.error?.message.startsWith(`${cause} `)).toBe(true);
    expect(bundle.review.summary.startsWith(`${cause} `)).toBe(true);
    const output = formatCuaStudyHuman(result, subject);
    expect(typeof output === "string" ? undefined : output.error?.message).toBe(
      result.error?.message,
    );
  });

  it("starts no participant after one whose closing request got the error", async () => {
    // The first participant's two turns succeed; its closing request is the first to get the 429.
    const { result, created } = await runStudy({
      participants: [{ id: "first" }, { id: "second" }, { id: "third" }],
      concurrency: 1,
      fetchFor: (session) => (session === 1 ? exhaustedAfter(TWO_TURN_SESSION) : undefined),
    });
    expect(created()).toEqual(["first"]);
    expect(result.lanes?.slice(1).map((lane) => [lane.status, lane.skippedReason])).toEqual([
      ["blocked", NOT_STARTED],
      ["blocked", NOT_STARTED],
    ]);
    expect(result.error?.message.split(". ").slice(0, 2)).toEqual([
      "The model provider account ran out of credits during this run: 1 of 3 participants ran and 2 were not started",
      "Add credits to the account, then run the study again",
    ]);
    expect(result.observer?.ok).toBe(true);
  });
});

describe("the cause sentence a run opens with", () => {
  it("counts the one participant of a single-participant run", async () => {
    const { result, bundle } = await runStudy({
      participants: [{ id: "only" }],
      concurrency: 1,
      fetchFor: () => exhaustedAfter([]),
    });
    const cause =
      "The model provider account ran out of credits during this run: 1 of 1 participant ran. Add credits to the account, then run the study again.";
    expect(bundle.review.summary.startsWith(`${cause} `)).toBe(true);
    expect(result.error?.message.startsWith(`${cause} `)).toBe(true);
    expect(result.observer?.ok).toBe(true);
  });

  it("counts as not started only those the credits stopped", async () => {
    // "early" is skipped because its end came before its start, not for credits.
    let clockMs = 1_000_000;
    const { result } = await runStudy({
      participants: [{ id: "first" }, { id: "early", endAfterMs: 1 }, { id: "third" }],
      concurrency: 1,
      fetchFor: (session) => (session === 1 ? exhaustedAfter([]) : undefined),
      now: () => (clockMs += 1_000),
    });
    expect(result.lanes?.map((lane) => lane.status)).toEqual(["failed", "blocked", "blocked"]);
    expect(result.error?.message.split(". ")[0]).toBe(
      "The model provider account ran out of credits during this run: 1 of 3 participants ran and 1 was not started",
    );
  });
});

describe("a participant still preparing its desktop when the account runs out", () => {
  it("closes its desktop without sending its first request", async () => {
    // The second participant's desktop is created only after the first's session has ended on
    // the 429 body.
    let firstEnded!: () => void;
    const afterFirst = new Promise<void>((resolve) => {
      firstEnded = resolve;
    });
    const { result, created, sessions } = await runStudy({
      participants: [{ id: "first" }, { id: "second" }],
      concurrency: 2,
      fetchFor: (session) => (session === 1 ? exhaustedAfter([]) : undefined),
      afterSession: (session) => {
        if (session === 1) firstEnded();
      },
      module: (handle) => ({
        Sandbox: {
          ...handle.module.Sandbox,
          create: (async (...args: Parameters<E2BDesktopModule["Sandbox"]["create"]>) => {
            const options = args.at(-1) as E2BDesktopCreateOptions;
            if (options.metadata?.participantId === "second") await afterFirst;
            return handle.module.Sandbox.create(...args);
          }) as E2BDesktopModule["Sandbox"]["create"],
        },
      }),
    });
    expect(created()).toEqual(["first", "second"]);
    expect(sessions).toBe(1);
    expect(result.lanes?.[1]).toMatchObject({
      status: "blocked",
      skippedReason:
        "not started: the model provider account ran out of credits while its desktop was being prepared; the desktop was closed before its first request",
    });
    expect(result.error?.message.split(". ")[0]).toBe(
      "The model provider account ran out of credits during this run: 1 of 2 participants ran and 1 was not started",
    );
    expect(result.observer?.ok).toBe(true);
  });
});
