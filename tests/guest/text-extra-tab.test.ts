import type { Page } from "playwright-core";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runComputerUseLoop,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest,
} from "../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../src/evidence/redaction.js";
import { createGuestBrowserTools } from "../../src/guest/browser-tools.js";
import { createGuestDesktopExecutor } from "../../src/guest/desktop-executor.js";
import type { GuestDesktopNativeTools } from "../../src/guest/desktop-native.js";
import { setup } from "../browser-control/fixture.js";
import { cleanupPorts, fixture, inserts } from "../helpers/chromium-text-port.js";

afterEach(cleanupPorts);

const WIDTH = 960,
  HEIGHT = 720;

/** A participant that types once, then ends on its next request. */
function typingParticipant(requests: CuaTurnRequest[]): CuaProvider {
  return {
    id: "fixture",
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: true,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "open",
    },
    nextTurn: async (req): Promise<CuaTurn> => {
      requests.push(req);
      return requests.length === 1
        ? { actions: [{ kind: "type", text: "Hello" }], pendingSafetyChecks: [], done: false }
        : {
            actions: [],
            pendingSafetyChecks: [],
            done: true,
            outcome: "reached",
            message: "Done.",
          };
    },
  };
}

describe("typing on a local desktop while a second tab is open", () => {
  it("says the extra tab is why the text was refused, across the guest wire to the participant", async () => {
    const text = fixture();
    // The participant opened a second tab, for example the study inbox.
    text.pages.push({} as Page);
    const frame = PNG.sync.write(new PNG({ width: WIDTH, height: HEIGHT }));
    const native: GuestDesktopNativeTools = {
      input: vi.fn(async () => {}),
      capture: vi.fn(async () => frame),
      activeWindowId: vi.fn(async () => "owned-window"),
      typeAscii: vi.fn(async () => {}),
    };
    const authority = new AbortController();
    const guest = createGuestDesktopExecutor({
      width: WIDTH,
      height: HEIGHT,
      tools: createGuestBrowserTools(native, text.port),
      authoritySignal: authority.signal,
      onTerminal: vi.fn(),
    });
    const wire = setup({ executor: guest, timeoutMs: 5_000 });
    const requests: CuaTurnRequest[] = [];
    try {
      const result = await runComputerUseLoop({
        instructions: "Read the code in the inbox tab, then type a message in the app.",
        provider: typingParticipant(requests),
        executor: wire.client.executor,
        persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
        redaction: defaultRedactionHooks,
        now: Date.now,
        timeoutMs: 20_000,
        writeScreenshot: async (name: string) => `screenshots/${name}`,
      });

      expect(result.completionReason).toBe("goal_satisfied");
      const rejected = result.trace.items.filter(
        (item) => item.title === "action rejected before dispatch",
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.text).toContain("reason: extra_tab");
      expect(requests[1]?.contextHint).toMatch(/more than one browser tab is open/);
      expect(text.newCDPSession).not.toHaveBeenCalled();
      expect(inserts(text)).toHaveLength(0);
    } finally {
      wire.close();
      authority.abort();
    }
  });
});
