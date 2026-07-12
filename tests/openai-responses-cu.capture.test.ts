import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CuaObservation, CuaTurnRequest } from "../src/computer-use.js";
import {
  WIRE_CAPTURE_ENV,
  createOpenAiResponsesProvider,
  redactWireJson,
  wireCaptureFileName,
  type FetchLike
} from "../src/openai-responses-cu.js";

// Deterministic coverage for the opt-in response wire-capture seam — the fixture-
// provenance lesson from the 0.6.1 parser incident (see src/openai-responses-cu.ts
// module header). Fake fetch + temp dir + injected env: no network, no key, no
// spend, and no process.env mutation. Asserts the gate is off by default, capture
// is response-side only, every string field is redacted, and naming is call-ordered.

// A tiny real PNG so call outputs carry a genuine base64 data URL.
function tinyPng(): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < 4; i += 1) {
    const o = i * 4;
    png.data[o] = 10;
    png.data[o + 1] = 20;
    png.data[o + 2] = 30;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

const SCREENSHOT = tinyPng();
const INSTRUCTIONS = "Act as a new user and sign in.";

function observation(): CuaObservation {
  return { screenshot: SCREENSHOT, stateSignature: "sig" };
}

function request(): CuaTurnRequest {
  return { instructions: INSTRUCTIONS, observation: observation() };
}

const neverAbort = new AbortController().signal;
const noDelay = async (): Promise<void> => undefined;

// Secret-shaped at runtime; the template split keeps the committed source from
// matching the public-surface scanner (same trick as the other redaction tests).
const FAKE_SECRET = `sk-proj-${"a".repeat(24)}`;

// A fetch fake that returns scripted ok JSON responses in sequence.
function scriptedFetch(responses: unknown[]): FetchLike {
  let i = 0;
  return async () => {
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
  };
}

const RESPONSE_ONE = {
  id: "resp_1",
  output: [{ type: "computer_call", call_id: "call_1", actions: [{ type: "click", x: 11, y: 22 }] }],
  usage: { input_tokens: 10, output_tokens: 4 }
};

const RESPONSE_TWO = {
  id: "resp_2",
  output: [{ type: "message", content: [{ type: "output_text", text: "Finished." }] }]
};

describe("wire capture (opt-in, response-side, redacted)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-wire-capture-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("writes nothing when the env gate is unset (default off)", async () => {
    const provider = createOpenAiResponsesProvider({
      apiKey: "test-key",
      fetchFn: scriptedFetch([RESPONSE_ONE, RESPONSE_TWO]),
      env: {}
    });
    await provider.nextTurn(request(), neverAbort);
    await provider.nextTurn(request(), neverAbort);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("writes nothing when the env gate is empty or whitespace", async () => {
    const provider = createOpenAiResponsesProvider({
      apiKey: "test-key",
      fetchFn: scriptedFetch([RESPONSE_ONE, RESPONSE_TWO]),
      env: { [WIRE_CAPTURE_ENV]: "   " }
    });
    await provider.nextTurn(request(), neverAbort);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("captures each ok response body as pretty-printed JSON in call order, without changing turns", async () => {
    // A nested, not-yet-existing dir proves the recursive mkdir.
    const captureDir = path.join(cwd, "nested", "wire");
    const provider = createOpenAiResponsesProvider({
      apiKey: "test-key",
      fetchFn: scriptedFetch([RESPONSE_ONE, RESPONSE_TWO]),
      env: { [WIRE_CAPTURE_ENV]: captureDir }
    });

    // Behavior with capture ON is identical to capture OFF: same parsed turns.
    const turn1 = await provider.nextTurn(request(), neverAbort);
    expect(turn1.actions).toEqual([{ kind: "click", x: 11, y: 22, button: "left" }]);
    const turn2 = await provider.nextTurn(request(), neverAbort);
    expect(turn2.done).toBe(true);
    expect(turn2.message).toBe("Finished.");

    const files = (await readdir(captureDir)).sort();
    expect(files).toEqual(["wire-001.json", "wire-002.json"]);

    // Exact bytes: redacted (no-op here — nothing secret-shaped), 2-space pretty-
    // printed, trailing newline. Byte-stable output is what makes diffs reviewable.
    const first = await readFile(path.join(captureDir, "wire-001.json"), "utf8");
    expect(first).toBe(`${JSON.stringify(RESPONSE_ONE, null, 2)}\n`);
    const second = JSON.parse(await readFile(path.join(captureDir, "wire-002.json"), "utf8")) as { id: string };
    expect(second.id).toBe("resp_2");
  });

  it("passes every string field through redactText before writing", async () => {
    const captureDir = path.join(cwd, "wire");
    const leaky = {
      id: "resp_1",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: `Your key is ${FAKE_SECRET} stored at /home/someuser/app/.env` }]
        }
      ],
      usage: { input_tokens: 7, output_tokens: 3 }
    };
    const provider = createOpenAiResponsesProvider({
      apiKey: "test-key",
      fetchFn: scriptedFetch([leaky]),
      env: { [WIRE_CAPTURE_ENV]: captureDir }
    });
    await provider.nextTurn(request(), neverAbort);

    const text = await readFile(path.join(captureDir, "wire-001.json"), "utf8");
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).toContain("[REDACTED_SECRET]");
    expect(text).toContain("[REDACTED_RUNTIME_PATH]");
    // Non-string fields pass through unchanged.
    const parsed = JSON.parse(text) as { usage: { input_tokens: number; output_tokens: number } };
    expect(parsed.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it("captures only ok responses: a retried 429 leaves no extra file", async () => {
    const captureDir = path.join(cwd, "wire");
    let call = 0;
    const fetchFn: FetchLike = async () => {
      call += 1;
      if (call === 1) {
        return { ok: false, status: 429, text: async () => "rate limited (may echo input)", json: async () => ({}) };
      }
      return { ok: true, status: 200, text: async () => "", json: async () => RESPONSE_TWO };
    };
    const provider = createOpenAiResponsesProvider({
      apiKey: "test-key",
      fetchFn,
      delayFn: noDelay,
      env: { [WIRE_CAPTURE_ENV]: captureDir }
    });
    await provider.nextTurn(request(), neverAbort);

    expect(call).toBe(2);
    const files = (await readdir(captureDir)).sort();
    expect(files).toEqual(["wire-001.json"]);
    expect(await readFile(path.join(captureDir, "wire-001.json"), "utf8")).toContain("resp_2");
  });

  it("never captures request material: no screenshots, no instructions", async () => {
    const captureDir = path.join(cwd, "wire");
    const provider = createOpenAiResponsesProvider({
      apiKey: "test-key",
      fetchFn: scriptedFetch([RESPONSE_ONE, RESPONSE_TWO]),
      env: { [WIRE_CAPTURE_ENV]: captureDir }
    });
    // Two turns so the second REQUEST carries the base64 screenshot call output.
    await provider.nextTurn(request(), neverAbort);
    await provider.nextTurn(request(), neverAbort);

    const files = await readdir(captureDir);
    const everything = (
      await Promise.all(files.map((file) => readFile(path.join(captureDir, file), "utf8")))
    ).join("\n");
    expect(everything).not.toContain("data:image/png");
    expect(everything).not.toContain(SCREENSHOT.toString("base64"));
    expect(everything).not.toContain(INSTRUCTIONS);
  });
});

describe("redactWireJson", () => {
  it("redacts strings deeply — keys and values, in objects and arrays", () => {
    const input = {
      note: `leaked ${FAKE_SECRET}`,
      [FAKE_SECRET]: "value under a secret-shaped key",
      nested: { list: ["plain", `also ${FAKE_SECRET}`] }
    };
    const out = redactWireJson(input) as Record<string, unknown>;
    expect(out.note).toBe("leaked [REDACTED_SECRET]");
    expect(out["[REDACTED_SECRET]"]).toBe("value under a secret-shaped key");
    expect((out.nested as { list: string[] }).list).toEqual(["plain", "also [REDACTED_SECRET]"]);
    expect(JSON.stringify(out)).not.toContain(FAKE_SECRET);
  });

  it("passes non-string primitives through unchanged and does not mutate the input", () => {
    const input = { n: 42, b: true, z: null, list: [1, false, null] };
    const out = redactWireJson(input);
    expect(out).toEqual({ n: 42, b: true, z: null, list: [1, false, null] });
    expect(out).not.toBe(input);
  });
});

describe("wireCaptureFileName", () => {
  it("is deterministic, zero-padded, and ordered", () => {
    expect(wireCaptureFileName(1)).toBe("wire-001.json");
    expect(wireCaptureFileName(42)).toBe("wire-042.json");
    expect(wireCaptureFileName(1234)).toBe("wire-1234.json");
  });
});
