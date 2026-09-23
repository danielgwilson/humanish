import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareGuestClipboard } from "../src/guest-desktop-clipboard.js";
import { createGuestDesktopExecutor, type GuestDesktopTools } from "../src/guest-desktop-executor.js";
import { CuaExecutorError } from "../src/cua-executor-error.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

class ClipboardChild extends EventEmitter {
  readonly writes: Buffer[] = [];
  readonly stdin = new Writable({ write: (chunk: Buffer, _encoding, done) => {
    this.writes.push(Buffer.from(chunk)); done();
  } });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal: string) => true);
  exited = false;
  closed = false;
  exit(code = 0): void { this.exited = true; this.emit("exit", code, null); }
  close(code = 0): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.exited) this.exit(code);
    this.stdout.end(); this.stderr.end();
    this.emit("close", code, null);
  }
  reply(value: string): void { this.stdout.write(value); }
  get goCount(): number { return this.writes.filter(value => value.equals(Buffer.from("G"))).length; }
}

function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
}

describe("guest clipboard transaction", () => {
  let child: ClipboardChild;
  let authority: AbortController;
  const environment = { DISPLAY: ":91", XAUTHORITY: "/synthetic/guest/xauth", LC_ALL: "C.UTF-8" };
  const prepare = (text = "synthetic text") => prepareGuestClipboard({ text, signal: authority.signal, environment, directory: "/synthetic/guest" });
  async function ready() {
    const pending = prepare();
    child.reply("R");
    return pending;
  }
  beforeEach(() => {
    child = new ClipboardChild();
    authority = new AbortController();
    spawnMock.mockReset().mockReturnValue(child);
  });
  afterEach(() => { child.close(1); vi.useRealTimers(); });

  it("frames UTF-8 on stdin and sends G only after readiness and paste admission", async () => {
    const text = "é e\u0301 中文 😀\nnext\tcell";
    const pending = prepare(text);
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith("/opt/humanish/control/clipboard", [], {
      cwd: "/synthetic/guest", env: environment, stdio: ["pipe", "pipe", "pipe"]
    });
    expect(child.writes).toHaveLength(1);
    expect(child.writes[0]!.readUInt32BE(0)).toBe(Buffer.byteLength(text));
    expect(child.writes[0]!.subarray(4).toString("utf8")).toBe(text);
    expect(child.stdin.writableEnded).toBe(false);
    expect(child.goCount).toBe(0);
    child.reply("R");
    const transaction = await pending;
    expect(child.goCount).toBe(0);
    let settled = false;
    const pasted = outcome(transaction.paste()).then(result => { settled = true; return result; });
    expect(child.goCount).toBe(1);
    child.reply("D");
    await Promise.resolve();
    expect(settled).toBe(false); // D alone is insufficient without native close.
    child.exit(0);
    await Promise.resolve();
    expect(settled).toBe(false); // exit alone does not prove stdio completion.
    child.close(0);
    expect((await pasted).error).toBeUndefined();
    await transaction.close();
    await transaction.close();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["", "before\0after", "\ud800", "x".repeat(65_537)])("refuses invalid text before process allocation (case %#)", async text => {
    await expect(prepare(text)).rejects.toMatchObject({ code: "invalid_request", disposition: "not_dispatched" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses pre-aborted preparation without starting a helper", async () => {
    authority.abort();
    await expect(prepare()).rejects.toMatchObject({ code: "session_revoked", disposition: "not_dispatched" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(["before R", "after R"])("cancellation %s sends zero G bytes", async phase => {
    if (phase === "before R") {
      const prepared = outcome(prepare());
      authority.abort(); child.close(1);
      expect((await prepared).error).toMatchObject({ code: "session_revoked", disposition: "not_dispatched" });
    } else {
      const transaction = await ready();
      authority.abort();
      await expect(transaction.paste()).rejects.toMatchObject({ code: "session_revoked", disposition: "not_dispatched" });
      child.close(1); await transaction.close();
    }
    expect(child.goCount).toBe(0);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it.each(["D", "RR", "RD", "garbage", "x".repeat(32_768)])("rejects unsolicited or oversized preparation output (case %#)", async reply => {
    const prepared = outcome(prepare());
    child.reply(reply); child.close(0);
    expect((await prepared).error).toMatchObject({ code: "execution_failed", disposition: "not_dispatched" });
    expect(child.goCount).toBe(0);
  });

  it.each(["R", "D", "garbage"])("rejects output %s after ready without allowing a paste", async reply => {
    const transaction = await ready();
    child.reply(reply);
    await expect(transaction.paste()).rejects.toMatchObject({ code: "execution_failed", disposition: "not_dispatched" });
    child.close(0); await transaction.close();
    expect(child.goCount).toBe(0);
  });

  it("does not issue another G when paste is called twice", async () => {
    const transaction = await ready();
    const first = outcome(transaction.paste());
    await expect(transaction.paste()).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    expect(child.goCount).toBe(1);
    child.reply("D"); child.close(0);
    expect((await first).error).toBeUndefined();
    await expect(transaction.paste()).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    expect(child.goCount).toBe(1);
  });

  it.each(["duplicate D", "garbage", "nonzero close", "missing D"])("does not report delivery after %s", async fault => {
    const transaction = await ready();
    const pasted = outcome(transaction.paste());
    if (fault !== "missing D") child.reply("D");
    if (fault === "duplicate D") child.reply("D");
    if (fault === "garbage") child.reply("x".repeat(32_768));
    child.close(fault === "nonzero close" ? 1 : 0);
    expect((await pasted).error).toMatchObject({ code: "execution_failed", disposition: "outcome_uncertain" });
    await transaction.close();
    expect(child.goCount).toBe(1);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it.each(["error", "stdin", "stderr"])("sanitizes %s diagnostics without exposing text or retrying", async channel => {
    const prepared = outcome(prepare());
    const diagnostic = "synthetic-private-clipboard-text";
    if (channel === "error") child.emit("error", new Error(diagnostic));
    if (channel === "stdin") child.stdin.emit("error", new Error(diagnostic));
    if (channel === "stderr") child.stderr.write(diagnostic);
    child.close(1);
    const error = (await prepared).error;
    expect(error).toMatchObject({ code: "execution_failed", disposition: "not_dispatched", message: "Desktop executor could not complete the request." });
    expect(String(error)).not.toContain(diagnostic);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("rejects exit before readiness without sending G", async () => {
    const prepared = outcome(prepare());
    child.close(0);
    expect((await prepared).error).toMatchObject({ code: "execution_failed", disposition: "not_dispatched" });
    expect(child.goCount).toBe(0);
  });

  it("refuses G after a known native exit even while stdio close is pending", async () => {
    const transaction = await ready();
    child.exit(0);
    const pasted = outcome(transaction.paste());
    expect(child.goCount).toBe(0);
    child.close(0);
    expect((await pasted).error).toMatchObject({ disposition: "not_dispatched" });
    await transaction.close();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("latches the first failure and does not repeatedly signal the same child", async () => {
    vi.useFakeTimers();
    const prepared = outcome(prepare());
    child.stderr.write("first synthetic failure");
    child.stderr.write("later synthetic failure");
    child.reply("D"); authority.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await prepared).error).toMatchObject({ disposition: "not_dispatched" });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.close(1);
  });

  it.each([false, true])("bounds never-closing helper with dispatched=%s and handles late close", async dispatch => {
    vi.useFakeTimers();
    const transaction = await ready();
    const pasted = dispatch ? outcome(transaction.paste()) : undefined;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    const closing = outcome(transaction.close());
    await vi.advanceTimersByTimeAsync(2000);
    expect((await closing).error).toMatchObject({ code: "execution_failed", disposition: dispatch ? "outcome_uncertain" : "not_dispatched" });
    if (pasted) expect((await pasted).error).toMatchObject({ code: "deadline_exceeded", disposition: "outcome_uncertain" });
    expect(child.goCount).toBe(dispatch ? 1 : 0);
    child.close(0);
    authority.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never signals an exited helper on a later deadline or abort", async () => {
    vi.useFakeTimers();
    const transaction = await ready();
    const pasted = outcome(transaction.paste());
    child.reply("D"); child.exit(0);
    authority.abort();
    const closing = outcome(transaction.close());
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await pasted).error).toMatchObject({ disposition: "outcome_uncertain" });
    expect((await closing).error).toMatchObject({ disposition: "outcome_uncertain" });
    expect(child.kill).not.toHaveBeenCalled();
    child.close(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("executor clipboard finalization", () => {
  it.each(["before paste", "after paste"])("failed cleanup %s cannot produce a successful or reusable executor", async phase => {
    const authority = new AbortController();
    const terminal = vi.fn();
    const paste = vi.fn(async () => { throw new CuaExecutorError("deadline_exceeded", "outcome_uncertain"); });
    const close = vi.fn(async () => { throw new Error("synthetic-private-cleanup-detail"); });
    const tools: GuestDesktopTools = {
      capture: vi.fn(async () => Buffer.alloc(0)), input: vi.fn(async () => {}),
      prepareText: vi.fn(async () => {
        if (phase === "before paste") authority.abort();
        return { paste, close };
      })
    };
    const executor = createGuestDesktopExecutor({ width: 100, height: 100, tools, authoritySignal: authority.signal, onTerminal: terminal });
    await expect(executor.execute({ kind: "type", text: "synthetic" })).rejects.toMatchObject({
      code: "execution_failed", disposition: phase === "before paste" ? "not_dispatched" : "outcome_uncertain",
      message: "Desktop executor could not complete the request."
    });
    expect(paste).toHaveBeenCalledTimes(phase === "before paste" ? 0 : 1);
    expect(close).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledOnce();
    await expect(executor.execute({ kind: "click", x: 1, y: 1 })).rejects.toMatchObject({ code: "session_revoked" });
    expect(tools.input).not.toHaveBeenCalled();
  });
});
