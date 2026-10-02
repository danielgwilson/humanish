import { shellQuote } from "../shell.js";
import { perceptualSignature } from "../../evidence/frame-signature.js";
import { commandFailureInfo } from "../command-failure.js";

import type { CuaAction, CuaExecutor, CuaObservation } from "../../actors/computer-use/loop.js";
import { CuaExecutorError } from "../../actors/computer-use/executor-error.js";
import { xdotoolHeldModifiers } from "../../guest/desktop-keys.js";

// The desktop side of the computer-use loop: a CuaExecutor (from src/actors/computer-use/loop.ts)
// backed by an E2B desktop sandbox. All of its behavior goes through a narrow injected port
// (E2BDesktopLike), so tests drive it with a fake desktop that records calls: no SDK, no sandbox,
// no spend. The E2B desktop route (src/routes/computer-use/e2b-desktop/desktop.ts) passes the real
// Sandbox.
//
// E2BDesktopLike is a structural subset of the @e2b/desktop Sandbox (peer range ^2.3.2). Each
// method name and signature below matches the SDK class, so a Sandbox instance satisfies this
// interface with no adapter:
//
//   screenshot(): Promise<Uint8Array>            // default/'bytes' overload
//   leftClick(x?, y?): Promise<void>
//   rightClick(x?, y?): Promise<void>
//   middleClick(x?, y?): Promise<void>
//   doubleClick(x?, y?): Promise<void>
//   moveMouse(x, y): Promise<void>
//   getCursorPosition(): Promise<{ x: number; y: number }>
//   scroll(direction?: 'up' | 'down', amount?: number): Promise<void>
//   write(text, options?): Promise<void>         // the text-typing method
//   press(key: string | string[]): Promise<void>
//   drag([x1, y1], [x2, y2]): Promise<void>      // tuple endpoints, not a path
//   wait(ms): Promise<void>
//
// Deviations forced by the real SDK shape (vs the executor spec):
//  - scroll is vertical only: scroll(direction, amount) takes no coordinates, so the executor
//    moves the cursor to the action's point first, ignores dx, and maps dy to direction and
//    amount.
//  - drag takes two coordinate tuples (from, to), not an N-point path, so we drag
//    from the first point of action.path to the last and drop intermediate points.
//  - write is the typing method (there is no `type` method); press is the key
//    method (there is no `keyPress`), and press accepts the keys array directly.
//
// Public-safety: observe() returns the raw screenshot bytes in CuaObservation.screenshot. The
// loop decides what to persist (raw frames, or blurred ones when redactScreenshots is set), so
// this module never redacts and never logs screenshots or actions. The stateSignature is a
// coarse, non-reversible perceptual hash.

/**
 * The minimal slice of the @e2b/desktop Sandbox the executor depends on: a structural subset of
 * the SDK class (checked against 2.4.0), so a Sandbox satisfies it with no adapter. Methods are typed to return `Promise<void> | void` (and the
 * screenshot bytes likewise) so a synchronous fake also satisfies the port; the
 * executor awaits every call, which is correct for both sync and async returns.
 */
export interface E2BDesktopLike {
  /** Optional command surface used only for best-effort substrate fallbacks. */
  commands?: {
    run(
      command: string,
      options?: { requestTimeoutMs?: number; timeoutMs?: number },
    ): Promise<{
      exitCode?: number;
      stderr?: string;
      stdout?: string;
    }>;
  };
  /** Optional file surface for transferring typed text without shell-quoting it. */
  files?: {
    write(
      path: string,
      data: string | ArrayBuffer,
      options?: { requestTimeoutMs?: number; useOctetStream?: boolean },
    ): Promise<unknown>;
  };
  /** Capture the current desktop frame as PNG bytes (default/'bytes' overload). */
  screenshot(): Promise<Uint8Array | Buffer> | Uint8Array | Buffer;
  /** Left click, optionally moving to (x, y) first. */
  leftClick(x?: number, y?: number): Promise<void> | void;
  /** Right click, optionally moving to (x, y) first. */
  rightClick(x?: number, y?: number): Promise<void> | void;
  /** Middle click, optionally moving to (x, y) first. */
  middleClick(x?: number, y?: number): Promise<void> | void;
  /** Double left click, optionally moving to (x, y) first. */
  doubleClick(x?: number, y?: number): Promise<void> | void;
  /** Move the mouse to the given coordinates. */
  moveMouse(x: number, y: number): Promise<void> | void;
  /** Optional fresh pointer read; older/custom desktops retain coordinate-bearing clicks. */
  getCursorPosition?(): Promise<{ x: number; y: number }> | { x: number; y: number };
  /** Scroll the mouse wheel vertically by amount ticks in a direction. */
  scroll(direction?: "up" | "down", amount?: number): Promise<void> | void;
  /** Write text at the current cursor position (the SDK's typing method). */
  write(text: string): Promise<void> | void;
  /** Press a key or chord (the SDK's key method); accepts the keys array. */
  press(key: string | string[]): Promise<void> | void;
  /** Drag from one coordinate tuple to another. */
  drag(from: [number, number], to: [number, number]): Promise<void> | void;
  /** Wait for the given number of milliseconds. */
  wait(ms: number): Promise<void> | void;
}

export interface E2BDesktopExecutorOptions {
  /** Fallback wait when a wait action carries no ms. Default 500. */
  defaultWaitMs?: number;
  /**
   * Pixels of CuaAction scroll dy per one SDK scroll tick. The executor maps
   * abs(dy) / scrollAmountPerTick to the SDK's integer `amount` (floored at 1 for
   * any nonzero scroll). Default 100.
   */
  scrollAmountPerTick?: number;
  /**
   * Optional runtime-only browser state probe. Used for deterministic stopWhen guards. The loop
   * never persists raw URL/title/text; it only uses them in memory to decide whether to stop.
   */
  observeBrowserState?: () => Promise<Pick<CuaObservation, "url" | "title" | "text" | "scrollY">>;
}

const DEFAULT_WAIT_MS = 500;
const DEFAULT_SCROLL_AMOUNT_PER_TICK = 100;
const TYPE_COMMAND_TIMEOUT_MS = 15_000;
const HELD_KEYS_TIMEOUT_MS = 15_000;
const CURSOR_READ_TIMEOUT_MS = 500;

/**
 * The stock image's xdotool waits ~15s on a synchronized move to its current position.
 * Only an exact integer match can omit that move; fractional actions keep the SDK's own
 * coordinate conversion. Read every time: another action or sequential role may move it.
 * The SDK's getCursorPosition (2.3 through 2.4.0) takes no timeout or signal. Bound our wait, observe late
 * rejection, and leave the underlying read-only request alone; it cannot dispatch a click.
 */
function cursorAlreadyAt(
  desktop: E2BDesktopLike,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0)
    return Promise.resolve(false);
  let readPosition: E2BDesktopLike["getCursorPosition"];
  try {
    readPosition = desktop.getCursorPosition;
  } catch {
    return Promise.resolve(false);
  }
  if (typeof readPosition !== "function" || signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (matches: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(matches);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(false), CURSOR_READ_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => (settled ? undefined : readPosition.call(desktop)))
      .then(
        (position: unknown) => {
          if (settled) return;
          if (position === null || typeof position !== "object") {
            finish(false);
            return;
          }
          // A custom port can return malformed values or throwing accessors; all are uncertainty.
          try {
            const point = position as { x?: unknown; y?: unknown };
            finish(
              Number.isSafeInteger(point.x) &&
                Number.isSafeInteger(point.y) &&
                point.x === x &&
                point.y === y,
            );
          } catch {
            finish(false);
          }
        },
        () => finish(false),
      );
  });
}

/** Coerce screenshot bytes (Uint8Array or Buffer) to a Node Buffer without copying when possible. */
function toBuffer(bytes: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/** The stage of a `type` action that failed. */
export type CuaTypePhase = "desktop-write" | "text-tempfile" | "text-command";

/**
 * A `type` action that failed. Typed text can be a credential (a login step typing a subject-env
 * password), so the message names the phase and, for xdotool, its exit code only: no text, no
 * temp-file path, no substrate output. The loop records `.name` + `.message` into the actor trace.
 */
export class CuaTypeError extends Error {
  readonly phase: CuaTypePhase;
  readonly exitCode?: number;

  constructor(phase: CuaTypePhase, exitCode?: number) {
    super(`type failed at ${phase}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`);
    this.name = "CuaTypeError";
    this.phase = phase;
    if (exitCode !== undefined) this.exitCode = exitCode;
  }
}

/** The SDK write's per-character delay, kept so typing keeps its pace. */
const XDOTOOL_TYPE_DELAY_MS = 75;

const TYPE_DIRECTORY = /^\/tmp\/humanish-type-[A-Za-z0-9]+$/;

/** A desktop with the command and file surfaces typeText needs. */
type TypingDesktop = E2BDesktopLike & Required<Pick<E2BDesktopLike, "commands" | "files">>;

function canTypeText(desktop: E2BDesktopLike): desktop is TypingDesktop {
  return desktop.commands !== undefined && desktop.files !== undefined;
}

/**
 * Type `text` with one xdotool command in the UTF-8 locale, reading it from a file.
 *
 * The stock desktop runs commands in the C locale, where xdotool types the characters before the
 * first non-ASCII one and then fails; the SDK write splits text into 25-unit chunks and fails the
 * same way partway through. Either would leave a prefix typed, so there is one attempt and no
 * retry. The text is written to a 0600 file in a directory `mktemp -d` makes, passed to xdotool by
 * path (never through the shell), and the directory is removed on every exit.
 */
async function typeText(desktop: TypingDesktop, text: string): Promise<void> {
  const { commands, files } = desktop;
  const quick = { requestTimeoutMs: TYPE_COMMAND_TIMEOUT_MS, timeoutMs: TYPE_COMMAND_TIMEOUT_MS };
  let directory: string | undefined;
  try {
    const made = await commands.run(
      'umask 077 && d=$(mktemp -d /tmp/humanish-type-XXXXXXXX) && : > "$d/text" && printf \'%s\' "$d"',
      quick,
    );
    directory = made.stdout?.trim();
  } catch {
    throw new CuaTypeError("text-tempfile");
  }
  if (directory === undefined || !TYPE_DIRECTORY.test(directory))
    throw new CuaTypeError("text-tempfile");
  const file = `${directory}/text`;
  try {
    try {
      await files.write(file, text, { requestTimeoutMs: TYPE_COMMAND_TIMEOUT_MS });
    } catch {
      throw new CuaTypeError("text-tempfile");
    }
    // xdotool waits the delay after every character, so a long text needs a longer budget.
    const timeoutMs = TYPE_COMMAND_TIMEOUT_MS + [...text].length * XDOTOOL_TYPE_DELAY_MS;
    let result: { exitCode?: number } | undefined;
    try {
      result = await commands.run(
        `DISPLAY="\${DISPLAY:-:0}" LC_ALL=C.UTF-8 xdotool type --delay ${XDOTOOL_TYPE_DELAY_MS} --file ${shellQuote(file)}`,
        { requestTimeoutMs: timeoutMs, timeoutMs },
      );
    } catch (error) {
      // The SDK throws on a non-zero exit; only its exit code is kept.
      throw new CuaTypeError("text-command", commandFailureInfo(error).exitCode);
    }
    // A structural fake may return a non-zero exit instead of throwing, as the SDK does.
    if (result?.exitCode !== undefined && result.exitCode !== 0)
      throw new CuaTypeError("text-command", result.exitCode);
  } finally {
    await commands.run(`rm -rf -- ${shellQuote(directory)}`, quick).catch(() => undefined);
  }
}

/**
 * Create a CuaExecutor backed by an E2B desktop (or any structural E2BDesktopLike,
 * e.g. a CI fake). observe() captures a frame and computes its perceptual
 * signature; execute() dispatches one CuaAction to the matching desktop method.
 * Every desktop call is awaited so sync and async implementations both work. No
 * screenshot or action is ever logged.
 */
export function createE2BDesktopExecutor(
  desktop: E2BDesktopLike,
  options: E2BDesktopExecutorOptions = {},
): CuaExecutor {
  const defaultWaitMs = options.defaultWaitMs ?? DEFAULT_WAIT_MS;
  const scrollAmountPerTick = options.scrollAmountPerTick ?? DEFAULT_SCROLL_AMOUNT_PER_TICK;

  return {
    async observe(): Promise<CuaObservation> {
      // Probe browser state before the screenshot so a deterministic stopWhen match
      // and its persisted frame describe the same settled surface as closely as the
      // desktop substrate allows.
      const browserState = await options.observeBrowserState?.().catch(() => undefined);
      const raw = await desktop.screenshot();
      const screenshot = toBuffer(raw);
      return {
        screenshot,
        stateSignature: perceptualSignature(screenshot),
        ...(browserState?.url === undefined ? {} : { url: browserState.url }),
        ...(browserState?.title === undefined ? {} : { title: browserState.title }),
        ...(browserState?.text === undefined ? {} : { text: browserState.text }),
        ...(browserState?.scrollY === undefined ? {} : { scrollY: browserState.scrollY }),
      };
    },

    async execute(action: CuaAction, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      const held = "heldKeys" in action ? xdotoolHeldModifiers(action.heldKeys) : undefined;
      // A pointer action that sends no input presses no keys either, as on the guest desktop.
      if (held === undefined || sendsNoInput(action)) return dispatch(action, signal);
      return withHeldModifiers(desktop, held, () => dispatch(action, signal));
    },
  };

  async function dispatch(action: CuaAction, signal?: AbortSignal): Promise<void> {
    switch (action.kind) {
      case "click": {
        const button = action.button ?? "left";
        if (button === "right") {
          await desktop.rightClick(action.x, action.y);
        } else if (button === "middle") {
          await desktop.middleClick(action.x, action.y);
        } else {
          const alreadyAtTarget = await cursorAlreadyAt(desktop, action.x, action.y, signal);
          signal?.throwIfAborted();
          if (alreadyAtTarget) await desktop.leftClick();
          else await desktop.leftClick(action.x, action.y);
        }
        return;
      }
      case "double_click": {
        const alreadyAtTarget = await cursorAlreadyAt(desktop, action.x, action.y, signal);
        signal?.throwIfAborted();
        if (alreadyAtTarget) await desktop.doubleClick();
        else await desktop.doubleClick(action.x, action.y);
        return;
      }
      case "move":
        await desktop.moveMouse(action.x, action.y);
        return;
      case "scroll": {
        // The real SDK scroll is vertical only and takes no position, so move the
        // cursor to the scroll point first (the action targets a specific spot;
        // scrolling at the wrong cursor position would scroll the wrong panel).
        // dx (horizontal) has no SDK target and is ignored; a zero dy is a no-op.
        if (action.dy === 0) return;
        await desktop.moveMouse(action.x, action.y);
        const direction = action.dy > 0 ? "down" : "up";
        const amount = Math.max(1, Math.round(Math.abs(action.dy) / scrollAmountPerTick));
        await desktop.scroll(direction, amount);
        return;
      }
      case "type": {
        if (canTypeText(desktop)) {
          await typeText(desktop, action.text);
          return;
        }
        // A desktop without command and file surfaces keeps the SDK write, with no retry: a
        // failed write may already have typed part of the text. Its error could echo the
        // command, and so the text, so it is replaced.
        try {
          await desktop.write(action.text);
        } catch {
          throw new CuaTypeError("desktop-write");
        }
        return;
      }
      case "keypress":
        // The SDK press() accepts a string[] directly; pass the keys through so
        // a chord (e.g. ["Control", "a"]) is pressed together, not in sequence.
        await desktop.press(action.keys);
        return;
      case "drag": {
        // The SDK drag takes two endpoints, not an N-point path: drag from the
        // first to the last point. 0 points is a safe no-op; 1 point has no
        // distinct endpoint, so it is also a no-op (no spurious click/move).
        const path = action.path;
        if (path.length < 2) return;
        const from = path[0];
        const to = path[path.length - 1];
        if (from === undefined || to === undefined) return;
        await desktop.drag([from.x, from.y], [to.x, to.y]);
        return;
      }
      case "wait":
        await desktop.wait(action.ms ?? defaultWaitMs);
        return;
      case "screenshot":
        // No-op: the loop calls observe() separately to capture each frame, so
        // capturing here would double-capture. Leave the desktop untouched.
        return;
      case "speak":
        throw new CuaExecutorError("action_rejected", "not_dispatched");
    }
  }
}

function sendsNoInput(action: CuaAction): boolean {
  return (
    (action.kind === "scroll" && action.dy === 0) ||
    (action.kind === "drag" && action.path.length < 2)
  );
}

/**
 * Hold `chord` (xdotool modifier names) down for `run`, then release it whether `run` succeeded
 * or not. The SDK has no key-down method, so this uses the sandbox's command channel, where the
 * SDK's own input methods also run xdotool. A release that fails leaves the desktop in an unknown
 * state, so it ends the session.
 */
async function withHeldModifiers(
  desktop: E2BDesktopLike,
  chord: string,
  run: () => Promise<void>,
): Promise<void> {
  const commands = desktop.commands;
  if (!commands) throw new CuaExecutorError("action_rejected", "not_dispatched");
  const options = { requestTimeoutMs: HELD_KEYS_TIMEOUT_MS, timeoutMs: HELD_KEYS_TIMEOUT_MS };
  let failed = false;
  let failure: unknown;
  try {
    await commands.run(`xdotool keydown ${chord}`, options);
    await run();
  } catch (error) {
    failed = true;
    failure = error;
  }
  // A keydown that failed may still have pressed some keys, so the release always runs.
  try {
    await commands.run(`xdotool keyup ${chord}`, options);
  } catch {
    throw new CuaExecutorError("execution_failed", "outcome_uncertain");
  }
  if (failed) throw failure;
}
