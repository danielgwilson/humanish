// The fake page, context and CDP session the guest Chromium text port tests share.
import { EventEmitter } from "node:events";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { vi } from "vitest";
import { createGuestChromiumText } from "../../src/guest/chromium-text.js";
import type { GuestChromiumText } from "../../src/guest/chromium-text.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const cleanups: Array<() => Promise<void>> = [];

/** Restores real timers and runs the cleanups fixture() and prepared() registered. */
export async function cleanupPorts(): Promise<void> {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export function fixture() {
  const pageEvents = new EventEmitter(),
    contextEvents = new EventEmitter();
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
  const context = Object.assign(contextEvents, {
    pages: () => [...pages],
    newCDPSession,
  }) as unknown as BrowserContext;
  const page = Object.assign(pageEvents, {
    isClosed: () => false,
    context: () => context,
  }) as unknown as Page;
  pages.push(page);
  const assertFocusedWindow = vi.fn(async (_signal: AbortSignal) => {});
  const port = createGuestChromiumText({ context, page, assertFocusedWindow });
  const abort = new AbortController();
  cleanups.push(() => port.close().catch(() => {}));
  return {
    port,
    abort,
    send,
    detach,
    session,
    context,
    page,
    pages,
    pageEvents,
    contextEvents,
    newCDPSession,
    assertFocusedWindow,
  };
}

export async function prepared(
  f: ReturnType<typeof fixture>,
  text = "Synthetic 你好 👩🏽‍💻 e\u0301\t\n",
): ReturnType<GuestChromiumText["prepareText"]> {
  const handle = await f.port.prepareText(text, f.abort.signal);
  cleanups.push(() => handle.close().catch(() => {}));
  return handle;
}

export function inserts(f: ReturnType<typeof fixture>) {
  return f.send.mock.calls.filter(([method]) => method === "Input.insertText");
}
