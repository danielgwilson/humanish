import { Duplex } from "node:stream";
import { PNG } from "pngjs";
import { vi } from "vitest";
import type { CuaExecutor, CuaObservation } from "../src/computer-use.js";
import { createBrowserControlClient } from "../src/browser-control-client.js";
import { attachBrowserControlDispatcher } from "../src/browser-control-dispatcher.js";
export const identity = { generation: "generation-1", challenge: "synthetic-challenge", runtimeRevision: "fixture-v1" };
export function png(): Buffer { return PNG.sync.write(new PNG({ width: 2, height: 2 })); }
export function observation(): CuaObservation { return { screenshot: png(), stateSignature: "fixture-state", url: "https://example.test/", title: "Notes", text: "Empty", scrollY: 0.125 }; }
export function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value)); const result = Buffer.alloc(body.length + 4);
  result.writeUInt32BE(body.length); body.copy(result, 4); return result;
}
export function request(seq = 1, operation: "HELLO" | "OBSERVE" | "EXECUTE" = "HELLO", extra = {}): object {
  return { version: 1, type: "request", identity, seq, requestId: `request-${seq}`, operation, ...extra };
}
export function reply(seq = 1, operation: "HELLO" | "OBSERVE" | "EXECUTE" = "HELLO", extra = {}): object {
  return { version: 1, type: "reply", identity, seq, requestId: `request-${seq}`, operation, ok: true, ...extra };
}
export function pair(fragment = false): { left: Duplex; right: Duplex; leftWrites: Buffer[]; rightWrites: Buffer[] } {
  const leftWrites: Buffer[] = [], rightWrites: Buffer[] = [];
  let left: Duplex, right: Duplex;
  const endpoint = (peer: () => Duplex, writes: Buffer[]): Duplex => new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      if (fragment) for (let i = 0; i < chunk.length; i += 3) peer().push(chunk.subarray(i, i + 3));
      else peer().push(chunk);
      callback();
    },
    destroy(_error, callback) { queueMicrotask(() => { if (!peer().destroyed) peer().push(null); }); callback(); }
  });
  left = endpoint(() => right, leftWrites); right = endpoint(() => left, rightWrites);
  return { left, right, leftWrites, rightWrites };
}
export function setup(options: { executor?: CuaExecutor; timeoutMs?: number; fragment?: boolean; authorized?: () => boolean; speechEnabled?: boolean } = {}) {
  const pipes = pair(options.fragment);
  const authority = new AbortController();
  const observe = vi.fn(async () => observation()), execute = vi.fn(async () => {});
  const server = attachBrowserControlDispatcher({ transport: pipes.right, identity, executor: options.executor ?? { observe, execute },
    authoritySignal: authority.signal, isAuthorized: options.authorized ?? (() => true) });
  const client = createBrowserControlClient({ transport: pipes.left, identity, requestTimeoutMs: options.timeoutMs ?? 200,
    ...(options.speechEnabled === true ? { speechEnabled: true } : {}) });
  return { ...pipes, authority, observe, execute, server, client, close: () => { client.close(); server.close(); } };
}
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
