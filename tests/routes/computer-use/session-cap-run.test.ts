// A computer-use study of two participants with a session cap, run on fake desktops ($0, real
// orchestration and real time with sub-second caps). One ends its own session early and passes; the
// other is still working at its cap, gives its closing report and passes with stop cause
// `session_cap`. The cap counts from the start of the session, so a slow desktop does not use it,
// and each sandbox is sized from its participant's cap.

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
import { lab } from "../../admission/fixtures.js";
import { makeFanoutModule } from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };
const MIN = 60_000;
// How long each fake desktop takes to be created, standing in for a hosted desktop's setup.
const SETUP_MS = 800;

/** A visitor that takes a turn every 100 ms and ends its own session on turn `endsOn`, if any. */
function visitor(endsOn: number | undefined, hints: (string | undefined)[]): CuaProvider {
  return {
    id: "visitor",
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
      hints.push(request.contextHint);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (hints.length === endsOn)
        return {
          actions: [],
          pendingSafetyChecks: [],
          done: true,
          message: "REACHED THE GOAL. The page says Example Domain.",
        };
      return {
        actions: [{ kind: "click", x: 10 + hints.length, y: 20 }],
        pendingSafetyChecks: [],
        done: false,
        message: "Reading the page again.",
      };
    },
    async debrief() {
      return {
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        closingReport: { summary: "I kept reading the one page.", frictionReports: [] },
      };
    },
  };
}

describe("two participants with a session cap", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-session-cap-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("lets one end itself early and ends the other at its cap with a closing report", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        mode: "live",
        participants: [
          { id: "quick", instruction: "Look once and stop.", maxSessionMs: 1_500 },
          {
            id: "steady",
            instruction: "Keep working.",
            maxSessionMs: 1_500,
            windDownMs: 1_000,
          },
        ],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const create = handle.module.Sandbox.create;
    handle.module.Sandbox.create = (async (...args: Parameters<typeof create>) => {
      await new Promise((resolve) => setTimeout(resolve, SETUP_MS));
      return create(...args);
    }) as typeof create;
    const quickHints: (string | undefined)[] = [];
    const steadyHints: (string | undefined)[] = [];
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) =>
          runCuaActorSession({
            ...options,
            provider: options.instructions.includes("Look once")
              ? visitor(2, quickHints)
              : visitor(undefined, steadyHints),
          }),
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);

    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId!);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect(bundle.simulations.map((record) => record.status)).toEqual(["passed", "passed"]);
    const trace = async (index: number): Promise<ActorTrace> =>
      JSON.parse(
        await readFile(
          path.join(runDir, "actors", `${bundle.simulations[index]!.streamIds[0]}.json`),
          "utf8",
        ),
      ) as ActorTrace;

    const quick = await trace(0);
    expect(quick.completionReason).toBe("goal_satisfied");
    expect(quick.stopCause).toBeUndefined();
    expect(quickHints).toHaveLength(2);

    const steady = await trace(1);
    expect(steady.completionReason).toBe("goal_satisfied");
    expect(steady.stopCause).toBe("session_cap");
    expect(steady.reason).toBe("I kept reading the one page.");
    expect(steady.debrief).toMatchObject({ trigger: "session_cap", status: "completed" });
    // The cap counts from the session's start, after the desktop's setup: the session lasts the
    // 1.5 s cap and a turn or so more, and the first wind-down hint comes about 500 ms in.
    expect(steady.durationMs).toBeGreaterThanOrEqual(1_500);
    expect(steady.durationMs).toBeLessThan(2_500);
    expect(steadyHints[0]).toBeUndefined();
    expect(steadyHints.at(-1)).toMatch(
      /^Your session ends at \d\d:\d\d UTC at the latest, in 1 minute\./,
    );

    // Each sandbox lives its participant's session plus the 10-minute buffer: the 1.5 s cap plus 5
    // minutes for the closing report.
    expect(handle.created.map((created) => created.timeoutMs)).toEqual([
      1_500 + 5 * MIN + 10 * MIN,
      1_500 + 5 * MIN + 10 * MIN,
    ]);
  });
});
