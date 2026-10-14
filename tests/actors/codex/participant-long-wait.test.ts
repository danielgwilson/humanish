import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";

import { createRestrictedCodexParticipant } from "../../../src/actors/codex/restricted-participant.js";
import type { RestrictedCodexResult } from "../../../src/actors/codex/restricted-policy.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaLoopResult,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

const native = vi.hoisted(() => ({
  waitMs: 60_000,
  replies: [] as string[],
  descriptions: [] as string[],
}));

// The native Codex task, faked at the session boundary. A tool call that throws ends the native
// run with codex_tool_call, as the restricted transport does when the host request fails.
vi.mock("../../../src/actors/codex/restricted-session.js", () => ({
  createRestrictedCodexSession: vi.fn(
    (options: {
      participant: { tool: { description: string; call: (args: unknown) => Promise<string> } };
    }) => {
      native.descriptions.push(options.participant.tool.description);
      return {
        run: async (): Promise<RestrictedCodexResult> => {
          const { call } = options.participant.tool;
          try {
            native.replies.push(
              await call({
                narration: "I am staying in the call until the other person joins.",
                actions: [{ kind: "wait", ms: native.waitMs }],
              }),
            );
            native.replies.push(
              await call({
                narration: "They joined, so I wave.",
                actions: [{ kind: "click", x: 1, y: 1 }],
              }),
            );
          } catch {
            return {
              status: "failed",
              output: null,
              usage: null,
              usageComplete: true,
              dispatched: true,
              errorCode: "codex_tool_call",
              failurePhase: "response",
            };
          }
          return {
            status: "completed",
            output: {
              outcome: "reached",
              summary: "We both joined the call.",
              frictionReports: [],
            },
            usage: { input: 20, output: 5 },
            inferenceUsage: [{ input: 20, output: 5 }],
            usageComplete: true,
            dispatched: true,
            errorCode: null,
          };
        },
        close: async () => true,
        resolvedModel: undefined,
        authentication: undefined,
        pendingUsage: undefined,
        pendingInferenceUsage: undefined,
        cliVersion: undefined,
        unknownNotifications: {},
        policyRefusal: undefined,
        truncatedFrameBytes: undefined,
        protocolIncompatibilities: undefined,
        protocolAdditions: undefined,
      };
    },
  ),
}));

/** A 160 x 160 light frame (100 tiles of 16 px), or the same with a row of 30 tiles added. */
function frame(withRow: boolean): Buffer {
  const image = new PNG({ width: 160, height: 160 });
  image.data.fill(240);
  if (withRow)
    for (let at = 64 * 160 * 4; at < 112 * 160 * 4; at += 4) image.data.fill(20, at, at + 3);
  return PNG.sync.write(image);
}

const QUIET = frame(false);
const NEW_ROW = frame(true);

/**
 * One Codex participant that asks for one wait, then waves. The loop's clock moves only when it
 * sleeps, and the screen shows a new row from `changesAtMs`. The desktop records each call.
 */
async function waitInCall(
  waitMs: number,
  options: {
    maxWaitMs?: number;
    idleWaitMs?: number;
    speechEnabled?: boolean;
    changesAtMs?: number;
  } = {},
): Promise<{ result: CuaLoopResult; executed: CuaAction[]; firstReply: Record<string, unknown> }> {
  const { maxWaitMs, idleWaitMs, speechEnabled = false, changesAtMs = Infinity } = options;
  native.waitMs = waitMs;
  native.replies.length = 0;
  native.descriptions.length = 0;
  // As the routes build it: the participant and the loop read speech from the same desktop.
  const participant = createRestrictedCodexParticipant({
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
    ...(idleWaitMs === undefined ? {} : { idleWaitMs }),
    ...(speechEnabled ? { speechEnabled: true } : {}),
  });
  const executed: CuaAction[] = [];
  let t = 0;
  const result = await runComputerUseLoop({
    instructions: "Join the call and wait for the other person.",
    provider: participant.provider,
    executor: {
      ...(speechEnabled ? { speechEnabled: true } : {}),
      observe: async () => {
        const screenshot = t >= changesAtMs ? NEW_ROW : QUIET;
        return { screenshot, stateSignature: screenshot === NEW_ROW ? "row" : "quiet" };
      },
      execute: async (action) => {
        executed.push(action);
      },
    },
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" },
    redaction: defaultRedactionHooks,
    timeoutMs: 20 * 60_000,
    turnTimeoutMs: 5_000,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    writeScreenshot: async (name: string) => `screenshots/${name}`,
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
    ...(idleWaitMs === undefined ? {} : { idleWaitMs }),
  });
  await participant.close();
  return {
    result,
    executed,
    firstReply: JSON.parse(native.replies[0] ?? "{}") as Record<string, unknown>,
  };
}

const waitTitles = (result: CuaLoopResult) =>
  result.trace.items
    .filter((item) => item.kind === "ui_action" && item.title.startsWith("wait"))
    .map((item) => [item.title, item.watch?.wake]);

describe("a Codex participant that asks for a long wait", () => {
  it("gets its tool call back when the screen changes, with no wait sent to the desktop", async () => {
    // A 5-minute wait is watched for 5 minutes, past the 2 minutes one wait sent to the desktop
    // lasts by default. Looks every 5 s; the one at 40 s sees the new row, and the quick look at
    // 40.5 s sees it still.
    const { result, executed, firstReply } = await waitInCall(300_000, { changesAtMs: 40_000 });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(executed).toEqual([{ kind: "click", x: 1, y: 1 }]);
    expect(waitTitles(result)).toEqual([["wait 40500ms", "changed"]]);
    const watch = result.trace.items.find((item) => item.watch !== undefined)?.watch;
    expect([watch?.askedMs, watch?.limitMs]).toEqual([300_000, 300_000]);
    expect(firstReply.acknowledgments).toEqual([{ index: 0, status: "completed" }]);
    expect(firstReply.contextHint).toBe(
      "Your wait lasted 41 seconds and ended when the screen changed.",
    );
  });

  it("is told its wait ended at its limit", async () => {
    const { result, firstReply } = await waitInCall(60_000);

    expect(result.completionReason).toBe("goal_satisfied");
    expect(waitTitles(result)).toEqual([["wait 60000ms", "limit"]]);
    expect(firstReply.contextHint).toBe(
      "Your wait lasted 60 seconds; no change on the screen held still long enough to end it.",
    );
  });

  it.each([
    { options: {}, perWait: 120_000, watched: 600_000, shortest: 5_000 },
    { options: { maxWaitMs: 90_000 }, perWait: 90_000, watched: 90_000, shortest: 5_000 },
    { options: { speechEnabled: true }, perWait: 30_000, watched: 600_000, shortest: 5_000 },
    { options: { idleWaitMs: 60_000 }, perWait: 120_000, watched: 600_000, shortest: 60_000 },
  ])(
    "is told a call of only waits lasts $shortest to $watched ms, can last longer in a row, and a wait among other actions at most $perWait ms",
    async ({ options, perWait, watched, shortest }) => {
      await waitInCall(1_000, options);

      expect(native.descriptions[0]).toContain(
        "A call whose actions are only waits and that asks for some wait time returns when",
      );
      expect(native.descriptions[0]).toContain(
        `after its waits' ms, together at least ${shortest} ms and at most ${watched} ms.`,
      );
      expect(native.descriptions[0]).toContain("It does not reload anything.");
      expect(native.descriptions[0]).toContain(
        `When such calls come one after another, a later one can wait longer than its ms, up to ${watched} ms`,
      );
      expect(native.descriptions[0]).toContain(`lasts its ms, at most ${perWait} ms`);
    },
  );
});
