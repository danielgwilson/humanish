// Whether this terminal can render the characters we write to it.
//
// FOUND BY A PARTICIPANT, not by us (labs/tui-self-study.yaml): a computer-use participant sitting
// at a stock desktop ran `humanish` and read back `humanish ��� run realistic synthetic personas`.
// The em dash is three bytes of UTF-8, and a terminal whose locale is not UTF-8 renders each byte
// as a replacement glyph. Every ASCII character on the same screen was fine, which is exactly the
// signature.
//
// The honest fix is not "stop using em dashes" — it is to ask what the terminal can render and mean
// it. A surface that emits characters its own terminal cannot decode is not being expressive, it is
// producing garbage that reads as a bug in the tool.

const UTF8 = /utf-?8/i;

/**
 * Does this environment declare a UTF-8 locale? The POSIX variables are checked in the order the C
 * library resolves them (LC_ALL overrides LC_CTYPE overrides LANG).
 *
 * Windows terminals declare none of these and are handled as UTF-8: modern Windows Terminal and
 * PowerShell render it, and the failure this guards against is a Unix locale that says C/POSIX.
 */
export function terminalRendersUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === "win32") return true;
  const declared = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
  if (declared === undefined || declared.trim().length === 0) {
    // Nothing declared at all. A bare login shell on a stock image lands here, and that is the
    // case the participant hit — assume it cannot, because the failure is silent and ugly while
    // the fallback is merely plainer.
    return false;
  }
  return UTF8.test(declared);
}

/**
 * The ASCII stand-in for a character, when the terminal cannot render the real one. Anything with
 * no entry here is already ASCII and passes through.
 */
const ASCII_FALLBACKS = new Map<string, string>([
  ["—", "--"],
  ["–", "-"],
  ["’", "'"],
  ["‘", "'"],
  ["“", '"'],
  ["”", '"'],
  ["…", "..."],
  ["·", "-"],
  ["❯", ">"],
  ["‹", "<"],
  ["▸", ">"],
  ["✓", "+"],
  ["⚑", "!"],
  ["⏎", "Enter"],
  ["↑", "^"],
  ["↓", "v"],
  ["←", "<-"],
  ["→", "->"],
  ["×", "x"],
  ["≈", "~"],
  ["✗", "x"]
]);

/**
 * Rewrite a string so a non-UTF-8 terminal can read it. A no-op when the terminal handles Unicode,
 * so the good case keeps every glyph it was designed with.
 *
 * Characters with no declared fallback are replaced with `?` rather than passed through: passing
 * them through is what produced `���` in the first place, and one `?` is at least legible as
 * "something did not survive".
 */
export function forTerminal(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (terminalRendersUnicode(env)) return text;
  let out = "";
  for (const character of text) {
    if (character.codePointAt(0)! < 128) {
      out += character;
      continue;
    }
    out += ASCII_FALLBACKS.get(character) ?? "?";
  }
  return out;
}
