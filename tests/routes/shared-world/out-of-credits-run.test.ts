// A provisioned shared world whose OpenAI account runs out of credits partway: the second
// participant's first request gets the captured 429 body, and the third, due ten minutes in, is
// not started. A run that still waited for it would time this test out. The N+1 fakes, two slots,
// and the real OpenAI provider on a fake fetch for the participant that runs out.

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
import { baseSeams, concurrentStudy, makeRunSession } from "../../helpers/shared-world-fakes.js";

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
            ? runCuaActorSession({
                ...options,
                executor: {
                  observe: async () => ({ screenshot: FRAME, stateSignature: "s" }),
                  execute: async () => {},
                },
                participant: {
                  vendor: "openai",
                  options: { apiKey: env.OPENAI_API_KEY!, fetchFn: outOfCredits },
                },
              })
            : passing(options),
        analysis: { run: automaticAnalysisBoundary() },
      },
    });

    // The app's sandbox and two participants' desktops; none for the third.
    expect(created.map((options) => options.metadata?.kind)).toHaveLength(3);
    expect(result.roles.map((role) => role.status)).toEqual(["passed", "failed", "blocked"]);
    expect(result.roles[2]?.skippedReason).toBe(
      "not started: the model provider account ran out of credits during this run; no desktop was created",
    );
    expect(result.ok).toBe(false);

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
});
