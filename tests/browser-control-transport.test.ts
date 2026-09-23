import { Duplex } from "node:stream";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { BrowserControlTransport } from "../src/browser-control-transport.js";
import { BROWSER_CONTROL_LIMITS } from "../src/browser-control-protocol.js";
import { frame, pair, tick } from "./browser-control-fixture.js";

describe("browser control byte framing", () => {
  it("contains queued native errors from rejected streams without crashing Node or retaining listeners", () => {
    // No uncaughtException/error handler in the subprocess: the old constructor
    // crashes after ready() has already returned its safe rejection.
    const source = new URL("../src/browser-control-client.ts", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { PassThrough } from 'node:stream';
      import { createBrowserControlClient } from ${JSON.stringify(source)};
      const tick = () => new Promise(resolve => setImmediate(resolve));
      for (const mode of ['destroying', 'closed', 'object-mode']) {
        const stream = new PassThrough({ objectMode: mode === 'object-mode' });
        if (mode === 'closed') { stream.destroy(); await tick(); }
        else stream.destroy(new Error('synthetic pending transport error'));
        const client = createBrowserControlClient({ transport: stream,
          identity: { generation: 'g', challenge: 'c', runtimeRevision: 'r' } });
        await assert.rejects(client.ready(), { code: 'executor_closed', disposition: 'not_dispatched' });
        await tick(); await tick();
        assert.equal(stream.destroyed, true);
        assert.equal(stream.listenerCount('error'), 0);
        assert.equal(stream.listenerCount('close'), 0);
        client.close();
      }
      process.stdout.write('contained\\n');
    `], { encoding: "utf8", timeout: 10_000 });
    expect(output).toBe("contained\n");
  });
  it("decodes fragmented headers/bodies and coalesced frames exactly once", async () => {
    const pipes = pair(true), frames = vi.fn(), closed = vi.fn();
    const transport = new BrowserControlTransport(pipes.right, frames, closed);
    pipes.left.write(Buffer.concat([frame({ one: 1 }), frame({ two: 2 })])); await tick();
    expect(frames.mock.calls).toEqual([[{ one: 1 }], [{ two: 2 }]]); expect(closed).not.toHaveBeenCalled(); transport.close();
  });
  it.each([0, BROWSER_CONTROL_LIMITS.frameBytes + 1, 0xffffffff])("rejects oversized/empty header %s without receiving its body", async size => {
    const pipes = pair(), frames = vi.fn(), closed = vi.fn();
    const transport = new BrowserControlTransport(pipes.right, frames, closed);
    const header = Buffer.alloc(4); header.writeUInt32BE(size); pipes.left.write(header); await tick();
    expect(transport.closed).toBe(true); expect(frames).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce();
  });
  it.each([Buffer.from([0, 0]), Buffer.from([0, 0, 0, 4, 123])])("rejects truncated frame on EOF", async bytes => {
    const pipes = pair(), frames = vi.fn(), closed = vi.fn();
    new BrowserControlTransport(pipes.right, frames, closed); pipes.left.write(bytes); pipes.left.destroy(); await tick();
    expect(closed).toHaveBeenCalledWith("invalid_response"); expect(frames).not.toHaveBeenCalled();
  });
  it.each([Buffer.from([0xc3, 0x28]), Buffer.from("{broken"), Buffer.from('{"x":NaN}')])("rejects malformed UTF-8/JSON without raw errors", async body => {
    const pipes = pair(), closed = vi.fn(); new BrowserControlTransport(pipes.right, vi.fn(), closed);
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length); pipes.left.write(Buffer.concat([header, body])); await tick();
    expect(closed).toHaveBeenCalledWith("invalid_response");
  });
  it("rejects a second pending write and settles a backpressured write on close", async () => {
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, _callback) {} });
    const transport = new BrowserControlTransport(stream, vi.fn(), vi.fn());
    const pending = transport.send({ hello: true });
    await expect(transport.send({ second: true })).rejects.toMatchObject({ code: "executor_busy", disposition: "not_dispatched" });
    transport.close("deadline_exceeded");
    await expect(pending).rejects.toMatchObject({ code: "deadline_exceeded", disposition: "outcome_uncertain" });
    expect(stream.destroyed).toBe(true);
  });
  it("rejects outgoing frames before write and destroys only its owned stream", async () => {
    const pipes = pair(), transport = new BrowserControlTransport(pipes.left, vi.fn(), vi.fn());
    await expect(transport.send("x".repeat(BROWSER_CONTROL_LIMITS.frameBytes))).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(pipes.leftWrites).toHaveLength(0); transport.close();
  });
  it("expires partial-frame assembly without renewing the deadline for trickled bytes", async () => {
    vi.useFakeTimers();
    const pipes = pair(), closed = vi.fn();
    const transport = new BrowserControlTransport(pipes.right, vi.fn(), closed);
    try {
      pipes.left.write(Buffer.from([0]));
      await vi.advanceTimersByTimeAsync(30_000);
      pipes.left.write(Buffer.from([0]));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(closed).toHaveBeenCalledWith("deadline_exceeded");
    } finally { transport.close(); vi.useRealTimers(); }
  });
});
