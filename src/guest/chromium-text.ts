import { randomUUID } from "node:crypto";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import {
  ComputerUseExecutorError,
  isComputerUseExecutorError,
} from "../actors/computer-use/executor-error.js";
import type { CuaExecutorErrorCode } from "../actors/computer-use/executor-error.js";

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

interface PreparedGuestChromiumText {
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
 * Text a preparation accepts: non-empty, no NUL, at most 64 KiB of UTF-8 that round-trips.
 * Written as the negated refusal so each comparison keeps its original form.
 */
export function isAdmissibleText(text: unknown): text is string {
  return !(
    typeof text !== "string" ||
    !text ||
    text.includes("\0") ||
    Buffer.byteLength(text, "utf8") > 65536 ||
    Buffer.from(text, "utf8").toString("utf8") !== text
  );
}

/** The owned top frame's id from Page.getFrameTree, or undefined for anything else. */
export function ownedFrameId(tree: {
  frameTree?: { frame?: { id?: unknown; parentId?: unknown } };
}): string | undefined {
  const frameId = tree.frameTree?.frame?.id;
  if (typeof frameId !== "string" || !frameId || tree.frameTree!.frame!.parentId) return undefined;
  return frameId;
}

/** An isolated world's execution context id: a positive safe integer (negated refusal form). */
export function isExecutionContextId(contextId: unknown): contextId is number {
  return !(!Number.isSafeInteger(contextId) || (contextId as number) <= 0);
}

/** The fixed Runtime.evaluate parameters for one probe in the port's isolated world. */
export function evaluateParams(expression: string, contextId: number) {
  return {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: false,
    userGesture: false,
    includeCommandLineAPI: false,
    silent: true,
  };
}

/** A probe passed: no exception, and a boolean true result. */
export function probeAccepted(reply: {
  exceptionDetails?: unknown;
  result: { type: string; value?: unknown };
}): boolean {
  return !reply.exceptionDetails && reply.result.type === "boolean" && reply.result.value === true;
}

/** What a port reads and never changes once it is created. */
interface TextPortSettings {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly assertFocusedWindow: (signal: AbortSignal) => Promise<void>;
  readonly worldName: string;
}

/**
 * What changes after a port is created and more than one of its functions reads. Each field is
 * read at its use, never copied into a local across an await.
 */
interface TextPortState {
  /** Bumped by every target event; an operation started at another generation is revoked. */
  generation: number;
  /** Set by close (checkScope, session acquisition). */
  closed: boolean;
  /** Set by a closed target, a failure after dispatch, or a failed detach (checkScope). */
  unusable: boolean;
  /** Set by an observed dialog (checkScope). */
  dialogSeen: boolean;
  /** One preparation at a time (prepareText; released by its disposal). */
  busy: boolean;
  /** The prepared handle's disposal, which close runs (prepareText, disposal, close). */
  activeDisposal: (() => Promise<void>) | undefined;
  /** Each running operation's interrupt (runOperation, target events, close). */
  readonly interruptions: Set<(code: CuaExecutorErrorCode) => void>;
  /** Every session acquired and not yet detached (acquisition, detach, close). */
  readonly sessions: Set<CDPSession>;
}

/** The target event handlers, registered once and removed by the same references at close. */
interface TargetHandlers {
  invalidate(): void;
  dialog(): void;
  targetClosed(): void;
}

function targetHandlers(state: TextPortState): TargetHandlers {
  function invalidate() {
    state.generation++;
    for (const interrupt of state.interruptions) interrupt("session_revoked");
  }
  function dialog() {
    state.dialogSeen = true;
    invalidate();
  }
  function targetClosed() {
    state.unusable = true;
    invalidate();
  }
  return { invalidate, dialog, targetClosed };
}

function watchTargetEvents(settings: TextPortSettings, handlers: TargetHandlers): void {
  const { page, context } = settings;
  page.on("framenavigated", handlers.invalidate);
  page.on("frameattached", handlers.invalidate);
  page.on("framedetached", handlers.invalidate);
  page.on("dialog", handlers.dialog);
  page.on("close", handlers.targetClosed);
  context.on("page", handlers.invalidate);
  context.on("close", handlers.targetClosed);
}

function unwatchTargetEvents(settings: TextPortSettings, handlers: TargetHandlers): void {
  const { page, context } = settings;
  page.off("framenavigated", handlers.invalidate);
  page.off("frameattached", handlers.invalidate);
  page.off("framedetached", handlers.invalidate);
  page.off("dialog", handlers.dialog);
  page.off("close", handlers.targetClosed);
  context.off("page", handlers.invalidate);
  context.off("close", handlers.targetClosed);
}

/** The port may act: open, usable, still at `expected`, and the one page of its context. */
function checkScope(settings: TextPortSettings, state: TextPortState, expected: number): void {
  const { context, page } = settings;
  if (state.closed || state.unusable)
    throw new ComputerUseExecutorError("executor_closed", "not_dispatched");
  if (state.generation !== expected)
    throw new ComputerUseExecutorError("session_revoked", "not_dispatched");
  const pages = context.pages();
  if (
    state.dialogSeen ||
    page.isClosed() ||
    page.context() !== context ||
    pages.length !== 1 ||
    pages[0] !== page
  )
    throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
}

/**
 * One bounded operation: a 5 s deadline, the caller's abort, and any interrupt race every step.
 * A failure after a dispatching step makes the port unusable and reports outcome_uncertain.
 */
async function runOperation<T>(
  settings: TextPortSettings,
  state: TextPortState,
  signal: AbortSignal,
  expected: number,
  body: (op: Operation) => Promise<T>,
): Promise<T> {
  let dispatched = false;
  let stopped: CuaExecutorErrorCode | undefined;
  const controller = new AbortController();
  let rejectStop!: (error: ComputerUseExecutorError) => void;
  const stop = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  // An event can interrupt before the first awaited step; consume that rejection.
  void stop.catch(() => {});
  const interrupt = (code: CuaExecutorErrorCode) => {
    if (stopped) return;
    stopped = code;
    controller.abort();
    rejectStop(
      new ComputerUseExecutorError(code, dispatched ? "outcome_uncertain" : "not_dispatched"),
    );
  };
  const abort = () => interrupt("cancelled");
  const timer = setTimeout(() => interrupt("deadline_exceeded"), DEADLINE_MS);
  state.interruptions.add(interrupt);
  signal.addEventListener("abort", abort, { once: true });
  const check = () => {
    if (signal.aborted) abort();
    if (stopped)
      throw new ComputerUseExecutorError(
        stopped,
        dispatched ? "outcome_uncertain" : "not_dispatched",
      );
    checkScope(settings, state, expected);
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
      },
    });
  } catch (error) {
    controller.abort();
    if (dispatched) state.unusable = true;
    const code = stopped ?? (isComputerUseExecutorError(error) ? error.code : "transport_failed");
    throw new ComputerUseExecutorError(code, dispatched ? "outcome_uncertain" : "not_dispatched");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    state.interruptions.delete(interrupt);
  }
}

/** Detaches one session within the deadline. A failed detach makes the port unusable. */
type DetachSession = (session: CDPSession) => Promise<void>;

/** A port's detach, memoized per session: every caller shares the one bounded attempt. */
function sessionDetacher(state: TextPortState): DetachSession {
  const detachments = new WeakMap<CDPSession, Promise<void>>();
  return (session) => {
    const prior = detachments.get(session);
    if (prior) return prior;
    const result = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.detach(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new ComputerUseExecutorError("deadline_exceeded", "not_dispatched")),
              DEADLINE_MS,
            );
          }),
        ]);
      } catch {
        state.unusable = true;
        throw new ComputerUseExecutorError("transport_failed", "not_dispatched");
      } finally {
        clearTimeout(timer);
        state.sessions.delete(session);
      }
    })();
    detachments.set(session, result);
    // Late acquisition after cancellation also uses this consumed, bounded path.
    void result.catch(() => {});
    return result;
  };
}

/** The owner's native window check, as one step of an operation. */
async function assertOwnerReady(settings: TextPortSettings, op: Operation): Promise<void> {
  const { assertFocusedWindow } = settings;
  await op.step(() => assertFocusedWindow(op.signal));
}

/** One fixed probe in the isolated world; anything but a boolean true refuses the action. */
async function probeElement(
  op: Operation,
  session: CDPSession,
  contextId: number,
  expression: string,
): Promise<void> {
  const result = await op.step(() =>
    session.send("Runtime.evaluate", evaluateParams(expression, contextId)),
  );
  if (!probeAccepted(result))
    throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
}

/** One prepared text handle: its session and isolated world, and what it has done. */
interface PreparedText {
  readonly text: string;
  /** The port generation the preparation started at. */
  readonly expected: number;
  /** Aborted by the caller's signal or the handle's disposal. */
  readonly lifetime: AbortController;
  readonly signal: AbortSignal;
  readonly abortLifetime: () => void;
  session: CDPSession | undefined;
  contextId: number | undefined;
  used: boolean;
  disposed: boolean;
  dispatchedText: boolean;
  disposal: Promise<void> | undefined;
}

/**
 * Preparation: the owner check, a CDP session (recorded on the handle as soon as it exists, so
 * disposal detaches a partial acquisition), the owned top frame, an isolated world, and the
 * `PREPARE` probe.
 */
async function acquireIsolatedWorld(
  settings: TextPortSettings,
  state: TextPortState,
  detach: DetachSession,
  prepared: PreparedText,
  op: Operation,
): Promise<void> {
  await assertOwnerReady(settings, op);
  prepared.session = await op.step(() =>
    settings.context.newCDPSession(settings.page).then((acquired) => {
      state.sessions.add(acquired);
      if (op.signal.aborted || state.closed) void detach(acquired).catch(() => {});
      return acquired;
    }),
  );
  const tree = await op.step(() => prepared.session!.send("Page.getFrameTree"));
  const frameId = ownedFrameId(tree);
  if (frameId === undefined)
    throw new ComputerUseExecutorError("invalid_response", "not_dispatched");
  const world = await op.step(() =>
    prepared.session!.send("Page.createIsolatedWorld", {
      frameId,
      worldName: settings.worldName,
    }),
  );
  prepared.contextId = world.executionContextId;
  if (!isExecutionContextId(prepared.contextId))
    throw new ComputerUseExecutorError("invalid_response", "not_dispatched");
  await probeElement(op, prepared.session!, prepared.contextId, PREPARE);
}

/** Disposes a prepared handle once: aborts its lifetime, detaches its session, releases busy. */
function disposePrepared(
  state: TextPortState,
  detach: DetachSession,
  prepared: PreparedText,
  self: () => Promise<void>,
): Promise<void> {
  if (!prepared.disposal) {
    prepared.disposed = true;
    prepared.lifetime.abort();
    prepared.signal.removeEventListener("abort", prepared.abortLifetime);
    prepared.disposal = (async () => {
      try {
        if (prepared.session) await detach(prepared.session);
      } catch (error) {
        throw new ComputerUseExecutorError(
          isComputerUseExecutorError(error) ? error.code : "transport_failed",
          prepared.dispatchedText ? "outcome_uncertain" : "not_dispatched",
        );
      } finally {
        state.busy = false;
        if (state.activeDisposal === self) state.activeDisposal = undefined;
      }
    })();
  }
  return prepared.disposal;
}

/**
 * The handle for one preparation. paste inserts the text once: owner check, `RECHECK` probe, owner
 * check, check, then insertText. close is the handle's disposal.
 */
function preparedHandle(
  settings: TextPortSettings,
  state: TextPortState,
  prepared: PreparedText,
  dispose: () => Promise<void>,
): PreparedGuestChromiumText {
  return {
    async paste() {
      if (prepared.used || prepared.disposed)
        throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
      prepared.used = true; // A failed attempt cannot be retried through this handle.
      await runOperation(
        settings,
        state,
        prepared.lifetime.signal,
        prepared.expected,
        async (op) => {
          await assertOwnerReady(settings, op);
          await probeElement(op, prepared.session!, prepared.contextId!, RECHECK);
          await assertOwnerReady(settings, op);
          op.check();
          await op.step(() => {
            prepared.dispatchedText = true;
            return prepared.session!.send("Input.insertText", { text: prepared.text });
          }, true);
        },
      );
    },
    close: dispose,
  };
}

/**
 * Closes the port: interrupts running operations, removes the target listeners, disposes the
 * active handle and detaches every session. The first cleanup failure is reported.
 */
function closePort(
  settings: TextPortSettings,
  state: TextPortState,
  handlers: TargetHandlers,
  detach: DetachSession,
): Promise<void> {
  state.closed = true;
  for (const interrupt of state.interruptions) interrupt("executor_closed");
  unwatchTargetEvents(settings, handlers);
  const active = state.activeDisposal?.();
  return Promise.allSettled([...(active ? [active] : []), ...[...state.sessions].map(detach)]).then(
    (results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  );
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
  const settings: TextPortSettings = {
    context,
    page,
    assertFocusedWindow,
    worldName: `humanish-text-${randomUUID()}`,
  };
  const state: TextPortState = {
    generation: 0,
    closed: false,
    unusable: false,
    dialogSeen: false,
    busy: false,
    activeDisposal: undefined,
    interruptions: new Set(),
    sessions: new Set(),
  };
  const detach = sessionDetacher(state);
  const handlers = targetHandlers(state);
  watchTargetEvents(settings, handlers);
  let closing: Promise<void> | undefined;

  return {
    async assertReady(signal) {
      await runOperation(settings, state, signal, state.generation, (op) =>
        assertOwnerReady(settings, op),
      );
    },
    async prepareText(text, signal) {
      if (!isAdmissibleText(text))
        throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
      checkScope(settings, state, state.generation);
      if (state.busy) throw new ComputerUseExecutorError("executor_busy", "not_dispatched");
      state.busy = true;
      const expected = state.generation;
      const lifetime = new AbortController();
      const prepared: PreparedText = {
        text,
        expected,
        lifetime,
        signal,
        abortLifetime: () => lifetime.abort(),
        session: undefined,
        contextId: undefined,
        used: false,
        disposed: false,
        dispatchedText: false,
        disposal: undefined,
      };
      signal.addEventListener("abort", prepared.abortLifetime, { once: true });
      if (signal.aborted) prepared.abortLifetime();
      const dispose = (): Promise<void> => disposePrepared(state, detach, prepared, dispose);
      state.activeDisposal = dispose;
      try {
        await runOperation(settings, state, lifetime.signal, prepared.expected, (op) =>
          acquireIsolatedWorld(settings, state, detach, prepared, op),
        );
      } catch (error) {
        await dispose().catch(() => {});
        throw error;
      }
      return preparedHandle(settings, state, prepared, dispose);
    },
    close() {
      return (closing ??= closePort(settings, state, handlers, detach));
    },
  };
}
