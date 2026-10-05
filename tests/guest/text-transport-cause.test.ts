import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runComputerUseLoop,
  type CuaProvider,
  type CuaTurn,
} from "../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../src/evidence/redaction.js";
import { createGuestBrowserTools } from "../../src/guest/browser-tools.js";
import { createGuestDesktopExecutor } from "../../src/guest/desktop-executor.js";
import type { GuestDesktopNativeTools } from "../../src/guest/desktop-native.js";
import { setup } from "../browser-control/fixture.js";
import { cleanupPorts, fixture } from "../helpers/chromium-text-port.js";

afterEach(cleanupPorts);

const WIDTH = 960,
  HEIGHT = 720;
const CDP_FAILURE = "Protocol error (Input.insertText): Target closed.";

/** A participant that types six characters into a combobox search field. */
const typingParticipant: CuaProvider = {
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
  nextTurn: async (): Promise<CuaTurn> => ({
    actions: [{ kind: "type", text: "Acme H" }],
    pendingSafetyChecks: [],
    done: false,
  }),
};

/** Runs one type action whose Input.insertText throws `failure`, through the guest wire. */
async function typeThrough(failure: Error) {
  const text = fixture();
  const answer = text.send.getMockImplementation()!;
  text.send.mockImplementation(async (method, params) => {
    if (method === "Input.insertText") throw failure;
    return answer(method, params);
  });
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
  try {
    const result = await runComputerUseLoop({
      instructions: "Pick a provider from the list.",
      provider: typingParticipant,
      executor: wire.client.executor,
      persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
      redaction: defaultRedactionHooks,
      now: Date.now,
      timeoutMs: 20_000,
      writeScreenshot: async (name: string) => `screenshots/${name}`,
    });
    // What the guest sent the host: every reply frame, as text.
    const replies = Buffer.concat(wire.rightWrites).toString("utf8");
    return { result, replies };
  } finally {
    wire.close();
    authority.abort();
  }
}

describe("a local participant whose typed text fails in the browser", () => {
  it("records the failing step and a fixed category in the trace and the session reason", async () => {
    const { result } = await typeThrough(new Error(CDP_FAILURE));
    const cause =
      "cause: insert_text, target_closed: the page, its browser context or the browser closed while inserting text (Input.insertText)";
    expect(result.completionReason).toBe("harness_error");
    expect(result.reason).toBe(
      `desktop executor error: transport_failed; disposition: outcome_uncertain; ${cause}`,
    );
    const failure = result.trace.items.find((item) => item.title === "desktop executor error");
    expect(failure?.text).toContain(cause);
    expect(JSON.stringify(result.trace)).not.toContain("Protocol error");
  });

  it.each([
    [
      "a form value",
      "locator.fill: strict mode violation: locator('input[value=\"Alice Jones\"]') resolved to 2 elements",
      "Alice Jones",
      "unknown",
    ],
    [
      "a cookie pair",
      "Protocol error (Input.insertText): session_cookie=abc123PrivateValue",
      "abc123PrivateValue",
      "protocol_error",
    ],
    [
      "a file path",
      "ENOENT: no such file or directory, open '/mnt/records/Alice-Jones.txt'",
      "/mnt/records",
      "unknown",
    ],
  ])(
    "sends and records only the two fixed words when the message holds %s",
    async (_kind, message, privateText, category) => {
      const { result, replies } = await typeThrough(new Error(message));
      expect(replies).toContain(`"diagnostic":{"step":"insert_text","category":"${category}"}`);
      expect(replies).not.toContain(privateText);
      expect(result.reason).toContain(`cause: insert_text, ${category}:`);
      expect(JSON.stringify(result)).not.toContain(privateText);
    },
  );
});
