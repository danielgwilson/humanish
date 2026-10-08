import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  decodeEscapes,
  decodeEscapesUtf8,
  decodeEscapesWithOrigins,
  scanEncodedText,
  scanEncodedTextCached,
} from "../../src/evidence/encoded-text.js";
import { sensitivePatterns } from "../../src/evidence/redaction.js";
import { generateText, generateValues } from "../helpers/scrub-model.js";
import { checkProperty, propertyRun, shorterStrings } from "../helpers/seeded-random.js";

// Concatenated so this file never holds a secret-shaped literal; the scan detects it.
const SECRET = "sk-" + "syntheticvalue1234567890abcdef";
// Fixed binary that is neither text nor an archive: it starts with 0x0b and holds control and
// high bytes.
const binary = (length: number) =>
  Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) % 256));

describe("decodeEscapes", () => {
  it("undoes JSON, JS, percent and HTML escapes", () => {
    expect(decodeEscapes("\\u0073\\x6b\\/%2D&#115;&#x6B;&lowbar;&amp;")).toBe("sk/-sk_&");
  });

  it("reads each percent escape as one character", () => {
    expect(decodeEscapes("caf%C3%A9")).toBe("caf\u00c3\u00a9");
  });
});

/** The stretch of the original each decoded code unit came from, as `[start, end]` pairs. */
function originsOf(text: string, utf8 = false): [string, [number, number][]] {
  const decoded = decodeEscapesWithOrigins(text, utf8);
  return [decoded.text, [...decoded.starts].map((start, unit) => [start, decoded.ends[unit]!])];
}

/**
 * Why decodeEscapesWithOrigins is wrong for the text, or undefined: its text must equal the plain
 * decoder's, its stretches must cover the original in order with no gap, and each stretch must
 * decode on its own to text that holds the code unit it stands for.
 */
function originsProblem(text: string, utf8: boolean): string | undefined {
  const decode = utf8 ? decodeEscapesUtf8 : decodeEscapes;
  const { text: decoded, starts, ends } = decodeEscapesWithOrigins(text, utf8);
  if (decoded !== decode(text)) return `decodes to ${JSON.stringify(decoded)}`;
  let covered = 0;
  for (let unit = 0; unit < decoded.length; unit += 1) {
    const [start, end] = [starts[unit]!, ends[unit]!];
    const sameStretch = unit > 0 && start === starts[unit - 1] && end === ends[unit - 1];
    if (!sameStretch && start !== covered) return `unit ${unit} starts at ${start}, not ${covered}`;
    if (!decode(text.slice(start, end)).includes(decoded[unit]!))
      return `unit ${unit} does not come from ${JSON.stringify(text.slice(start, end))}`;
    covered = end;
  }
  return covered === text.length ? undefined : `the stretches end at ${covered}`;
}

describe("decodeEscapesWithOrigins", () => {
  it("maps each decoded character to the whole escape it came from", () => {
    expect(originsOf("a%41\\u0042&amp;")).toEqual([
      "aAB&",
      [
        [0, 1],
        [1, 4],
        [4, 10],
        [10, 15],
      ],
    ]);
  });

  it("maps a character to every escape that wrote it across passes", () => {
    // \u0025 writes the `%` of %41 in an earlier pass, and %26 the `&` of &#x37;.
    expect(originsOf("x\\u002541%26#x37;")).toEqual([
      "xA7",
      [
        [0, 1],
        [1, 9],
        [9, 17],
      ],
    ]);
  });

  it("maps a UTF-8 sequence to all its escapes and each byte to its own in the byte reading", () => {
    expect(originsOf("%C3%A9!", true)).toEqual([
      "é!",
      [
        [0, 6],
        [6, 7],
      ],
    ]);
    expect(originsOf("%C3%A9!")).toEqual([
      "\u00c3\u00a9!",
      [
        [0, 3],
        [3, 6],
        [6, 7],
      ],
    ]);
  });

  it("maps both halves of a surrogate pair to the reference that wrote them", () => {
    expect(originsOf("&#x1F600;")).toEqual([
      "😀",
      [
        [0, 9],
        [0, 9],
      ],
    ]);
  });

  it("decodes as decodeEscapes and decodeEscapesUtf8 do, with stretches that cover the text in order", async () => {
    for (const utf8 of [false, true])
      expect(
        await checkProperty(
          {
            generate: (random) => generateText(random, generateValues(random), true),
            check: async (text) => originsProblem(text, utf8),
            shrink: (text) => shorterStrings(text),
            show: (text) => JSON.stringify(text),
          },
          propertyRun(400),
        ),
      ).toBeUndefined();
  });
});

describe("decodeEscapesUtf8", () => {
  it("reads a run of percent escapes as UTF-8", () => {
    expect(decodeEscapesUtf8("caf%C3%A9 %e2%82%ac %F0%9F%98%80")).toBe("café € 😀");
    expect(decodeEscapesUtf8("voil%C3%A0%2Fsecret &amp; \\u0073")).toBe("voilà/secret & s");
  });

  it("keeps a byte that starts no valid UTF-8 sequence as one character", () => {
    // A lone byte, a cut-short sequence, an overlong `/` and a surrogate half.
    expect(decodeEscapesUtf8("%E9t%E9")).toBe("\u00e9t\u00e9");
    expect(decodeEscapesUtf8("%C3")).toBe("\u00c3");
    expect(decodeEscapesUtf8("%E2%82x")).toBe("\u00e2\u0082x");
    expect(decodeEscapesUtf8("%C0%AF")).toBe("\u00c0\u00af");
    expect(decodeEscapesUtf8("%ED%A0%80")).toBe("\u00ed\u00a0\u0080");
    expect(decodeEscapesUtf8("%FF%C3%A9")).toBe("\u00ffé");
  });
});

describe("decodeEscapes, continued", () => {
  it("leaves text without escapes and unknown references alone", () => {
    expect(decodeEscapes("plain text &unknown; 100%")).toBe("plain text &unknown; 100%");
  });
});

describe("scanEncodedText", () => {
  // Each reading of percent-encoded UTF-8 puts a space where the other does not: à (C3 A0) read
  // byte by byte ends in a no-break space, and U+2000 (E2 80 80) is a space read as UTF-8.
  it.each([
    ["read as UTF-8", "%3Fpassword%3DVoil%C3%A0Correlation7Battery"],
    ["read byte by byte", "%3Fpassword%3Dabcde%E2%80%80LongSecret7Battery"],
  ])("finds a percent-encoded password only %s", (_reading, text) => {
    expect(scanEncodedText(text).sensitive).toBe(true);
  });

  it("finds the secret through each encoding", () => {
    for (const text of [
      SECRET,
      Buffer.from(SECRET).toString("base64"),
      Buffer.from(SECRET, "utf16le").toString("base64"),
      Buffer.from(Buffer.from(SECRET).toString("base64")).toString("base64"),
      `"${Buffer.from(SECRET).toString("base64").replace(/\//g, "\\/")}"`,
    ]) {
      expect(scanEncodedText(text).sensitive, text).toBe(true);
    }
  });

  it("calls an encoded archive or a long encoded binary run opaque", () => {
    expect(scanEncodedText(gzipSync("anything").toString("base64")).opaque).toBe(true);
    expect(scanEncodedText(binary(96).toString("base64")).opaque).toBe(true);
  });

  it("allows opaque runs when the caller says so, but still finds an encoded secret", () => {
    const options = { allowOpaqueBase64: true };
    expect(scanEncodedText(binary(96).toString("base64"), options).opaque).toBe(false);
    expect(scanEncodedText(Buffer.from(SECRET).toString("base64"), options).sensitive).toBe(true);
  });

  it("leaves hex digests, identifiers, URL paths, filler and short binary runs alone", () => {
    for (const text of [
      "sha256:dc1ee8a784c37702b5b456b1657db9c8ce3fc98fd4e30c203b300aaf724eae2f",
      "runScriptedBrowserSessionInPreparedRoot",
      "com/danielgwilson/humanish/releases/download/runtime",
      "x".repeat(2000),
      binary(48).toString("base64"),
    ]) {
      expect(scanEncodedText(text), text).toEqual({ sensitive: false, opaque: false });
    }
  });
});

// utf16Text skips bytes with no 0x00 because every pattern needs ASCII, and ASCII in UTF-16 always
// has a zero byte. These fail if a pattern that could match without ASCII is ever added.
describe("the sensitive patterns the UTF-16 gate relies on", () => {
  it("are written in ASCII without Unicode mode", () => {
    for (const pattern of sensitivePatterns()) {
      expect(pattern.source, pattern.source).toMatch(/^[\x20-\x7e]*$/);
      expect(pattern.unicode || pattern.flags.includes("v"), pattern.source).toBe(false);
    }
  });

  it("each require an ASCII letter or digit outside any class or quantifier", () => {
    for (const pattern of sensitivePatterns()) {
      const literals = pattern.source
        .replace(/\\./g, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\{\d+(?:,\d*)?\}/g, "")
        .replace(/[(){}?:*+|^$.]/g, "");
      expect(literals, pattern.source).toMatch(/[A-Za-z0-9]/);
    }
  });
});

describe("scanEncodedTextCached", () => {
  it("returns what scanEncodedText returns, cached or not", () => {
    for (const text of [
      Buffer.from(SECRET).toString("base64"),
      gzipSync("anything").toString("base64"),
      "plain text",
    ]) {
      const fresh = scanEncodedText(text);
      expect(scanEncodedTextCached(text)).toEqual(fresh);
      expect(scanEncodedTextCached(text)).toEqual(fresh);
    }
  });

  it("hands out a frozen result, so no caller can change what the cache holds", () => {
    const text = "frozen check";
    expect(Object.isFrozen(scanEncodedTextCached(text))).toBe(true);
  });

  it("keys the cache on the options as well as the bytes", () => {
    const text = binary(96).toString("base64");
    expect(scanEncodedTextCached(text).opaque).toBe(true);
    expect(scanEncodedTextCached(text, { allowOpaqueBase64: true }).opaque).toBe(false);
    expect(scanEncodedTextCached(text).opaque).toBe(true);
  });

  it("keys on the exact string, so strings that share a UTF-8 encoding stay apart", () => {
    const loneSurrogate = `${Buffer.from(SECRET).toString("base64")} \ud800`;
    const replacement = `${Buffer.from(SECRET).toString("base64")} \ufffd`;
    expect(Buffer.from(loneSurrogate).equals(Buffer.from(replacement))).toBe(true);
    expect(scanEncodedTextCached(loneSurrogate)).toEqual(scanEncodedText(loneSurrogate));
    expect(scanEncodedTextCached(replacement)).toEqual(scanEncodedText(replacement));
  });

  it("stays correct after more distinct inputs than the cache holds", () => {
    const secret = Buffer.from(SECRET).toString("base64");
    expect(scanEncodedTextCached(secret).sensitive).toBe(true);
    for (let index = 0; index < 300; index += 1) {
      const text = `clean text ${index}`;
      expect(scanEncodedTextCached(text)).toEqual({
        sensitive: false,
        opaque: false,
      });
    }
    expect(scanEncodedTextCached(secret).sensitive).toBe(true);
  });
});
