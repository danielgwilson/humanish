import { perceptualSignature } from "../evidence/frame-signature.js";
import { setTimeout as delay } from "node:timers/promises";
import type { CuaAction, CuaActionResult, CuaExecutor } from "../actors/computer-use/loop.js";
import {
  BROWSER_CONTROL_LIMITS,
  validateBrowserControlAction,
  validateBrowserControlPng,
} from "../browser-control/protocol.js";
import {
  ComputerUseExecutorError,
  isComputerUseExecutorError,
} from "../actors/computer-use/executor-error.js";
import {
  executeX11Action,
  type X11TextChannel,
  type X11Transport,
} from "../substrates/x11/desktop.js";
import { guestX11Dialect, type X11Dialect, type X11Frame } from "../substrates/x11/translator.js";

/**
 * Internal guest port: the X11 transport's input, capture, text and pointer read, which the
 * executor wraps with its authority checks. Implementations recheck signal synchronously before
 * native dispatch. Without readPointer the guest refuses `read_pointer`.
 */
export type GuestDesktopTools = Pick<
  X11Transport,
  "capture" | "input" | "prepareText" | "readPointer"
>;

export interface GuestDesktopExecutorOptions {
  width: number;
  height: number;
  tools: GuestDesktopTools;
  authoritySignal: AbortSignal;
  /** Owner must stop the private display/browser after a partial/uncertain input. */
  onTerminal: () => void;
}

/** The fixed inputs every observe and execute call reads. */
interface GuestExecutorContext extends X11Frame {
  readonly tools: GuestDesktopTools;
  readonly dialect: X11Dialect;
  readonly authoritySignal: AbortSignal;
  /** Calls the owner's onTerminal, read from the options at the time of the call. */
  readonly onTerminal: () => void;
}

/** What the executor tracks between calls. */
interface GuestExecutorState {
  /** An observe or execute call is in flight. */
  busy: boolean;
  /** The session ended; every later call is revoked. */
  terminal: boolean;
}

/** What one execute call has done so far. Its failure and cleanup paths read it. */
interface ActionProgress {
  /** Native input or a text insertion may have reached the desktop. */
  dispatched: boolean;
  /** Text preparation started. */
  preparing: boolean;
  text: X11TextChannel | undefined;
}

/** Headed X11 input and full-frame captures. Browser metadata is deliberately absent. */
export function createGuestDesktopExecutor(options: GuestDesktopExecutorOptions): CuaExecutor {
  const { width, height, tools, authoritySignal } = options;
  if (!isValidFrameSize(width, height))
    throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
  const context: GuestExecutorContext = {
    width,
    height,
    tools,
    dialect: guestX11Dialect({ width, height }),
    authoritySignal,
    onTerminal: () => options.onTerminal(),
  };
  const state: GuestExecutorState = { busy: false, terminal: false };
  return {
    stallRecovery: "fail_closed",
    observe: () => observeFrame(context, state),
    execute: (action, callerSignal) => executeAction(context, state, action, callerSignal),
  };
}

/** Whether a frame of this size fits the browser-control limits. */
export function isValidFrameSize(width: number, height: number): boolean {
  return (
    [width, height].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= BROWSER_CONTROL_LIMITS.dimension,
    ) && width * height <= BROWSER_CONTROL_LIMITS.pixels
  );
}

/** Ends the session once. A throw from the owner's onTerminal leaves it ended. */
function terminate(state: GuestExecutorState, context: GuestExecutorContext): void {
  if (state.terminal) return;
  state.terminal = true;
  try {
    context.onTerminal();
  } catch {
    /* Terminal state remains closed even if the owner fails. */
  }
}

function assertOpen(state: GuestExecutorState, signal: AbortSignal, dispatched = false): void {
  if (state.terminal || signal.aborted)
    throw new ComputerUseExecutorError(
      "session_revoked",
      dispatched ? "outcome_uncertain" : "not_dispatched",
    );
}

function begin(state: GuestExecutorState, signal: AbortSignal): void {
  assertOpen(state, signal);
  if (state.busy) throw new ComputerUseExecutorError("executor_busy", "not_dispatched");
  state.busy = true;
}

/** Captures one full frame and checks it is a PNG of the executor's size. */
async function observeFrame(
  context: GuestExecutorContext,
  state: GuestExecutorState,
): ReturnType<CuaExecutor["observe"]> {
  const { tools, authoritySignal, width, height } = context;
  begin(state, authoritySignal);
  try {
    const screenshot = await tools.capture(authoritySignal);
    assertOpen(state, authoritySignal);
    validateBrowserControlPng(screenshot);
    if (screenshot.readUInt32BE(16) !== width || screenshot.readUInt32BE(20) !== height) {
      throw new ComputerUseExecutorError("invalid_response", "not_dispatched");
    }
    return { screenshot, stateSignature: perceptualSignature(screenshot) };
  } catch (error) {
    terminate(state, context);
    throw isComputerUseExecutorError(error)
      ? error
      : new ComputerUseExecutorError("execution_failed", "not_dispatched");
  } finally {
    state.busy = false;
  }
}

/**
 * Runs one action through the X11 translator, over the guest's tools with the authority checked
 * immediately before each native input and text insertion.
 */
async function executeAction(
  context: GuestExecutorContext,
  state: GuestExecutorState,
  value: CuaAction,
  callerSignal: AbortSignal | undefined,
): Promise<CuaActionResult | undefined> {
  const { authoritySignal, dialect } = context;
  const signal = callerSignal ? AbortSignal.any([authoritySignal, callerSignal]) : authoritySignal;
  begin(state, signal);
  const progress: ActionProgress = { dispatched: false, preparing: false, text: undefined };
  try {
    const action = validateBrowserControlAction(value);
    const result = await executeX11Action(
      action,
      { dialect, transport: authorizedTransport(context, state, signal, progress) },
      signal,
    );
    assertOpen(state, signal, progress.dispatched);
    return result;
  } catch (error) {
    if (failureEndsSession(progress, error, signal)) terminate(state, context);
    // Do not send mouseup/key-release after revocation: it can itself click/drop. failureError
    // reads the signal after terminate, because onTerminal can abort it.
    throw failureError(progress.dispatched, error, signal);
  } finally {
    try {
      await progress.text?.close();
    } catch {
      terminate(state, context);
      // oxlint-disable-next-line no-unsafe-finally -- a text channel that fails to close makes the action outcome unknowable
      throw new ComputerUseExecutorError(
        "execution_failed",
        progress.dispatched ? "outcome_uncertain" : "not_dispatched",
      );
    } finally {
      state.busy = false;
    }
  }
}

/**
 * The guest's tools as the translator's transport, recording progress. Each input and text
 * insertion checks the authority first, with no await before the native call. The runner's held-
 * key release goes through the same check, so nothing is released after revocation. The text
 * channel is closed by executeAction after its failure handling, so the owner's onTerminal runs
 * before the browser text channel closes.
 */
function authorizedTransport(
  context: GuestExecutorContext,
  state: GuestExecutorState,
  signal: AbortSignal,
  progress: ActionProgress,
): X11Transport {
  const { tools } = context;
  const { readPointer } = tools;
  return {
    capture: (captureSignal) => tools.capture(captureSignal),
    // A pointer read sends no input, so it needs no dispatch record.
    ...(readPointer === undefined
      ? {}
      : { readPointer: (readSignal: AbortSignal) => readPointer.call(tools, readSignal) }),
    input(args, inputSignal) {
      assertOpen(state, signal, progress.dispatched);
      progress.dispatched = true;
      return tools.input(args, inputSignal);
    },
    async prepareText(text, textSignal) {
      progress.preparing = true;
      const channel = await tools.prepareText(text, textSignal);
      progress.text = channel;
      return {
        async paste() {
          assertOpen(state, signal);
          progress.dispatched = true;
          try {
            await channel.paste();
          } catch (error) {
            // This transaction has no earlier input. Its private bridge can
            // prove that no insertion or native input was sent.
            if (isComputerUseExecutorError(error) && error.disposition === "not_dispatched")
              progress.dispatched = false;
            throw error;
          }
        },
        close: async () => {},
      };
    },
    wait: (ms, waitSignal) => delay(ms, undefined, { signal: waitSignal }),
  };
}

/**
 * Whether a failed action ends the session: anything dispatched, an aborted signal, an error the
 * executor did not raise, or a failed text preparation other than a refusal before dispatch. It
 * reads signal.aborted only when the earlier conditions do not decide, as the inline check did.
 */
export function failureEndsSession(
  progress: Pick<ActionProgress, "preparing" | "dispatched">,
  error: unknown,
  signal: Pick<AbortSignal, "aborted">,
): boolean {
  return (
    (progress.preparing &&
      !(
        isComputerUseExecutorError(error) &&
        error.code === "action_rejected" &&
        error.disposition === "not_dispatched"
      )) ||
    progress.dispatched ||
    signal.aborted ||
    !isComputerUseExecutorError(error)
  );
}

/**
 * The error a failed action throws: outcome_uncertain once anything was dispatched, then
 * session_revoked when the signal aborted, then the executor's own error or execution_failed. It
 * reads signal.aborted only for an undispatched failure, as the inline mapping did.
 */
export function failureError(
  dispatched: boolean,
  error: unknown,
  signal: Pick<AbortSignal, "aborted">,
): ComputerUseExecutorError {
  if (dispatched)
    return isComputerUseExecutorError(error)
      ? new ComputerUseExecutorError(error.code, "outcome_uncertain", {
          diagnostic: error.diagnostic,
        })
      : new ComputerUseExecutorError("execution_failed", "outcome_uncertain");
  if (signal.aborted) return new ComputerUseExecutorError("session_revoked", "not_dispatched");
  return isComputerUseExecutorError(error)
    ? error
    : new ComputerUseExecutorError("execution_failed", "not_dispatched");
}
