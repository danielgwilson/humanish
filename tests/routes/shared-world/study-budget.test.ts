// The study budget on a shared world: the host and its follower share caps.maxTotalUsd, and each
// checks it before every model request, as a computer-use participant does. Both run the real
// session loop with the route's own budget closure; only the model and the screen are fakes.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorCapabilities } from "../../../src/actors/contract.js";
import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type {
  CuaExecutor,
  CuaLoopResult,
  CuaProvider,
} from "../../../src/actors/computer-use/loop.js";
import { parseStudy } from "../../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { automaticAnalysisBoundary } from "../../helpers/automatic-analysis-boundary.js";
import { runSharedWorld } from "../../helpers/route-run.js";
import { makeCommandHandler, makeFakeModule } from "../../helpers/shared-world-fakes.js";

const CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open",
};
const LOBBY_URL = "https://lobby-trivia.example.test/en/lobby/AB2CD9";
const FRAME = PNG.sync.write(new PNG({ width: 4, height: 4 }));

/** A host and one follower on a public app, sharing a $1 study budget at gpt-5.5's rates. */
function hostAndFollower(): StudyConfig {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "lobby-budget-test",
    route: "shared-world",
    mode: "live",
    subject: {
      source: "app-url",
      appUrl: "https://lobby-trivia.example.test/",
      publicTarget: { owner: "example-operator/lobby-trivia", authorized: true },
    },
    policies: { allowPublicTargets: true },
    actor: { type: "openai-computer-use", model: "gpt-5.5", mission: "Play the lobby game." },
    caps: { maxTotalUsd: 1 },
    participants: [
      {
        id: "host",
        host: true,
        persona: "party-host",
        instruction: "Create a lobby, then play.",
      },
      {
        id: "player-2",
        persona: "competitive-friend",
        instruction: "Join the lobby you're told the code for, then play.",
      },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** A model that clicks on every turn, reporting the next of `inputs` as its input tokens. */
function clickingModel(inputs: number[], onRequest: () => void): CuaProvider {
  return {
    id: "fake-cua",
    version: "gpt-5.5",
    capabilities: CAPS,
    async nextTurn() {
      onRequest();
      return {
        actions: [{ kind: "click", x: 10, y: 20 }],
        pendingSafetyChecks: [],
        done: false,
        usage: { input: inputs.shift() ?? 0, output: 0 },
      };
    },
  };
}

/** A screen on the lobby that changes on every look; each click first waits for `clicked`. */
function lobbyScreen(clicked: () => Promise<void>): CuaExecutor {
  let looks = 0;
  return {
    observe: async () => ({
      screenshot: FRAME,
      stateSignature: `s${(looks += 1)}`,
      url: LOBBY_URL,
    }),
    execute: clicked,
  };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-shared-budget-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("the study budget on a shared world", () => {
  it("stops the follower before its next request once the host crosses the budget", async () => {
    // At $5 per million input tokens: the host's first turn and the follower's are $0.05 each,
    // and the host's second turn adds $2, which crosses the $1 budget while the follower clicks.
    let followerAsked!: () => void;
    const followerHasAsked = new Promise<void>((resolve) => {
      followerAsked = resolve;
    });
    let hostEnded!: () => void;
    const hostHasEnded = new Promise<void>((resolve) => {
      hostEnded = resolve;
    });
    const requests = { host: 0, follower: 0 };
    const sessions = new Map<string, CuaLoopResult>();
    const host = {
      provider: clickingModel([10_000, 400_000], () => (requests.host += 1)),
      executor: lobbyScreen(() => followerHasAsked),
    };
    const follower = {
      provider: clickingModel([10_000], () => {
        requests.follower += 1;
        followerAsked();
      }),
      executor: lobbyScreen(() => hostHasEnded),
    };

    const { module } = makeFakeModule(makeCommandHandler({ worldVersion: 0 }));
    const result = await runSharedWorld({
      cwd,
      config: hostAndFollower(),
      dryRun: false,
      env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      deps: {
        desktopModule: async () => module,
        detachedTimers: { now: () => 0, sleep: async () => {} },
        readLobbyCodeFromFrame: async () => "AB2CD9",
        analysis: { run: automaticAnalysisBoundary() },
        runSession: async (options: CuaActorSessionOptions) => {
          const isHost = options.persona.id === "party-host";
          try {
            const session = await runCuaActorSession({
              ...options,
              ...(isHost ? host : follower),
            });
            sessions.set(isHost ? "host" : "follower", session);
            return session;
          } finally {
            if (isHost) hostEnded();
          }
        },
      },
    });

    // The host crossed the budget with its second reply.
    expect(requests.host).toBe(2);
    expect(sessions.get("host")?.trace.stopCause).toBe("study_spend_limit");
    // The follower stops before a second request.
    expect(requests.follower).toBe(1);
    expect(sessions.get("follower")?.completionReason).toBe("budget_reached");
    expect(sessions.get("follower")?.trace.stopCause).toBe("study_spend_limit");
    expect(result.roles.map((role) => role.session?.completionReason)).toEqual([
      "budget_reached",
      "budget_reached",
    ]);
  });
});
