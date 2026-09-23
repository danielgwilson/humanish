import { randomUUID } from "node:crypto";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { CuaExecutorError, isCuaExecutorError } from "./cua-executor-error.js";
import type { CuaExecutorErrorCode } from "./cua-executor-error.js";

const DEADLINE_MS = 5_000;

// These expressions execute only in this port's isolated world. Actor text is
// never interpolated into JavaScript, a selector, a world name, or a CDP method.
const PREPARE = `(() => {
  const active = () => Object.getOwnPropertyDescriptor(Document.prototype, "activeElement").get.call(document);
  const element = active();
  const editable = () => {
    if (!Document.prototype.hasFocus.call(document) || active() !== element ||
        !element || !element.isConnected || element.ownerDocument !== document ||
        element.localName === "iframe" || element.localName === "frame") return false;
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (element instanceof HTMLInputElement) return !element.disabled && !element.readOnly &&
      ["text", "search", "tel", "url", "email", "password", "number"].includes(element.type);
    return element instanceof HTMLElement && element.isContentEditable;
  };
  if (!editable()) return false;
  Object.defineProperty(globalThis, "__humanish_text_preparation__", {
    configurable: true, value: Object.freeze({ editable })
  });
  return true;
})()`;

const RECHECK = `(() => {
  const state = globalThis.__humanish_text_preparation__;
  return !!state && state.editable() === true;
})()`;

export interface PreparedGuestChromiumText {
  paste(): Promise<void>;
  close(): Promise<void>;
}

export interface GuestChromiumText {
  /** Owner/window readiness only: deliberately permits a focused browser toolbar. */
  assertReady(signal: AbortSignal): Promise<void>;
  prepareText(text: string, signal: AbortSignal): Promise<PreparedGuestChromiumText>;
  close(): Promise<void>;
}

interface Operation {
  signal: AbortSignal;
  check(): void;
  step<T>(call: () => Promise<T>, dispatch?: boolean): Promise<T>;
}

/**
 * A finite text port for one owner-acquired Chromium page in a one-page context.
 * It neither selects/activates targets nor handles browser chrome, frames or
 * dialogs. An observed dialog poisons this port; the owner must handle it and
 * construct a new port. A dialog already open can make preparation time out.
 *
 * Focus checks and insertText are separate protocol calls: page code can change
 * focus between them. This is not atomic element binding or proof an app applied
 * text. A lost post-send acknowledgement is uncertain and terminal for this port.
 * The owner remains responsible for browser/session teardown.
 */
export function createGuestChromiumText(options: {
  context: BrowserContext;
  page: Page;
  assertFocusedWindow: (signal: AbortSignal) => Promise<void>;
}): GuestChromiumText {
  const { context, page, assertFocusedWindow } = options;
  const worldName = `humanish-text-${randomUUID()}`;
  let generation = 0;
  let closed = false;
  let unusable = false;
  let dialogSeen = false;
  let busy = false;
  let closing: Promise<void> | undefined;
  let activeDisposal: (() => Promise<void>) | undefined;
  const interruptions = new Set<(code: CuaExecutorErrorCode) => void>();
  const sessions = new Set<CDPSession>();
  const detachments = new WeakMap<CDPSession, Promise<void>>();

  function invalidate() {
    generation++;
    for (const interrupt of interruptions) interrupt("session_revoked");
  }
  function dialog() { dialogSeen = true; invalidate(); }
  function targetClosed() { unusable = true; invalidate(); }
  page.on("framenavigated", invalidate);
  page.on("frameattached", invalidate);
  page.on("framedetached", invalidate);
  page.on("dialog", dialog);
  page.on("close", targetClosed);
  context.on("page", invalidate);
  context.on("close", targetClosed);

  function scope(expected: number) {
    if (closed || unusable) throw new CuaExecutorError("executor_closed", "not_dispatched");
    if (generation !== expected) throw new CuaExecutorError("session_revoked", "not_dispatched");
    const pages = context.pages();
    if (dialogSeen || page.isClosed() || page.context() !== context || pages.length !== 1 || pages[0] !== page)
      throw new CuaExecutorError("action_rejected", "not_dispatched");
  }

  async function run<T>(signal: AbortSignal, expected: number, body: (op: Operation) => Promise<T>): Promise<T> {
    let dispatched = false;
    let stopped: CuaExecutorErrorCode | undefined;
    const controller = new AbortController();
    let rejectStop!: (error: CuaExecutorError) => void;
    const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    // An event can interrupt before the first awaited step; consume that rejection.
    void stop.catch(() => {});
    const interrupt = (code: CuaExecutorErrorCode) => {
      if (stopped) return;
      stopped = code;
      controller.abort();
      rejectStop(new CuaExecutorError(code, dispatched ? "outcome_uncertain" : "not_dispatched"));
    };
    const abort = () => interrupt("cancelled");
    const timer = setTimeout(() => interrupt("deadline_exceeded"), DEADLINE_MS);
    interruptions.add(interrupt);
    signal.addEventListener("abort", abort, { once: true });
    const check = () => {
      if (signal.aborted) abort();
      if (stopped) throw new CuaExecutorError(stopped, dispatched ? "outcome_uncertain" : "not_dispatched");
      scope(expected);
    };
    try {
      check();
      return await body({
        signal: controller.signal,
        check,
        async step<T>(call: () => Promise<T>, dispatch = false): Promise<T> {
          check();
          if (dispatch) dispatched = true;
          const value = await Promise.race([call(), stop]);
          check();
          return value;
        }
      });
    } catch (error) {
      controller.abort();
      if (dispatched) unusable = true;
      const code = stopped ?? (isCuaExecutorError(error) ? error.code : "transport_failed");
      throw new CuaExecutorError(code, dispatched ? "outcome_uncertain" : "not_dispatched");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      interruptions.delete(interrupt);
    }
  }

  function detach(session: CDPSession): Promise<void> {
    const prior = detachments.get(session);
    if (prior) return prior;
    const result = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.detach(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new CuaExecutorError("deadline_exceeded", "not_dispatched")), DEADLINE_MS);
          })
        ]);
      } catch {
        unusable = true;
        throw new CuaExecutorError("transport_failed", "not_dispatched");
      } finally {
        clearTimeout(timer);
        sessions.delete(session);
      }
    })();
    detachments.set(session, result);
    // Late acquisition after cancellation also uses this consumed, bounded path.
    void result.catch(() => {});
    return result;
  }

  async function ready(op: Operation) {
    await op.step(() => assertFocusedWindow(op.signal));
  }

  async function probe(op: Operation, session: CDPSession, contextId: number, expression: string) {
    const result = await op.step(() => session.send("Runtime.evaluate", {
      expression, contextId, returnByValue: true, awaitPromise: false,
      userGesture: false, includeCommandLineAPI: false, silent: true
    }));
    if (result.exceptionDetails || result.result.type !== "boolean" || result.result.value !== true)
      throw new CuaExecutorError("action_rejected", "not_dispatched");
  }

  return {
    async assertReady(signal) {
      await run(signal, generation, ready);
    },
    async prepareText(text, signal) {
      if (typeof text !== "string" || !text || text.includes("\0") || Buffer.byteLength(text, "utf8") > 65536 ||
          Buffer.from(text, "utf8").toString("utf8") !== text)
        throw new CuaExecutorError("invalid_request", "not_dispatched");
      scope(generation);
      if (busy) throw new CuaExecutorError("executor_busy", "not_dispatched");
      busy = true;
      const expected = generation;
      const lifetime = new AbortController();
      const abortLifetime = () => lifetime.abort();
      signal.addEventListener("abort", abortLifetime, { once: true });
      if (signal.aborted) abortLifetime();
      let session: CDPSession | undefined;
      let contextId: number;
      let used = false;
      let disposed = false;
      let dispatchedText = false;
      let disposal: Promise<void> | undefined;
      const dispose = () => {
        if (!disposal) {
          disposed = true;
          lifetime.abort();
          signal.removeEventListener("abort", abortLifetime);
          disposal = (async () => {
            try { if (session) await detach(session); }
            catch (error) {
              throw new CuaExecutorError(isCuaExecutorError(error) ? error.code : "transport_failed",
                dispatchedText ? "outcome_uncertain" : "not_dispatched");
            } finally {
              busy = false;
              if (activeDisposal === dispose) activeDisposal = undefined;
            }
          })();
        }
        return disposal;
      };
      activeDisposal = dispose;
      try {
        await run(lifetime.signal, expected, async op => {
          await ready(op);
          session = await op.step(() => context.newCDPSession(page).then(acquired => {
            sessions.add(acquired);
            if (op.signal.aborted || closed) void detach(acquired).catch(() => {});
            return acquired;
          }));
          const tree = await op.step(() => session!.send("Page.getFrameTree"));
          const frameId = tree.frameTree?.frame?.id;
          if (typeof frameId !== "string" || !frameId || tree.frameTree.frame.parentId)
            throw new CuaExecutorError("invalid_response", "not_dispatched");
          const world = await op.step(() => session!.send("Page.createIsolatedWorld", { frameId, worldName }));
          contextId = world.executionContextId;
          if (!Number.isSafeInteger(contextId) || contextId <= 0)
            throw new CuaExecutorError("invalid_response", "not_dispatched");
          await probe(op, session!, contextId, PREPARE);
        });
      } catch (error) {
        await dispose().catch(() => {});
        throw error;
      }
      return {
        async paste() {
          if (used || disposed) throw new CuaExecutorError("action_rejected", "not_dispatched");
          used = true; // A failed attempt cannot be retried through this handle.
          await run(lifetime.signal, expected, async op => {
            await ready(op);
            await probe(op, session!, contextId, RECHECK);
            await ready(op);
            op.check();
            await op.step(() => {
              dispatchedText = true;
              return session!.send("Input.insertText", { text });
            }, true);
          });
        },
        close: dispose
      };
    },
    close() {
      if (!closing) {
        closed = true;
        for (const interrupt of interruptions) interrupt("executor_closed");
        page.off("framenavigated", invalidate);
        page.off("frameattached", invalidate);
        page.off("framedetached", invalidate);
        page.off("dialog", dialog);
        page.off("close", targetClosed);
        context.off("page", invalidate);
        context.off("close", targetClosed);
        const active = activeDisposal?.();
        closing = Promise.allSettled([...(active ? [active] : []), ...[...sessions].map(detach)]).then(results => {
          const failure = results.find(result => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        });
      }
      return closing;
    }
  };
}
