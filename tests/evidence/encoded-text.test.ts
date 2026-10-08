import { gzipSync } from "node:zlib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  decodeEscapes,
  readingsOf,
  scanEncodedText,
  scanEncodedTextCached,
} from "../../src/evidence/encoded-text.js";
import { sensitivePatterns } from "../../src/evidence/redaction.js";
import { propertyParameters, scrubInputs } from "../helpers/scrub-arbitraries.js";
import { modelReadings } from "../helpers/scrub-model.js";

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

  it("leaves a named reference that only Object.prototype defines as written", () => {
    expect(readingsOf("&constructor; &CONSTRUCTOR; &toString; &amp;")).toEqual([
      "&constructor; &CONSTRUCTOR; &toString; &amp;",
      "&constructor; &CONSTRUCTOR; &toString; &",
    ]);
  });
});

describe("readingsOf", () => {
  it("lists the text as written, decoded, read as UTF-8 and transfer-expanded", () => {
    expect(readingsOf("plain")).toEqual(["plain"]);
    expect(readingsOf("caf%C3%A9")).toEqual(["caf%C3%A9", "caf\u00c3\u00a9", "café"]);
    expect(readingsOf("a\\nb %41=42")).toEqual(["a\\nb %41=42", "a\\nb A=42", "a\nb AB"]);
  });

  it("reads percent escapes as UTF-8 when a \\u escape writes their percent signs", () => {
    expect(readingsOf("\\u0025C3\\u0025A9")).toEqual(["\\u0025C3\\u0025A9", "\u00c3\u00a9", "é"]);
  });

  it("reads a run of percent escapes as UTF-8, keeping a byte-order mark", () => {
    expect(readingsOf("caf%C3%A9 %e2%82%ac %F0%9F%98%80")).toContain("café € 😀");
    expect(readingsOf("voil%C3%A0%2Fsecret &amp; \\u0073")).toContain("voilà/secret & s");
    expect(readingsOf("%EF%BB%BF%41")).toContain("\uFEFFA");
  });

  it("agrees with a decoder built on JSON.parse, decodeURIComponent and String.fromCodePoint", () => {
    const texts = fc.oneof(
      scrubInputs({ holdsValues: true }).map(({ text }) => text),
      fc.string({ unit: "binary", maxLength: 40 }),
    );
    fc.assert(
      fc.property(texts, (text) => {
        expect(readingsOf(text)).toEqual(modelReadings(text));
      }),
      propertyParameters(),
    );
  });

  it("keeps a byte that starts no valid UTF-8 sequence as one character", () => {
    // A lone byte, a cut-short sequence, an overlong `/` and a surrogate half read the same both
    // ways, so they give one decoded reading.
    for (const [text, decoded] of [
      ["%E9t%E9", "\u00e9t\u00e9"],
      ["%C3", "\u00c3"],
      ["%E2%82x", "\u00e2\u0082x"],
      ["%C0%AF", "\u00c0\u00af"],
      ["%ED%A0%80", "\u00ed\u00a0\u0080"],
    ])
      expect(readingsOf(text!)).toEqual([text, decoded]);
    expect(readingsOf("%FF%C3%A9")).toEqual(["%FF%C3%A9", "\u00ff\u00c3\u00a9", "\u00ffé"]);
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
