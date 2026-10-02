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
  function closingTransport() {
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
    const requests = vi.fn(async () => ({}));
    const notifications = vi.fn();
    const losses = vi.fn();
    transport.onRequest = requests;
    transport.onClosingNotification = notifications;
    transport.onClosingLoss = losses;
    const written: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const closed = transport.close({ threadId: "thread-1", turnId: "turn-1" });
    const send = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
    const finish = async () => {
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      expect(await closed).toBe(true);
      deadline.close();
    };
    return { child, requests, notifications, losses, written, send, finish };
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
