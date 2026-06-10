import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { ActorCapabilities, ActorPersonaRef } from "../src/actor-contract.js";
import {
  describeCuaAction,
  runComputerUseLoop,
  type CuaExecutor,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest
} from "../src/computer-use.js";
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

const persona: ActorPersonaRef = {
  id: "dana",
  traitsApplied: ["friction-tolerance:low"],
  promptDigest: "abc123def456"
};

function frame(): Buffer {
  const png = new PNG({ width: 200, height: 150 });
  for (let i = 0; i < 200 * 150; i += 1) {
    const o = i * 4;
    const v = i % 2 === 0 ? 0 : 255;
    png.data[o] = v;
    png.data[o + 1] = v;
    png.data[o + 2] = v;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

class ScriptedProvider implements CuaProvider {
  readonly id = "fake-cua";
  readonly version = "fake-1";
  readonly capabilities = FAKE_CAPS;
  readonly seen: CuaTurnRequest[] = [];
  private i = 0;
  constructor(private readonly turns: CuaTurn[]) {}
  async nextTurn(req: CuaTurnRequest): Promise<CuaTurn> {
    this.seen.push(req);
    const turn = this.turns[this.i];
    this.i += 1;
    return turn ?? { actions: [], pendingSafetyChecks: [], done: true, message: "done (exhausted)" };
  }
}

class RepeatProvider implements CuaProvider {
  readonly id = "fake-cua";
  readonly version = "fake-1";
  readonly capabilities = FAKE_CAPS;
  readonly seen: CuaTurnRequest[] = [];
  constructor(private readonly turn: CuaTurn) {}
  async nextTurn(req: CuaTurnRequest): Promise<CuaTurn> {
    this.seen.push(req);
    return this.turn;
  }
}

class SignatureExecutor implements CuaExecutor {
  private i = 0;
  readonly frame = frame();
  constructor(private readonly signatures: string[]) {}
  async observe(): Promise<{ screenshot: Buffer; stateSignature: string }> {
    const sig = this.signatures[Math.min(this.i, this.signatures.length - 1)] ?? "sig";
    this.i += 1;
    return { screenshot: this.frame, stateSignature: sig };
  }
  async execute(): Promise<void> {}
}

// A monotonic injected clock so deadlines and timestamps are deterministic.
function monotonicClock(step = 1000): () => number {
  let t = 0;
  return () => (t += step);
}

function recorder() {
  const written: Array<{ name: string; bytes: Buffer }> = [];
  return {
    written,
    writeScreenshot: async (name: string, bytes: Buffer): Promise<string> => {
      written.push({ name, bytes });
      return `screenshots/${name}`;
    }
  };
}

describe("describeCuaAction", () => {
  it("never includes raw typed text", () => {
    expect(describeCuaAction({ kind: "type", text: "secret@example.test" })).toBe("type [19 chars]");
    expect(describeCuaAction({ kind: "click", x: 3, y: 4 })).toBe("click (3, 4)");
    expect(describeCuaAction({ kind: "keypress", keys: ["Control", "a"] })).toBe("keypress Control+a");
  });
});

describe("runComputerUseLoop", () => {
  it("completes when the model reports a natural endpoint", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false, reasoning: "looking", responseId: "r1" },
      { actions: [{ kind: "type", text: "hello@example.test" }], pendingSafetyChecks: [], done: false, responseId: "r2" },
      { actions: [], pendingSafetyChecks: [], done: true, message: "Booked the appointment.", responseId: "r3" }
    ]);
    const executor = new SignatureExecutor(["s0", "s1", "s2", "s3"]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "Act as Dana and book a visit.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      writeScreenshot: sink.writeScreenshot
    });

    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("Booked the appointment.");
    expect(result.trace.schema).toBe("mimetic.actor-trace.v1");
    expect(result.trace.lane).toBe("computer-use");
    expect(result.trace.protocol).toBe("cua-loop");
    expect(result.trace.provider).toBe("fake-cua");
    expect(result.trace.ids.model).toBe("fake-1");
    expect(result.trace.counts.turns).toBe(3);
    expect(result.trace.counts.actions).toBe(2);
    // initial + 2 executed turns
    expect(result.trace.counts.screenshots).toBe(3);
  });

  it("DEFAULT persists RAW full-fidelity frames (local fidelity) and never logs raw typed text", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "type", text: "hello@example.test" }], pendingSafetyChecks: [], done: false },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    const executor = new SignatureExecutor(["s0", "s1"]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      writeScreenshot: sink.writeScreenshot
      // redactScreenshots omitted → defaults false → raw
    });

    // Typed text (synthetic identity) is STILL never in the trace — that redaction is unconditional.
    expect(JSON.stringify(result.trace)).not.toContain("hello@example.test");
    // Screenshots are recorded raw (redaction: "none"), full fidelity for local use.
    const shots = result.trace.items.filter((i) => i.kind === "screenshot");
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((i) => i.screenshotRef?.redaction === "none")).toBe(true);
    expect(result.trace.redaction.screenshots).toBe("raw");
    // What was persisted IS the raw frame, byte-identical to what the executor produced.
    expect(sink.written.length).toBe(shots.length);
    expect(Buffer.compare(sink.written[0]!.bytes, executor.frame)).toBe(0);
  });

  it("redactScreenshots: true persists blurred thumbnails (publish-safe), not raw frames", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "type", text: "hello@example.test" }], pendingSafetyChecks: [], done: false },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    const executor = new SignatureExecutor(["s0", "s1"]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      redactScreenshots: true,
      writeScreenshot: sink.writeScreenshot
    });

    const shots = result.trace.items.filter((i) => i.kind === "screenshot");
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((i) => i.screenshotRef?.redaction === "blurred")).toBe(true);
    expect(result.trace.redaction.screenshots).toBe("blurred");
    // Persisted bytes are the redacted thumbnail, NOT the raw frame.
    expect(Buffer.compare(sink.written[0]!.bytes, executor.frame)).not.toBe(0);
  });

  it("scrubText scrubs a KNOWN provisioned value the MODEL narrates into reasoning/message (no shape for pattern redaction)", async () => {
    // A DB password has no secret "shape" — redactText alone cannot catch it. The lab injects
    // scrubText so a value the model transcribes into its narration never lands raw in the trace.
    const provisionedValue = "shapeless-db-pw-7Q2x";
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false,
        reasoning: `I see the config shows password ${provisionedValue} on screen`,
        message: `noting ${provisionedValue} before continuing` },
      { actions: [], pendingSafetyChecks: [], done: true, message: `done; the value was ${provisionedValue}` }
    ]);
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      scrubText: (text) => text.split(provisionedValue).join("[REDACTED_SECRET]")
    });

    // The shapeless value never appears anywhere in the trace (reasoning, message, summary).
    expect(JSON.stringify(result.trace)).not.toContain(provisionedValue);
    expect(JSON.stringify(result.trace)).toContain("[REDACTED_SECRET]");
  });

  it("gives up on an idle streak, citing the friction (not a turn count)", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "screenshot" }], pendingSafetyChecks: [], done: false });
    const executor = new SignatureExecutor(["s0", "s1", "s2", "s3", "s4"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      idleSteps: 3
    });

    expect(result.completionReason).toBe("gave_up");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("no material UI action");
  });

  it("gives up on a no-progress streak and nudges before stopping", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 5, y: 5 }], pendingSafetyChecks: [], done: false });
    const executor = new SignatureExecutor(["same"]); // signature never changes

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    expect(result.completionReason).toBe("gave_up");
    expect(result.reason).toContain("no change to the UI state");
    // A recovery hint was injected before the backstop tripped.
    expect(provider.seen.some((r) => (r.contextHint ?? "").includes("No visible progress"))).toBe(true);
  });

  it("stops on the wall-clock deadline (checked at the top of the loop)", async () => {
    let t = 0;
    const now = (): number => t;
    // The first model turn jumps the clock past the deadline; iteration 2 trips it.
    const provider: CuaProvider = {
      id: "tick",
      version: "t",
      capabilities: FAKE_CAPS,
      async nextTurn() {
        t = 1000;
        return { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false };
      }
    };
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 100,
      now
    });

    expect(result.completionReason).toBe("timed_out");
    expect(result.status).toBe("timed_out");
    expect(result.trace.counts.turns).toBe(1);
  });

  it("enforces the deadline on a hung provider call (raceSettle)", async () => {
    const provider: CuaProvider = {
      id: "hang",
      version: "h",
      capabilities: FAKE_CAPS,
      nextTurn: () => new Promise<CuaTurn>(() => {}) // never resolves
    };
    const executor = new SignatureExecutor(["s0"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 30,
      now: () => 0
    });

    expect(result.completionReason).toBe("timed_out");
    expect(result.status).toBe("timed_out");
  });

  it("does not actuate the desktop once aborted mid-turn", async () => {
    const controller = new AbortController();
    let executed = 0;
    const provider: CuaProvider = {
      id: "ab",
      version: "a",
      capabilities: FAKE_CAPS,
      async nextTurn() {
        controller.abort();
        return { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false };
      }
    };
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot: frame(), stateSignature: "s" }),
      execute: async () => {
        executed += 1;
      }
    };

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      signal: controller.signal
    });

    expect(result.completionReason).toBe("harness_error");
    expect(executed).toBe(0); // no action ran after the abort
  });

  it("pauses (blocked) on an unacknowledged safety check", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 1, y: 1 }],
      pendingSafetyChecks: [{ id: "sc_1", code: "malicious_instructions", message: "be careful" }],
      done: false
    });
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    expect(result.completionReason).toBe("blocked_approval");
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("safety check");
    expect(result.trace.items.some((i) => i.kind === "approval")).toBe(true);
  });

  it("carries acknowledged safety checks onto the NEXT turn's request, verbatim and one-shot", async () => {
    const check = { id: "sc_9", code: "malicious_instructions", message: "be careful" };
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [check], done: false, responseId: "r1" },
      { actions: [{ kind: "click", x: 2, y: 2 }], pendingSafetyChecks: [], done: false, responseId: "r2" },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    const executor = new SignatureExecutor(["s0", "s1", "s2"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      acknowledgeSafetyChecks: (checks) => checks
    });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(provider.seen).toHaveLength(3);
    // Turn 1: nothing to acknowledge yet.
    expect(provider.seen[0]?.acknowledgedSafetyChecks).toBeUndefined();
    // Turn 2: the acks granted for turn 1's checks ride the request that carries
    // that call's output — verbatim wire triples, not fabricated from codes.
    expect(provider.seen[1]?.acknowledgedSafetyChecks).toEqual([check]);
    // Turn 3: acks are one-shot; stale acks must not be re-sent.
    expect(provider.seen[2]?.acknowledgedSafetyChecks).toBeUndefined();
  });

  it("stops when the signal is already aborted", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false });
    const executor = new SignatureExecutor(["s0"]);
    const controller = new AbortController();
    controller.abort();

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      signal: controller.signal
    });

    expect(result.completionReason).toBe("harness_error");
    expect(result.status).toBe("failed");
  });
});
