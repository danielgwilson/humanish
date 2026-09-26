import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createBrowserControlClient } from "../src/browser-control-client.js";
import { attachBrowserControlDispatcher } from "../src/browser-control-dispatcher.js";
import { BrowserControlTransport } from "../src/browser-control-transport.js";
import { CuaExecutorError } from "../src/cua-executor-error.js";
import { frame, identity, observation, pair, reply, request, setup, tick } from "./browser-control-fixture.js";

const click = { kind: "click" as const, x: 12.125, y: 15.75 };

describe("browser control client and dispatcher", () => {
  it("handshakes and transfers PNG/browser state and full fractional actions over fragmented bytes", async () => {
    const heardSpeech = [{ id: "utterance-1", source: "speaker_audio" as const, text: "Hello", durationMs: 500 }];
    const speak = { kind: "speak" as const, text: "I can hear you." };
    const execute = vi.fn(async () => {}), observe = vi.fn(async () => ({ ...observation(), heardSpeech }));
    const f = setup({ fragment: true, speechEnabled: true, executor: { speechEnabled: true,
      observe, execute } });
    await f.client.ready(); expect(execute).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
    expect(f.client.executor.speechEnabled).toBe(true);
    expect(await f.client.executor.observe()).toEqual({ ...observation(), heardSpeech }); await f.client.executor.execute(speak);
    expect(execute).toHaveBeenCalledWith(speak, expect.any(AbortSignal));
    const sent = f.leftWrites.map(bytes => JSON.parse(bytes.subarray(4).toString()));
    expect(sent.map(value => value.operation)).toEqual(["HELLO", "OBSERVE", "EXECUTE"]);
    expect(sent[2].action).toEqual(speak);
    f.close();
  });
  it("rejects concurrent operations including during HELLO rather than queuing", async () => {
    const f = setup(); const first = f.client.ready();
    await expect(f.client.executor.execute(click)).rejects.toMatchObject({ code: "executor_busy", disposition: "not_dispatched" });
    await first; expect(f.execute).not.toHaveBeenCalled(); f.close();
  });
  it("validates input and pre-aborted signals before any write", async () => {
    const f = setup(), signal = AbortSignal.abort();
    await expect(f.client.executor.execute(click, signal)).rejects.toMatchObject({ code: "cancelled", disposition: "not_dispatched" });
    await expect(f.client.executor.execute({ kind: "type", text: "x".repeat(65537) })).rejects.toMatchObject({ code: "invalid_request", disposition: "not_dispatched" });
    expect(f.leftWrites).toHaveLength(0); expect(f.execute).not.toHaveBeenCalled(); f.close();
  });
  it("rejects speech before writing unless the optional media capability was admitted", async () => {
    const f = setup();
    await expect(f.client.executor.execute({ kind: "speak", text: "Hello" }))
      .rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
    expect(f.leftWrites).toHaveLength(0); expect(f.execute).not.toHaveBeenCalled(); f.close();
  });
  it.each(["seq", "generation", "challenge", "revision", "operation", "extra", "version"])("terminally rejects stale or malformed %s replies", async mode => {
    const pipes = pair();
    const server = new BrowserControlTransport(pipes.right, () => {
      const value: any = reply();
      if (mode === "seq") value.seq = 2;
      if (mode === "generation") value.identity = { ...identity, generation: "stale" };
      if (mode === "challenge") value.identity = { ...identity, challenge: "stale" };
      if (mode === "revision") value.identity = { ...identity, runtimeRevision: "stale" };
      if (mode === "operation") value.operation = "OBSERVE";
      if (mode === "extra") value.secret = "synthetic-private";
      if (mode === "version") value.version = 2;
      void server.send(value).catch(() => {});
    }, () => {});
    const client = createBrowserControlClient({ transport: pipes.left, identity, requestTimeoutMs: 50 });
    await expect(client.ready()).rejects.toBeInstanceOf(CuaExecutorError);
    await expect(client.executor.execute(click)).rejects.toMatchObject({ code: "executor_closed", disposition: "not_dispatched" });
    client.close(); server.close();
  });
  it("closes on duplicate acknowledgement and never replays an action", async () => {
    const pipes = pair();
    const server = new BrowserControlTransport(pipes.right, () => pipes.right.write(Buffer.concat([frame(reply()), frame(reply())])), () => {});
    const client = createBrowserControlClient({ transport: pipes.left, identity });
    await client.ready().catch(() => {}); await tick();
    await expect(client.executor.execute(click)).rejects.toMatchObject({ code: "executor_closed" });
    expect(pipes.leftWrites).toHaveLength(1); server.close();
  });
  it("reports lost action acknowledgement as uncertain and refuses later work", async () => {
    const execute = vi.fn(async () => {}), pipes = pair();
    const peer = new BrowserControlTransport(pipes.right, value => {
      const req = value as { operation: string; seq: number };
      if (req.operation === "HELLO") void peer.send(reply()).catch(() => {});
      else { void execute(); pipes.right.destroy(); }
    }, () => {});
    const client = createBrowserControlClient({ transport: pipes.left, identity, requestTimeoutMs: 100 });
    await client.ready(); await expect(client.executor.execute(click)).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    await expect(client.executor.execute(click)).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(execute).toHaveBeenCalledOnce(); peer.close();
  });
  it("terminally closes on an explicit uncertain error even when the peer keeps its channel open", async () => {
    const pipes = pair();
    const peer = new BrowserControlTransport(pipes.right, value => {
      const req = value as { operation: string; seq: number };
      void peer.send(req.operation === "HELLO" ? reply() : reply(req.seq, "EXECUTE", { actionId: `action-${req.seq}`,
        ok: false, error: { code: "execution_failed", disposition: "outcome_uncertain" } })).catch(() => {});
    }, () => {});
    const client = createBrowserControlClient({ transport: pipes.left, identity }); await client.ready();
    await expect(client.executor.execute(click)).rejects.toMatchObject({ code: "execution_failed", disposition: "outcome_uncertain" });
    const writes = pipes.leftWrites.length;
    await expect(client.executor.execute(click)).rejects.toMatchObject({ code: "executor_closed", disposition: "not_dispatched" });
    expect(pipes.leftWrites).toHaveLength(writes); peer.close();
  });
  it("deadline poisons the channel and rejects a late acknowledgement", async () => {
    const pipes = pair(); let sequence = 0;
    const peer = new BrowserControlTransport(pipes.right, value => {
      const req = value as { operation: string; seq: number }; sequence = req.seq;
      if (req.operation === "HELLO") void peer.send(reply()).catch(() => {});
    }, () => {});
    const client = createBrowserControlClient({ transport: pipes.left, identity, requestTimeoutMs: 25 }); await client.ready();
    await expect(client.executor.execute(click)).rejects.toMatchObject({ code: "deadline_exceeded", disposition: "outcome_uncertain" });
    await expect(peer.send(reply(sequence, "EXECUTE", { actionId: `action-${sequence}` }))).rejects.toBeInstanceOf(CuaExecutorError);
    await expect(client.executor.observe()).rejects.toMatchObject({ code: "executor_closed" }); peer.close();
  });
  it("cancels during a delayed write callback with uncertainty, even if no callback acknowledgement arrived", async () => {
    let release: (() => void) | undefined;
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { release = callback; } });
    const client = createBrowserControlClient({ transport: stream, identity, requestTimeoutMs: 100 });
    const ready = client.ready(); client.close();
    await expect(ready).rejects.toMatchObject({ disposition: "outcome_uncertain" }); release?.();
    expect(stream.destroyed).toBe(true);
  });
  it("bounds a nonreading peer and does not buffer a second request", async () => {
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, _callback) {} });
    const client = createBrowserControlClient({ transport: stream, identity, requestTimeoutMs: 15 });
    const first = client.ready(); await expect(client.ready()).rejects.toMatchObject({ code: "executor_busy" });
    await expect(first).rejects.toMatchObject({ code: "deadline_exceeded", disposition: "outcome_uncertain" });
    expect(stream.destroyed).toBe(true);
  });
  it("aborts driver preparation on authority revocation without delivering a browser input", async () => {
    let prepared!: () => void, release!: () => void, driverSignal: AbortSignal | undefined;
    const started = new Promise<void>(resolve => { prepared = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; }); const input = vi.fn();
    const f = setup({ executor: { observe: async () => observation(), execute: async (_action, signal) => {
      driverSignal = signal; prepared(); await resume;
      if (signal?.aborted) throw new CuaExecutorError("session_revoked", "not_dispatched");
      input();
    } } });
    await f.client.ready(); const pending = f.client.executor.execute(click); await started;
    f.authority.abort(); release();
    await expect(pending).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    expect(driverSignal?.aborted).toBe(true); expect(input).not.toHaveBeenCalled();
    await expect(f.client.executor.execute(click)).rejects.toMatchObject({ code: "executor_closed" }); f.close();
  });
  it("aborts driver preparation when caller cancels after writing and never retries", async () => {
    let prepared!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { prepared = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; }); const input = vi.fn();
    const f = setup({ executor: { observe: async () => observation(), execute: async (_action, signal) => {
      prepared(); await resume; if (signal?.aborted) throw new CuaExecutorError("cancelled", "not_dispatched"); input();
    } } });
    const abort = new AbortController(); await f.client.ready(); const pending = f.client.executor.execute(click, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled", disposition: "outcome_uncertain" }); await started;
    abort.abort(); await tick(); release();
    await rejected;
    expect(input).not.toHaveBeenCalled(); f.close();
  });
  it("rechecks authority on the actual request and returns a safe pre-dispatch refusal", async () => {
    let authorized = true; const f = setup({ authorized: () => authorized });
    await f.client.ready(); authorized = false;
    await expect(f.client.executor.execute(click)).rejects.toMatchObject({ code: "session_revoked", disposition: "not_dispatched" });
    expect(f.execute).not.toHaveBeenCalled(); f.close();
  });
  it("does not mislabel a driver exception after invocation as a pre-dispatch refusal", async () => {
    const secret = "synthetic unshareable error";
    const f = setup({ executor: { observe: async () => observation(), execute: async () => { throw new Error(secret); } } });
    await f.client.ready(); const error = await f.client.executor.execute(click).catch(error => error);
    expect(error).toMatchObject({ code: "action_rejected", disposition: "outcome_uncertain" });
    expect(JSON.stringify(f.rightWrites.map(bytes => bytes.toString()))).not.toContain(secret); f.close();
  });
  it("keeps the channel usable after a genuine pre-dispatch rejection", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new CuaExecutorError("action_rejected", "not_dispatched")).mockResolvedValue(undefined);
    const f = setup({ executor: { observe: async () => observation(), execute } });
    await expect(f.client.executor.execute(click)).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
    await expect(f.client.executor.observe()).resolves.toHaveProperty("screenshot");
    await expect(f.client.executor.execute(click)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2); f.close();
  });
  it("still closes the channel when an observation is rejected before dispatch", async () => {
    const f = setup({ executor: { observe: async () => { throw new CuaExecutorError("action_rejected", "not_dispatched"); }, execute: async () => {} } });
    await expect(f.client.executor.observe()).rejects.toMatchObject({ code: "action_rejected" });
    await expect(f.client.executor.execute(click)).rejects.toMatchObject({ code: "executor_closed" }); f.close();
  });
  it.each([
    request(1, "EXECUTE", { actionId: "action-1", action: click }), request(1, "HELLO", { secret: "extra" }),
    { ...request(), version: 99 }, { ...request(), identity: { ...identity, generation: "stale" } },
    request(1, "HELLO", { operation: "CDP" })
  ])("malformed/unready input causes zero browser calls", async value => {
    const pipes = pair(), observe = vi.fn(), execute = vi.fn(), authority = new AbortController();
    const server = attachBrowserControlDispatcher({ transport: pipes.right, identity, executor: { observe, execute }, authoritySignal: authority.signal, isAuthorized: () => true });
    pipes.left.write(frame(value)); await tick(); expect(execute).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(pipes.right.destroyed).toBe(true); server.close();
  });
  it("rejects coalesced action/duplicate frames with at most one driver invocation", async () => {
    const pipes = pair(), authority = new AbortController();
    const execute = vi.fn(async () => { await new Promise<void>(() => {}); });
    const server = attachBrowserControlDispatcher({ transport: pipes.right, identity, executor: { observe: async () => observation(), execute }, authoritySignal: authority.signal, isAuthorized: () => true });
    pipes.left.write(frame(request())); await tick();
    const action = frame(request(2, "EXECUTE", { actionId: "action-2", action: click })); pipes.left.write(Buffer.concat([action, action])); await tick();
    expect(execute).toHaveBeenCalledOnce(); expect(pipes.right.destroyed).toBe(true); server.close();
  });
});
