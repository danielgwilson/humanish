import { ComputerUseExecutorError } from "../../actors/computer-use/executor-error.js";
import type { CuaAction, CuaRegion } from "../../actors/computer-use/loop.js";
import { CUA_WAIT_LIMITS } from "../../actors/computer-use/wait.js";
import { xdotoolChord, xdotoolHeldModifiers } from "./keys.js";

// The one translation from a computer-use action to X11 input. Every desktop humanish drives runs
// xdotool on an X display: E2B and Modal sandboxes and the local guest VM. This module turns a
// CuaAction into the native steps; desktop.ts runs them through a substrate's transport. A new
// action is added here once and reaches every desktop.
//
// The hosted desktops and the guest have sent different commands for the same action since before
// they shared this module. Each difference is a field of X11Dialect, with its reason. The fields
// are kept so this module changes nothing a desktop receives; unifying one is a behavior change
// with its own live check.

/** A point in desktop pixels. */
export interface X11Point {
  readonly x: number;
  readonly y: number;
}

/** A desktop frame's size in pixels. */
export interface X11Frame {
  readonly width: number;
  readonly height: number;
}

/** One native step of an action. */
export type X11Step =
  /**
   * One xdotool command: the words after `xdotool`. With `unlessPointerThere`, it is skipped when
   * the action's last `read-pointer` step found the pointer at its target.
   */
  | {
      readonly kind: "xdotool";
      readonly args: readonly string[];
      readonly unlessPointerThere?: true;
    }
  /** Read the pointer and note whether it is exactly at `at`. */
  | { readonly kind: "read-pointer"; readonly at: X11Point }
  /** Insert text at the keyboard focus through the transport's text path. */
  | { readonly kind: "text"; readonly text: string }
  /** Wait on the desktop. */
  | { readonly kind: "wait"; readonly ms: number }
  /** Read the pointer and return its position as the action's result. */
  | { readonly kind: "report-pointer" }
  /** Capture the desktop and return `region` of it as the action's result. */
  | { readonly kind: "report-region"; readonly region: X11Region };

/** A rectangle of the desktop in whole pixels. */
export type X11Region = Readonly<CuaRegion>;

/** An action's native steps and the modifiers held down around them. */
export interface X11Plan {
  /** An xdotool chord pressed before the steps and released after them, or undefined. */
  readonly held: string | undefined;
  readonly steps: readonly X11Step[];
}

/** How a scroll's pixel distance becomes wheel steps. */
type X11Scroll =
  /**
   * Vertical only, as one `click --repeat`: |dy| / pixelsPerStep rounded, at least one step, and
   * nothing for dy 0. @e2b/desktop's scroll took a direction and an amount, so dx never reached
   * a hosted desktop.
   */
  | { readonly kind: "vertical-repeat"; readonly pixelsPerStep: number }
  /**
   * One `click` per step on both axes, horizontal first, each distance divided by pixelsPerStep
   * and rounded up. More than maxSteps in one action is refused before any input, since a wheel
   * step is not an exact pixel distance.
   */
  | { readonly kind: "wheel-steps"; readonly pixelsPerStep: number; readonly maxSteps: number };

/** Where the hosted desktops and the guest send different commands for the same action. */
export interface X11Dialect {
  /**
   * The frame pointer input must land in. With one, a point outside it is refused before any
   * input and the rest are rounded to a pixel. Without one, coordinates reach xdotool as the
   * participant gave them, as @e2b/desktop passed them.
   */
  readonly frame: X11Frame | undefined;
  /** Moves wait for the pointer to arrive (`mousemove --sync`), as @e2b/desktop's moveMouse did. */
  readonly syncMoves: boolean;
  /**
   * Left and double clicks read the pointer first and skip the move when it is already at an
   * integer target: the stock E2B image's synchronized move to the pointer's own position waits
   * about 15 s.
   */
  readonly skipsRedundantClickMoves: boolean;
  /**
   * A click whose x or y is 0 does not move first. @e2b/desktop's click methods move only for
   * truthy coordinates, so a hosted click at x 0 clicks where the pointer is.
   */
  readonly clicksInPlaceAtZero: boolean;
  /**
   * xdotool's `--delay` between the clicks of a double or triple click; undefined keeps its
   * default.
   */
  readonly doubleClickDelayMs: number | undefined;
  readonly scroll: X11Scroll;
  /**
   * `path` moves through every point and refuses a path of fewer than two. `endpoints` drags from
   * the first point to the last and does nothing for a shorter path: @e2b/desktop's drag took two
   * points.
   */
  readonly drag: "path" | "endpoints";
  /**
   * `exact` refuses text that would not survive UTF-8 unchanged (a NUL or a lone surrogate) and
   * sends nothing for empty text: the guest's text transports need exact UTF-8. `as-given` hands
   * any text to the transport.
   */
  readonly text: "exact" | "as-given";
  /**
   * What a failed release of held keys reports. `uncertain` ends the action as execution_failed
   * with an uncertain outcome: a hosted desktop skips a failed command and carries on, so keys
   * that may still be down must stop that. `first-failure` reports the action's first failure:
   * any failed guest input ends its session already.
   */
  readonly releaseFailure: "uncertain" | "first-failure";
}

/**
 * The hosted desktops (E2B and Modal sandboxes): the commands @e2b/desktop 2.4's Sandbox methods
 * sent, which the hosted executor and the e2b-desktop modules were tuned against.
 */
export const HOSTED_X11_DIALECT: X11Dialect = Object.freeze({
  frame: undefined,
  syncMoves: true,
  skipsRedundantClickMoves: true,
  clicksInPlaceAtZero: true,
  doubleClickDelayMs: undefined,
  scroll: Object.freeze({ kind: "vertical-repeat", pixelsPerStep: 100 }),
  drag: "endpoints",
  text: "as-given",
  releaseFailure: "uncertain",
});

/** The local guest VM's headed display, whose input is checked against its frame. */
export function guestX11Dialect(frame: X11Frame): X11Dialect {
  return {
    frame: { width: frame.width, height: frame.height },
    syncMoves: false,
    skipsRedundantClickMoves: false,
    clicksInPlaceAtZero: false,
    doubleClickDelayMs: 100,
    scroll: { kind: "wheel-steps", pixelsPerStep: 120, maxSteps: 100 },
    drag: "path",
    text: "exact",
    releaseFailure: "first-failure",
  };
}

const BUTTONS = { left: "1", middle: "2", right: "3" } as const;

function refused(): ComputerUseExecutorError {
  return new ComputerUseExecutorError("action_rejected", "not_dispatched");
}

/**
 * The native steps for one action on a desktop that speaks `dialect`. It throws the refusal for an
 * action the desktop cannot take, before anything is sent. A pointer action that sends no input
 * holds no keys either.
 */
export function planX11Action(action: CuaAction, dialect: X11Dialect): X11Plan {
  if (action.kind === "hold_keys") return holdPlan(action);
  const held = "heldKeys" in action ? xdotoolHeldModifiers(action.heldKeys) : undefined;
  const steps = actionSteps(action, dialect);
  return { held: steps.length === 0 ? undefined : held, steps };
}

/** An action whose steps run with at most its pointer modifiers held. */
type StepAction = Exclude<CuaAction, { kind: "hold_keys" }>;

function actionSteps(action: StepAction, dialect: X11Dialect): X11Step[] {
  switch (action.kind) {
    case "move":
      return [move(dialect, action)];
    case "click": {
      const button = action.button ?? "left";
      return clickSteps(dialect, action, button, ["click", BUTTONS[button]]);
    }
    case "double_click":
      return clickSteps(dialect, action, "left", repeatedClick(dialect, 2));
    case "triple_click":
      return guardedMoveThen(dialect, action, xdotool(repeatedClick(dialect, 3)));
    case "mouse_down":
    case "mouse_up": {
      const press = xdotool([
        action.kind === "mouse_down" ? "mousedown" : "mouseup",
        BUTTONS[action.button ?? "left"],
      ]);
      const { x, y } = action;
      if (x === undefined && y === undefined) return [press];
      if (x === undefined || y === undefined) throw refused();
      return guardedMoveThen(dialect, { x, y }, press);
    }
    case "read_pointer":
      return [{ kind: "report-pointer" }];
    case "zoom":
      return [{ kind: "report-region", region: checkedRegion(dialect, action.region) }];
    case "scroll":
      return scrollSteps(dialect, action);
    case "drag":
      return dragSteps(dialect, action.path);
    case "type":
      return textSteps(dialect, action.text);
    case "keypress":
      return [xdotool(["key", "--clearmodifiers", xdotoolChord(action.keys)])];
    case "wait":
      // The loop sends every wait with its length; planWait owns the lengths.
      return [{ kind: "wait", ms: action.ms ?? CUA_WAIT_LIMITS.settleMs }];
    case "screenshot":
      // The loop captures each frame with observe(), so the action sends nothing.
      return [];
    case "speak":
      throw refused();
  }
}

/**
 * Hold a chord for the action's length: one keydown, a wait on the desktop and one keyup, which
 * the runner sends even when the wait fails. Any key may be held, since holding is the action; a
 * hold longer than one desktop call carries is refused.
 */
function holdPlan(action: Extract<CuaAction, { kind: "hold_keys" }>): X11Plan {
  const { ms } = action;
  if (!Number.isFinite(ms) || ms < 0 || ms > CUA_WAIT_LIMITS.stepMs) throw refused();
  return { held: xdotoolChord(action.keys), steps: [{ kind: "wait", ms }] };
}

/** `click --repeat count`, with the dialect's delay between clicks, on the left button. */
function repeatedClick(dialect: X11Dialect, count: number): string[] {
  const delay = dialect.doubleClickDelayMs;
  return [
    "click",
    "--repeat",
    String(count),
    ...(delay === undefined ? [] : ["--delay", String(delay)]),
    "1",
  ];
}

/**
 * A move to `at`, then `command`. On a dialect with the pointer guard the move is skipped when the
 * pointer is already there, for every button. The actions added after the hosted desktops' command
 * set was fixed use this; click and double_click keep clickSteps' older rules.
 */
function guardedMoveThen(dialect: X11Dialect, at: X11Point, command: X11Command): X11Step[] {
  const step = move(dialect, at);
  if (!dialect.skipsRedundantClickMoves) return [step, command];
  return [
    { kind: "read-pointer", at: { x: at.x, y: at.y } },
    { ...step, unlessPointerThere: true },
    command,
  ];
}

/**
 * A zoom region of whole pixels, at least one wide and high. A dialect with a frame refuses a
 * region that leaves it here; elsewhere the runner checks it against the captured frame.
 */
function checkedRegion(dialect: X11Dialect, region: X11Region): X11Region {
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0) throw refused();
  if (width < 1 || height < 1) throw refused();
  const frame = dialect.frame;
  if (frame !== undefined && (x + width > frame.width || y + height > frame.height))
    throw refused();
  return { x, y, width, height };
}

/** A one-command step. */
type X11Command = Extract<X11Step, { kind: "xdotool" }>;

function xdotool(args: readonly string[]): X11Command {
  return { kind: "xdotool", args };
}

/** A point as xdotool arguments: checked and rounded against the dialect's frame, if it has one. */
function pointArgs(dialect: X11Dialect, { x, y }: X11Point): string[] {
  const frame = dialect.frame;
  if (frame === undefined) return [String(x), String(y)];
  // Refuse out-of-frame input instead of clicking a clamped, unintended target.
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw refused();
  return [
    String(Math.min(frame.width - 1, Math.round(x))),
    String(Math.min(frame.height - 1, Math.round(y))),
  ];
}

function move(dialect: X11Dialect, point: X11Point): X11Command {
  return xdotool([
    "mousemove",
    ...(dialect.syncMoves ? ["--sync"] : []),
    ...pointArgs(dialect, point),
  ]);
}

/** A move to `at` (unless the dialect clicks in place there), then `click`. */
function clickSteps(
  dialect: X11Dialect,
  at: X11Point,
  button: keyof typeof BUTTONS,
  click: readonly string[],
): X11Step[] {
  const steps: X11Step[] = [];
  const guarded = dialect.skipsRedundantClickMoves && button === "left";
  if (guarded) steps.push({ kind: "read-pointer", at: { x: at.x, y: at.y } });
  if (!(dialect.clicksInPlaceAtZero && !(at.x && at.y))) {
    const step = move(dialect, at);
    steps.push(guarded ? { ...step, unlessPointerThere: true } : step);
  }
  steps.push(xdotool(click));
  return steps;
}

function scrollSteps(
  dialect: X11Dialect,
  action: Extract<CuaAction, { kind: "scroll" }>,
): X11Step[] {
  const scroll = dialect.scroll;
  if (scroll.kind === "vertical-repeat") {
    if (action.dy === 0) return [];
    const steps = Math.max(1, Math.round(Math.abs(action.dy) / scroll.pixelsPerStep));
    return [
      move(dialect, action),
      xdotool(["click", "--repeat", String(steps), action.dy > 0 ? "5" : "4"]),
    ];
  }
  const origin = move(dialect, action);
  const horizontal = Math.ceil(Math.abs(action.dx) / scroll.pixelsPerStep);
  const vertical = Math.ceil(Math.abs(action.dy) / scroll.pixelsPerStep);
  if (horizontal + vertical > scroll.maxSteps) throw refused();
  if (horizontal + vertical === 0) return [];
  return [
    origin,
    ...Array.from({ length: horizontal }, () => xdotool(["click", action.dx > 0 ? "7" : "6"])),
    ...Array.from({ length: vertical }, () => xdotool(["click", action.dy > 0 ? "5" : "4"])),
  ];
}

function dragSteps(dialect: X11Dialect, path: readonly X11Point[]): X11Step[] {
  if (dialect.drag === "endpoints" && path.length < 2) return [];
  const points = dialect.drag === "endpoints" ? [path[0]!, path.at(-1)!] : path;
  // Every point is checked before the first input.
  const [first, ...rest] = points.map((point) => move(dialect, point));
  if (first === undefined || rest.length === 0) throw refused();
  return [first, xdotool(["mousedown", "1"]), ...rest, xdotool(["mouseup", "1"])];
}

function textSteps(dialect: X11Dialect, text: string): X11Step[] {
  if (dialect.text === "as-given") return [{ kind: "text", text }];
  if (text.includes("\0") || Buffer.from(text, "utf8").toString("utf8") !== text) throw refused();
  return text.length === 0 ? [] : [{ kind: "text", text }];
}
