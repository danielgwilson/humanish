import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_CONTROL_LIMITS } from "../../../src/browser-control/protocol.js";
import { createRestrictedCodexParticipant } from "../../../src/actors/codex/restricted-participant.js";
import type { RestrictedCodexResult } from "../../../src/actors/codex/restricted-policy.js";
import { runComputerUseLoop, type CuaAction } from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

const native = vi.hoisted(() => ({ replies: [] as string[] }));

// The native Codex task, faked at the session boundary. A tool call that throws ends the native
// run with codex_tool_call, as the restricted transport does when the host request fails.
vi.mock("../../../src/actors/codex/restricted-session.js", () => ({
  createRestrictedCodexSession: vi.fn(
    (options: { participant: { tool: { call: (args: unknown) => Promise<string> } } }) => ({
      run: async (): Promise<RestrictedCodexResult> => {
        const { call } = options.participant.tool;
        try {
          native.replies.push(
            await call({
              narration: "I am staying in the call until the other person joins.",
              actions: [{ kind: "wait", ms: 60_000 }],
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
          output: { outcome: "reached", summary: "We both joined the call.", frictionReports: [] },
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
    }),
  ),
}));

function frame(shade: number): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data[0] = shade;
  image.data[3] = 255;
  return PNG.sync.write(image);
}

describe("a Codex participant that asks for a long wait", () => {
  it("waits the longest one action allows, records the shortened wait and keeps its session", async () => {
    native.replies.length = 0;
    const participant = createRestrictedCodexParticipant();
    const executed: CuaAction[] = [];
    let shade = 0;
    const result = await runComputerUseLoop({
      instructions: "Join the call and wait for the other person.",
      provider: participant.provider,
      executor: {
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
    });
    await participant.close();

    expect(result.completionReason).toBe("goal_satisfied");
    expect(executed).toEqual([
      { kind: "wait", ms: BROWSER_CONTROL_LIMITS.waitMs },
      { kind: "click", x: 1, y: 1 },
    ]);
    const shortened = result.trace.items.filter(
      (item) => item.kind === "notice" && item.title === "wait shortened",
    );
    expect(shortened).toHaveLength(1);
    expect(shortened[0]?.text).toContain("requested: 60000ms");
    expect(shortened[0]?.text).toContain(`waited: ${BROWSER_CONTROL_LIMITS.waitMs}ms`);
    // The participant learns why its wait was shorter on the reply to that tool call.
    const reply = JSON.parse(native.replies[0] ?? "{}") as {
      acknowledgments?: unknown;
      contextHint?: string | null;
    };
    expect(reply.acknowledgments).toEqual([{ index: 0, status: "completed" }]);
    expect(reply.contextHint).toContain(String(BROWSER_CONTROL_LIMITS.waitMs));
  });
});
