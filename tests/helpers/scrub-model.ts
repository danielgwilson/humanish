// A reference model for the known-value scrubs, scrubSecretValues and
// transientCommsKnownValueScrub: what scrubbed text must not hold, and generators of values and of
// text that holds them encoded, split by escapes, wrapped in marker shapes or next to markers.

import { decodeEscapes, decodeEscapesUtf8 } from "../../src/evidence/encoded-text.js";
import { encodedForms } from "../../src/evidence/secret-scrub.js";
import { shorterStrings, type Random } from "./seeded-random.js";

/** The markers the scrubs and redactText write. A form wholly inside one is the marker's own text. */
export const WRITTEN_MARKERS = [
  "[REDACTED_SECRET]",
  "[REDACTED_LOCAL_PATH]",
  "[REDACTED_RUNTIME_PATH]",
] as const;
const SCRUB_MARKER = "[REDACTED_SECRET]";

/** Each form a value must not keep once it is scrubbed. */
const valueForms = (value: string): string[] => encodedForms(value);

function markerSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const marker of WRITTEN_MARKERS)
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1))
      spans.push([at, at + marker.length]);
  return spans.sort((left, right) => left[0] - right[0]);
}

/** Whether [at, end) lies within one span. Markers never overlap, since each holds one `[`. */
function insideMarker(spans: readonly [number, number][], at: number, end: number): boolean {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (spans[middle]![0] <= at) low = middle + 1;
    else high = middle;
  }
  const span = spans[low - 1];
  return span !== undefined && end <= span[1];
}

/**
 * Where the text, its decodeEscapes or its decodeEscapesUtf8 holds a form of a value outside the
 * written markers, or undefined when none does.
 */
export function survivingForm(values: readonly string[], text: string): string | undefined {
  const readings: [string, string][] = [
    ["the text", text],
    ["its decodeEscapes", decodeEscapes(text)],
    ["its decodeEscapesUtf8", decodeEscapesUtf8(text)],
  ];
  for (const [name, reading] of readings) {
    const markers = markerSpans(reading);
    for (const value of values)
      for (const form of valueForms(value))
        for (let at = reading.indexOf(form); at !== -1; at = reading.indexOf(form, at + 1))
          if (!insideMarker(markers, at, at + form.length))
            return `${JSON.stringify(form)}, a form of ${JSON.stringify(value)}, at ${at} in ${name} ${JSON.stringify(reading)}`;
  }
  return undefined;
}

/** Whether the output is the input with zero or more stretches each replaced by the marker. */
export function keepsSpelling(input: string, output: string): boolean {
  const pieces = output.split(SCRUB_MARKER);
  if (pieces.length === 1) return input === output;
  const first = pieces[0]!;
  const last = pieces.at(-1)!;
  const end = input.length - last.length;
  if (!input.startsWith(first) || !input.endsWith(last) || end < first.length) return false;
  let at = first.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = input.indexOf(piece, at);
    if (found === -1 || found + piece.length > end) return false;
    at = found + piece.length;
  }
  return true;
}

/** The characters from `first` to `last`. */
const range = (first: string, last: string): string[] =>
  Array.from({ length: last.charCodeAt(0) - first.charCodeAt(0) + 1 }, (_, at) =>
    String.fromCharCode(first.charCodeAt(0) + at),
  );
const UPPER = range("A", "Z");
const LETTERS = [...range("a", "z"), ...UPPER];
const DIGITS = range("0", "9");
const WORD = [...LETTERS, ...DIGITS];
const PUNCTUATION = [..."-_.~+/=:?&#;%\\[]\"' "];
const NON_ASCII = ["é", "à", "€", "😀", "﻿", " ", "Ã", "©"];
const VALUE_CHARACTERS = [...WORD, ...WORD, ...PUNCTUATION, ...NON_ASCII];
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
const SEPARATORS = ["", "", " ", " ", "\n", ", "];
// Named references decodeEscapes undoes, for the characters a generated value holds.
const ENTITY_NAMES: Readonly<Record<string, string>> = {
  "&": "amp",
  "'": "apos",
  "\\": "bsol",
  ":": "colon",
  "=": "equals",
  "[": "lsqb",
  "]": "rsqb",
  "#": "num",
  "%": "percnt",
  ".": "period",
  "+": "plus",
  "?": "quest",
  '"': "quot",
  ";": "semi",
  "/": "sol",
  _: "lowbar",
};

function characters(random: Random, min: number, max: number, pool: readonly string[]): string {
  let text = "";
  for (let count = random.int(min, max); count > 0; count -= 1) text += random.pick(pool);
  return text;
}

function markerDrawnValue(random: Random): string {
  const marker = random.pick(WRITTEN_MARKERS);
  const word = characters(random, 1, 6, WORD);
  const cut = random.int(1, marker.length - 1);
  switch (random.int(0, 4)) {
    case 0: {
      const start = random.int(0, marker.length - 4);
      return marker.slice(start, random.int(start + 4, marker.length));
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
}

function insertAt(random: Random, text: string, insert: string): string {
  const at = random.int(0, text.length);
  return text.slice(0, at) + insert + text.slice(at);
}

/** A value of four characters or more, as the transient registry keeps. */
function generateValue(random: Random): string {
  let value: string;
  switch (random.int(0, 5)) {
    case 0:
      value = characters(random, 4, 8, DIGITS);
      break;
    case 1:
      value = characters(random, 4, 14, VALUE_CHARACTERS);
      break;
    case 2:
      value = `https://example.test/v?code=${characters(random, 4, 8, DIGITS)}&t=${characters(random, 2, 8, VALUE_CHARACTERS)}`;
      break;
    case 3:
      value = markerDrawnValue(random);
      break;
    case 4:
      value = insertAt(random, characters(random, 2, 10, WORD), random.pick(VALUE_ESCAPES));
      break;
    default:
      value = insertAt(random, characters(random, 3, 10, WORD), random.pick(NON_ASCII));
  }
  return value.length >= 4 ? value : value + characters(random, 4 - value.length, 4, WORD);
}

/** One to three distinct values. */
export function generateValues(random: Random): string[] {
  const values = new Set<string>();
  for (let count = random.int(1, 3); count > 0; count -= 1) values.add(generateValue(random));
  return [...values];
}

const hex = (code: number, width: number, upper: boolean): string => {
  const digits = code.toString(16).padStart(width, "0");
  return upper ? digits.toUpperCase() : digits;
};

type EscapeKind = "percent" | "unicode" | "hex" | "decimal" | "entityHex" | "named";
const ALL_KINDS: readonly EscapeKind[] = [
  "percent",
  "unicode",
  "hex",
  "decimal",
  "entityHex",
  "named",
];

function escapeCharacter(random: Random, char: string, kind: EscapeKind): string | undefined {
  const code = char.codePointAt(0)!;
  const upper = random.chance(0.5);
  switch (kind) {
    case "percent":
      return [...Buffer.from(char, "utf8")].map((byte) => `%${hex(byte, 2, upper)}`).join("");
    case "unicode":
      return [...Array(char.length).keys()]
        .map((index) => `\\u${hex(char.charCodeAt(index), 4, upper)}`)
        .join("");
    case "hex":
      return code < 0x100 ? `\\x${hex(code, 2, upper)}` : undefined;
    case "decimal":
      return `&#${code};`;
    case "entityHex":
      return `&#x${hex(code, 1, upper)};`;
    default:
      return ENTITY_NAMES[char] === undefined ? undefined : `&${ENTITY_NAMES[char]};`;
  }
}

/** The value with about half its characters escaped, each by a kind from `kinds`. */
function splitEscapes(random: Random, value: string, kinds: readonly EscapeKind[]): string {
  let text = "";
  for (const char of value)
    text += (random.chance(0.5) && escapeCharacter(random, char, random.pick(kinds))) || char;
  return text;
}

/**
 * Escapes inside escapes that one decodeEscapes call undoes, since it undoes `\u` first, percent
 * escapes next and HTML references last: `%26%2355;` is `&#55;`, and `%` is `%`.
 */
function nestedEscapes(random: Random, value: string): string {
  const inner = splitEscapes(random, value, ["percent", "decimal", "entityHex", "named"]);
  let middle = "";
  for (const char of inner)
    middle +=
      "&#;".includes(char) && random.chance(0.5) ? `%${hex(char.charCodeAt(0), 2, false)}` : char;
  let outer = "";
  for (const char of middle)
    outer +=
      char.charCodeAt(0) < 0x100 && random.chance(0.3)
        ? `\\u${hex(char.charCodeAt(0), 4, random.chance(0.5))}`
        : char;
  return outer;
}

/** The value percent-encoded and then encoded again, which one decodeEscapes call leaves encoded. */
function twiceEncoded(random: Random, value: string): string {
  const once = [...Buffer.from(value, "utf8")].map((byte) => hex(byte, 2, false));
  const percent = random.pick(["%25", "&#37;", "&percnt;"]);
  return once.map((digits) => percent + digits).join("");
}

function holdsValue(text: string, value: string): boolean {
  const readings = [text, decodeEscapes(text), decodeEscapesUtf8(text)];
  return valueForms(value).some((form) => readings.some((reading) => reading.includes(form)));
}

function base64AtOffset(random: Random, value: string): string {
  const bytes = (count: number): Buffer =>
    Buffer.from(Array.from({ length: count }, () => random.int(0, 255)));
  return Buffer.concat([
    bytes(random.int(0, 2)),
    Buffer.from(value, "utf8"),
    bytes(random.int(0, 3)),
  ]).toString(random.pick(["base64", "base64url"] as const));
}

/** The value written one way: an encoded form, split or nested escapes, or inside a marker shape. */
function embedding(random: Random, value: string, kind = random.int(0, 6)): string {
  const checked = (encoded: string): string => (holdsValue(encoded, value) ? encoded : value);
  switch (kind) {
    case 0:
      return random.pick(encodedForms(value));
    case 1:
      return base64AtOffset(random, value);
    case 2:
      return checked(splitEscapes(random, value, ALL_KINDS));
    case 3:
      return checked(nestedEscapes(random, value));
    case 4:
      return twiceEncoded(random, value);
    case 5:
      return `[REDACTED_${embedding(random, value, random.int(0, 3))}]`;
    default:
      return value;
  }
}

function decoy(random: Random): string {
  switch (random.int(0, 5)) {
    case 0:
      return `[REDACTED_${characters(random, 1, 10, MARKER_WORD)}]`;
    case 1:
      return "[REDACTED_SECRET";
    case 2:
      return "REDACTED_SECRET]";
    case 3:
      return "[redacted_secret]";
    case 4:
      return "[REDACTED_]";
    default:
      return `[REDACTED_${Buffer.from(characters(random, 4, 8, DIGITS)).toString("hex")}]`;
  }
}

/**
 * Text of filler words, written markers, marker-shaped decoys and unrelated escapes, joined with
 * or without separators. With `holdsValues` it also holds at least one value, written by
 * `embedding`.
 */
export function generateText(
  random: Random,
  values: readonly string[],
  holdsValues: boolean,
): string {
  const segments: string[] = [];
  const segment = (kind: number): string => {
    switch (kind) {
      case 0:
        return characters(random, 1, 10, [...WORD, ...NON_ASCII, ".", ",", "-", "/"]);
      case 1:
        return random.pick(WRITTEN_MARKERS);
      case 2:
        return decoy(random);
      case 3:
        return random.pick(UNRELATED_ESCAPES);
      default:
        return embedding(random, random.pick(values));
    }
  };
  for (let count = random.int(1, 8); count > 0; count -= 1)
    segments.push(segment(random.int(0, holdsValues ? 4 : 3)));
  if (holdsValues) segments.splice(random.int(0, segments.length), 0, segment(4));
  let text = segments[0]!;
  for (const next of segments.slice(1)) text += random.pick(SEPARATORS) + next;
  return text;
}

export interface ScrubInput {
  readonly values: readonly string[];
  readonly text: string;
}

/** Inputs with one value fewer, a shorter text or a shorter value. */
export function* smallerScrubInputs(input: ScrubInput): Generator<ScrubInput> {
  if (input.values.length > 1)
    for (const index of input.values.keys())
      yield { ...input, values: input.values.filter((_, other) => other !== index) };
  for (const text of shorterStrings(input.text)) yield { ...input, text };
  for (const [index, value] of input.values.entries())
    for (const shorter of shorterStrings(value, 4))
      if (!input.values.includes(shorter))
        yield {
          ...input,
          values: input.values.map((other, at) => (at === index ? shorter : other)),
        };
}

export const showScrubInput = (input: ScrubInput): string => JSON.stringify(input);
