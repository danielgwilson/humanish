// The checkpoint tap: the loop tells its caller each time a turn's checkpoint screenshot (turn-03)
// or after-dwell screenshot (turn-03-after-dwell) is recorded, with the turn's number. A hosted
// desktop pairs each call with the time of the browser-state read that screenshot came after, and
// a participant's network log numbers its requests by those pairs, so the tap must fire once per
// such screenshot and never for a turn that took none.

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import type { ActorCapabilities, ActorPersonaRef } from "../../../src/actors/contract.js";
import {
  runComputerUseLoopWithTaps,
  type CuaProvider,
  type CuaTurn,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

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
const persona: ActorPersonaRef = { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" };
const FRAME = PNG.sync.write(new PNG({ width: 2, height: 2 }));
const MINUTE = 60_000;

const click = (x: number): CuaTurn => ({
  actions: [{ kind: "click", x, y: 1 }],
  pendingSafetyChecks: [],
  done: false,
});
const finished: CuaTurn = { actions: [], pendingSafetyChecks: [], done: true, message: "Done." };

/** The screenshot titles a run recorded, in order. */
const screenshotTitles = (items: ReadonlyArray<{ kind: string; title?: string }>): string[] =>
  items.filter((item) => item.kind === "screenshot").map((item) => item.title ?? "");

describe("the checkpoint tap", () => {
  it("fires with each checkpoint's turn, again after a dwell, and not for a cut-off turn", async () => {
    // Turn 1 lands on a page whose text starts the dwell window. Turn 3's reply is cut off by the
    // output limit and is sent again as turn 4.
    const replies: CuaTurn[] = [
      click(1),
      click(2),
      { ...click(3), interruption: "output_limit" },
      click(4),
      finished,
    ];
    let observed = 0;
    let t = 0;
    const taps: number[] = [];
    const result = await runComputerUseLoopWithTaps({
      instructions: "Watch the video, then finish.",
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 60 * MINUTE,
      now: () => (t += 1),
      sleep: async (ms) => {
        t += ms;
      },
      provider: {
        id: "checkpoint-tap",
        capabilities: CAPS,
        outputLimitRetry: true,
        nextTurn: async () => replies.shift() ?? finished,
      },
      executor: {
        observe: async () => {
          observed += 1;
          return {
            screenshot: FRAME,
            stateSignature: `frame-${observed}`,
            text: observed === 2 ? "video playing" : "page",
          };
        },
        execute: async () => undefined,
      },
      dwell: { when: { any: [{ textIncludes: "video" }] }, ms: 100, everyMs: 40, then: "continue" },
      onCheckpoint: (turn) => taps.push(turn),
    });

    expect(result.trace.stopCause).toBeUndefined();
    expect(screenshotTitles(result.trace.items)).toEqual([
      "turn-00-start",
      "turn-01",
      "dwell-01",
      "dwell-02",
      "dwell-03",
      "turn-01-after-dwell",
      "turn-02",
      "turn-04",
    ]);
    expect(taps).toEqual([0, 1, 1, 2, 4]);
  });

  it("does not fire for a turn held to the participant's scheduled end", async () => {
    // Each reply takes a minute of the clock. Turn 2 ends the session before the scheduled end,
    // so the loop holds the participant and asks again without a checkpoint. Turn 4's reply
    // comes after the end, and its checkpoint is the last.
    const start = Date.UTC(2026, 9, 12, 9, 0);
    let t = start;
    const replies: CuaTurn[] = [click(1), finished, click(3)];
    const provider: CuaProvider = {
      id: "checkpoint-tap-held",
      capabilities: CAPS,
      async nextTurn() {
        t += MINUTE;
        return replies.shift() ?? click(9);
      },
      async debrief() {
        return {
          actions: [],
          pendingSafetyChecks: [],
          done: true,
          closingReport: { summary: "Worked until the end.", frictionReports: [] },
        };
      },
    };
    const taps: number[] = [];
    const result = await runComputerUseLoopWithTaps({
      instructions: "Work until your session ends.",
      provider,
      executor: {
        observe: async () => ({ screenshot: FRAME, stateSignature: `at-${t}` }),
        execute: async () => undefined,
      },
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 60 * MINUTE,
      now: () => t,
      clock: { end: { atMs: start + 3 * MINUTE + 30_000, windDownMs: MINUTE } },
      onCheckpoint: (turn) => taps.push(turn),
    });

    expect(result.trace.stopCause).toBe("scheduled_end");
    expect(screenshotTitles(result.trace.items)).toEqual([
      "turn-00-start",
      "turn-01",
      "turn-03",
      "turn-04",
    ]);
    expect(taps).toEqual([0, 1, 3, 4]);
  });
});
