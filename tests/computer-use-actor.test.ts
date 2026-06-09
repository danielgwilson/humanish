import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { ACTOR_TRACE_SCHEMA, type ActorPersonaRef } from "../src/actor-contract.js";
import { getActor } from "../src/actor-registry.js";
import { runCuaActorSession } from "../src/computer-use-actor.js";
import type { E2BDesktopLike } from "../src/e2b-desktop-executor.js";
import {
  DEFAULT_OPENAI_CU_MODEL,
  OPENAI_RESPONSES_CU_CAPABILITIES,
  type FetchLike
} from "../src/openai-responses-cu.js";

// A distinct, valid PNG per call so the executor's perceptual signature can register progress.
function makePng(seed: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (seed * 37 + i) % 256;
    png.data[i + 1] = (seed * 89 + i) % 256;
    png.data[i + 2] = (seed * 13 + i) % 256;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

// Real OpenAI Responses provider, fake transport. Returns the scripted JSON per call.
function scriptedFetch(responses: unknown[]): FetchLike {
  let i = 0;
  return async (_url, _init) => {
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
  };
}

interface RecordingDesktop extends E2BDesktopLike {
  calls: Array<[string, ...unknown[]]>;
}

function makeFakeDesktop(): RecordingDesktop {
  let frame = 0;
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]): void => { calls.push([name, ...args]); };
  return {
    calls,
    async screenshot() { frame += 1; return makePng(frame); },
    leftClick: record("leftClick"),
    rightClick: record("rightClick"),
    middleClick: record("middleClick"),
    doubleClick: record("doubleClick"),
    moveMouse: record("moveMouse"),
    scroll: record("scroll"),
    write: record("write"),
    press: record("press"),
    drag: record("drag"),
    wait: record("wait")
  };
}

const persona: ActorPersonaRef = { id: "synthetic-new-user", traitsApplied: ["patience:medium"], promptDigest: "digest" };
const baseOpts = { instructions: "open the page and stop", persona, timeoutMs: 60_000, now: () => 0 };

describe("openai-computer-use actor (deterministic, no spend)", () => {
  it("T1: is registered with the OpenAI computer-use capabilities", () => {
    const descriptor = getActor("openai-computer-use");
    expect(descriptor.id).toBe("openai-computer-use");
    expect(descriptor.capabilities).toBe(OPENAI_RESPONSES_CU_CAPABILITIES);
    expect(descriptor.capabilities.lanes).toContain("computer-use");
  });

  it("T2: config → real provider → loop → real executor → trace actually flows (anti-theater)", async () => {
    const fetchFn = scriptedFetch([
      { id: "resp_1", output: [{ type: "computer_call", call_id: "c1", action: { type: "click", x: 11, y: 22 } }] },
      { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }
    ]);
    const desktop = makeFakeDesktop();

    const result = await runCuaActorSession({ ...baseOpts, openai: { apiKey: "test-key", fetchFn }, desktop });

    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.lane).toBe("computer-use");
    expect(result.trace.protocol).toBe("cua-loop");
    expect(result.trace.provider).toBe("openai-responses-cu");
    // The real executor translated the model's click into a real desktop call:
    expect(desktop.calls).toContainEqual(["leftClick", 11, 22]);
  });

  it("T3: emits a conformant mimetic.actor-trace.v1", async () => {
    const fetchFn = scriptedFetch([
      { id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }
    ]);
    const result = await runCuaActorSession({ ...baseOpts, openai: { apiKey: "test-key", fetchFn }, desktop: makeFakeDesktop() });
    const trace = result.trace;
    expect(trace.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(["passed", "failed", "blocked", "timed_out"]).toContain(trace.status);
    expect(Array.isArray(trace.items)).toBe(true);
    expect(trace.redaction).toBeDefined();
    expect(trace.counts).toBeDefined();
    expect(trace.ids?.model ?? DEFAULT_OPENAI_CU_MODEL).toBe(DEFAULT_OPENAI_CU_MODEL);
  });

  it("T4: typed secrets and raw frames never reach the trace (redaction enforced at the boundary)", async () => {
    const secret = "hunter2@secret.example";
    const fetchFn = scriptedFetch([
      { id: "r1", output: [{ type: "computer_call", call_id: "c1", action: { type: "type", text: secret } }] },
      { id: "r2", output: [{ type: "message", content: [{ type: "output_text", text: "typed" }] }] }
    ]);
    const result = await runCuaActorSession({ ...baseOpts, openai: { apiKey: "test-key", fetchFn }, desktop: makeFakeDesktop() });

    expect(JSON.stringify(result.trace)).not.toContain(secret);
    const shots = result.trace.items.filter((item) => item.kind === "screenshot");
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((item) => item.screenshotRef?.redaction === "blurred")).toBe(true);
  });

  it("T5: fail-closed on safety checks by default (no auto-ack passed)", async () => {
    const fetchFn = scriptedFetch([
      {
        id: "r1",
        output: [{
          type: "computer_call",
          call_id: "c1",
          action: { type: "click", x: 1, y: 2 },
          pending_safety_checks: [{ id: "s1", code: "malicious_instructions", message: "blocked" }]
        }]
      }
    ]);
    const result = await runCuaActorSession({ ...baseOpts, openai: { apiKey: "test-key", fetchFn }, desktop: makeFakeDesktop() });

    expect(result.status).toBe("blocked");
    expect(result.completionReason).toBe("blocked_approval");
  });

  it("T6: the API key never escapes into the trace", async () => {
    const apiKey = "sk-proj-do-not-leak-me";
    const fetchFn = scriptedFetch([
      { id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }
    ]);
    const result = await runCuaActorSession({ ...baseOpts, openai: { apiKey, fetchFn }, desktop: makeFakeDesktop() });
    expect(JSON.stringify(result.trace)).not.toContain(apiKey);
  });
});
