import { describe, expect, it, vi } from "vitest";
import { createGuestBrowserTools } from "../src/guest-browser-tools.js";
import { createGuestDesktopExecutor } from "../src/guest-desktop-executor.js";
import type { GuestDesktopNativeTools } from "../src/guest-desktop-native.js";
import { CuaExecutorError } from "../src/cua-executor-error.js";

const navigation = ["key", "--clearmodifiers", "ctrl+l"];
function fixture() {
  const authority = new AbortController();
  const native: GuestDesktopNativeTools = {
    input: vi.fn(async () => {}), capture: vi.fn(async () => Buffer.alloc(0)),
    activeWindowId: vi.fn(async () => "123"), typeAscii: vi.fn(async () => {})
  };
  const contentTransaction = { paste: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const content = {
    prepareText: vi.fn(async () => contentTransaction), assertReady: vi.fn(async (_signal: AbortSignal) => {})
  };
  const tools = createGuestBrowserTools(native, content);
  return { authority, native, content, contentTransaction, tools };
}

describe("owned browser text routing", () => {
  it("routes normal text unchanged to the content port without native typing", async () => {
    const f = fixture();
    const text = "日本🙂e\u0301\nnext\tcell";
    const transaction = await f.tools.prepareText(text, f.authority.signal);
    await transaction.paste(); await transaction.close();
    expect(f.content.prepareText).toHaveBeenCalledExactlyOnceWith(text, f.authority.signal);
    expect(f.contentTransaction.paste).toHaveBeenCalledOnce();
    expect(f.native.input).not.toHaveBeenCalled();
    expect(f.native.typeAscii).not.toHaveBeenCalled();
  });

  it("admits an explicit address-bar action and consumes its arm once", async () => {
    const f = fixture();
    await f.tools.input(navigation, f.authority.signal);
    await f.tools.capture(f.authority.signal); // Looking does not change navigation intent.
    const transaction = await f.tools.prepareText("https://example.test/a?b=1", f.authority.signal);
    await transaction.paste(); await transaction.close();
    expect(f.native.typeAscii).toHaveBeenCalledExactlyOnceWith("https://example.test/a?b=1", f.authority.signal);
    expect(f.content.prepareText).not.toHaveBeenCalled();
    await f.tools.prepareText("page text", f.authority.signal);
    expect(f.content.prepareText).toHaveBeenCalledExactlyOnceWith("page text", f.authority.signal);
  });

  it.each([
    ["key", "--clearmodifiers", "alt+d"], ["key", "ctrl+l"], ["key", "--clearmodifiers", "ctrl+L"],
    ["key", "--clearmodifiers", "ctrl+l", "extra"], ["mousemove", "10", "10"], ["click", "1"]
  ].map(args => ({ args })))("does not infer navigation from an unadmitted native action (case %#)", async ({ args }) => {
    const f = fixture();
    await f.tools.input(args, f.authority.signal);
    await f.tools.prepareText("text", f.authority.signal);
    expect(f.content.prepareText).toHaveBeenCalledOnce();
    expect(f.native.typeAscii).not.toHaveBeenCalled();
  });

  it.each(["🙂", "é", "line\nnext", "tab\tcell", "return\rnext", "\0", "\x7f", "", "a".repeat(65_537)])("rejects unsupported chrome text before any additional input (case %#)", async text => {
    const f = fixture();
    await f.tools.input(navigation, f.authority.signal);
    await expect(f.tools.prepareText(text, f.authority.signal)).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
    expect(f.native.input).toHaveBeenCalledOnce();
    expect(f.native.typeAscii).not.toHaveBeenCalled();
    expect(f.content.prepareText).not.toHaveBeenCalled();
  });

  it("invalidates prepared navigation after a different native input", async () => {
    const f = fixture();
    await f.tools.input(navigation, f.authority.signal);
    const transaction = await f.tools.prepareText("https://example.test", f.authority.signal);
    await f.tools.input(["click", "1"], f.authority.signal);
    await expect(transaction.paste()).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.native.input).toHaveBeenCalledTimes(2);
    expect(f.native.typeAscii).not.toHaveBeenCalled();
    expect(f.content.prepareText).not.toHaveBeenCalled();
  });

  it("cannot rearm stale navigation when an earlier Ctrl+L completes after later input", async () => {
    const f = fixture();
    let finish!: () => void;
    vi.mocked(f.native.input).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const old = f.tools.input(navigation, f.authority.signal);
    await f.tools.input(["click", "1"], f.authority.signal);
    finish(); await expect(old).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    await f.tools.prepareText("text", f.authority.signal);
    expect(f.content.prepareText).toHaveBeenCalledOnce();
    expect(f.native.typeAscii).not.toHaveBeenCalled();
  });

  it("does not arm a Ctrl+L whose signal was cancelled during native completion", async () => {
    const f = fixture();
    vi.mocked(f.native.input).mockImplementationOnce(async () => { f.authority.abort(); });
    await f.tools.input(navigation, f.authority.signal).catch(() => {});
    await f.tools.prepareText("text", new AbortController().signal);
    expect(f.content.prepareText).toHaveBeenCalledOnce();
    expect(f.native.typeAscii).not.toHaveBeenCalled();
  });

  it.each(["before prepare", "during prepare", "before paste", "during paste readiness"])("cancellation %s issues no navigation replay or native text", async phase => {
    const f = fixture();
    await f.tools.input(navigation, f.authority.signal);
    if (phase === "before prepare") f.authority.abort();
    if (phase === "during prepare") f.content.assertReady.mockImplementationOnce(async () => { f.authority.abort(); });
    if (phase.includes("prepare")) {
      await expect(f.tools.prepareText("text", f.authority.signal)).rejects.toMatchObject({ disposition: "not_dispatched" });
    } else {
      const transaction = await f.tools.prepareText("text", f.authority.signal);
      if (phase === "before paste") f.authority.abort();
      else f.content.assertReady.mockImplementationOnce(async () => { f.authority.abort(); });
      await expect(transaction.paste()).rejects.toMatchObject({ disposition: "not_dispatched" });
      await transaction.close();
    }
    expect(f.native.input).toHaveBeenCalledOnce();
    expect(f.native.typeAscii).not.toHaveBeenCalled();
    expect(f.content.prepareText).not.toHaveBeenCalled();
  });

  it("cancellation after the navigation chord is uncertain and never types", async () => {
    const f = fixture();
    await f.tools.input(navigation, f.authority.signal);
    const transaction = await f.tools.prepareText("text", f.authority.signal);
    vi.mocked(f.native.input).mockImplementationOnce(async () => { f.authority.abort(); });
    await expect(transaction.paste()).rejects.toMatchObject({ code: "session_revoked", disposition: "outcome_uncertain" });
    expect(f.native.typeAscii).not.toHaveBeenCalled();
    expect(f.content.prepareText).not.toHaveBeenCalled();
  });

  it("invalidates text if foreign input arrives while checking readiness after Ctrl+L", async () => {
    const f = fixture();
    await f.tools.input(navigation, f.authority.signal);
    const transaction = await f.tools.prepareText("text", f.authority.signal);
    f.content.assertReady.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      await f.tools.input(["click", "1"], f.authority.signal);
    });
    await expect(transaction.paste()).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    expect(f.native.typeAscii).not.toHaveBeenCalled();
    expect(f.content.prepareText).not.toHaveBeenCalled();
  });

  it.each(["prepare", "paste"])("a content %s failure never selects native input", async phase => {
    const f = fixture();
    const failure = new CuaExecutorError("deadline_exceeded", phase === "prepare" ? "not_dispatched" : "outcome_uncertain");
    if (phase === "prepare") {
      f.content.prepareText.mockRejectedValueOnce(failure);
      await expect(f.tools.prepareText("text", f.authority.signal)).rejects.toBe(failure);
    } else {
      f.contentTransaction.paste.mockRejectedValueOnce(failure);
      const transaction = await f.tools.prepareText("text", f.authority.signal);
      await expect(transaction.paste()).rejects.toBe(failure);
    }
    expect(f.native.input).not.toHaveBeenCalled();
    expect(f.native.typeAscii).not.toHaveBeenCalled();
  });

  it("owned-browser readiness rejection prevents navigation dispatch", async () => {
    const f = fixture();
    await f.tools.input(navigation, f.authority.signal);
    const transaction = await f.tools.prepareText("text", f.authority.signal);
    f.content.assertReady.mockRejectedValueOnce(new CuaExecutorError("action_rejected", "not_dispatched"));
    await expect(transaction.paste()).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.native.input).toHaveBeenCalledOnce();
    expect(f.native.typeAscii).not.toHaveBeenCalled();
  });

  it("native failure is sanitized and uncertain with no content fallback", async () => {
    const f = fixture();
    await f.tools.input(navigation, f.authority.signal);
    const transaction = await f.tools.prepareText("text", f.authority.signal);
    vi.mocked(f.native.typeAscii).mockRejectedValueOnce(new Error("synthetic private native text"));
    await expect(transaction.paste()).rejects.toMatchObject({ code: "execution_failed", disposition: "outcome_uncertain", message: "Desktop executor could not complete the request." });
    expect(f.content.prepareText).not.toHaveBeenCalled();
    await expect(transaction.paste()).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.native.typeAscii).toHaveBeenCalledOnce();
  });

  it.each(["after close", "after success"])("never reuses a prepared native insertion %s", async phase => {
    const f = fixture();
    await f.tools.input(navigation, f.authority.signal);
    const transaction = await f.tools.prepareText("text", f.authority.signal);
    if (phase === "after success") await transaction.paste();
    else await transaction.close();
    await expect(transaction.paste()).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.native.typeAscii).toHaveBeenCalledTimes(phase === "after success" ? 1 : 0);
  });

  it("known unsupported text leaves the executor usable without automatic replay", async () => {
    const f = fixture();
    const terminal = vi.fn();
    const executor = createGuestDesktopExecutor({ width: 100, height: 100, tools: f.tools, authoritySignal: f.authority.signal, onTerminal: terminal });
    await executor.execute({ kind: "keypress", keys: ["CTRL", "l"] });
    await expect(executor.execute({ kind: "type", text: "🙂" })).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
    expect(terminal).not.toHaveBeenCalled();
    expect(f.native.typeAscii).not.toHaveBeenCalled();
    await executor.execute({ kind: "keypress", keys: ["CTRL", "l"] });
    await executor.execute({ kind: "type", text: "https://example.test" });
    expect(f.native.typeAscii).toHaveBeenCalledOnce();
  });
});
