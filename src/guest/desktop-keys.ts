import { ComputerUseExecutorError } from "../actors/computer-use/executor-error.js";

// Key names for the xdotool-driven desktops: the guest's headed display and the E2B sandbox. Both
// hand these strings to xdotool, which has a command language, so only names from these tables
// ever reach it. The guest runtime ships this module, so it lives in src/guest/, which CI's
// guest-desktop job and scripts/guest-desktop-proof.mjs key on.
//
// The tables take the names in OpenAI's computer-use key map, the names @e2b/desktop's press()
// mapped (the hosted desktop sent keys through it before), and every printable ASCII
// punctuation character. xdotool finds the key and the Shift level for a keysym itself, so `?`
// arrives as `question` with Shift held on an American English keymap.

/** The modifiers a pointer action may hold, keyed by the upper-cased provider name. */
const modifierNames: Readonly<Record<string, string>> = Object.freeze({
  CTRL: "ctrl",
  CONTROL: "ctrl",
  ALT: "alt",
  OPTION: "alt",
  SHIFT: "shift",
  META: "super",
  SUPER: "super",
  CMD: "super",
  COMMAND: "super",
  WIN: "super",
  WINDOWS: "super",
});

const keyNames: Readonly<Record<string, string>> = Object.freeze({
  ...modifierNames,
  CONTROL_LEFT: "Control_L",
  CONTROL_RIGHT: "Control_R",
  ALT_LEFT: "Alt_L",
  ALT_RIGHT: "Alt_R",
  SHIFT_LEFT: "Shift_L",
  SHIFT_RIGHT: "Shift_R",
  SUPER_LEFT: "Super_L",
  SUPER_RIGHT: "Super_R",
  ENTER: "Return",
  RETURN: "Return",
  TAB: "Tab",
  ESC: "Escape",
  ESCAPE: "Escape",
  SPACE: "space",
  " ": "space",
  BACKSPACE: "BackSpace",
  DELETE: "Delete",
  DEL: "Delete",
  INSERT: "Insert",
  HOME: "Home",
  END: "End",
  PAGEUP: "Prior",
  PAGEDOWN: "Next",
  PAGE_UP: "Prior",
  PAGE_DOWN: "Next",
  ARROWUP: "Up",
  ARROWDOWN: "Down",
  ARROWLEFT: "Left",
  ARROWRIGHT: "Right",
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
  CAPS_LOCK: "Caps_Lock",
  NUM_LOCK: "Num_Lock",
  SCROLL_LOCK: "Scroll_Lock",
  PAUSE: "Pause",
  BREAK: "Pause",
  PRINT: "Print",
  MENU: "Menu",
  "!": "exclam",
  '"': "quotedbl",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "&": "ampersand",
  "'": "apostrophe",
  "(": "parenleft",
  ")": "parenright",
  "*": "asterisk",
  "+": "plus",
  ",": "comma",
  "-": "minus",
  ".": "period",
  "/": "slash",
  ":": "colon",
  ";": "semicolon",
  "<": "less",
  "=": "equal",
  ">": "greater",
  "?": "question",
  "@": "at",
  "[": "bracketleft",
  "\\": "backslash",
  "]": "bracketright",
  "^": "asciicircum",
  _: "underscore",
  "`": "grave",
  "{": "braceleft",
  "|": "bar",
  "}": "braceright",
  "~": "asciitilde",
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

/**
 * A name that is itself a chord (`Control+a`, `ctrl++`) split at each plus sign that joins two
 * names. A lone `+` and a trailing `+` after a joining one are the plus key.
 */
function chordParts(key: string): string[] {
  return key.length > 1 ? key.split(/\+(?!$)/) : [key];
}

/** A keypress chord in xdotool syntax. Unknown or repeated keys are refused before dispatch. */
export function xdotoolChord(keys: readonly string[]): string {
  return chord(
    keys.flatMap(chordParts).map((key) => {
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
