// Two ways the harness stopped seeing a working participant, both found by real runs.
//
// #393: inside a scroll-pinned (scrollytelling) section the viewport stays visually fixed while
// the participant advances, so the frame hash read "no change" and the no-progress backstop ended
// working reading sessions as gave_up — three live lanes died this way in one day. Scroll position
// is state: it rides the progress key, bucketed.
//
// Tab pinning: the CDP state observer selected the LAUNCH tab forever, so a verification link
// opening in a new tab left the observed URL frozen — stopWhen and task criteria went blind, and a
// live funnel read "reach-dashboard 0/2" under a screenshot OF the dashboard. The state observer
// now follows the participant's active tab; the geometry observer keeps its launch-window pin.

import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { ActorCapabilities, ActorPersonaRef } from "../src/actor-contract.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaExecutor,
  type CuaObservation,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest
} from "../src/computer-use.js";
import { makeChromeBrowserStateObserver, makeChromeDesktopGeometryObserver } from "../src/cua-actor-lab.js";
import type { E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import { createE2BDesktopExecutor, type E2BDesktopLike } from "../src/e2b-desktop-executor.js";
import { defaultRedactionHooks } from "../src/redaction.js";

const FAKE_CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};

const persona: ActorPersonaRef = { id: "reader", traitsApplied: [], promptDigest: "abc123def456" };

function frame(): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < 64 * 64; i += 1) {
    const o = i * 4;
    png.data[o] = 128;
    png.data[o + 1] = 128;
    png.data[o + 2] = 128;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

class RepeatScrollProvider implements CuaProvider {
  readonly id = "fake-cua";
  readonly version = "fake-1";
  readonly capabilities = FAKE_CAPS;
  async nextTurn(_req: CuaTurnRequest): Promise<CuaTurn> {
    // The same bucketed fingerprint every turn — exactly what reading a long page looks like.
    return { actions: [{ kind: "scroll", x: 640, y: 400, dx: 0, dy: 300 }], pendingSafetyChecks: [], done: false };
  }
}

function scrollingExecutor(scrollYFor: (observeIndex: number) => number | undefined): CuaExecutor & { observes: number } {
  const staticFrame = frame();
  const executor = {
    observes: 0,
    async observe(): Promise<CuaObservation> {
      const scrollY = scrollYFor(executor.observes);
      executor.observes += 1;
      // The PINNED frame: identical signature every time, like a scrollytelling section.
      return { screenshot: staticFrame, stateSignature: "pinned", ...(scrollY === undefined ? {} : { scrollY }) };
    },
    async execute(_action: CuaAction): Promise<void> {}
  };
  return executor;
}

function monotonicClock(step = 1000): () => number {
  let t = 0;
  return () => (t += step);
}

describe("scroll position is state (#393)", () => {
  it("a participant scrolling through a pinned section is never ended as gave_up", async () => {
    // scrollY advances 300px per observation — every observation crosses a progress bucket.
    const executor = scrollingExecutor((index) => index * 300);
    const result = await runComputerUseLoop({
      instructions: "Read the whole page.",
      provider: new RepeatScrollProvider(),
      executor,
      persona,
      redaction: defaultRedactionHooks,
      // The wall clock is the honest stop for a long read; 40 fake seconds ≈ 38 turns, roughly
      // double the no-progress backstop, so the old behavior would have tripped long before this.
      timeoutMs: 40_000,
      now: monotonicClock()
    });

    expect(result.completionReason).toBe("budget_reached");
    expect(result.reason).not.toContain("gave up");
    expect(result.trace.counts.noProgressTurns ?? 0).toBe(0);
  });

  it("still ends a participant nudging a dead panel — sub-bucket jiggle is not progress", async () => {
    // scrollY wiggles within one 200px bucket forever: same key, same fingerprint, honest gave_up.
    const executor = scrollingExecutor((index) => (index % 2) * 40);
    const result = await runComputerUseLoop({
      instructions: "Read the whole page.",
      provider: new RepeatScrollProvider(),
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    expect(result.completionReason).toBe("gave_up");
    expect(result.reason).toContain("no change to the UI state");
  });
});

describe("the state observer follows the participant's active tab", () => {
  function captureScript(): { commands: string[]; desktop: E2BDesktopSandbox } {
    const commands: string[] = [];
    const desktop = {
      commands: {
        run: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, stdout: "{}" };
        }
      },
      screenshot: async () => new Uint8Array(PNG.sync.write(new PNG({ width: 4, height: 4 })))
    } as unknown as E2BDesktopSandbox;
    return { commands, desktop };
  }

  it("selects the most-recently-active page target, not the launch tab", async () => {
    const { commands, desktop } = captureScript();
    await makeChromeBrowserStateObserver(desktop, 1000, { targetUrl: "http://127.0.0.1:3000/" }, "launch-target-id")();
    expect(commands).toHaveLength(1);
    // Chrome's /json lists page targets most-recently-focused first; the participant's current
    // tab is the head. The launch target survives only as the fallback.
    expect(commands[0]).toContain("const page = httpPages[0] ||");
  });

  it("keeps the geometry observer pinned to the launch window", async () => {
    const { commands, desktop } = captureScript();
    await makeChromeDesktopGeometryObserver(desktop, 1000, { targetUrl: "http://127.0.0.1:3000/" }, "launch-target-id")();
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain("const page = httpPages[0] ||");
    expect(commands[0]).toContain("expectedTargetId");
  });

  it("parses scrollY from the observer and stamps it onto the observation", async () => {
    const desktop = {
      commands: {
        run: async () => ({ exitCode: 0, stdout: JSON.stringify({ url: "http://127.0.0.1:3000/docs", title: "Docs", text: "hello", scrollY: 1234.5 }) })
      },
      screenshot: async () => new Uint8Array(PNG.sync.write(new PNG({ width: 4, height: 4 })))
    } as unknown as E2BDesktopSandbox;
    const observe = makeChromeBrowserStateObserver(desktop, 1000, { targetUrl: "http://127.0.0.1:3000/" });
    const state = await observe();
    expect(state.scrollY).toBe(1234.5);

    const executor = createE2BDesktopExecutor(desktop as unknown as E2BDesktopLike, { observeBrowserState: observe });
    const observation = await executor.observe();
    expect(observation.scrollY).toBe(1234.5);
  });
});
