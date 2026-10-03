import { ComputerUseExecutorError } from "../actors/computer-use/executor-error.js";

// Key names for the xdotool-driven desktops: the guest's headed display and the E2B sandbox. Both
// hand these strings to xdotool, which has a command language, so only names from these tables
// ever reach it. The guest runtime ships this module, so it lives in src/guest/, which CI's
// guest-desktop job and scripts/guest-desktop-proof.mjs key on.

/** The modifiers a pointer action may hold, keyed by the upper-cased provider name. */
const modifierNames: Readonly<Record<string, string>> = Object.freeze({
  CTRL: "ctrl",
  CONTROL: "ctrl",
  ALT: "alt",
  SHIFT: "shift",
  META: "super",
  SUPER: "super",
  CMD: "super",
});

const keyNames: Readonly<Record<string, string>> = Object.freeze({
  ...modifierNames,
  ENTER: "Return",
  RETURN: "Return",
  TAB: "Tab",
  ESC: "Escape",
  ESCAPE: "Escape",
  SPACE: "space",
  " ": "space",
  BACKSPACE: "BackSpace",
  DELETE: "Delete",
  INSERT: "Insert",
  HOME: "Home",
  END: "End",
  PAGEUP: "Prior",
  PAGEDOWN: "Next",
  ARROWUP: "Up",
  ARROWDOWN: "Down",
  ARROWLEFT: "Left",
  ARROWRIGHT: "Right",
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
  "+": "plus",
  "-": "minus",
  "=": "equal",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  ";": "semicolon",
  "'": "apostrophe",
  "[": "bracketleft",
  "]": "bracketright",
  "`": "grave",
});

function lookup(table: Readonly<Record<string, string>>, key: string): string | undefined {
  const upper = key.toUpperCase();
  return Object.hasOwn(table, upper) ? table[upper] : undefined;
}

function chord(names: string[]): string {
  if (new Set(names).size !== names.length)
    throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
  return names.join("+");
}

/** A keypress chord in xdotool syntax. Unknown or repeated keys are refused before dispatch. */
export function xdotoolChord(keys: readonly string[]): string {
  return chord(
    keys.map((key) => {
      if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
      if (/^F(?:[1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
      const name = lookup(keyNames, key);
      if (!name) throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
      return name;
    }),
  );
}

/**
 * The xdotool chord for a pointer action's held keys, or undefined when it holds none. Only
 * modifiers can be held, which is the use the OpenAI computer-use docs describe; an ordinary key
 * held down could type into the page.
 */
export function xdotoolHeldModifiers(keys: readonly string[] | undefined): string | undefined {
  if (keys === undefined || keys.length === 0) return undefined;
  return chord(
    keys.map((key) => {
      const name = lookup(modifierNames, key);
      if (!name) throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
      return name;
    }),
  );
}
