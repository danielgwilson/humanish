import { describe, expect, it } from "vitest";

import { forTerminal, terminalRendersUnicode } from "../src/terminal-encoding.js";

// Found by a participant, not by us: a computer-use participant at a stock desktop read
// `humanish ??? run realistic synthetic personas` off the screen and reported it as broken
// characters (labs/tui-self-study.yaml). The stock image declares no locale at all.

describe("what a terminal can actually render", () => {
  it("trusts a declared UTF-8 locale, in the order the C library resolves them", () => {
    expect(terminalRendersUnicode({ LANG: "en_US.UTF-8" })).toBe(true);
    expect(terminalRendersUnicode({ LANG: "C", LC_CTYPE: "en_US.utf8" })).toBe(true);
    // LC_ALL overrides everything below it — including a UTF-8 LANG.
    expect(terminalRendersUnicode({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe(false);
  });

  it("treats an undeclared locale as unable, because that is the case that broke", () => {
    // The stock desktop template declares nothing. Assuming capability there is what produced
    // replacement glyphs on a real participant's screen; assuming the opposite costs a plainer
    // dash.
    expect(terminalRendersUnicode({})).toBe(false);
    expect(terminalRendersUnicode({ LANG: "" })).toBe(false);
    expect(terminalRendersUnicode({ LANG: "C" })).toBe(false);
    expect(terminalRendersUnicode({ LANG: "POSIX" })).toBe(false);
  });

  it("leaves text alone when the terminal can read it", () => {
    const text = "humanish — 1 × ~$0.62 · ✓ done";
    expect(forTerminal(text, { LANG: "en_US.UTF-8" })).toBe(text);
  });

  it("rewrites what it can and never passes an undecodable character through", () => {
    const ascii = forTerminal("humanish — ✓ 1 × ~$0.62 · ⚑ ❯ …", { LANG: "C" });
    expect(ascii).toBe("humanish -- + 1 x ~$0.62 - ! > ...");
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(ascii), "no non-ASCII may survive").toBe(false);
  });

  it("substitutes a question mark for a character with no declared fallback", () => {
    // Passing it through is exactly what produced the garbage; one `?` at least reads as
    // "something did not survive" rather than as a corrupted glyph.
    // One `?` per CODE POINT, not per UTF-16 unit: an astral character is one thing the reader
    // did not get, not two.
    expect(forTerminal("emoji 🎉 here", { LANG: "C" })).toBe("emoji ? here");
  });
});
