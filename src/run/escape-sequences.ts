// What a terminal draws with and what a URL encodes with, found in one pass. RunSecrets looks for a
// value in a view of the text with the first dropped and the second decoded, so that a color code
// or a percent escape inside a value does not hide it.

const BEL = "\x07";
const STRING_TERMINATOR = "\x1b\\";

const between = (code: number, low: number, high: number): boolean => code >= low && code <= high;

const isHexDigit = (code: number): boolean =>
  between(code, 0x30, 0x39) || between(code, 0x41, 0x46) || between(code, 0x61, 0x66);

/**
 * The end of a control sequence whose parameter bytes start at `from`: parameter bytes, then
 * intermediate bytes, then one final byte. -1 when no final byte follows.
 */
function controlSequenceEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && between(text.charCodeAt(at), 0x30, 0x3f)) at += 1;
  while (at < text.length && between(text.charCodeAt(at), 0x20, 0x2f)) at += 1;
  return at < text.length && between(text.charCodeAt(at), 0x40, 0x7e) ? at + 1 : -1;
}

/** The end of the run of percent escapes that starts at `from`, or `from` when none does. */
function percentRunEnd(text: string, from: number): number {
  let end = from;
  while (
    end + 2 < text.length &&
    text[end] === "%" &&
    isHexDigit(text.charCodeAt(end + 1)) &&
    isHexDigit(text.charCodeAt(end + 2))
  )
    end += 3;
  return end;
}

/**
 * The stretches of the text a value's view drops or decodes, in order and without overlap, each
 * as [start, end): operating-system commands (`ESC ]`), control sequences (`ESC [`) and the
 * two-byte escapes `ESC 7`, `ESC 8`, `ESC =` and `ESC >`, raw or JSON-escaped (`\u001b`), and runs
 * of percent escapes. An operating-system command ends at the first BEL after it or, with none
 * after it, at the last `ESC \` in the text. A JSON-escaped one ends at the first backslash after
 * it, which must start `\u0007` or `\u001b\\`. A start with no end is left as written. These are the
 * matches of one regex of the six shapes; that regex took time quadratic in a run of unterminated
 * commands, and this takes time linear in the text.
 */
export function escapeSequences(text: string): [number, number][] {
  const lastTerminator = text.lastIndexOf(STRING_TERMINATOR);
  // The first BEL at or after the last place searched from. Starts only move forward, so each
  // stretch of text is searched once.
  let bel = text.indexOf(BEL);
  const commandEnd = (start: number): number => {
    if (bel !== -1 && bel < start + 2) bel = text.indexOf(BEL, start + 2);
    if (bel !== -1) return bel + 1;
    return lastTerminator >= start + 2 ? lastTerminator + STRING_TERMINATOR.length : -1;
  };
  const jsonCommandEnd = (start: number): number => {
    const backslash = text.indexOf("\\", start + 7);
    if (backslash === -1) return -1;
    if (text.startsWith("\\u0007", backslash)) return backslash + 6;
    return text.startsWith("\\u001b\\\\", backslash) ? backslash + 8 : -1;
  };
  const endAt = (at: number): number => {
    switch (text[at]) {
      case "\x1b": {
        const next = text[at + 1];
        if (next === "]") return commandEnd(at);
        if (next === "[") return controlSequenceEnd(text, at + 2);
        return next !== undefined && "78=>".includes(next) ? at + 2 : -1;
      }
      case "\\":
        if (text.startsWith("\\u001b]", at)) return jsonCommandEnd(at);
        return text.startsWith("\\u001b[", at) ? controlSequenceEnd(text, at + 7) : -1;
      case "%": {
        const end = percentRunEnd(text, at);
        return end === at ? -1 : end;
      }
      default:
        return -1;
    }
  };
  const sequences: [number, number][] = [];
  for (let at = 0; at < text.length;) {
    const end = endAt(at);
    if (end === -1) at += 1;
    else {
      sequences.push([at, end]);
      at = end;
    }
  }
  return sequences;
}
