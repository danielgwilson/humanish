// Shared worlds whose OpenAI account runs out of credits partway, on both planes. The participant
// that runs out gets the captured 429 body from the real OpenAI provider on a fake fetch; one due
// ten minutes in would time a test out if the run still waited for it. The N+1 fakes.

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { FetchLike } from "../../../src/actors/computer-use/provider-http.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { parseStudy } from "../../../src/study/config.js";
import { automaticAnalysisBoundary } from "../../helpers/automatic-analysis-boundary.js";
import { runSharedWorld } from "../../helpers/route-run.js";
import {
  baseSeams,
  concurrentStudy,
  makeCommandHandler,
  makeFakeModule,
  makeRunSession,
} from "../../helpers/shared-world-fakes.js";
import { STUDY_SCHEMA } from "../../../src/study/types.js";

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
const FRAME = PNG.sync.write(new PNG({ width: 4, height: 4 }));
const NOT_STARTED =
  "not started: the model provider account ran out of credits during this run; no desktop was created";

/** The session options for a participant whose every request gets the 429 body. */
function outOfCreditsSession(options: CuaActorSessionOptions): CuaActorSessionOptions {
  return {
    ...options,
    executor: {
      observe: async () => ({ screenshot: FRAME, stateSignature: "s" }),
      execute: async () => {},
    },
    participant: {
      vendor: "openai",
      options: {
        ...options.participant?.options,
        apiKey: "test-openai-key",
        fetchFn: outOfCredits,
      },
    },
  };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-shared-credits-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("a shared world whose account runs out of credits", () => {
  it("starts no participant after the one that got the error, and says so", async () => {
    const study = concurrentStudy(3, 2);
    const parsed = parseStudy({
      ...study,
      participants: study.participants.map((entry, index) =>
        index === 2 ? { ...entry, startAfterMs: 600_000 } : entry,
      ),
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const state = { worldVersion: 0 };
    const { env, deps, created } = baseSeams(state, async () => {});
    const passing = makeRunSession(state, async () => {});
    const result = await runSharedWorld({
      cwd,
      config: parsed.config,
      dryRun: false,
      env,
      deps: {
        ...deps,
        runSession: (options: CuaActorSessionOptions) =>
          options.persona.id === "persona-2"
            ? runCuaActorSession(outOfCreditsSession(options))
            : passing(options),
        analysis: { run: automaticAnalysisBoundary() },
      },
    });

    // The app's sandbox and two participants' desktops; none for the third.
    expect(created.map((options) => options.metadata?.kind)).toHaveLength(3);
    expect(result.roles.map((role) => role.status)).toEqual(["passed", "failed", "blocked"]);
    expect(result.roles[2]?.skippedReason).toBe(NOT_STARTED);
    expect(result.ok).toBe(false);
    expect(result.observer?.ok).toBe(true);

    const cause =
      "The model provider account ran out of credits during this run: 2 of 3 participants ran and 1 was not started. Add credits to the account, then run the study again.";
    expect(result.error?.message.startsWith(`${cause} `)).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary.startsWith(`${cause} `)).toBe(true);
    expect(bundle.streams.map((stream) => stream.actor?.stopCause)).toEqual([
      undefined,
      "provider_out_of_credits",
      undefined,
    ]);
    expect(bundle.simulations[2]?.arrival?.startedAt).toBeUndefined();
  });

  it("records the followers of a host that ran out before its lobby as not started for credits", async () => {
    const parsed = parseStudy({
      schema: STUDY_SCHEMA,
      id: "lobby-credits-test",
      route: "shared-world",
      mode: "live",
      subject: {
        source: "app-url",
        appUrl: "https://lobby-trivia.example.test/",
        publicTarget: { owner: "example-operator/lobby-trivia", authorized: true },
      },
      policies: { allowPublicTargets: true },
      actor: { type: "openai-computer-use", model: "gpt-5.5", mission: "Play the lobby game." },
      participants: [
        { id: "host", host: true, persona: "party-host", instruction: "Create a lobby." },
        { id: "player-2", persona: "competitive-friend", instruction: "Join the lobby." },
        {
          id: "player-3",
          persona: "competitive-friend",
          instruction: "Join the lobby.",
          startAfterMs: 600_000,
        },
      ],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 3 },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const { module, created } = makeFakeModule(makeCommandHandler({ worldVersion: 0 }));
    const result = await runSharedWorld({
      cwd,
      config: parsed.config,
      dryRun: false,
      env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      deps: {
        desktopModule: async () => module,
        detachedTimers: { now: () => 0, sleep: async () => {} },
        readLobbyCodeFromFrame: async () => undefined,
        analysis: { run: automaticAnalysisBoundary() },
        runSession: (options: CuaActorSessionOptions) =>
          runCuaActorSession(outOfCreditsSession(options)),
      },
    });

    // Only the host's desktop: the followers never opened the app.
    expect(created).toHaveLength(1);
    expect(result.roles.map((role) => [role.status, role.skippedReason])).toEqual([
      ["failed", undefined],
      ["blocked", NOT_STARTED],
      ["blocked", NOT_STARTED],
    ]);
    expect(result.ok).toBe(false);
    expect(result.observer?.ok).toBe(true);
    const cause =
      "The model provider account ran out of credits during this run: 1 of 3 participants ran and 2 were not started. Add credits to the account, then run the study again.";
    expect(result.error?.message.startsWith(`${cause} `)).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.review.summary.startsWith(`${cause} `)).toBe(true);
  });
});
