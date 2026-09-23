import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_CONTROL_LIMITS } from "../src/browser-control-protocol.js";
import { createGuestDesktopNativeTools } from "../src/guest-desktop-native.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

/** Only the native process boundary is mocked; capture ownership uses real files. */
class Helper extends EventEmitter {
  readonly received: Buffer[] = [];
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, done) => { this.received.push(Buffer.from(chunk)); done(); }
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal: string) => true);
  exited = false;
  exit(code = 0): void {
    this.exited = true;
    this.emit("exit", code, null);
  }
  close(code = 0): void {
    if (!this.exited) this.exit(code);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
}

function outcome<T>(promise: Promise<T>) {
  // Attach rejection observation before advancing a deadline or emitting a fault.
  return promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
}

describe("guest native helper ownership and failure bounds", () => {
  let directory: string;
  let helper: Helper;
  let spawned: Promise<void>;
  let tools: ReturnType<typeof createGuestDesktopNativeTools>;
  let authority: AbortController;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "humanish-native-helper-test-"));
    helper = new Helper();
    authority = new AbortController();
    spawned = new Promise(resolve => {
      spawnMock.mockReset().mockImplementation(() => { resolve(); return helper; });
    });
    tools = createGuestDesktopNativeTools({ display: ":91", temporaryDirectory: directory, xauthority: join(directory, "xauth") });
  });
  afterEach(async () => {
    helper.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("launches a fixed input helper with only the explicit guest environment", async () => {
    vi.stubEnv("HUMANISH_TEST_OPERATOR_SECRET", "synthetic-operator-secret");
    vi.stubEnv("XAUTHORITY", "/synthetic/operator/authority");
    const result = outcome(tools.input(["mousemove", "12", "34"], authority.signal));
    expect(spawnMock).toHaveBeenCalledOnce();
    const [binary, args, options] = spawnMock.mock.calls[0]!;
    expect(binary).toBe("/usr/bin/xdotool");
    expect(args).toEqual(["mousemove", "12", "34"]);
    expect(options).toEqual({ cwd: directory, stdio: ["pipe", "pipe", "pipe"], env: {
      PATH: "/usr/bin:/bin", HOME: directory, DISPLAY: ":91", XAUTHORITY: join(directory, "xauth"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8"
    } });
    expect(Buffer.concat(helper.received).toString("utf8")).toBe("");
    expect(helper.stdin.writableEnded).toBe(true);
    helper.close();
    expect((await result).error).toBeUndefined();
    authority.abort();
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it("refuses pre-aborted input without creating a child", async () => {
    authority.abort();
    await expect(tools.input(["click", "1"], authority.signal)).rejects.toMatchObject({ code: "session_revoked", disposition: "not_dispatched" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(["spawn error", "stdin error", "nonzero close"])("sanitizes %s without a retry", async fault => {
    const result = outcome(tools.input(["click", "1"], authority.signal));
    if (fault === "spawn error") helper.emit("error", new Error("synthetic private diagnostic"));
    if (fault === "stdin error") helper.stdin.emit("error", new Error("synthetic private diagnostic"));
    helper.close(9);
    const error = (await result).error;
    expect(error).toMatchObject({ code: "execution_failed", disposition: "outcome_uncertain", message: "Desktop executor could not complete the request." });
    expect(String(error)).not.toContain("synthetic private");
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it.each(["stdout", "stderr", "combined"])("bounds aggregate %s output without exposing it", async channel => {
    const result = outcome(tools.input(["mousemove", "1", "2"], authority.signal));
    if (channel === "stdout") helper.stdout.write(Buffer.alloc(16_385, 65));
    if (channel === "stderr") helper.stderr.write(Buffer.alloc(16_385, 66));
    if (channel === "combined") { helper.stdout.write(Buffer.alloc(8192, 65)); helper.stderr.write(Buffer.alloc(8193, 66)); }
    expect(helper.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    helper.close(0);
    expect((await result).error).toMatchObject({ code: "execution_failed", disposition: "outcome_uncertain", message: "Desktop executor could not complete the request." });
  });

  it("waits for close, rather than treating exit as completed stdio", async () => {
    let settled = false;
    const result = outcome(tools.input(["click", "1"], authority.signal)).then(value => { settled = true; return value; });
    helper.exit(0);
    await Promise.resolve();
    expect(settled).toBe(false);
    helper.close(0);
    expect((await result).error).toBeUndefined();
  });

  it("kills only the acquired child on abort and waits for its close", async () => {
    vi.useFakeTimers();
    let settled = false;
    const result = outcome(tools.input(["mousedown", "1"], authority.signal)).then(value => { settled = true; return value; });
    authority.abort();
    expect(helper.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    helper.close(1);
    expect((await result).error).toMatchObject({ code: "session_revoked", disposition: "outcome_uncertain" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the native deadline and does not replay the action", async () => {
    vi.useFakeTimers();
    const result = outcome(tools.input(["click", "1"], authority.signal));
    await vi.advanceTimersByTimeAsync(9999);
    expect(helper.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(helper.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    helper.close(1);
    expect((await result).error).toMatchObject({ code: "deadline_exceeded", disposition: "outcome_uncertain" });
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "deadline", "output overflow", "stdin error"])("never signals an exited child after %s", async fault => {
    vi.useFakeTimers();
    const result = outcome(tools.input(["click", "1"], authority.signal));
    helper.exit(0);
    if (fault === "abort") authority.abort();
    if (fault === "deadline") await vi.advanceTimersByTimeAsync(10_000);
    if (fault === "output overflow") helper.stdout.write(Buffer.alloc(16_385));
    if (fault === "stdin error") helper.stdin.emit("error", new Error("synthetic private diagnostic"));
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).error).toMatchObject({ disposition: "outcome_uncertain" });
    expect(helper.kill).not.toHaveBeenCalled();
    helper.close(0); // Late stdio closure releases the retained listeners/timers only.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(helper.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds never-closing input and handles a late close without another kill", async () => {
    vi.useFakeTimers();
    const result = outcome(tools.input(["click", "1"], authority.signal));
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await result).error).toMatchObject({ code: "execution_failed", disposition: "outcome_uncertain" });
    expect(helper.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    helper.close(0);
    authority.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(helper.kill).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures owned bytes and removes only its capture directory after close", async () => {
    const canary = join(directory, "unrelated-canary");
    await writeFile(canary, "keep");
    const result = outcome(tools.capture(authority.signal));
    await spawned;
    const [binary, args] = spawnMock.mock.calls[0]!;
    expect(binary).toBe("/usr/bin/scrot");
    expect(args[0]).toBe("--silent");
    const path = args[1] as string;
    expect(dirname(dirname(path))).toBe(directory);
    await writeFile(path, Buffer.from("synthetic capture bytes"));
    helper.close();
    expect((await result).value).toEqual(Buffer.from("synthetic capture bytes"));
    expect(await readdir(directory)).toEqual(["unrelated-canary"]);
    expect(await readFile(canary, "utf8")).toBe("keep");
  });

  it("cancels during directory preparation without spawning scrot", async () => {
    const result = outcome(tools.capture(authority.signal));
    authority.abort();
    expect((await result).error).toMatchObject({ code: "session_revoked", disposition: "not_dispatched" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes a failed capture only after helper closure is confirmed", async () => {
    const result = outcome(tools.capture(authority.signal));
    await spawned;
    const path = spawnMock.mock.calls[0]![1][1] as string;
    await writeFile(path, "partial capture");
    authority.abort();
    expect(await readdir(directory)).toHaveLength(1);
    helper.close(1);
    expect((await result).error).toMatchObject({ code: "session_revoked" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("retains a never-closed capture through late exit and close for owner recovery", async () => {
    vi.useFakeTimers();
    const result = outcome(tools.capture(authority.signal));
    await spawned;
    const path = spawnMock.mock.calls[0]![1][1] as string;
    await writeFile(path, "possibly still being written");
    authority.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).error).toMatchObject({ disposition: "outcome_uncertain" });
    expect(await readFile(path, "utf8")).toBe("possibly still being written");
    helper.close(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await readFile(path, "utf8")).toBe("possibly still being written");
    expect(helper.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["empty", "oversize", "symlink"])("refuses %s capture files and preserves unrelated bytes", async fault => {
    const canary = join(directory, "unrelated-canary");
    await writeFile(canary, "keep");
    const result = outcome(tools.capture(authority.signal));
    await spawned;
    const path = spawnMock.mock.calls[0]![1][1] as string;
    if (fault === "symlink") await symlink(canary, path);
    else {
      await writeFile(path, "");
      if (fault === "oversize") await truncate(path, BROWSER_CONTROL_LIMITS.pngBytes + 1);
    }
    helper.close();
    expect((await result).error).toBeDefined();
    expect(await readFile(canary, "utf8")).toBe("keep");
    expect(await readdir(directory)).toEqual(["unrelated-canary"]);
  });
});
