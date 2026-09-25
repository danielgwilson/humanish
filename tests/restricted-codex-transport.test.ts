import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { RestrictedCodexDeadline, RestrictedCodexTransport, closeOwnedCodexProcess,
  ownCodexProcess } from "../src/restricted-codex-transport.js";

describe("native child cleanup authority", () => {
  it("never signals a PID or process group after the owned native child has exited", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: 12345 });
    const owned = ownCodexProcess(child as unknown as ChildProcessWithoutNullStreams);
    child.emit("exit", 0, null); child.emit("close", 0, null);
    const globalKill = vi.spyOn(process, "kill");
    expect(await closeOwnedCodexProcess(owned)).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(globalKill).not.toHaveBeenCalled();
  });

  it("resets aggregate stdout and event budgets only after an admitted host response", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(), pid: 12345, killed: false, exitCode: null, signalCode: null, spawnargs: [], spawnfile: "synthetic" });
    const deadline = new RestrictedCodexDeadline(5000);
    const transport = new RestrictedCodexTransport(ownCodexProcess(child as unknown as ChildProcessWithoutNullStreams), deadline);
    transport.onRequest = async () => ({ success: true, contentItems: [{ type: "inputText", text: "{}" }] });
    const payload = "x".repeat(900_000);
    const event = () => child.stdout.write(`${JSON.stringify({ method: "warning", params: { payload } })}\n`);
    for (let index = 0; index < 5; index++) event();
    child.stdout.write(`${JSON.stringify({ id: 900, method: "item/tool/call", params: {} })}\n`);
    await vi.waitFor(() => expect(child.stdin.readableLength).toBeGreaterThan(0));
    for (let index = 0; index < 5; index++) event();
    expect(deadline.code).toBeNull();
    deadline.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
});
