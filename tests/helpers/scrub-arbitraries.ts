// fast-check arbitraries for the known-value scrub properties: values like the ones a run
// registers, and text that holds them encoded, split by escapes, wrapped in marker shapes or next
// to markers.
// Text is built with `.map` from drawn segments, so fast-check shrinks a failing case by dropping
// segments, simplifying values and turning escape choices back to "as written".

import fc from "fast-check";

import { modelForms, WRITTEN_MARKERS } from "./scrub-model.js";

// CI runs a fixed seed. HUMANISH_PROPERTY_CASES runs more cases locally, and HUMANISH_PROPERTY_SEED
// with the `path` a failure prints replays it.
const FIXED_SEED = 271_828;
const DEFAULT_CASES = 400;

/** The seed and case count for fc.assert. */
export function propertyParameters(): { seed: number; numRuns: number } {
  const seed = Number(process.env.HUMANISH_PROPERTY_SEED);
  const cases = Number(process.env.HUMANISH_PROPERTY_CASES);
  return {
    seed: Number.isInteger(seed) ? seed : FIXED_SEED,
    numRuns: Number.isInteger(cases) && cases > 0 ? cases : DEFAULT_CASES,
  };
}

/** The characters from `first` to `last`. */
const range = (first: string, last: string): string[] =>
  Array.from({ length: last.charCodeAt(0) - first.charCodeAt(0) + 1 }, (_, at) =>
    String.fromCharCode(first.charCodeAt(0) + at),
  );
const UPPER = range("A", "Z");
const DIGITS = range("0", "9");
const WORD = [...range("a", "z"), ...UPPER, ...DIGITS];
const PUNCTUATION = [..."-_.~+/=:?&#;%\\[]\"' "];
const NON_ASCII = ["é", "à", "€", "😀", "﻿", " ", "Ã", "©"];
const VALUE_CHARACTERS = [...WORD, ...PUNCTUATION, ...NON_ASCII];
const MARKER_WORD = [...UPPER, ...DIGITS, "_"];
// Escapes a value can hold as written, such as a token copied from a URL.
const VALUE_ESCAPES = ["%41", "%2d", "%C3%A9", "\\u0041", "\\x41", "&#65;", "&amp;", "\\/", "%5B"];
// Escapes and escape fragments that hold no value.
const UNRELATED_ESCAPES = [
  "%20",
  "%2F",
  "%25",
  "%5BREDACTED_SECRET%5D",
  "\\u0041",
  "\\/",
  "&amp;",
  "&#65;",
  "&#x41;",
  "%C3%A9",
  "%E2%80%80",
  "%FF",
  "\\x41",
  "\\\\u00e9",
  "%",
  "\\",
  "&#",
  "%3",
];
const SEPARATORS = ["", " ", "\n", ", "];
// Named references for the characters a generated value holds.
const REFERENCE_NAMES = new Map([
  ["&", "amp"],
  ["'", "apos"],
  ["\\", "bsol"],
  [":", "colon"],
  ["=", "equals"],
  ["[", "lsqb"],
  ["]", "rsqb"],
  ["#", "num"],
  ["%", "percnt"],
  [".", "period"],
  ["+", "plus"],
  ["?", "quest"],
  ['"', "quot"],
  [";", "semi"],
  ["/", "sol"],
  ["_", "lowbar"],
]);

const chars = (pool: readonly string[], minLength: number, maxLength: number) =>
  fc.string({ unit: fc.constantFrom(...pool), minLength, maxLength });

const insert = ([base, piece, at]: [string, string, number]): string => {
  const cut = at % (base.length + 1);
  return base.slice(0, cut) + piece + base.slice(cut);
};

const markerDrawn = fc
  .tuple(fc.constantFrom(...WRITTEN_MARKERS), fc.nat(), fc.nat(), chars(WORD, 1, 6), fc.nat(4))
  .map(([marker, first, second, word, shape]) => {
    const cut = 1 + (first % (marker.length - 1));
    switch (shape) {
      case 0: {
        const start = first % (marker.length - 3);
        return marker.slice(start, start + 4 + (second % (marker.length - start - 3)));
      }
      case 1:
        return marker + word;
      case 2:
        return word + marker;
      case 3:
        return word + marker.slice(0, cut);
      default:
        return marker.slice(cut) + word;
    }
  });

/** A value of four characters or more, as the transient registry keeps. */
const valueArbitrary = fc
  .oneof(
    chars(DIGITS, 4, 8),
    chars(VALUE_CHARACTERS, 4, 14),
    fc
      .tuple(chars(DIGITS, 4, 8), chars(VALUE_CHARACTERS, 2, 8))
      .map(([code, token]) => `https://example.test/v?code=${code}&t=${token}`),
    markerDrawn,
    fc.tuple(chars(WORD, 2, 10), fc.constantFrom(...VALUE_ESCAPES), fc.nat()).map(insert),
    fc.tuple(chars(WORD, 3, 10), fc.constantFrom(...NON_ASCII), fc.nat()).map(insert),
    // A character's UTF-8 bytes as characters, as in xÃ©z.
    fc
      .tuple(chars(WORD, 1, 6), fc.constantFrom("é", "à", "€", "😀"), fc.nat())
      .map(([base, char, at]) => insert([base, Buffer.from(char).toString("latin1"), at])),
  )
  .map((value) => value.padEnd(4, "0"));

interface Embedding {
  readonly index: number;
  readonly kind: number;
  readonly choices: readonly number[];
}

const hex = (code: number, width: number, upper: boolean): string => {
  const digits = code.toString(16).padStart(width, "0");
  return upper ? digits.toUpperCase() : digits;
};

/** The character escaped one way, or as written when that way does not fit it. */
function escapeCharacter(char: string, choice: number): string {
  const code = char.codePointAt(0)!;
  const upper = choice >= 128;
  switch (choice % 7) {
    case 1:
      return [...Buffer.from(char, "utf8")].map((byte) => `%${hex(byte, 2, upper)}`).join("");
    case 2:
      return [...Array(char.length).keys()]
        .map((at) => `\\u${hex(char.charCodeAt(at), 4, upper)}`)
        .join("");
    case 3:
      return code < 0x100 ? `\\x${hex(code, 2, upper)}` : char;
    case 4:
      return `&#${code};`;
    case 5:
      return `&#x${hex(code, 1, upper)};`;
    case 6:
      return REFERENCE_NAMES.has(char) ? `&${REFERENCE_NAMES.get(char)};` : char;
    default:
      return char;
  }
}

/** The value written one way, with `choice(i)` deciding each step. */
function written(value: string, kind: number, choice: (at: number) => number): string {
  switch (kind) {
    case 1: {
      const forms = modelForms(value);
      return forms[choice(0) % forms.length]!;
    }
    case 2:
      return [...value].map((char, at) => escapeCharacter(char, choice(at))).join("");
    case 3: {
      // Escapes inside escapes that one decoding undoes, since `\u` is undone first, percent
      // escapes next and HTML references last: `%26%2355;` is `&#55;`, and `%` is `%`.
      const inner = [...value]
        .map((char, at) => escapeCharacter(char, [0, 1, 4, 5, 6][choice(at) % 5]!))
        .join("");
      return [...inner]
        .map((char, at) => {
          const code = char.charCodeAt(0);
          if ("&#;".includes(char) && choice(at + 1) % 2 === 1) return `%${hex(code, 2, false)}`;
          return code < 0x100 && choice(at + 2) % 4 === 1 ? `\\u${hex(code, 4, false)}` : char;
        })
        .join("");
    }
    case 4: {
      const bytes = (count: number, from: number) =>
        Buffer.from(Array.from({ length: count }, (_, at) => choice(from + at)));
      return Buffer.concat([
        bytes(choice(0) % 3, 1),
        Buffer.from(value, "utf8"),
        bytes(choice(3) % 4, 4),
      ]).toString(choice(8) % 2 === 0 ? "base64" : "base64url");
    }
    case 5:
      return `[REDACTED_${written(value, 1 + (choice(9) % 3), choice)}]`;
    case 6: {
      // Encoded twice, which one decoding leaves encoded once.
      const percent = ["%25", "&#37;", "&percnt;"][choice(10) % 3]!;
      return [...Buffer.from(value, "utf8")].map((byte) => percent + hex(byte, 2, false)).join("");
    }
    default:
      return value;
  }
}

const decoyArbitrary = fc.oneof(
  chars(MARKER_WORD, 1, 10).map((word) => `[REDACTED_${word}]`),
  fc.constantFrom("[REDACTED_SECRET", "REDACTED_SECRET]", "[redacted_secret]", "[REDACTED_]"),
  chars(DIGITS, 4, 8).map((digits) => `[REDACTED_${Buffer.from(digits).toString("hex")}]`),
);

const plainSegment = fc.oneof(
  chars([...WORD, ...NON_ASCII, ".", ",", "-", "/"], 1, 10),
  fc.constantFrom(...WRITTEN_MARKERS),
  decoyArbitrary,
  fc.constantFrom(...UNRELATED_ESCAPES),
);

export interface ScrubInput {
  readonly values: readonly string[];
  readonly text: string;
}

/** Inputs that `scrubInputs` draws, and which ways of writing a value they use. */
export interface ScrubInputShape {
  /** Whether the text holds at least one value. */
  readonly holdsValues: boolean;
  /** Whether a value may be encoded twice, which one decoding leaves encoded once. */
  readonly twiceEncoded?: boolean;
  /**
   * Whether a value may hold `[`, `]`, `%`, `\` or `&`. With a bracket it can overlap a marker's
   * edge; with an escape character its own decoding differs from it.
   */
  readonly markerOrEscapeCharacters?: boolean;
}

/**
 * One to three values, and text of filler, written markers, marker-shaped decoys and unrelated
 * escapes, joined with or without separators. With `holdsValues` it also holds values, each
 * written as is, in an encoded form, split by escapes, nested escapes, base64 at a byte offset,
 * inside a marker shape or, with `twiceEncoded`, encoded twice.
 */
export function scrubInputs(shape: ScrubInputShape): fc.Arbitrary<ScrubInput> {
  const values = fc.uniqueArray(
    shape.markerOrEscapeCharacters === false
      ? valueArbitrary.map((value) => value.replace(/[[\]%\\&]/g, "x"))
      : valueArbitrary,
    { minLength: 1, maxLength: 3 },
  );
  const embedding: fc.Arbitrary<Embedding> = fc.record({
    index: fc.nat(2),
    kind: fc.nat(shape.twiceEncoded === false ? 5 : 6),
    choices: fc.array(fc.nat(255), { maxLength: 48 }),
  });
  const segment = shape.holdsValues ? fc.oneof(plainSegment, embedding) : plainSegment;
  return fc
    .record({
      values,
      first: shape.holdsValues ? embedding : plainSegment,
      segments: fc.array(segment, { maxLength: 7 }),
      separators: fc.array(fc.constantFrom(...SEPARATORS), { maxLength: 8 }),
    })
    .map(({ values, first, segments, separators }) => {
      const parts = [first, ...segments].map((part) => {
        if (typeof part === "string") return part;
        const value = values[part.index % values.length]!;
        const choice = (at: number): number =>
          part.choices.length === 0 ? 0 : part.choices[at % part.choices.length]!;
        return written(value, part.kind, choice);
      });
      const text = parts.map((part, at) => (at === 0 ? "" : (separators[at - 1] ?? "")) + part);
      return { values, text: text.join("") };
    });
}
