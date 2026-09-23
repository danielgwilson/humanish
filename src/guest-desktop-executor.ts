import { perceptualSignature } from "./frame-signature.js";
import { setTimeout as delay } from "node:timers/promises";
import type { CuaAction, CuaExecutor } from "./computer-use.js";
import { BROWSER_CONTROL_LIMITS, validateBrowserControlAction, validateBrowserControlPng } from "./browser-control-protocol.js";
import { CuaExecutorError, isCuaExecutorError } from "./cua-executor-error.js";

/** Internal guest port. Implementations recheck signal synchronously before native dispatch. */
export interface GuestDesktopTools {
  capture(signal: AbortSignal): Promise<Buffer>;
  input(args: readonly string[], signal: AbortSignal): Promise<void>;
  prepareText(text: string, signal: AbortSignal): Promise<{ paste(): Promise<void>; close(): Promise<void> }>;
}

const keyNames: Readonly<Record<string, string>> = Object.freeze({
  CTRL: "ctrl", CONTROL: "ctrl", ALT: "alt", SHIFT: "shift", META: "super", SUPER: "super", CMD: "super",
  ENTER: "Return", RETURN: "Return", TAB: "Tab", ESC: "Escape", ESCAPE: "Escape", SPACE: "space", " ": "space",
  BACKSPACE: "BackSpace", DELETE: "Delete", INSERT: "Insert", HOME: "Home", END: "End",
  PAGEUP: "Prior", PAGEDOWN: "Next", ARROWUP: "Up", ARROWDOWN: "Down", ARROWLEFT: "Left", ARROWRIGHT: "Right",
  UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right",
  "+": "plus", "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", "\\": "backslash",
  ";": "semicolon", "'": "apostrophe", "[": "bracketleft", "]": "bracketright", "`": "grave"
});

/** xdotool has a command language: never send an unchecked key name to it. */
export function guestDesktopChord(keys: readonly string[]): string {
  const normalized = keys.map(key => {
    if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
    if (/^F(?:[1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
    const name = Object.hasOwn(keyNames, key.toUpperCase()) ? keyNames[key.toUpperCase()] : undefined;
    if (!name) throw new CuaExecutorError("action_rejected", "not_dispatched");
    return name;
  });
  if (new Set(normalized).size !== normalized.length) throw new CuaExecutorError("action_rejected", "not_dispatched");
  return normalized.join("+");
}

export interface GuestDesktopExecutorOptions {
  width: number;
  height: number;
  tools: GuestDesktopTools;
  authoritySignal: AbortSignal;
  /** Owner must stop the private display/browser after a partial/uncertain input. */
  onTerminal: () => void;
}

/** Headed X11 input and full-frame captures. Browser metadata is deliberately absent. */
export function createGuestDesktopExecutor(options: GuestDesktopExecutorOptions): CuaExecutor {
  const { width, height, tools, authoritySignal } = options;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= BROWSER_CONTROL_LIMITS.dimension)
    || width * height > BROWSER_CONTROL_LIMITS.pixels) throw new CuaExecutorError("invalid_request", "not_dispatched");
  let busy = false;
  let terminal = false;
  function terminate(): void {
    if (terminal) return;
    terminal = true;
    try { options.onTerminal(); } catch { /* Terminal state remains closed even if the owner fails. */ }
  }
  function assertOpen(signal: AbortSignal, dispatched = false): void {
    if (terminal || signal.aborted) throw new CuaExecutorError("session_revoked", dispatched ? "outcome_uncertain" : "not_dispatched");
  }
  function begin(signal: AbortSignal): void {
    assertOpen(signal);
    if (busy) throw new CuaExecutorError("executor_busy", "not_dispatched");
    busy = true;
  }
  function point(x: number, y: number): string[] {
    // Reject out-of-frame input instead of clicking a clamped, unintended target.
    if (x < 0 || y < 0 || x >= width || y >= height) throw new CuaExecutorError("action_rejected", "not_dispatched");
    return [String(Math.min(width - 1, Math.round(x))), String(Math.min(height - 1, Math.round(y)))];
  }
  function plan(action: CuaAction): string[][] {
    switch (action.kind) {
      case "move": return [["mousemove", ...point(action.x, action.y)]];
      case "click": return [["mousemove", ...point(action.x, action.y)], ["click", { left: "1", middle: "2", right: "3" }[action.button ?? "left"]]];
      case "double_click": return [["mousemove", ...point(action.x, action.y)], ["click", "--repeat", "2", "--delay", "100", "1"]];
      case "keypress": return [["key", "--clearmodifiers", guestDesktopChord(action.keys)]];
      case "type": {
        // Text transports require exact UTF-8; NUL truncation and lone surrogates
        // must be refused instead of silently changing the requested text.
        if (action.text.includes("\0") || Buffer.from(action.text, "utf8").toString("utf8") !== action.text) throw new CuaExecutorError("action_rejected", "not_dispatched");
        return [];
      }
      case "drag": {
        const points = action.path.map(p => point(p.x, p.y));
        if (points.length < 2) throw new CuaExecutorError("action_rejected", "not_dispatched");
        return [["mousemove", ...points[0]!], ["mousedown", "1"], ...points.slice(1).map(p => ["mousemove", ...p]), ["mouseup", "1"]];
      }
      case "scroll": {
        const origin = point(action.x, action.y);
        // Native X11 wheel steps do not promise exact pixel scroll distances.
        const horizontal = Math.ceil(Math.abs(action.dx) / 120), vertical = Math.ceil(Math.abs(action.dy) / 120);
        if (horizontal + vertical > 100) throw new CuaExecutorError("action_rejected", "not_dispatched");
        return horizontal + vertical === 0 ? [] : [["mousemove", ...origin],
          ...Array.from({ length: horizontal }, () => ["click", action.dx > 0 ? "7" : "6"]),
          ...Array.from({ length: vertical }, () => ["click", action.dy > 0 ? "5" : "4"])];
      }
      case "wait": case "screenshot": return [];
    }
  }
  return {
    stallRecovery: "fail_closed",
    async observe() {
      begin(authoritySignal);
      try {
        const screenshot = await tools.capture(authoritySignal);
        assertOpen(authoritySignal);
        validateBrowserControlPng(screenshot);
        if (screenshot.readUInt32BE(16) !== width || screenshot.readUInt32BE(20) !== height) {
          throw new CuaExecutorError("invalid_response", "not_dispatched");
        }
        return { screenshot, stateSignature: perceptualSignature(screenshot) };
      } catch (error) {
        terminate();
        throw isCuaExecutorError(error) ? error : new CuaExecutorError("execution_failed", "not_dispatched");
      } finally { busy = false; }
    },
    async execute(value, callerSignal) {
      const signal = callerSignal ? AbortSignal.any([authoritySignal, callerSignal]) : authoritySignal;
      begin(signal);
      let dispatched = false;
      let preparing = false;
      let text: Awaited<ReturnType<GuestDesktopTools["prepareText"]>> | undefined;
      try {
        const action = validateBrowserControlAction(value);
        const commands = plan(action); // Validate the entire action before any preparation/input.
        if (action.kind === "type" && action.text.length) {
          preparing = true;
          text = await tools.prepareText(action.text, signal);
          assertOpen(signal);
          dispatched = true;
          try { await text.paste(); }
          catch (error) {
            // This transaction has no earlier input. Its private bridge can
            // prove that no insertion or native input was sent.
            if (isCuaExecutorError(error) && error.disposition === "not_dispatched") dispatched = false;
            throw error;
          }
        }
        if (action.kind === "wait") await delay(action.ms ?? 250, undefined, { signal });
        for (const command of commands) {
          assertOpen(signal, dispatched);
          // No await between authority check and the native port invocation.
          dispatched = true;
          await tools.input(command, signal);
        }
        assertOpen(signal, dispatched);
      } catch (error) {
        if ((preparing && !(isCuaExecutorError(error) && error.code === "action_rejected" && error.disposition === "not_dispatched")) || dispatched || signal.aborted || !isCuaExecutorError(error)) terminate();
        // Do not send mouseup/key-release after revocation: it can itself click/drop.
        if (dispatched) throw new CuaExecutorError(isCuaExecutorError(error) ? error.code : "execution_failed", "outcome_uncertain");
        if (signal.aborted) throw new CuaExecutorError("session_revoked", "not_dispatched");
        throw isCuaExecutorError(error) ? error : new CuaExecutorError("execution_failed", "not_dispatched");
      } finally {
        try { await text?.close(); }
        catch { terminate(); throw new CuaExecutorError("execution_failed", dispatched ? "outcome_uncertain" : "not_dispatched"); }
        finally { busy = false; }
      }
    }
  };
}
