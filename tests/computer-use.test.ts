import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { ActorCapabilities, ActorPersonaRef } from "../src/actor-contract.js";
import {
  describeCuaAction,
  runComputerUseLoop,
  stableProgressKey,
  type CuaAction,
  type CuaExecutor,
  type CuaObservation,
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

class ObservationSequenceExecutor implements CuaExecutor {
  private i = 0;
  readonly frame = frame();
  readonly actions: CuaAction[] = [];
  constructor(private readonly observations: CuaObservation[]) {}
  async observe(): Promise<CuaObservation> {
    const observation = this.observations[Math.min(this.i, this.observations.length - 1)];
    this.i += 1;
    return observation ?? { screenshot: this.frame, stateSignature: "fallback" };
  }
  async execute(action: CuaAction): Promise<void> {
    this.actions.push(action);
  }
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

  it("stops deterministically when post-action browser text matches stopWhen", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 10, y: 20 }],
      pendingSafetyChecks: [],
      done: false
    });
    const executor = new ObservationSequenceExecutor([
      { screenshot: frame(), stateSignature: "before", url: "http://127.0.0.1:3000/items/123", text: "Edit item" },
      { screenshot: frame(), stateSignature: "after", url: "http://127.0.0.1:3000/items/123", text: "Saved successfully" }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Save the item.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      stopWhen: { any: [{ id: "saved", textIncludes: "Saved successfully" }] }
    });

    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("stopWhen matched saved (textIncludes)");
    expect(provider.seen).toHaveLength(1);
    expect(executor.actions).toHaveLength(1);
    expect(JSON.stringify(result.trace)).not.toContain("Saved successfully");
    const notice = result.trace.items.find((item) => item.kind === "notice" && item.status === "matched");
    expect(notice?.text).toContain("immediately preceding screenshot item");
    expect(notice?.text).not.toContain("Saved successfully");
  });

  it("can stop on an exact URL path plus page text after an action", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 10, y: 20 }],
      pendingSafetyChecks: [],
      done: false
    });
    const executor = new ObservationSequenceExecutor([
      { screenshot: frame(), stateSignature: "detail", url: "https://example.test/tasks/rfd_123", text: "Confirm deny" },
      { screenshot: frame(), stateSignature: "queue", url: "https://example.test/tasks?tab=open", text: "Tasks\nReview queue" }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Deny the request.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      stopWhen: { any: [{ id: "returned-to-queue", urlPathEquals: "/tasks", textIncludes: "Tasks" }] }
    });

    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("stopWhen matched returned-to-queue (urlPathEquals+textIncludes)");
    expect(provider.seen).toHaveLength(1);
    expect(executor.actions).toHaveLength(1);
    expect(JSON.stringify(result.trace)).not.toContain("Review queue");
  });

  it("can stop before the first model turn when appState already satisfies stopWhen", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 10, y: 20 }],
      pendingSafetyChecks: [],
      done: false
    });
    const executor = new ObservationSequenceExecutor([
      {
        screenshot: frame(),
        stateSignature: "ready",
        appState: { workflow: { status: "done", count: 3 } }
      }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Finish the workflow.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      stopWhen: { any: [{ id: "already-done", appStatePathEquals: { path: "workflow.status", equals: "done" } }] }
    });

    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("stopWhen matched already-done (appStatePathEquals)");
    expect(provider.seen).toHaveLength(0);
    expect(executor.actions).toHaveLength(0);
    expect(JSON.stringify(result.trace)).not.toContain("workflow");
    const screenshotIndex = result.trace.items.findIndex((item) => item.kind === "screenshot");
    const noticeIndex = result.trace.items.findIndex((item) => item.kind === "notice" && item.status === "matched");
    expect(screenshotIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBe(screenshotIndex + 1);
    expect(result.trace.items[noticeIndex]?.text).toContain("immediately preceding screenshot item");
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

  it("records public-safe actor diagnostics when the provider loop crashes", async () => {
    const provisionedValue = "shapeless-runtime-token-9a2b";
    const provider: CuaProvider = {
      id: "crashy-provider",
      version: "c1",
      capabilities: FAKE_CAPS,
      async nextTurn(): Promise<CuaTurn> {
        throw new Error(`provider subprocess exited with ${provisionedValue}`);
      }
    };
    const executor = new SignatureExecutor(["s0"]);

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

    expect(result.completionReason).toBe("actor_error");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("computer-use loop error");
    expect(result.trace.items.at(-1)).toMatchObject({
      kind: "notice",
      status: "error",
      title: "computer-use loop error",
      text: "phase: requesting provider turn 1; error: Error; message: provider subprocess exited with [REDACTED_SECRET]",
      screenshotRef: { path: "screenshots/turn-00-start.png", redaction: "none" }
    });
    expect(JSON.stringify(result.trace)).not.toContain(provisionedValue);
  });

  it("records the last UI action when the executor crashes mid-actuation", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 11, y: 22 }], pendingSafetyChecks: [], done: false }
    ]);
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot: frame(), stateSignature: "s0" }),
      execute: async () => {
        throw new Error("desktop actuator exited 1");
      }
    };

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    expect(result.completionReason).toBe("actor_error");
    expect(result.trace.items.at(-1)).toMatchObject({
      kind: "notice",
      status: "error",
      title: "computer-use loop error",
      text: "phase: executing click (11, 22); error: Error; message: desktop actuator exited 1; last action: click (11, 22)"
    });
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

// ---------------------------------------------------------------------------
// Issue #148: state-driven (non-vision) executors. RUNG 2 (appState-preferred progress,
// no-screenshot persistence, redaction.notes self-describes appState) and RUNG 3 (a
// requiresFrame provider against a screenshot-less observation fails closed).
// ---------------------------------------------------------------------------

// A non-vision executor: returns NO screenshot and a (configurable) appState per turn, with a
// constant stateSignature so progress can ONLY come from the appState delta.
class StateExecutor implements CuaExecutor {
  private i = 0;
  readonly observed: CuaObservation[] = [];
  constructor(
    private readonly appStates: Array<Record<string, unknown>>,
    private readonly stateSignature = "constant-sig"
  ) {}
  async observe(): Promise<CuaObservation> {
    const appState = this.appStates[Math.min(this.i, this.appStates.length - 1)] ?? {};
    this.i += 1;
    const obs: CuaObservation = { stateSignature: this.stateSignature, appState };
    this.observed.push(obs);
    return obs;
  }
  async execute(): Promise<void> {}
}

// A state-reasoning provider: omits requiresFrame (defaults falsey) and reasons over appState.
class StateProvider implements CuaProvider {
  readonly id = "fake-state-brain";
  readonly version = "state-1";
  readonly capabilities = FAKE_CAPS;
  private i = 0;
  constructor(private readonly turns: CuaTurn[]) {}
  async nextTurn(): Promise<CuaTurn> {
    const turn = this.turns[this.i];
    this.i += 1;
    return turn ?? { actions: [], pendingSafetyChecks: [], done: true, message: "done (exhausted)" };
  }
}

describe("stableProgressKey (issue #148)", () => {
  it("is order-independent: shuffled key order maps to the SAME key (no fabricated progress)", () => {
    const a = stableProgressKey({ route: "/home", turn: 3, modal: null, unread: 2 });
    const b = stableProgressKey({ unread: 2, modal: null, turn: 3, route: "/home" });
    expect(a).toBe(b);
  });

  it("distinguishes genuinely different states", () => {
    expect(stableProgressKey({ route: "/home" })).not.toBe(stableProgressKey({ route: "/inbox" }));
  });

  it("does NOT throw on a cyclic appState — it degrades to a bounded value", () => {
    const cyclic: Record<string, unknown> = { route: "/home" };
    cyclic.self = cyclic;
    const key = stableProgressKey(cyclic);
    expect(typeof key).toBe("string");
    expect(key).toContain("[Circular]");
  });

  it("does NOT throw on a huge/deep appState — it caps to a bounded value", () => {
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i += 1) huge[`k${i}`] = "x".repeat(64);
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };
    expect(() => stableProgressKey(huge)).not.toThrow();
    expect(() => stableProgressKey(deep)).not.toThrow();
    expect(stableProgressKey(huge).length).toBeLessThanOrEqual(8200);
  });
});

describe("runComputerUseLoop with a state-driven (non-vision) executor (issue #148)", () => {
  it("persists ZERO frames, resolves redaction.screenshots to n/a, and self-describes appState in redaction.notes", async () => {
    const provider = new StateProvider([
      { actions: [{ kind: "type", text: "hi" }], pendingSafetyChecks: [], done: false },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    // Distinct appState per turn → progress; constant stateSignature throughout. The route
    // values are deliberately distinctive so the runtime-only assertion below cannot false-match.
    const executor = new StateExecutor([
      { route: "/appstate-marker-one", turn: 1 },
      { route: "/appstate-marker-two", turn: 2 }
    ]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "drive via state",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      writeScreenshot: sink.writeScreenshot
    });

    expect(result.completionReason).toBe("goal_satisfied");
    // (a) zero frames written, zero screenshot trace items, no Buffer.alloc(0) on disk.
    expect(sink.written.length).toBe(0);
    expect(result.trace.items.filter((i) => i.kind === "screenshot").length).toBe(0);
    expect(result.trace.counts.screenshots).toBe(0);
    // (b) redaction resolves to n/a.
    expect(result.trace.redaction.screenshots).toBe("n/a");
    // (c) redaction.notes self-describes the appState stance (doctrine fix 1, invariant 6).
    expect(result.trace.redaction.notes).toContain("App state was observed");
    expect(result.trace.redaction.notes).toContain("NOT written to the trace");
    // appState is runtime-only: it must NEVER appear in the serialized trace.
    expect(JSON.stringify(result.trace)).not.toContain('"route"');
    expect(JSON.stringify(result.trace)).not.toContain("appstate-marker");
  });

  it("an appState delta drives progress even when the stateSignature is CONSTANT", async () => {
    // 8 actuating turns then stop; appState changes every turn → never trips no-progress.
    const turns: CuaTurn[] = [];
    for (let i = 0; i < 8; i += 1) turns.push({ actions: [{ kind: "click", x: i, y: i }], pendingSafetyChecks: [], done: false });
    turns.push({ actions: [], pendingSafetyChecks: [], done: true, message: "done" });
    const provider = new StateProvider(turns);
    const appStates = Array.from({ length: 9 }, (_, i) => ({ turn: i }));
    const executor = new StateExecutor(appStates, "frozen-sig");

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    // A constant stateSignature would have tripped gave_up at step 3; the appState delta saved it.
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.counts.noProgressTurns ?? 0).toBe(0);
  });

  it("the inverse trips the backstop: a CONSTANT appState (and constant signature) gives up on no progress", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false });
    // Same appState object every turn → progressKey never changes.
    const executor = new StateExecutor([{ turn: "frozen" }], "frozen-sig");

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    expect(result.completionReason).toBe("gave_up");
    expect(result.reason).toContain("no change");
  });

  it("shuffled-key-order appState across turns is NOT progress (gives up)", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false });
    // Same content, different key insertion order each turn — must NOT register as progress.
    const executor = new StateExecutor(
      [
        { route: "/x", turn: 1, modal: null },
        { modal: null, turn: 1, route: "/x" },
        { turn: 1, route: "/x", modal: null },
        { route: "/x", modal: null, turn: 1 }
      ],
      "frozen-sig"
    );

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    expect(result.completionReason).toBe("gave_up");
  });

  it("an oversized/cyclic appState does NOT crash the loop (bounded progress key)", async () => {
    const provider = new StateProvider([
      { actions: [{ kind: "type", text: "x" }], pendingSafetyChecks: [], done: false },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    const cyclic: Record<string, unknown> = { route: "/home" };
    cyclic.self = cyclic;
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i += 1) huge[`k${i}`] = i;
    const executor = new StateExecutor([cyclic, huge], "frozen-sig");

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    // No throw → the loop produced a terminal verdict.
    expect(["goal_satisfied", "gave_up"]).toContain(result.completionReason);
  });
});

describe("runComputerUseLoop vision-provider frame guard (issue #148, RUNG 3)", () => {
  it("a requiresFrame provider against a screenshot-less observation fails closed with the named reason (not a crash)", async () => {
    // A vision provider (requiresFrame: true) paired with a state-only executor (no screenshot).
    class VisionProvider implements CuaProvider {
      readonly id = "vision-needs-frame";
      readonly version = "v1";
      readonly capabilities = FAKE_CAPS;
      readonly requiresFrame = true;
      async nextTurn(): Promise<CuaTurn> {
        return { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false };
      }
    }
    const provider = new VisionProvider();
    const executor = new StateExecutor([{ turn: 1 }]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      writeScreenshot: sink.writeScreenshot
    });

    expect(result.completionReason).toBe("harness_error");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("vision-needs-frame");
    expect(result.reason).toContain("requires a screenshot frame");
    // Failed before any frame was persisted.
    expect(sink.written.length).toBe(0);
  });

  it("a requiresFrame provider WITH a screenshot behaves normally (no false trip)", async () => {
    class VisionProvider implements CuaProvider {
      readonly id = "vision-with-frame";
      readonly version = "v1";
      readonly capabilities = FAKE_CAPS;
      readonly requiresFrame = true;
      private i = 0;
      async nextTurn(): Promise<CuaTurn> {
        this.i += 1;
        return this.i >= 2
          ? { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
          : { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false };
      }
    }
    const provider = new VisionProvider();
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    expect(result.completionReason).toBe("goal_satisfied");
  });
});
