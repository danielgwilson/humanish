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

function frame(shade: number): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data[0] = shade;
  image.data[3] = 255;
  return PNG.sync.write(image);
}

/** One Codex participant that waits, then waves; the desktop records each call it receives. */
async function waitInCall(
  waitMs: number,
  maxWaitMs?: number,
  speechEnabled = false,
): Promise<{ result: CuaLoopResult; executed: CuaAction[]; firstReply: Record<string, unknown> }> {
  native.waitMs = waitMs;
  native.replies.length = 0;
  native.descriptions.length = 0;
  // As the routes build it: the participant and the loop read speech from the same desktop.
  const participant = createRestrictedCodexParticipant({
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
    ...(speechEnabled ? { speechEnabled: true } : {}),
  });
  const executed: CuaAction[] = [];
  let shade = 0;
  const result = await runComputerUseLoop({
    instructions: "Join the call and wait for the other person.",
    provider: participant.provider,
    executor: {
      ...(speechEnabled ? { speechEnabled: true } : {}),
      observe: async () => ({ screenshot: frame(shade), stateSignature: String(shade) }),
      execute: async (action) => {
        executed.push(action);
        shade += 1;
      },
    },
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" },
    redaction: defaultRedactionHooks,
    timeoutMs: 20_000,
    turnTimeoutMs: 5_000,
    now: () => Date.now(),
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

const shortenedNotices = (result: CuaLoopResult) =>
  result.trace.items.filter((item) => item.kind === "notice" && item.title === "wait shortened");

describe("a Codex participant that asks for a long wait", () => {
  it("waits the whole minute in two desktop calls and keeps its session", async () => {
    const { result, executed, firstReply } = await waitInCall(60_000);

    expect(result.completionReason).toBe("goal_satisfied");
    expect(executed).toEqual([
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 30_000 },
      { kind: "click", x: 1, y: 1 },
    ]);
    expect(shortenedNotices(result)).toEqual([]);
    // The reply to that tool call acknowledges one completed action and needs no explanation.
    expect(firstReply.acknowledgments).toEqual([{ index: 0, status: "completed" }]);
    expect(firstReply.contextHint).toBeNull();
    expect(native.descriptions[0]).toContain("at most 120000 ms");
  });

  it("shortens a wait past the study's longest, says so in its reply and keeps its session", async () => {
    const { result, executed, firstReply } = await waitInCall(300_000, 90_000);

    expect(result.completionReason).toBe("goal_satisfied");
    expect(executed).toEqual([
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 30_000 },
      { kind: "click", x: 1, y: 1 },
    ]);
    const shortened = shortenedNotices(result);
    expect(shortened).toHaveLength(1);
    expect(shortened[0]?.text).toContain("requested: 300000ms");
    expect(shortened[0]?.text).toContain("waited: 90000ms");
    expect(firstReply.acknowledgments).toEqual([{ index: 0, status: "completed" }]);
    expect(firstReply.contextHint).toContain("shortened to 90000ms");
    expect(native.descriptions[0]).toContain("at most 90000 ms");
  });

  it("is told and given 30 s on a desktop with speech when the study sets no longest wait", async () => {
    const { result, executed, firstReply } = await waitInCall(60_000, undefined, true);

    expect(result.completionReason).toBe("goal_satisfied");
    expect(executed).toEqual([
      { kind: "wait", ms: 30_000 },
      { kind: "click", x: 1, y: 1 },
    ]);
    expect(shortenedNotices(result)).toHaveLength(1);
    expect(firstReply.contextHint).toContain("shortened to 30000ms");
    expect(native.descriptions[0]).toContain("at most 30000 ms");
  });
});
