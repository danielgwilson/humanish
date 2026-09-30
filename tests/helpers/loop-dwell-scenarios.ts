import {
  FRAME,
  click,
  done,
  framed,
  scriptedProvider,
  sequenceExecutor,
  turn,
  type LoopScenario,
} from "./loop-golden.js";

// The dwell-window scenarios of the harness-stops golden, kept apart so the edge-golden test
// file stays readable. Their keys are spread into that golden in this order.

const clockWithSleep = () => {
  let t = 0;
  return {
    now: () => (t += 1),
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

/**
 * A clock and sleep for dwell scenarios that also tell where an observe call falls: the first
 * observe after a sleep is a window frame, the second is the observation right after the window.
 */
function dwellWatch() {
  let t = 0;
  let observesSinceSleep = Number.POSITIVE_INFINITY;
  /** Call once per observe. */
  const place = (): "frame" | "after window" | "outside" => {
    observesSinceSleep += 1;
    if (observesSinceSleep === 1) return "frame";
    return observesSinceSleep === 2 ? "after window" : "outside";
  };
  return {
    now: () => (t += 1),
    sleep: async (ms: number) => {
      t += ms;
      observesSinceSleep = 0;
    },
    place,
    /** Call once per observe; true for the observation taken right after the window. */
    afterWindow: () => place() === "after window",
  };
}

export const dwellScenarios: Record<string, LoopScenario> = {
  dwellContinue: (probe) => ({
    provider: scriptedProvider(probe, [turn({ actions: [click(1, 1)] }), done("Finished.")]),
    executor: sequenceExecutor(probe, [
      { screenshot: FRAME, stateSignature: "a", text: "intro" },
      { screenshot: FRAME, stateSignature: "b", text: "video playing" },
    ]),
    options: {
      ...clockWithSleep(),
      dwell: {
        when: { any: [{ textIncludes: "video" }] },
        ms: 100,
        everyMs: 40,
        then: "continue",
      },
    },
  }),
  dwellStopAtStart: (probe) => ({
    provider: scriptedProvider(probe, []),
    executor: sequenceExecutor(probe, framed("a")),
    options: { ...clockWithSleep(), dwell: { ms: 60, everyMs: 30, then: "stop" } },
  }),
  dwellSkipped: (probe) => ({
    provider: scriptedProvider(probe, [done("Finished.")]),
    executor: sequenceExecutor(probe, framed("a")),
    options: {
      ...clockWithSleep(),
      timeoutMs: 50,
      dwell: { ms: 500, everyMs: 100, then: "stop" },
    },
  }),
  dwellFramelessAfterWindow: (probe) => {
    const watch = dwellWatch();
    return {
      provider: scriptedProvider(probe, [done("Finished.")], { requiresFrame: true }),
      executor: sequenceExecutor(probe, [
        () => (watch.afterWindow() ? { stateSignature: "a" } : framed("a")[0]!),
      ]),
      options: {
        now: watch.now,
        sleep: watch.sleep,
        dwell: { ms: 20, everyMs: 10, then: "continue" },
      },
    };
  },
  dwellAppStateAfterWindow: (probe) => {
    const watch = dwellWatch();
    return {
      provider: scriptedProvider(probe, [done("Finished.")]),
      executor: sequenceExecutor(probe, [
        () =>
          watch.afterWindow()
            ? { stateSignature: "a", appState: { route: "/after-window" } }
            : { stateSignature: "a" },
      ]),
      options: {
        now: watch.now,
        sleep: watch.sleep,
        dwell: { ms: 20, everyMs: 10, then: "continue" },
      },
    };
  },
  dwellAppStateInsideWindow: (probe) => {
    const watch = dwellWatch();
    return {
      provider: scriptedProvider(probe, [done("Finished.")]),
      executor: sequenceExecutor(probe, [
        () =>
          watch.place() === "frame"
            ? { stateSignature: "a", appState: { route: "/in-window" } }
            : { stateSignature: "a" },
      ]),
      options: {
        now: watch.now,
        sleep: watch.sleep,
        dwell: { ms: 20, everyMs: 10, then: "continue" },
      },
    };
  },
  dwellHintWithBackstopHint: (probe) => {
    const watch = dwellWatch();
    let observes = 0;
    return {
      provider: scriptedProvider(probe, [
        turn({ actions: [click(1, 1)] }),
        turn({ actions: [click(1, 1)] }),
        done("Finished."),
      ]),
      executor: sequenceExecutor(probe, [
        () => {
          watch.afterWindow();
          observes += 1;
          return {
            screenshot: FRAME,
            stateSignature: "a",
            ...(observes === 3 ? { text: "video" } : {}),
          };
        },
      ]),
      options: {
        now: watch.now,
        sleep: watch.sleep,
        noProgressSteps: 2,
        dwell: {
          when: { any: [{ textIncludes: "video" }] },
          ms: 20,
          everyMs: 10,
          then: "continue",
        },
      },
    };
  },
};
