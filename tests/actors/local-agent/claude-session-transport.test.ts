import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runComputerUseLoop, type CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import { CuaProviderError } from "../../../src/actors/computer-use/provider-error.js";
import { startClaudeSession } from "../../../src/actors/local-agent/claude-session.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

// The stdio transport of the persistent Claude Code session, driven through a fake `claude -p`
// child. Its wire shapes follow tests/fixtures/claude-code-stream-json/interrupted-turn.ndjson,
// captured from Claude Code 2.1.285.

type Json = Record<string, unknown>;

const request = (): CuaTurnRequest => ({
  instructions: "Finish the synthetic task.",
  observation: { screenshot: Buffer.from("89504e470d0a1a0a", "hex"), stateSignature: "s" },
});

/** A fake `claude -p --input-format stream-json` child: it records stdin and the test writes stdout. */
function fakeClaudeChild() {
  const received: Json[] = [];
  const messages = new EventEmitter();
  const stdout = new PassThrough();
  let pendingText = "";
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pendingText += chunk.toString("utf8");
      for (let end = pendingText.indexOf("\n"); end >= 0; end = pendingText.indexOf("\n")) {
        const message = JSON.parse(pendingText.slice(0, end)) as Json;
        pendingText = pendingText.slice(end + 1);
        received.push(message);
        messages.emit("message", message);
      }
      callback();
    },
  });
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => {
      kills += 1;
      child.emit("close", null, "SIGTERM");
      return true;
    },
  });
  return {
    received,
    messages,
    kills: () => kills,
    users: () => received.filter((message) => message.type === "user"),
    write: (message: Json) => stdout.write(`${JSON.stringify(message)}\n`),
    spawnFn: (() => child) as unknown as typeof spawn,
  };
}

/** The captured stream: init, an interrupt receipt, the interrupted result, the next result. */
const [, capturedReceipt, capturedInterrupted] = readFileSync(
  new URL("../../fixtures/claude-code-stream-json/interrupted-turn.ndjson", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Json);

/**
 * Answer every interrupt the way Claude Code 2.1.285 does: a receipt, and, when a turn was
 * running, that turn's `error_during_execution` result naming it.
 */
function answerInterrupts(fake: ReturnType<typeof fakeClaudeChild>, interrupted?: () => unknown) {
  fake.messages.on("message", (message: Json) => {
    if (message.type !== "control_request") return;
    const receipt = capturedReceipt?.response as Json;
    fake.write({ ...capturedReceipt, response: { ...receipt, request_id: message.request_id } });
    const uuid = interrupted?.();
    if (typeof uuid !== "string") return;
    fake.write({ ...capturedInterrupted, user_message_uuid: uuid, user_message_uuids: [uuid] });
  });
}

/** A `result` answering one user message, as Claude Code 2.1.285 writes it. */
function resultFor(uuid: unknown, reply: Json, usage = { input_tokens: 10, output_tokens: 5 }) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    ...(typeof uuid === "string" ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}),
    result: JSON.stringify(reply),
    usage,
  };
}

describe("the persistent Claude Code session transport", () => {
  it("delivers a result only to the request that produced it", async () => {
    const fake = fakeClaudeChild();
    answerInterrupts(fake);
    const session = await startClaudeSession({ spawnFn: fake.spawnFn });
    const first = new AbortController();
    const stalled = session.provider.nextTurn(request(), first.signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(1));
    first.abort();
    await expect(stalled).rejects.toThrow("run stopped");

    const retry = session.provider.nextTurn(request(), new AbortController().signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(2));
    const [stale, current] = fake.users();
    // The stalled turn finishes late, after its retry was sent.
    fake.write(resultFor(stale?.uuid, { message: "stale answer", done: true, actions: [] }));
    fake.write(resultFor(current?.uuid, { message: "current answer", done: true, actions: [] }));

    await expect(retry).resolves.toMatchObject({ message: "current answer" });
    await session.close();
  });

  it("interrupts a given-up turn and sends the next turn only after the receipt", async () => {
    const fake = fakeClaudeChild();
    const session = await startClaudeSession({ spawnFn: fake.spawnFn });
    const first = new AbortController();
    const stalled = session.provider.nextTurn(request(), first.signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(1));
    first.abort();
    await expect(stalled).rejects.toThrow("run stopped");
    const next = session.provider.nextTurn(request(), new AbortController().signal);
    await vi.waitFor(() => expect(fake.received).toHaveLength(2));
    const interrupt = fake.received[1]!;
    expect(interrupt).toMatchObject({
      type: "control_request",
      request: { subtype: "interrupt", cancel_queued: true },
    });
    // No receipt yet, so the next user message is still held back.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.users()).toHaveLength(1);
    fake.write({
      ...capturedReceipt,
      response: { ...(capturedReceipt?.response as Json), request_id: interrupt.request_id },
    });
    await vi.waitFor(() => expect(fake.users()).toHaveLength(2));
    fake.write(resultFor(fake.users()[1]?.uuid, { message: "next", done: true, actions: [] }));
    await expect(next).resolves.toMatchObject({ message: "next" });
    await session.close();
  });

  it("discards the interrupted turn's result and reports its usage as unknown", async () => {
    const fake = fakeClaudeChild();
    answerInterrupts(fake, () => fake.users()[0]?.uuid);
    const session = await startClaudeSession({ spawnFn: fake.spawnFn });
    expect(session.provider.interactionUsageIncomplete).toBe(false);
    const first = new AbortController();
    const stalled = session.provider.nextTurn(request(), first.signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(1));
    first.abort();
    await expect(stalled).rejects.toThrow("run stopped");
    const next = session.provider.nextTurn(request(), new AbortController().signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(2));
    const usage = { input_tokens: 7, output_tokens: 3 };
    fake.write(resultFor(fake.users()[1]?.uuid, { message: "m", done: true, actions: [] }, usage));
    await expect(next).resolves.toMatchObject({ message: "m", usage: { input: 7, output: 3 } });
    expect(session.provider.interactionUsageIncomplete).toBe(true);
    await session.close();
  });

  it("pairs an older Claude Code's unnamed result while no turn was given up", async () => {
    const fake = fakeClaudeChild();
    const session = await startClaudeSession({ spawnFn: fake.spawnFn });
    const turn = session.provider.nextTurn(request(), new AbortController().signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(1));
    fake.write(resultFor(undefined, { message: "unnamed", done: true, actions: [] }));
    await expect(turn).resolves.toMatchObject({ message: "unnamed" });
    expect(fake.kills()).toBe(0);
    await session.close();
  });

  it("sends nothing for a turn whose signal already aborted", async () => {
    const fake = fakeClaudeChild();
    const session = await startClaudeSession({ spawnFn: fake.spawnFn });
    const aborted = new AbortController();
    aborted.abort();
    await expect(session.provider.nextTurn(request(), aborted.signal)).rejects.toThrow(
      "run stopped",
    );
    expect(fake.received).toHaveLength(0);
    await session.close();
  });
});

describe("a Claude Code session that can no longer pair results", () => {
  async function abandonFirstTurn(fake: ReturnType<typeof fakeClaudeChild>) {
    const session = await startClaudeSession({ spawnFn: fake.spawnFn });
    const first = new AbortController();
    const stalled = session.provider.nextTurn(request(), first.signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(1));
    first.abort();
    await expect(stalled).rejects.toThrow("run stopped");
    return session;
  }

  it("ends as a provider error when an unnamed result arrives after a turn was given up", async () => {
    const fake = fakeClaudeChild();
    answerInterrupts(fake);
    const session = await abandonFirstTurn(fake);
    const next = session.provider.nextTurn(request(), new AbortController().signal);
    await vi.waitFor(() => expect(fake.users()).toHaveLength(2));
    fake.write(resultFor(undefined, { message: "whose?", done: true, actions: [] }));
    await expect(next).rejects.toMatchObject({ code: "protocol_error" });
    expect(fake.kills()).toBe(1);
    await expect(
      session.provider.nextTurn(request(), new AbortController().signal),
    ).rejects.toBeInstanceOf(CuaProviderError);
    await session.close();
  });

  it("ends as a provider error when Claude Code refuses the interrupt", async () => {
    const fake = fakeClaudeChild();
    fake.messages.on("message", (message: Json) => {
      if (message.type !== "control_request") return;
      fake.write({
        type: "control_response",
        response: { subtype: "error", request_id: message.request_id, error: "unsupported" },
      });
    });
    const session = await abandonFirstTurn(fake);
    await expect(
      session.provider.nextTurn(request(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "protocol_error" });
    expect(fake.users()).toHaveLength(1);
    expect(fake.kills()).toBe(1);
    await session.close();
  });

  it("ends as a provider error when the interrupt is never acknowledged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fake = fakeClaudeChild();
      const session = await startClaudeSession({ spawnFn: fake.spawnFn });
      const first = new AbortController();
      const stalled = session.provider.nextTurn(request(), first.signal);
      await new Promise((resolve) => fake.messages.once("message", resolve));
      first.abort();
      await expect(stalled).rejects.toThrow("run stopped");
      const next = session.provider.nextTurn(request(), new AbortController().signal);
      const outcome = next.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toMatchObject({ code: "protocol_error" });
      expect(fake.users()).toHaveLength(1);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a stalled Claude turn inside the computer-use loop", () => {
  it("interrupts the stalled attempt and records only the retry's answer", async () => {
    const fake = fakeClaudeChild();
    // Attempt 1 stalls until interrupted; the retry answers at once.
    answerInterrupts(fake, () => fake.users()[0]?.uuid);
    fake.messages.on("message", (message: Json) => {
      if (message.type !== "user" || fake.users().length !== 2) return;
      const reply = { message: "Done after the retry.", done: true, actions: [] };
      fake.write(resultFor(message.uuid, reply, { input_tokens: 20, output_tokens: 4 }));
    });
    const session = await startClaudeSession({ spawnFn: fake.spawnFn });
    let t = 0;
    const result = await runComputerUseLoop({
      instructions: "Finish the synthetic task.",
      provider: session.provider,
      executor: {
        observe: async () => ({ screenshot: Buffer.from("frame"), stateSignature: "s" }),
        execute: async () => undefined,
      },
      persona: { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" },
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      turnTimeoutMs: 50,
      now: () => (t += 1),
    });
    await session.close();

    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("Done after the retry.");
    expect(fake.received.map((message) => message.type)).toEqual([
      "user",
      "control_request",
      "user",
    ]);
    expect(result.trace.tokenUsage).toMatchObject({ input: 20, output: 4 });
    expect(result.trace.interactionUsageIncomplete).toBe(true);
  });
});
