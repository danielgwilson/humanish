import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { closeOwnedCodexProcess, ownCodexProcess } from "../src/restricted-codex-transport.js";

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
});
