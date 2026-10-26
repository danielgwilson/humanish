// A computer-use study in which a support agent works until its scheduled end while customers
// arrive, run on fake desktops ($0, real orchestration and real time with sub-second windows). The
// support agent's session ends at its end with a closing report and passes; each sandbox is sized
// from its own participant's window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { CuaProvider, CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import type { ActorTrace } from "../../../src/actors/contract.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import type { StudyConfig } from "../../../src/study/types.js";
import { lab } from "../../admission/fixtures.js";
import {
  makeFanoutModule,
  scriptedParticipant,
  TWO_TURN_SESSION,
} from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };
const MIN = 60_000;

/** A support agent who takes a turn every 100 ms and never ends on its own. */
function agentProvider(seen: { at: number; hint: string | undefined }[]): CuaProvider {
  return {
    id: "support-agent",
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: true,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "open",
    },
    async nextTurn(request: CuaTurnRequest) {
      seen.push({ at: Date.now(), hint: request.contextHint });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        actions: [{ kind: "click", x: 10 + seen.length, y: 20 }],
        pendingSafetyChecks: [],
        done: false,
        message: "Answering the next customer.",
      };
    },
    async debrief() {
      return {
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        closingReport: { summary: "I answered two customers.", frictionReports: [] },
      };
    },
  };
}

describe("a support agent with a scheduled end", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-scheduled-end-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("works until its end while customers come and go, then reports and passes", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        mode: "live",
        participants: [
          { id: "support-agent", endAfterMs: 1_500, windDownMs: 1_000 },
          { id: "customer", count: 2, startAfterMs: 300, startEveryMs: 300 },
        ],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const config: StudyConfig = parsed.config;
    const handle = makeFanoutModule();
    const seen: { at: number; hint: string | undefined }[] = [];
    const outcome = await runStudyWith(
      config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) =>
          options.clock?.end === undefined
            ? runCuaActorSession({
                ...options,
                participant: scriptedParticipant(TWO_TURN_SESSION),
              })
            : runCuaActorSession({ ...options, provider: agentProvider(seen) }),
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);

    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId!);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    // Records are in roster order: the support agent, then the two customers.
    expect(bundle.simulations.map((record) => record.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    // The staff member's closing report declares no outcome, so it passes as running until its
    // scheduled end and is not counted as reaching the goal.
    expect(bundle.review?.participants).toMatchObject({
      total: 3,
      reachedGoal: 2,
      ranUntilEnd: 1,
      ranOut: 0,
    });
    expect(bundle.review?.summary).toContain(
      "3 participants took part, each in their own copy of the app: 2/3 reported reaching the goal, 1 ran until its scheduled end.",
    );

    const agent = JSON.parse(
      await readFile(
        path.join(runDir, "actors", `${bundle.simulations[0]!.streamIds[0]}.json`),
        "utf8",
      ),
    ) as ActorTrace;
    expect(agent.completionReason).toBe("goal_satisfied");
    expect(agent.stopCause).toBe("scheduled_end");
    expect(agent.debrief).toMatchObject({ trigger: "scheduled_end", status: "completed" });

    // The support agent ends at its time, a turn or so after it, and is told the time left only
    // from the start of its wind-down, 500 ms in.
    const anchor = Date.parse(bundle.simulations[0]!.arrival!.scheduledAt!);
    const ended = Date.parse(agent.completedAt);
    expect(ended).toBeGreaterThanOrEqual(anchor + 1_500);
    expect(ended).toBeLessThan(anchor + 2_500);
    expect(
      seen.filter((turn) => turn.at < anchor + 450).every((turn) => turn.hint === undefined),
    ).toBe(true);
    const windDown = seen.filter((turn) => turn.at >= anchor + 550);
    expect(windDown.length).toBeGreaterThan(0);
    expect(windDown.every((turn) => turn.hint?.startsWith("Your session ends at "))).toBe(true);

    // Each sandbox lives its participant's session plus the 10-minute buffer: the support agent's
    // session is its 1.5 s window plus 5 minutes for the closing report; a customer's is the
    // 1-minute budget.
    expect(handle.created.map((created) => created.timeoutMs)).toEqual([
      1_500 + 5 * MIN + 10 * MIN,
      1 * MIN + 10 * MIN,
      1 * MIN + 10 * MIN,
    ]);
  });

  it("records each participant's own idle wait in its wait settings", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        mode: "live",
        actor: { type: "openai-computer-use", idleWaitMs: 5_000 },
        participants: [
          { id: "support-agent", idleWaitMs: 60_000 },
          { id: "customer", startAfterMs: 100 },
        ],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) =>
          runCuaActorSession({
            ...options,
            participant: scriptedParticipant(TWO_TURN_SESSION),
          }),
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId!);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const idleWaits = await Promise.all(
      bundle.simulations.map(async (record) => {
        const trace = JSON.parse(
          await readFile(path.join(runDir, "actors", `${record.streamIds[0]}.json`), "utf8"),
        ) as ActorTrace;
        return trace.waitSettings?.idleWaitMs;
      }),
    );
    expect(idleWaits).toEqual([60_000, 5_000]);
  });
});
