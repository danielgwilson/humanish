import { perceptualSignature } from "../evidence/frame-signature.js";
import { setTimeout as delay } from "node:timers/promises";
import type { CuaAction, CuaExecutor } from "../actors/computer-use/loop.js";
import {
  BROWSER_CONTROL_LIMITS,
  validateBrowserControlAction,
  validateBrowserControlPng,
} from "../browser-control/protocol.js";
import {
  ComputerUseExecutorError,
  isComputerUseExecutorError,
} from "../actors/computer-use/executor-error.js";
import { xdotoolChord, xdotoolHeldModifiers } from "./desktop-keys.js";

/** Internal guest port. Implementations recheck signal synchronously before native dispatch. */
export interface GuestDesktopTools {
  capture(signal: AbortSignal): Promise<Buffer>;
  input(args: readonly string[], signal: AbortSignal): Promise<void>;
  prepareText(
    text: string,
    signal: AbortSignal,
  ): Promise<{ paste(): Promise<void>; close(): Promise<void> }>;
}

export interface GuestDesktopExecutorOptions {
  width: number;
  height: number;
  tools: GuestDesktopTools;
  authoritySignal: AbortSignal;
  /** Owner must stop the private display/browser after a partial/uncertain input. */
  onTerminal: () => void;
}

/** The frame an executor addresses, in pixels. */
interface Frame {
  readonly width: number;
  readonly height: number;
}

/** The fixed inputs every observe and execute call reads. */
interface GuestExecutorContext extends Frame {
  readonly tools: GuestDesktopTools;
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

type TextChannel = Awaited<ReturnType<GuestDesktopTools["prepareText"]>>;

/** What one execute call has done so far. Its failure and cleanup paths read it. */
interface ActionProgress {
  /** Native input or a text insertion may have reached the desktop. */
  dispatched: boolean;
  /** Text preparation started. */
  preparing: boolean;
  /** The modifiers a keydown pressed and no keyup has released yet. */
  keysHeld: string | undefined;
  text: TextChannel | undefined;
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
 * Runs one action: validates and plans all of it first, pastes text, waits, then sends each
 * native command with the authority checked immediately before it.
 */
async function executeAction(
  context: GuestExecutorContext,
  state: GuestExecutorState,
  value: CuaAction,
  callerSignal: AbortSignal | undefined,
): Promise<void> {
  const { tools, authoritySignal } = context;
  const signal = callerSignal ? AbortSignal.any([authoritySignal, callerSignal]) : authoritySignal;
  begin(state, signal);
  const progress: ActionProgress = {
    dispatched: false,
    preparing: false,
    keysHeld: undefined,
    text: undefined,
  };
  try {
    const action = validateBrowserControlAction(value);
    const commands = planActionInput(context, action); // Validate the entire action before any preparation/input.
    if (action.kind === "type" && action.text.length) {
      progress.preparing = true;
      progress.text = await tools.prepareText(action.text, signal);
      assertOpen(state, signal);
      progress.dispatched = true;
      try {
        await progress.text.paste();
      } catch (error) {
        // This transaction has no earlier input. Its private bridge can
        // prove that no insertion or native input was sent.
        if (isComputerUseExecutorError(error) && error.disposition === "not_dispatched")
          progress.dispatched = false;
        throw error;
      }
    }
    if (action.kind === "wait") await delay(action.ms ?? 250, undefined, { signal });
    for (const command of commands) {
      assertOpen(state, signal, progress.dispatched);
      // No await between authority check and the native port invocation.
      progress.dispatched = true;
      // A keydown can press some keys before it fails; a failed keyup is not retried.
      if (command[0] === "keydown") progress.keysHeld = command[1];
      if (command[0] === "keyup") progress.keysHeld = undefined;
      await tools.input(command, signal);
    }
    assertOpen(state, signal, progress.dispatched);
  } catch (error) {
    // A failed pointer input still releases its modifiers. After revocation nothing more is
    // sent, as for the mouse button below.
    if (progress.keysHeld !== undefined && !signal.aborted) {
      try {
        await tools.input(["keyup", progress.keysHeld], signal);
      } catch {
        // The session ends below either way.
      }
    }
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

/**
 * The native commands for an action, wrapped in keydown/keyup when it holds modifiers. It throws
 * the refusal for an action the desktop cannot take, before anything is sent.
 */
export function planActionInput(frame: Frame, action: CuaAction): string[][] {
  const commands = actionCommands(frame, action);
  const held = "heldKeys" in action ? xdotoolHeldModifiers(action.heldKeys) : undefined;
  return held === undefined || commands.length === 0
    ? commands
    : [["keydown", held], ...commands, ["keyup", held]];
}

/** A pointer position as xdotool arguments. */
function framePoint(frame: Frame, x: number, y: number): string[] {
  const { width, height } = frame;
  // Reject out-of-frame input instead of clicking a clamped, unintended target.
  if (x < 0 || y < 0 || x >= width || y >= height)
    throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
  return [String(Math.min(width - 1, Math.round(x))), String(Math.min(height - 1, Math.round(y)))];
}

/** The native commands for an action, before any held modifiers. */
function actionCommands(frame: Frame, action: CuaAction): string[][] {
  switch (action.kind) {
    case "move":
      return [["mousemove", ...framePoint(frame, action.x, action.y)]];
    case "click":
      return [
        ["mousemove", ...framePoint(frame, action.x, action.y)],
        ["click", { left: "1", middle: "2", right: "3" }[action.button ?? "left"]],
      ];
    case "double_click":
      return [
        ["mousemove", ...framePoint(frame, action.x, action.y)],
        ["click", "--repeat", "2", "--delay", "100", "1"],
      ];
    case "keypress":
      return [["key", "--clearmodifiers", xdotoolChord(action.keys)]];
    case "type": {
      // Text transports require exact UTF-8; NUL truncation and lone surrogates
      // must be refused instead of silently changing the requested text.
      if (
        action.text.includes("\0") ||
        Buffer.from(action.text, "utf8").toString("utf8") !== action.text
      )
        throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
      return [];
    }
    case "drag": {
      const points = action.path.map((p) => framePoint(frame, p.x, p.y));
      if (points.length < 2)
        throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
      return [
        ["mousemove", ...points[0]!],
        ["mousedown", "1"],
        ...points.slice(1).map((p) => ["mousemove", ...p]),
        ["mouseup", "1"],
      ];
    }
    case "scroll": {
      const origin = framePoint(frame, action.x, action.y);
      // Native X11 wheel steps do not promise exact pixel scroll distances.
      const horizontal = Math.ceil(Math.abs(action.dx) / 120),
        vertical = Math.ceil(Math.abs(action.dy) / 120);
      if (horizontal + vertical > 100)
        throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
      return horizontal + vertical === 0
        ? []
        : [
            ["mousemove", ...origin],
            ...Array.from({ length: horizontal }, () => ["click", action.dx > 0 ? "7" : "6"]),
            ...Array.from({ length: vertical }, () => ["click", action.dy > 0 ? "5" : "4"]),
          ];
    }
    case "wait":
    case "screenshot":
      return [];
    case "speak":
      throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
  }
}
