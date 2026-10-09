// When each participant starts: the plan's simulation of the start queue, and the runtime that
// waits for each participant's time and a free slot. Time is the external dependency, so the
// runtime cases run on vitest's fake clock with a sleep that uses it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planArrivals, runOnSchedule } from "../../src/study/arrivals.js";

const S = 1_000;

describe("planArrivals", () => {
  it("spreads eight participants 30 s apart with 2-minute sessions to at most 4 at once", () => {
    const offsets = [0, 30, 60, 90, 120, 150, 180, 210].map((s) => s * S);
    expect(planArrivals(offsets, { slots: 8, sessionMs: 120 * S })).toEqual({
      declared: true,
      firstStartMs: 0,
      lastStartMs: 210 * S,
      peak: 4,
      waiting: 0,
      longestWaitMs: 0,
      lastEndMs: 330 * S,
      sessionMs: 120 * S,
    });
  });

  it("holds participants whose time comes while every slot is busy until one frees", () => {
    const plan = planArrivals([0, 10 * S, 20 * S, 30 * S], { slots: 2, sessionMs: 100 * S });
    expect(plan.peak).toBe(2);
    expect(plan.waiting).toBe(2);
    // The third starts when the first ends at 100 s, 80 s after its time; the fourth at 110 s.
    expect(plan.longestWaitMs).toBe(80 * S);
    expect(plan.lastEndMs).toBe(210 * S);
  });

  it("reads a roster without offsets as every participant at once, in waves past the slots", () => {
    const plan = planArrivals([undefined, undefined, undefined], { slots: 2, sessionMs: 60 * S });
    expect(plan).toEqual({
      declared: false,
      firstStartMs: 0,
      lastStartMs: 0,
      peak: 2,
      waiting: 1,
      longestWaitMs: 60 * S,
      lastEndMs: 120 * S,
      sessionMs: 60 * S,
    });
  });

  it("keeps a host on a slot of its own and queues the others on the rest", () => {
    // Host first, then three followers due at once on the two remaining slots.
    const plan = planArrivals([0, 0, 0, 0], { slots: 3, sessionMs: 100 * S, ownSlot: 0 });
    expect(plan.peak).toBe(3);
    expect(plan.waiting).toBe(1);
    expect(plan.lastEndMs).toBe(200 * S);
  });
});

describe("runOnSchedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A sleep on the faked global timers, which an abort ends early.
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });

  it("starts each participant at its time, in schedule order, and returns results in roster order", async () => {
    const anchor = Date.now();
    const started: string[] = [];
    const running = runOnSchedule(
      ["late", "first", "middle"],
      {
        startAfterMs: (item) => ({ late: 60 * S, first: 0, middle: 30 * S })[item],
        slots: 3,
        sleep,
      },
      async (item, index, slot) => {
        started.push(`${item}@${(Date.now() - anchor) / S}s#${slot.order}`);
        expect(slot.scheduledAt - anchor).toBe({ late: 60 * S, first: 0, middle: 30 * S }[item]);
        return `${item}:${index}`;
      },
    );
    await vi.advanceTimersByTimeAsync(60 * S);
    expect(await running).toEqual(["late:0", "first:1", "middle:2"]);
    expect(started).toEqual(["first@0s#0", "middle@30s#1", "late@60s#2"]);
  });

  it("makes a participant whose time comes while every slot is busy wait for the next free one", async () => {
    const anchor = Date.now();
    const startedAt: number[] = [];
    const running = runOnSchedule(
      [0, 0, 10 * S],
      { startAfterMs: (offset) => offset, slots: 2, sleep },
      async (_offset, index) => {
        startedAt[index] = Date.now() - anchor;
        await sleep(100 * S);
      },
    );
    await vi.advanceTimersByTimeAsync(200 * S);
    await running;
    expect(startedAt).toEqual([0, 0, 100 * S]);
  });

  it("wakes a participant waiting for a later time when the run stops early", async () => {
    const anchor = Date.now();
    const stop = new AbortController();
    const calledAt: number[] = [];
    const running = runOnSchedule(
      [0, 3 * 60 * 60 * S],
      { startAfterMs: (offset) => offset, slots: 2, sleep, signal: stop.signal },
      async (_offset, index) => {
        calledAt[index] = Date.now() - anchor;
        if (index === 0) {
          await sleep(5 * S);
          stop.abort();
        }
      },
    );
    await vi.advanceTimersByTimeAsync(10 * S);
    await running;
    expect(calledAt).toEqual([0, 5 * S]);
  });
});
