import { describe, expect, it } from "vitest";

import type { CuaAction } from "../../../src/actors/computer-use/loop.js";
import {
  DONE,
  MINUTE,
  NEW_ROW,
  QUIET,
  WAIT,
  runWatching,
  turnOf,
  waitItems,
} from "../../helpers/watching-loop.js";

// A participant held to a scheduled end (participants[].endAfterMs) waits for its end as its task.
// On a page that shows new items only after a reload, it reloads an unchanged screen again and
// again, and on any page it may only take screenshots. The fake desktop's screen never changes;
// the injected clock moves only when the loop sleeps, so every request time below is exact.

const RELOAD: CuaAction = { kind: "keypress", keys: ["ctrl", "r"] };
const HOUR = 60 * MINUTE;
/** Held to an end at minute 60, told the time left from minute 55. */
const HELD = { clock: { end: { atMs: HOUR, windDownMs: 5 * MINUTE } } };

const reloads = (executed: readonly CuaAction[]) =>
  executed.filter((action) => action.kind === "keypress").length;

describe("a held participant that reloads an unchanged page", () => {
  it("runs to its scheduled end and passes when it waits between 40 reloads", async () => {
    // Reload, wait, reload, wait. The waits leave the no-progress streak as it was, so on 0.133.1
    // the 21st reload was the 20th repeat on an unchanged screen and ended the session as gave_up.
    const run = await runWatching({
      screen: () => QUIET,
      turn: (_request, n) => turnOf([n % 2 === 1 ? RELOAD : WAIT]),
      loop: { ...HELD, maxWaitMs: MINUTE },
    });
    expect(reloads(run.executed)).toBeGreaterThanOrEqual(40);
    expect(run.result.status).toBe("passed");
    expect(run.result.trace.stopCause).toBe("scheduled_end");
  });

  it("requests no more often than an idle participant past its 20th repeat when it never waits", async () => {
    // Reload 1 is new and reloads 2 to 21 repeat it on an unchanged screen, all at 0 s, since only
    // a watch moves the clock. From the 20th repeat, reload 21, each reload is watched as a wait
    // with no length, so requests 22 onward come when an idle participant's requests 2 onward come.
    // Without the watch the clock never moves, so the script stops reloading after 1,000 requests.
    const reloading = await runWatching({
      screen: () => QUIET,
      turn: (_request, n) => (n <= 1_000 ? turnOf([RELOAD]) : DONE),
      loop: HELD,
    });
    const idle = await runWatching({ screen: () => QUIET, turn: () => turnOf([WAIT]), loop: HELD });
    const at = (run: typeof idle) => run.requests.map((request) => request.at);
    expect(at(reloading).slice(0, 21)).toEqual(Array(21).fill(0));
    expect(at(reloading).slice(20)).toEqual(at(idle));
    expect(reloading.requests[21]?.hint).toBe(
      "The wait after your last action lasted 5 seconds; no change on the screen held still long enough to end it.",
    );
    expect(
      reloading.result.trace.items
        .filter((item) => item.title === "watched the screen")
        .slice(0, 3)
        .map((item) => [item.watch?.limitMs, item.watch?.wake]),
    ).toEqual([
      [5_000, "limit"],
      [10_000, "limit"],
      [20_000, "limit"],
    ]);
    expect(reloading.result.status).toBe("passed");
    expect(reloading.result.trace.stopCause).toBe("scheduled_end");
  });
});

describe("a held participant whose reload brings a new issue", () => {
  it("is woken by the change its reload made, and its streak is recorded as it ends", async () => {
    // A new issue arrives at 300 s and shows after the next reload. Requests 1 to 21 come at 0 s,
    // then 5, 15, 35, 75, 155 and 315 s. The reload sent at 315 s shows the issue; the watch after
    // it compares its looks with the screen the participant reloaded, so the look at 320 s sees the
    // new row and the quick look at 320.5 s sees it still. Reloads 2 to 26 were the streak.
    let seenAt = 0;
    let reloadedAt = -1;
    const run = await runWatching({
      screen: (atMs) => {
        seenAt = atMs;
        return reloadedAt >= 300_000 ? NEW_ROW : QUIET;
      },
      turn: () => {
        reloadedAt = seenAt;
        return turnOf([RELOAD]);
      },
      loop: { clock: { end: { atMs: 10 * MINUTE, windDownMs: MINUTE } } },
    });
    expect(run.requests.slice(20, 28).map((request) => request.at)).toEqual([
      0, 5_000, 15_000, 35_000, 75_000, 155_000, 315_000, 320_500,
    ]);
    expect(run.requests[27]?.observation.screenshot).toBe(NEW_ROW);
    expect(run.requests[27]?.hint).toBe(
      "The wait after your last action lasted 6 seconds and ended when the screen changed.",
    );
    expect(
      run.result.trace.items.find(
        (item) => item.title === "repeated an action on an unchanged screen",
      )?.text,
    ).toBe(
      "25 turns in a row repeated a recent action on an unchanged screen, from 0:00 to 5:15 into the session. The participant is held to its scheduled end, so 20 such turns did not end its session, and from then on the screen was watched after each one before the next request.",
    );
  });

  it("after its first streak, watches each reload that follows one on an unchanged screen", async () => {
    // As above, request 28 at 320.5 s shows the issue, which ended the streak. Reload 28 is sent
    // with no watch; it shows the same screen, so reloads 29 and 30 are watched, for 5 and 10 s.
    // The click at turn 31 opens the issue, and reload 32 after it is sent with no watch, reload 33
    // with one. Without that, each issue the participant saw or opened gave it 20 more requests
    // back to back.
    let seenAt = 0;
    let reloadedAt = -1;
    const run = await runWatching({
      screen: (atMs) => {
        seenAt = atMs;
        return reloadedAt >= 300_000 ? NEW_ROW : QUIET;
      },
      turn: (_request, n) => {
        if (n === 31) return turnOf([{ kind: "click", x: 80, y: 80 }]);
        reloadedAt = seenAt;
        return turnOf([RELOAD]);
      },
      loop: { clock: { end: { atMs: 10 * MINUTE, windDownMs: MINUTE } } },
    });
    expect(run.requests.slice(27, 34).map((request) => request.at)).toEqual([
      320_500, 320_500, 325_500, 335_500, 335_500, 335_500, 340_500,
    ]);
  });
});

describe("a participant with no scheduled end that reloads an unchanged page", () => {
  it.each([
    { end: "no end", loop: {} },
    {
      end: "a session cap",
      loop: {
        clock: { end: { atMs: HOUR, windDownMs: 5 * MINUTE, kind: "session_cap" as const } },
      },
    },
  ])("is ended as gave_up at its 20th repeat with $end", async ({ loop }) => {
    const run = await runWatching({ screen: () => QUIET, turn: () => turnOf([RELOAD]), loop });
    expect(run.requests).toHaveLength(21);
    expect(run.requests.at(-1)?.at).toBe(0);
    expect(run.result.completionReason).toBe("gave_up");
    expect(run.result.trace.counts.noProgressTurns).toBe(20);
  });
});

describe("a held participant whose turns ask for no wait time", () => {
  const notices = (run: Awaited<ReturnType<typeof runWatching>>) =>
    run.result.trace.items.filter((item) => item.title === "watched the screen");

  it("is watched for idleWaitMs at a turn of only a screenshot, and its watches grow", async () => {
    // Without the watch the clock never moves, so the script stops after 1,000 requests.
    const run = await runWatching({
      screen: () => QUIET,
      turn: (_request, n) => (n <= 1_000 ? turnOf([{ kind: "screenshot" }]) : DONE),
      loop: { clock: { end: { atMs: 10 * MINUTE, windDownMs: MINUTE } } },
    });
    expect(run.requests.slice(0, 6).map((request) => request.at)).toEqual([
      0, 5_000, 15_000, 35_000, 75_000, 155_000,
    ]);
    expect(
      notices(run)
        .slice(0, 5)
        .map((item) => [item.watch?.limitMs, item.watch?.wake]),
    ).toEqual([
      [5_000, "limit"],
      [10_000, "limit"],
      [20_000, "limit"],
      [40_000, "limit"],
      [80_000, "limit"],
    ]);
    expect(run.requests[1]?.hint).toBe(
      "The wait before your screenshot lasted 5 seconds; no change on the screen held still long enough to end it.",
    );
    expect(run.result.trace.stopCause).toBe("scheduled_end");
  });

  it("is watched for idleWaitMs at a turn of 0 ms waits, which no longer reach the desktop", async () => {
    const run = await runWatching({
      screen: () => QUIET,
      turn: (_request, n) =>
        n <= 3
          ? turnOf([
              { kind: "wait", ms: 0 },
              { kind: "wait", ms: 0 },
            ])
          : DONE,
      loop: HELD,
    });
    expect(run.executed).toEqual([]);
    expect(waitItems(run.result).map((item) => [item.title, item.watch?.limitMs])).toEqual([
      ["wait 5000ms", 5_000],
      ["wait 0ms", undefined],
      ["wait 10000ms", 10_000],
      ["wait 0ms", undefined],
      ["wait 20000ms", 20_000],
      ["wait 0ms", undefined],
    ]);
    expect(run.requests[1]?.hint).toBe(
      "Your wait lasted 5 seconds; no change on the screen held still long enough to end it.",
    );
  });
});

describe("the trace of a held participant's repeats on an unchanged screen", () => {
  const streaks = (run: Awaited<ReturnType<typeof runWatching>>) =>
    run.result.trace.items
      .filter((item) => item.title === "repeated an action on an unchanged screen")
      .map((item) => [item.status, item.text, item.at]);

  it("records the streak when a new action ends it", async () => {
    // Reloads 2 to 30 repeat reload 1. Reloads 2 to 20 are seen at 0 s; reloads 21 to 30 are
    // watched for 5, 10, 20, 40, 80, 160, 320 and then 600 s at a time, so reload 30 is seen at
    // 2,435 s (40:35). The click at turn 31 is new, which ends the streak of 29.
    const click: CuaAction = { kind: "click", x: 80, y: 80 };
    const run = await runWatching({
      screen: () => QUIET,
      turn: (_request, n) => turnOf([n <= 30 ? RELOAD : n === 31 ? click : WAIT]),
      loop: HELD,
    });
    expect(streaks(run)).toEqual([
      [
        "warn",
        "29 turns in a row repeated a recent action on an unchanged screen, from 0:00 to 40:35 into the session. The participant is held to its scheduled end, so 20 such turns did not end its session, and from then on the screen was watched after each one before the next request.",
        new Date(2_435_000).toISOString(),
      ],
    ]);
  });

  it("records the streak the session ends in", async () => {
    // Reloads 2 to 20 are seen at 0 s. Watches of 5, 10, 20 and 40 s show reload 24 at 75 s; the
    // wind-down at 90 s ends the next one, so reload 25 is seen at 90 s, and watches start again at
    // 5 and 10 s: reload 27 is seen at 105 s (1:45). The end at 120 s ends reload 28's watch.
    const run = await runWatching({
      screen: () => QUIET,
      turn: () => turnOf([RELOAD]),
      loop: { clock: { end: { atMs: 2 * MINUTE, windDownMs: 30_000 } } },
    });
    expect(streaks(run)).toEqual([
      [
        "warn",
        "26 turns in a row repeated a recent action on an unchanged screen, from 0:00 to 1:45 into the session. The participant is held to its scheduled end, so 20 such turns did not end its session, and from then on the screen was watched after each one before the next request.",
        new Date(2 * MINUTE).toISOString(),
      ],
    ]);
    expect(run.result.trace.stopCause).toBe("scheduled_end");
  });

  it("records nothing for a participant with no scheduled end, whose streak ends its session", async () => {
    const run = await runWatching({ screen: () => QUIET, turn: () => turnOf([RELOAD]) });
    expect(run.result.completionReason).toBe("gave_up");
    expect(streaks(run)).toEqual([]);
  });
});
