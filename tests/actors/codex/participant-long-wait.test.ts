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
  options: { maxWaitMs?: number; speechEnabled?: boolean; changesAtMs?: number } = {},
): Promise<{ result: CuaLoopResult; executed: CuaAction[]; firstReply: Record<string, unknown> }> {
  const { maxWaitMs, speechEnabled = false, changesAtMs = Infinity } = options;
  native.waitMs = waitMs;
  native.replies.length = 0;
  native.descriptions.length = 0;
  // As the routes build it: the participant and the loop read speech from the same desktop.
  const participant = createRestrictedCodexParticipant({
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
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
    // A 5-minute wait is first watched for 2 minutes, the longest one wait lasts by default. Looks
    // every 5 s; the one at 40 s sees the new row, and the quick look at 40.5 s sees it still.
    const { result, executed, firstReply } = await waitInCall(300_000, { changesAtMs: 40_000 });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(executed).toEqual([{ kind: "click", x: 1, y: 1 }]);
    expect(waitTitles(result)).toEqual([["wait 40500ms", "changed"]]);
    expect(firstReply.acknowledgments).toEqual([{ index: 0, status: "completed" }]);
    expect(firstReply.contextHint).toBe(
      "Your wait lasted 41 seconds and ended when the screen changed.",
    );
  });

  it("is told its wait ended at its limit, and that the next one in a row can last longer", async () => {
    const { result, firstReply } = await waitInCall(60_000);

    expect(result.completionReason).toBe("goal_satisfied");
    expect(waitTitles(result)).toEqual([["wait 60000ms", "limit"]]);
    expect(firstReply.contextHint).toBe(
      "Your wait lasted 60 seconds; no change on the screen held still long enough to end it. A wait right after it can last twice as long, at most 10 minutes.",
    );
  });

  it.each([
    { options: {}, perWait: 120_000, grows: 600_000 },
    { options: { maxWaitMs: 90_000 }, perWait: 90_000, grows: 90_000 },
    { options: { speechEnabled: true }, perWait: 30_000, grows: 600_000 },
  ])(
    "is told the longest one wait lasts and the longest a watch grows to: $perWait and $grows ms",
    async ({ options, perWait, grows }) => {
      await waitInCall(1_000, options);

      expect(native.descriptions[0]).toContain(`each at most ${perWait} ms`);
      expect(native.descriptions[0]).toContain(`up to ${grows} ms`);
    },
  );
});
