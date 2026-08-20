// The surface's own colours (#455).
//
// These are the tokens from the reviewed design, not ANSI names. `"cyan"` and `"green"` hand the
// decision to whoever themed the terminal, so the same build looks different on every machine and
// matches the agreed design on none of them — including the ones where a themed "yellow" is barely
// distinguishable from the body text it is meant to warn against.
//
// Hex is downsampled by chalk to 256 or 16 colours when the terminal cannot do better, so the
// worst case is what we had before rather than a broken screen. `NO_COLOR` and a non-TTY are
// handled by chalk as well: everything degrades to plain text, and every state that carries colour
// also carries a glyph or a word, so nothing is encoded in hue alone.
export const PALETTE = {
  /** Selection, the cursor, and anything the operator is pointed at. */
  accent: "#93a2ff",
  /** Alive and well: a running participant, a passing verdict. */
  ok: "#7dc9a0",
  /** Wants attention but is not a failure: interrupted, missing keys, live spend. */
  warn: "#d9a441",
  /** A failed verdict. */
  bad: "#e0796b"
} as const;

export type PaletteName = keyof typeof PALETTE;
