import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  RestrictedCodexDeadline,
  RestrictedCodexTransport,
  closeOwnedCodexProcess,
  ownCodexProcess,
} from "../../../src/actors/codex/restricted-transport.js";

describe("native child cleanup authority", () => {
  it("never signals a PID or process group after the owned native child has exited", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      pid: 12345,
    });
    const owned = ownCodexProcess(child as unknown as ChildProcessWithoutNullStreams);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    const globalKill = vi.spyOn(process, "kill");
    expect(await closeOwnedCodexProcess(owned)).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(globalKill).not.toHaveBeenCalled();
  });

  it("resets aggregate stdout and event budgets only after an admitted host response", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      pid: 12345,
      killed: false,
      exitCode: null,
      signalCode: null,
      spawnargs: [],
      spawnfile: "synthetic",
    });
    const deadline = new RestrictedCodexDeadline(5000);
    const transport = new RestrictedCodexTransport(
      ownCodexProcess(child as unknown as ChildProcessWithoutNullStreams),
      deadline,
    );
    transport.onRequest = async () => ({
      success: true,
      contentItems: [{ type: "inputText", text: "{}" }],
    });
    const payload = "x".repeat(900_000);
    const event = () =>
      child.stdout.write(`${JSON.stringify({ method: "warning", params: { payload } })}\n`);
    for (let index = 0; index < 5; index++) event();
    child.stdout.write(`${JSON.stringify({ id: 900, method: "item/tool/call", params: {} })}\n`);
    await vi.waitFor(() => expect(child.stdin.readableLength).toBeGreaterThan(0));
    for (let index = 0; index < 5; index++) event();
    expect(deadline.code).toBeNull();
    deadline.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
});

describe("native transport while closing", () => {
  function closingTransport(interrupt = true) {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      // true: the signal was delivered, as ChildProcess.kill reports it.
      kill: vi.fn(() => true),
      pid: 12345,
    });
    const deadline = new RestrictedCodexDeadline(5000);
    const transport = new RestrictedCodexTransport(
      ownCodexProcess(child as unknown as ChildProcessWithoutNullStreams),
      deadline,
    );
    const requests = vi.fn(async () => ({}));
    const notifications = vi.fn();
    const losses = vi.fn();
    const truncated = vi.fn();
    transport.onRequest = requests;
    transport.onPolicyOnlyNotification = notifications;
    transport.onPolicyFailure = losses;
    transport.onTruncatedFrame = truncated;
    const written: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    // With an interrupt, close waits for its reply before stopping the process.
    const closed = transport.close(
      interrupt ? { threadId: "thread-1", turnId: "turn-1" } : undefined,
    );
    const send = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
    const finish = async (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
      expect(await closed).toBe(true);
      deadline.close();
    };
    return { child, requests, notifications, losses, truncated, written, send, finish };
  }

  it("declines a server request unhandled and checks each notification", async () => {
    const t = closingTransport();
    t.send({ id: 900, method: "item/tool/call", params: { tool: "humanish_ui" } });
    t.send({ method: "item/completed", params: { item: { type: "commandExecution" } } });
    await vi.waitFor(() => expect(t.notifications).toHaveBeenCalledOnce());
    expect(t.notifications).toHaveBeenCalledWith("item/completed", {
      item: { type: "commandExecution" },
    });
    expect(t.requests).not.toHaveBeenCalled();
    expect(t.written.join("")).toContain('"id":900,"error"');
    expect(t.losses).not.toHaveBeenCalled();
    await t.finish();
  });

  it("parses a last frame without its newline, and records one cut off before humanish stopped it", async () => {
    const whole = closingTransport();
    whole.child.stdout.end(
      JSON.stringify({ method: "item/completed", params: { item: { type: "commandExecution" } } }),
    );
    await vi.waitFor(() => expect(whole.notifications).toHaveBeenCalledOnce());
    expect(whole.losses).not.toHaveBeenCalled();
    await whole.finish();
    // Still waiting for the interrupt reply: humanish has not stopped the process yet.
    const cut = closingTransport();
    cut.child.stdout.end('{"method":"item/completed","params":{"item":{"type":"commandExec');
    await vi.waitFor(() => expect(cut.losses).toHaveBeenCalledWith("codex_protocol_error"));
    expect(cut.notifications).not.toHaveBeenCalled();
    expect(cut.truncated).not.toHaveBeenCalled();
    await cut.finish();
  });

  const partial = '{"method":"item/completed","params":{"item":{"type":"commandExec';

  it.each([
    ["by that signal", null, "SIGTERM"],
    ["with an exit code after it", 0, null],
  ] as const)(
    "reports the size of a frame cut off when humanish's SIGTERM ended the process %s",
    async (_, code, signal) => {
      const t = closingTransport(false);
      await vi.waitFor(() => expect(t.child.kill).toHaveBeenCalledWith("SIGTERM"));
      t.child.stdout.end(partial);
      await t.finish(code, signal);
      await vi.waitFor(() => expect(t.truncated).toHaveBeenCalledWith(Buffer.byteLength(partial)));
      expect(t.losses).not.toHaveBeenCalled();
    },
  );

  it("records a frame cut off when the process ended by a signal humanish did not send", async () => {
    const t = closingTransport(false);
    await vi.waitFor(() => expect(t.child.kill).toHaveBeenCalledWith("SIGTERM"));
    t.child.stdout.end(partial);
    await t.finish(null, "SIGSEGV");
    await vi.waitFor(() => expect(t.losses).toHaveBeenCalledWith("codex_protocol_error"));
    expect(t.truncated).not.toHaveBeenCalled();
  });

  it("records a frame cut off by a process that exited before humanish closed it", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      pid: 12345,
    });
    const deadline = new RestrictedCodexDeadline(5000);
    const transport = new RestrictedCodexTransport(
      ownCodexProcess(child as unknown as ChildProcessWithoutNullStreams),
      deadline,
    );
    const losses = vi.fn();
    const truncated = vi.fn();
    transport.onPolicyFailure = losses;
    transport.onTruncatedFrame = truncated;
    // The scoped review's sequence: a partial frame, an exit on its own, then humanish closes.
    child.stdout.write(partial);
    child.emit("exit", 0, null);
    const closed = transport.close();
    child.stdout.end();
    await vi.waitFor(() => expect(losses).toHaveBeenCalledWith("codex_protocol_error"));
    expect(child.kill).not.toHaveBeenCalled();
    expect(truncated).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    expect(await closed).toBe(true);
    deadline.close();
  });

  it("records a line it could not check", async () => {
    const t = closingTransport();
    t.child.stdout.write("{not-json}\n");
    await vi.waitFor(() => expect(t.losses).toHaveBeenCalledWith("codex_protocol_error"));
    t.child.stdout.write(`${"x".repeat(2 * 1024 * 1024 + 1)}`);
    await vi.waitFor(() => expect(t.losses).toHaveBeenCalledWith("response_too_large"));
    expect(t.notifications).not.toHaveBeenCalled();
    await t.finish();
  });
});

describe("native transport between requests", () => {
  it("reports output it could not check, so the session can record it", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      pid: 12345,
    });
    const deadline = new RestrictedCodexDeadline(5000);
    const transport = new RestrictedCodexTransport(
      ownCodexProcess(child as unknown as ChildProcessWithoutNullStreams),
      deadline,
    );
    const losses = vi.fn();
    transport.onPolicyFailure = losses;
    child.stdout.write("{not-json}\n");
    await vi.waitFor(() => expect(losses).toHaveBeenCalledWith("codex_protocol_error"));
    expect(deadline.code).toBe("codex_protocol_error");
    deadline.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
});

describe("native transport after its deadline stopped", () => {
  it("keeps checking notifications after a reply to no request stopped it", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      pid: 12345,
    });
    const deadline = new RestrictedCodexDeadline(5000);
    const transport = new RestrictedCodexTransport(
      ownCodexProcess(child as unknown as ChildProcessWithoutNullStreams),
      deadline,
    );
    const notifications = vi.fn();
    const policyOnly = vi.fn();
    const failures = vi.fn();
    transport.onNotification = notifications;
    transport.onPolicyOnlyNotification = policyOnly;
    transport.onPolicyFailure = failures;
    child.stdout.write(`${JSON.stringify({ id: 5, result: {} })}\n`);
    child.stdout.end(
      `${JSON.stringify({ id: 6, result: {} })}\n` +
        JSON.stringify({
          method: "item/completed",
          params: { item: { type: "commandExecution" } },
        }),
    );
    await vi.waitFor(() => expect(policyOnly).toHaveBeenCalledOnce());
    expect(deadline.code).toBe("codex_protocol_error");
    expect(notifications).not.toHaveBeenCalled();
    expect(failures).not.toHaveBeenCalled();
    deadline.close();
    child.stdin.destroy();
    child.stderr.destroy();
  });
});
