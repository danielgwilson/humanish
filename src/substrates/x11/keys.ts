import { ComputerUseExecutorError } from "../../actors/computer-use/executor-error.js";

// Key names for every X11 desktop: the hosted E2B and Modal desktops and the local guest. The
// translator (translator.ts) hands these strings to xdotool, which has a command language, so only
// names from these tables ever reach it. The guest runtime ships this module, so CI's
// guest-desktop job and scripts/guest-desktop-proof.mjs key on src/substrates/x11/ too.
//
// The tables take the names in OpenAI's computer-use key map, the names @e2b/desktop's press()
// mapped (the hosted desktop sent keys through it before), every printable ASCII punctuation
// character and its keysym name, and the X keysym names a model writing xdotool syntax sends. xdotool finds the key and the Shift level for a keysym itself, so `?`
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

/** Every printable ASCII punctuation character, keyed by itself, as its keysym. */
const punctuation: Readonly<Record<string, string>> = Object.freeze({
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

/** A table's keysym names keyed by themselves, upper-cased, so `ctrl+minus` works as `ctrl+-`. */
function keysymNamesOf(table: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.values(table).map((name) => [name.toUpperCase(), name]));
}

/**
 * X keysym names a model that writes xdotool syntax sends, as Anthropic's computer-use tool asks
 * for, beyond those the names above already reach. Each arrived in Chrome as its own key on E2B
 * and Modal desktops on 2026-10-26. `Meta` keys map to `Super` as the `META` modifier does.
 */
const xKeysyms: Readonly<Record<string, string>> = Object.freeze({
  PRIOR: "Prior",
  NEXT: "Next",
  ISO_LEFT_TAB: "ISO_Left_Tab",
  CONTROL_L: "Control_L",
  CONTROL_R: "Control_R",
  ALT_L: "Alt_L",
  ALT_R: "Alt_R",
  SHIFT_L: "Shift_L",
  SHIFT_R: "Shift_R",
  SUPER_L: "Super_L",
  SUPER_R: "Super_R",
  META_L: "Super_L",
  META_R: "Super_R",
  KP_ENTER: "KP_Enter",
  ...Object.fromEntries(Array.from({ length: 10 }, (_, digit) => [`KP_${digit}`, `KP_${digit}`])),
  KP_ADD: "KP_Add",
  KP_SUBTRACT: "KP_Subtract",
  KP_MULTIPLY: "KP_Multiply",
  KP_DIVIDE: "KP_Divide",
  KP_DECIMAL: "KP_Decimal",
  // The keypad's navigation keysyms share keycodes with its digits, and xdotool reaches the
  // digits by toggling Num Lock, so a sent KP_Home arrived as 7 on E2B and Modal. They map to the
  // main keys, which arrive as named. KP_Begin has no main key and is refused.
  KP_HOME: "Home",
  KP_END: "End",
  KP_UP: "Up",
  KP_DOWN: "Down",
  KP_LEFT: "Left",
  KP_RIGHT: "Right",
  KP_PRIOR: "Prior",
  KP_NEXT: "Next",
  KP_PAGE_UP: "Prior",
  KP_PAGE_DOWN: "Next",
  KP_INSERT: "Insert",
  KP_DELETE: "Delete",
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
  ...punctuation,
  ...keysymNamesOf(punctuation),
  ...xKeysyms,
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
