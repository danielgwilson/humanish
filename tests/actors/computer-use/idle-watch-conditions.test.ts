import { describe, expect, it } from "vitest";

import {
  DONE,
  MINUTE,
  QUIET,
  WAIT,
  runWatching,
  turnOf,
  waitItems,
  watchesOf,
} from "../../helpers/watching-loop.js";

// What else ends a watch besides a change: the participant's wind-down and end, the session
// deadline, speech, a study condition, the study budget and a stalled look. The fake desktop shows
// a static screen; the injected clock moves only when the loop sleeps.

const LONG_WAIT = turnOf([{ kind: "wait", ms: 60_000 }]);
/** A capped session stops on a reply without usage, so these replies report some. */
const withUsage = (turn: ReturnType<typeof turnOf>) => ({
  ...turn,
  usage: { input: 10, output: 2 },
});

describe("a watch and the participant's clock", () => {
  it.each([
    { deadline: "after the end", timeoutMs: 2 * 60 * MINUTE },
    { deadline: "at the end", timeoutMs: 60 * MINUTE },
  ])(
    "wakes once at the wind-down, and ends at the end with no look after it, deadline $deadline",
    async ({ timeoutMs }) => {
      // Watches grow 5 s, 10 s, ... to 1,280 s ending at 2,555 s. The next one, capped at 30 min,
      // is cut by the wind-down at 50 min (3,000 s). From there they start again at 5 s and grow
      // to 3,315 s; the one that would last 320 s is cut by the end at 60 min (3,600 s).
      const run = await runWatching({
        screen: () => QUIET,
        turn: () => turnOf([WAIT]),
        loop: {
          timeoutMs,
          maxWaitMs: 30 * MINUTE,
          idleSteps: 1,
          clock: { end: { atMs: 60 * MINUTE, windDownMs: 10 * MINUTE } },
        },
      });
      const watches = watchesOf(run.result).map((watch) => [watch.limitMs, watch.wake]);
      expect(watches.filter(([, wake]) => wake === "clock")).toEqual([
        [30 * MINUTE, "clock"],
        [320_000, "clock"],
      ]);
      expect(watches[10]).toEqual([5_000, "limit"]);
      const atWindDown = run.requests.find((request) => request.at === 50 * MINUTE);
      // The wait's length comes first, then the clock text that says why it ended.
      expect(atWindDown?.hint).toBe(
        "Your wait lasted 7 minutes. Your session ends at 01:00 UTC, in 10 minutes. Keep working until then. The session ends by itself at that time, and you will then be asked for your closing account.",
      );
      expect(Math.max(...run.observes)).toBeLessThan(60 * MINUTE);
      expect(run.result.trace.stopCause).toBe("scheduled_end");
      expect(run.result.completionReason).toBe("goal_satisfied");
    },
  );
});

describe("a watch and the backstops", () => {
  it("ends a capped participant on an unchanged screen at its 21st identical wait", async () => {
    // A session cap holds no one, so watched waits count toward the backstops. The first wait is
    // new; waits 2 to 21 repeat it on an unchanged screen, the 20 no-progress turns that trip
    // noProgressSteps (20) before idleSteps (24). Watches grow 5 s to 320 s and then last 600 s:
    // the 21st request goes at 635 s + 13 x 600 s = 8,435 s, before the cap's wind-down.
    const run = await runWatching({
      screen: () => QUIET,
      turn: () => turnOf([WAIT]),
      loop: {
        timeoutMs: 4 * 60 * MINUTE,
        clock: { end: { atMs: 3 * 60 * MINUTE, windDownMs: MINUTE, kind: "session_cap" } },
      },
    });
    expect(run.requests).toHaveLength(21);
    expect(run.requests.at(-1)?.at).toBe(8_435_000);
    expect(run.result.completionReason).toBe("gave_up");
    expect(run.result.trace.counts.noProgressTurns).toBe(20);
  });
});

describe("a watch and a host timer that fires early", () => {
  it("ends at the participant's end when its sleep returns 1 ms before it", async () => {
    // Every sleep returns 1 ms early, so the looks run at 4,999, 9,999 and 14,999 ms and the
    // watch's schedule reaches the cap at 20 s while the clock reads 19,999 ms.
    const run = await runWatching({
      screen: () => QUIET,
      sleepEarlyMs: 1,
      turn: (_request, n) => (n === 1 ? LONG_WAIT : DONE),
      loop: { clock: { end: { atMs: 20_000, windDownMs: 30_000, kind: "session_cap" } } },
    });
    expect(run.observes).toEqual([0, 4_999, 9_999, 14_999]);
    expect(run.requests).toHaveLength(1);
    expect(run.result.trace.stopCause).toBe("session_cap");
  });
});

describe("a watch and what the participant hears and the study watches for", () => {
  it("wakes on speech that arrives only with one look, and the next request carries it", async () => {
    const utterance = {
      id: "u1",
      source: "speaker_audio" as const,
      text: "Are you there?",
      durationMs: 900,
    };
    const run = await runWatching({
      screen: () => QUIET,
      executor: { speechEnabled: true },
      observe: (atMs) => (atMs === 10_000 ? { heardSpeech: [utterance] } : {}),
      turn: (_request, n) => (n === 1 ? LONG_WAIT : DONE),
    });
    expect(watchesOf(run.result).map((watch) => watch.wake)).toEqual(["speech"]);
    expect(run.requests[1]?.at).toBe(10_000);
    expect(run.requests[1]?.observation.heardSpeech).toEqual([utterance]);
    expect(run.requests[1]?.hint).toBe(
      "Your wait lasted 10 seconds and ended when you heard speech.",
    );
  });

  it("looks at most every 30 s on a desktop with speech, whatever idleWaitMs says", async () => {
    const run = await runWatching({
      screen: () => QUIET,
      executor: { speechEnabled: true },
      turn: (_request, n) => (n === 1 ? turnOf([WAIT]) : DONE),
      loop: { idleWaitMs: 60_000, maxWaitMs: 120_000 },
    });
    expect(run.observes).toEqual([0, 30_000, 60_000]);
  });

  it("ends on a stopWhen URL that a look sees with no pixel change, and the session stops", async () => {
    const run = await runWatching({
      screen: () => QUIET,
      observe: (atMs) => ({
        url: atMs >= 15_000 ? "https://app.test/done" : "https://app.test/queue",
      }),
      turn: () => LONG_WAIT,
      loop: { stopWhen: { any: [{ urlIncludes: "/done" }] } },
    });
    expect(watchesOf(run.result).map((watch) => watch.wake)).toEqual(["condition"]);
    expect(run.requests).toHaveLength(1);
    expect(run.result.completionReason).toBe("goal_satisfied");
    expect(run.result.reason).toBe("stopWhen matched rule-01 (urlIncludes)");
  });

  it("leaves a look matching both a dwell trigger and stopWhen to the checkpoint's order: dwell first", async () => {
    // The look at 10 s is on /ready; the page moves on during the 20 s dwell, so stopWhen, read on
    // the frame after the dwell, does not match and the participant continues.
    const run = await runWatching({
      screen: () => QUIET,
      observe: (atMs) => ({
        url: `https://app.test/${atMs < 10_000 ? "queue" : atMs === 10_000 ? "ready" : "gone"}`,
      }),
      turn: (_request, n) => (n === 1 ? LONG_WAIT : DONE),
      loop: {
        stopWhen: { any: [{ urlIncludes: "/ready" }] },
        dwell: {
          when: { any: [{ urlIncludes: "/ready" }] },
          ms: 20_000,
          everyMs: 10_000,
          then: "continue",
        },
      },
    });
    expect(watchesOf(run.result).map((watch) => watch.wake)).toEqual(["condition"]);
    expect(run.result.trace.items.map((item) => item.title)).toContain("dwell window complete");
    expect(run.requests).toHaveLength(2);
    expect(run.requests[1]?.hint).toMatch(
      /^Your wait lasted 10 seconds and ended when the page changed\. You stayed on this page for 20 seconds/,
    );
  });

  it("ends on a dwell trigger only one look sees, and the checkpoint holds the page", async () => {
    const run = await runWatching({
      screen: () => QUIET,
      observe: (atMs) => ({ url: `https://app.test/${atMs === 10_000 ? "ready" : "queue"}` }),
      turn: (_request, n) => (n === 1 ? LONG_WAIT : DONE),
      loop: {
        dwell: {
          when: { any: [{ urlIncludes: "/ready" }] },
          ms: 20_000,
          everyMs: 10_000,
          then: "continue",
        },
      },
    });
    expect(watchesOf(run.result).map((watch) => watch.wake)).toEqual(["condition"]);
    expect(run.result.trace.items.map((item) => item.title)).toContain("dwell window complete");
  });

  it("ends on a task that only one look satisfies, and keeps that look as the turn's screenshot", async () => {
    const run = await runWatching({
      screen: () => QUIET,
      observe: (atMs) => (atMs === 15_000 ? { text: "Ticket closed" } : { text: "Ticket open" }),
      turn: (_request, n) => (n === 1 ? LONG_WAIT : DONE),
      loop: {
        tasks: [
          {
            id: "close",
            goal: "Close the ticket.",
            success: { any: [{ textIncludes: "closed" }] },
          },
        ],
      },
    });
    expect(watchesOf(run.result).map((watch) => watch.wake)).toEqual(["condition"]);
    expect(run.result.trace.taskFunnel?.completed).toBe(1);
    expect(run.requests[1]?.at).toBe(15_000);
    expect(run.requests[1]?.observation.text).toBe("Ticket closed");
  });

  it("hands every look's URL to the URL tap and only the waking look's frame to the frame tap", async () => {
    const urls: Array<string | undefined> = [];
    let frames = 0;
    await runWatching({
      screen: () => QUIET,
      observe: (atMs) => ({ url: `https://app.test/at/${atMs}` }),
      turn: (_request, n) => (n === 1 ? turnOf([{ kind: "wait", ms: 20_000 }]) : DONE),
      loop: {
        onObservedUrl: (url) => urls.push(url),
        onScreenshot: () => {
          frames += 1;
        },
      },
    });
    // The opening observation, then looks at 5, 10, 15 and 20 s; the last one ends the watch.
    expect(urls).toEqual(
      [0, 5_000, 10_000, 15_000, 20_000].map((at) => `https://app.test/at/${at}`),
    );
    expect(frames).toBe(2);
  });
});

describe("a watch that the session ends", () => {
  it("stops with budget_reached at the look that finds the study budget gone", async () => {
    let gone = false;
    const run = await runWatching({
      screen: (atMs) => {
        gone = atMs >= 12_000;
        return QUIET;
      },
      turn: () => withUsage(LONG_WAIT),
      loop: { overRunBudget: () => (gone ? "the study budget is spent" : null) },
    });
    expect(watchesOf(run.result).map((watch) => [watch.wake, watch.looks])).toEqual([
      ["stopped", 3],
    ]);
    expect(run.requests).toHaveLength(1);
    expect(run.result.completionReason).toBe("budget_reached");
  });

  it("keeps the look that completed a task as the turn's screenshot when the budget runs out at it", async () => {
    // The look at 15 s shows the ticket closed and finds the study budget gone. The task funnel
    // counts the completion, so the frame that shows it is persisted before the session stops.
    let gone = false;
    const run = await runWatching({
      screen: (atMs) => {
        gone = atMs >= 15_000;
        return QUIET;
      },
      observe: (atMs) => ({ text: atMs >= 15_000 ? "Ticket closed" : "Ticket open" }),
      turn: () => withUsage(LONG_WAIT),
      loop: {
        overRunBudget: () => (gone ? "the study budget is spent" : null),
        tasks: [
          {
            id: "close",
            goal: "Close the ticket.",
            success: { any: [{ textIncludes: "closed" }] },
          },
        ],
      },
    });
    expect(run.requests).toHaveLength(1);
    expect(run.result.completionReason).toBe("budget_reached");
    expect(run.result.trace.taskFunnel?.completed).toBe(1);
    expect(
      run.result.trace.items.filter((item) => item.kind === "screenshot").map((item) => item.title),
    ).toEqual(["turn-00-start", "turn-01"]);
  });

  it("sends no request when the budget runs out after the watch's last look", async () => {
    // After the look at 5 s the budget is checked twice: at the look, with budget left, and
    // before request 2, when it is gone.
    let looked = false;
    let checksSinceLook = 0;
    const run = await runWatching({
      screen: (atMs) => {
        looked = atMs > 0;
        return QUIET;
      },
      turn: () => withUsage(turnOf([WAIT])),
      loop: {
        overRunBudget: () =>
          looked && (checksSinceLook += 1) >= 2 ? "the study budget is spent" : null,
      },
    });
    expect(run.requests).toHaveLength(1);
    expect(watchesOf(run.result).map((watch) => watch.wake)).toEqual(["limit"]);
    expect(run.result.completionReason).toBe("budget_reached");
  });

  it("sends none of the turn's screenshot actions to the desktop after it reaches the end", async () => {
    // The turn takes a screenshot and waits 10 s; the session cap at 7 s ends the watch, so the
    // wait is recorded for the 7 s it lasted and the screenshot is never sent.
    const run = await runWatching({
      screen: () => QUIET,
      turn: () => turnOf([{ kind: "screenshot" }, { kind: "wait", ms: 10_000 }]),
      loop: { clock: { end: { atMs: 7_000, windDownMs: 30_000, kind: "session_cap" } } },
    });
    expect(run.executed).toEqual([]);
    expect(waitItems(run.result).map((item) => [item.title, item.watch?.wake])).toEqual([
      ["wait 7000ms", "clock"],
    ]);
    expect(run.result.trace.stopCause).toBe("session_cap");
  });

  it("ends with a stalled look, and the next observation is a fresh one", async () => {
    let observe = 0;
    const run = await runWatching({
      screen: () => QUIET,
      // The look at 5 s and its retry never answer; the checkpoint's observation does.
      observe: () => ((observe += 1) === 2 || observe === 3 ? "hang" : {}),
      turn: (_request, n) => (n === 1 ? LONG_WAIT : DONE),
      loop: { observationTimeoutMs: 20 },
    });
    expect(watchesOf(run.result).map((watch) => watch.wake)).toEqual(["stalled"]);
    expect(observe).toBe(4);
    expect(run.requests[1]?.hint).toBe(
      "Your wait lasted 5 seconds; the screen could not be checked during it.",
    );
  });
});
