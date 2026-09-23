import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuestChromiumText } from "../src/guest-chromium-text.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const pageEvents = new EventEmitter(), contextEvents = new EventEmitter();
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<any> => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "owned-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.evaluate") return { result: { type: "boolean", value: true } };
    if (method === "Input.insertText") return {};
    throw new Error("Unexpected method");
  });
  const detach = vi.fn(async () => {});
  const session = { send, detach } as unknown as CDPSession;
  const newCDPSession = vi.fn(async () => session);
  const pages: Page[] = [];
  const context = Object.assign(contextEvents, { pages: () => [...pages], newCDPSession }) as unknown as BrowserContext;
  const page = Object.assign(pageEvents, { isClosed: () => false, context: () => context }) as unknown as Page;
  pages.push(page);
  const assertFocusedWindow = vi.fn(async (_signal: AbortSignal) => {});
  const port = createGuestChromiumText({ context, page, assertFocusedWindow });
  const abort = new AbortController();
  cleanups.push(() => port.close().catch(() => {}));
  return { port, abort, send, detach, session, context, page, pages, pageEvents, contextEvents, newCDPSession, assertFocusedWindow };
}

async function prepared(f: ReturnType<typeof fixture>, text = "Synthetic 你好 👩🏽‍💻 e\u0301\t\n") {
  const handle = await f.port.prepareText(text, f.abort.signal);
  cleanups.push(() => handle.close().catch(() => {}));
  return handle;
}

function inserts(f: ReturnType<typeof fixture>) {
  return f.send.mock.calls.filter(([method]) => method === "Input.insertText");
}

describe("owned Chromium text port", () => {
  it("uses fixed isolated-world probes and inserts exact text once without selecting a target", async () => {
    const f = fixture(), text = '你好 👩🏽‍💻 e\u0301\n\t"; globalThis.actorCode = true; //';
    const handle = await prepared(f, text);
    expect(f.newCDPSession).toHaveBeenCalledWith(f.page);
    expect(inserts(f)).toHaveLength(0);
    await handle.paste();
    expect(f.send.mock.calls.map(([method]) => method)).toEqual([
      "Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate", "Runtime.evaluate", "Input.insertText"
    ]);
    expect(inserts(f)).toEqual([["Input.insertText", { text }]]);
    expect(f.assertFocusedWindow).toHaveBeenCalledTimes(2);
    const world = f.send.mock.calls.find(([method]) => method === "Page.createIsolatedWorld")![1]!;
    expect(world).toEqual({ frameId: "owned-frame", worldName: expect.stringMatching(/^humanish-text-/) });
    for (const [, probe] of f.send.mock.calls.filter(([method]) => method === "Runtime.evaluate")) {
      expect(probe).toMatchObject({ contextId: 7, returnByValue: true, userGesture: false, includeCommandLineAPI: false });
      expect(probe!.expression).not.toContain(text);
    }
    await expect(handle.paste()).rejects.toMatchObject({ disposition: "not_dispatched" });
    await handle.close(); await handle.close(); await f.port.close(); await f.port.close();
    expect(f.detach).toHaveBeenCalledOnce();
    expect(f.pageEvents.eventNames()).toEqual([]);
    expect(f.contextEvents.eventNames()).toEqual([]);
  });

  it("assertReady checks owner/window without requiring editable content or acquiring CDP", async () => {
    const f = fixture();
    await f.port.assertReady(f.abort.signal);
    expect(f.assertFocusedWindow).toHaveBeenCalledOnce();
    expect(f.newCDPSession).not.toHaveBeenCalled();
  });

  it.each(["", "\0", "\ud800", "x".repeat(65537), "🙂".repeat(16385)])("rejects invalid text before browser calls", async text => {
    const f = fixture();
    await expect(f.port.prepareText(text, f.abort.signal)).rejects.toMatchObject({ code: "invalid_request", disposition: "not_dispatched" });
    expect(f.assertFocusedWindow).not.toHaveBeenCalled();
    expect(f.newCDPSession).not.toHaveBeenCalled();
  });

  it("refuses a context with another page without choosing or activating one", async () => {
    const f = fixture(); f.pages.push({} as Page);
    await expect(f.port.assertReady(f.abort.signal)).rejects.toMatchObject({ code: "action_rejected" });
    await expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({ code: "action_rejected" });
    expect(f.newCDPSession).not.toHaveBeenCalled();
  });

  it("rejects a mismatched owner context", async () => {
    const f = fixture(); vi.spyOn(f.page, "context").mockReturnValue({} as BrowserContext);
    await expect(f.port.assertReady(f.abort.signal)).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.assertFocusedWindow).not.toHaveBeenCalled();
  });

  it.each(["framenavigated", "frameattached", "framedetached", "dialog", "close"])("invalidates preparation after page %s", async event => {
    const f = fixture(), handle = await prepared(f);
    f.pageEvents.emit(event);
    await expect(handle.paste()).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(inserts(f)).toHaveLength(0);
  });

  it.each(["page", "close"])("invalidates preparation after context %s", async event => {
    const f = fixture(), handle = await prepared(f);
    f.contextEvents.emit(event);
    await expect(handle.paste()).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(inserts(f)).toHaveLength(0);
  });

  it("keeps an observed dialog refused until the owner creates another port", async () => {
    const f = fixture(); f.pageEvents.emit("dialog");
    await expect(f.port.assertReady(f.abort.signal)).rejects.toMatchObject({ code: "action_rejected" });
    await expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({ code: "action_rejected" });
    expect(f.newCDPSession).not.toHaveBeenCalled();
  });

  it("detects a target event during the native focus check", async () => {
    const f = fixture(); f.assertFocusedWindow.mockImplementationOnce(async () => { f.contextEvents.emit("page"); });
    await expect(f.port.assertReady(f.abort.signal)).rejects.toMatchObject({ code: "session_revoked", disposition: "not_dispatched" });
    expect(f.newCDPSession).not.toHaveBeenCalled();
  });

  it.each([
    { result: { type: "boolean", value: false } },
    { result: { type: "string", value: "true" } },
    { result: { type: "object", value: true } },
    { result: { type: "boolean", value: true }, exceptionDetails: { text: "synthetic error" } }
  ])("rejects a false, spoofed or exceptional probe result", async reply => {
    const f = fixture(), original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params) => method === "Runtime.evaluate" ? reply : original(method, params));
    await expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
    expect(inserts(f)).toHaveLength(0); expect(f.detach).toHaveBeenCalledOnce();
  });

  it("rechecks the private element reference before insertion", async () => {
    const f = fixture(), handle = await prepared(f);
    f.send.mockResolvedValueOnce({ result: { type: "boolean", value: false } });
    await expect(handle.paste()).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
    expect(inserts(f)).toHaveLength(0);
  });

  it("fixed probe resists document property spoofing, rejects frames, and notices element replacement", async () => {
    const f = fixture(), handle = await prepared(f);
    await handle.paste();
    const [setup, recheck] = f.send.mock.calls.filter(([method]) => method === "Runtime.evaluate").map(([, params]) => String(params!.expression));
    class HTMLElement { isConnected = true; isContentEditable = false; localName = "div"; ownerDocument: unknown; }
    class HTMLInputElement extends HTMLElement { disabled = false; readOnly = false; type = "text"; }
    class HTMLTextAreaElement extends HTMLElement { disabled = false; readOnly = false; }
    let focused = true, active: HTMLElement;
    class Document { hasFocus() { return focused; } get activeElement() { return active; } }
    const document = new Document(), input = new HTMLTextAreaElement();
    input.ownerDocument = document; active = input;
    const world = { Document, HTMLElement, HTMLInputElement, HTMLTextAreaElement, document };
    Object.defineProperty(document, "hasFocus", { value: () => true });
    Object.defineProperty(document, "activeElement", { get: () => input });
    expect(runInNewContext(setup!, world)).toBe(true);
    expect(runInNewContext(recheck!, world)).toBe(true);
    active = new HTMLTextAreaElement(); active.ownerDocument = document;
    expect(runInNewContext(recheck!, world)).toBe(false);
    active = input; focused = false;
    expect(runInNewContext(recheck!, world)).toBe(false);
    focused = true; active = new HTMLElement(); active.ownerDocument = document;
    active.localName = "iframe"; active.isContentEditable = true;
    expect(runInNewContext(setup!, world)).toBe(false);
  });

  it("does not acquire a session for an already-aborted call", async () => {
    const f = fixture(); f.abort.abort();
    await expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({ code: "cancelled", disposition: "not_dispatched" });
    expect(f.newCDPSession).not.toHaveBeenCalled();
  });

  it("checks cancellation synchronously after the final probe and before send", async () => {
    const f = fixture(), handle = await prepared(f);
    f.send.mockImplementationOnce(async () => { f.abort.abort(); return { result: { type: "boolean", value: true } }; });
    await expect(handle.paste()).rejects.toMatchObject({ code: "cancelled", disposition: "not_dispatched" });
    expect(inserts(f)).toHaveLength(0);
  });

  it("refuses concurrent preparations without opening another session", async () => {
    const f = fixture(); await prepared(f);
    await expect(f.port.prepareText("y", f.abort.signal)).rejects.toMatchObject({ code: "executor_busy" });
    expect(f.newCDPSession).toHaveBeenCalledOnce();
  });

  it("closing a prepared handle cancels its pending focus check without inserting", async () => {
    const f = fixture(), handle = await prepared(f), waiting = deferred<void>();
    f.assertFocusedWindow.mockImplementationOnce(async () => waiting.promise);
    const rejected = expect(handle.paste()).rejects.toMatchObject({ code: "cancelled", disposition: "not_dispatched" });
    await handle.close(); await rejected; waiting.resolve();
    expect(inserts(f)).toHaveLength(0); expect(f.detach).toHaveBeenCalledOnce();
  });

  it("bounds session acquisition and detaches a session that arrives after cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture(), waiting = deferred<CDPSession>();
    f.newCDPSession.mockReturnValueOnce(waiting.promise);
    const rejected = expect(f.port.prepareText("x", f.abort.signal)).rejects.toMatchObject({ code: "deadline_exceeded", disposition: "not_dispatched" });
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    waiting.resolve(f.session); await Promise.resolve(); await Promise.resolve();
    expect(f.detach).toHaveBeenCalledOnce(); expect(inserts(f)).toHaveLength(0);
  });

  it.each(["reject", "cancel", "close", "navigate", "timeout"])("preserves uncertainty when insertText %s occurs after send", async mode => {
    const f = fixture(), handle = await prepared(f), waiting = deferred<any>();
    if (mode === "timeout") vi.useFakeTimers();
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params) => {
      if (method !== "Input.insertText") return original(method, params);
      if (mode === "reject") throw new Error("synthetic backend private detail");
      if (mode === "cancel") f.abort.abort();
      if (mode === "navigate") f.pageEvents.emit("framenavigated");
      if (mode === "close") void f.port.close();
      return waiting.promise;
    });
    const rejected = expect(handle.paste()).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await expect(f.port.assertReady(new AbortController().signal)).rejects.toMatchObject({ code: "executor_closed" });
    expect(inserts(f)).toHaveLength(1);
    if (mode !== "reject") waiting.reject(new Error("late rejection must be consumed"));
    await Promise.resolve();
  });

  it("bounds cleanup and keeps the port unusable if detach cannot complete", async () => {
    vi.useFakeTimers();
    const f = fixture(), handle = await prepared(f), waiting = deferred<void>();
    f.detach.mockReturnValueOnce(waiting.promise);
    const rejected = expect(handle.close()).rejects.toMatchObject({ code: "transport_failed", disposition: "not_dispatched" });
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    await expect(f.port.assertReady(new AbortController().signal)).rejects.toMatchObject({ code: "executor_closed" });
    waiting.resolve();
  });

  it("owner close disposes the active handle and removes its caller signal listener", async () => {
    const f = fixture();
    const remove = vi.spyOn(f.abort.signal, "removeEventListener");
    const handle = await prepared(f);
    await f.port.close();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    await expect(handle.paste()).rejects.toMatchObject({ disposition: "not_dispatched" });
    await handle.close();
    expect(f.detach).toHaveBeenCalledOnce();
  });

  it("a cleanup failure after acknowledged insertion never claims the text was not dispatched", async () => {
    const f = fixture(), handle = await prepared(f);
    await handle.paste();
    f.detach.mockRejectedValueOnce(new Error("synthetic cleanup detail"));
    await expect(handle.close()).rejects.toMatchObject({ code: "transport_failed", disposition: "outcome_uncertain" });
    expect(inserts(f)).toHaveLength(1);
  });

  it("owner cleanup preserves the active handle's post-send uncertainty", async () => {
    const f = fixture(), handle = await prepared(f);
    await handle.paste();
    f.detach.mockRejectedValueOnce(new Error("synthetic cleanup detail"));
    await expect(f.port.close()).rejects.toMatchObject({ code: "transport_failed", disposition: "outcome_uncertain" });
    expect(f.detach).toHaveBeenCalledOnce();
  });
});
