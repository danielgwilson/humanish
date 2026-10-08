// Literal scrubbing of secret values from text that leaves the host, such as an error quoted in a
// run's warnings. A value is found as written and in the encoded forms an HTTP client, a log line or
// a JSON body gives it, so a token that reaches the text percent-encoded or base64-encoded is still
// removed. Pattern redaction (redactText) runs after this and finds secrets by shape.

import { isUtf8 } from "node:buffer";

import { escapeRegExp } from "../run/text.js";
import { decodeEscapes, readingsOf } from "./encoded-text.js";
import { REDACTION_MARKERS } from "./redaction.js";

const REDACTED = REDACTION_MARKERS.secret;
// A form wholly inside a marker humanish writes is the marker's own text, as when a value is part
// of the marker's name. Other bracketed text, such as `[REDACTED_373433393231]`, is searched like
// any text.
const MARKER = new RegExp(Object.values(REDACTION_MARKERS).map(escapeRegExp).join("|"), "g");
// The shortest encoded form searched for. Shorter base64 or hex runs are ordinary text often enough
// that matching them would redact words. A value itself is searched for at any length.
const MIN_ENCODED_FORM = 8;

/**
 * The characters of a value's base64 encoding that do not depend on its neighbours, with 0, 1 or
 * 2 bytes before it. A prefix byte shares the next character with the value, and so does the byte
 * after a partial last group, so those characters are dropped.
 */
function base64Middles(bytes: Buffer, encoding: "base64" | "base64url"): string[] {
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes])
      .toString(encoding)
      .replace(/=+$/, "");
    const total = offset + bytes.length;
    const start = offset === 0 ? 0 : offset + 1;
    const end = Math.floor(total / 3) * 4 + (total % 3);
    return encoded.slice(start, end);
  });
}

/**
 * A value as written, and percent-encoded, JSON-escaped once (also with non-ASCII characters as
 * `\u` escapes) and twice, its UTF-8 bytes read one per character and the reverse, base64 at each
 * byte offset, base64url and hex. Twice, because a JSON event can carry a command's JSON output as
 * a string. An
 * escaped form is searched for at any length, as the value is: it holds a backslash or a `%`, so it
 * is not ordinary text.
 */
export function encodedForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const json = JSON.stringify(value).slice(1, -1);
  // A serializer that writes ASCII only, such as Python's json.dumps, spells é as \u00e9.
  const asciiJson = json.replace(
    /[^\x00-\x7f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const escaped = [json, asciiJson, JSON.stringify(json).slice(1, -1)];
  // The encoders throw on a lone surrogate. Such a value is still found as written. encodeURI
  // keeps a `/` or a `:` as written, as a URL path does.
  try {
    escaped.push(encodeURIComponent(value), encodeURI(value));
  } catch {
    // no percent-encoded form
  }
  const binary = [
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    ...base64Middles(bytes, "base64"),
    ...base64Middles(bytes, "base64url"),
  ];
  // decodeEscapes reads each percent escape as one character, so a percent-encoded non-ASCII value
  // reads as its UTF-8 bytes one per character, é as Ã©.
  const bytewise = bytes.toString("latin1");
  if (bytewise !== value) escaped.push(bytewise);
  // The mirror: a value such as xÃ©z whose characters are bytes that read as UTF-8 (xéz), which
  // the UTF-8 reading of its percent-encoded form shows.
  if (/^[\x00-\xff]*$/.test(value)) {
    const latin1 = Buffer.from(value, "latin1");
    if (isUtf8(latin1)) {
      const utf8 = latin1.toString("utf8");
      if (utf8 !== value) escaped.push(utf8);
    }
  }
  return [value, ...escaped, ...binary.filter((form) => form.length >= MIN_ENCODED_FORM)];
}

/**
 * Whether [at, end) lies wholly inside one marker. The markers are one regex's matches, so they are
 * sorted and disjoint: only the first marker that ends after `at` can hold it.
 */
function insideMarker(markers: readonly [number, number][], at: number, end: number): boolean {
  let low = 0;
  let high = markers.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (markers[middle]![1] > at) high = middle;
    else low = middle + 1;
  }
  return low < markers.length && markers[low]![0] <= at && end <= markers[low]![1];
}

/**
 * The Knuth-Morris-Pratt failure table: entry `k` is the length of the longest proper prefix of
 * the form's first `k` characters that is also their suffix.
 */
function failureTable(form: string): Int32Array {
  const table = new Int32Array(form.length + 1);
  for (let at = 1, length = 0; at < form.length; at += 1) {
    while (length > 0 && form[at] !== form[length]) length = table[length]!;
    if (form[at] === form[length]) length += 1;
    table[at + 1] = length;
  }
  return table;
}

/**
 * Calls `found` with the start of every occurrence of the form, overlapping ones included, in time
 * linear in the text. indexOf skips to the next occurrence. After one, the failure table carries
 * the match on through the occurrences that overlap it, so no character is compared again, until
 * no prefix of the form is left matched and indexOf takes over.
 */
function eachOccurrence(text: string, form: string, found: (at: number) => void): void {
  let table: Int32Array | undefined;
  for (let at = text.indexOf(form); at !== -1;) {
    found(at);
    table ??= failureTable(form);
    let matched = table[form.length]!;
    let next = at + form.length;
    for (; matched > 0 && next < text.length; next += 1) {
      while (matched > 0 && text[next] !== form[matched]) matched = table[matched]!;
      if (text[next] === form[matched]) matched += 1;
      if (matched === form.length) {
        found(next + 1 - form.length);
        matched = table[form.length]!;
      }
    }
    at = matched > 0 ? -1 : text.indexOf(form, next);
  }
}

/** Every occurrence of every form not wholly inside a marker, in no order. */
function occurrences(text: string, forms: readonly string[]): [number, number][] {
  const markers: [number, number][] = [];
  for (const match of text.matchAll(MARKER)) {
    const start = match.index ?? 0;
    markers.push([start, start + match[0].length]);
  }
  const found: [number, number][] = [];
  for (const form of forms)
    eachOccurrence(text, form, (at) => {
      if (!insideMarker(markers, at, at + form.length)) found.push([at, at + form.length]);
    });
  return found;
}

/** The occurrences sorted and merged where they overlap or touch. */
function merged(found: [number, number][]): [number, number][] {
  found.sort((left, right) => left[0] - right[0]);
  const spans: [number, number][] = [];
  for (const span of found) {
    const last = spans.at(-1);
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else spans.push([span[0], span[1]]);
  }
  return spans;
}

function replaceSpans(text: string, spans: readonly [number, number][]): string {
  let result = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    result += text.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return result + text.slice(cursor);
}

const formsOf = (values: readonly string[]): string[] => [
  ...new Set(values.filter((value) => value.length > 0).flatMap(encodedForms)),
];

/**
 * A check that the text holds one of the values' forms outside the markers in any of its
 * readingsOf. A scrub's output must pass it.
 */
export function holdsSecretValue(values: readonly string[]): (text: string) => boolean {
  const forms = formsOf(values);
  return (text) => readingsOf(text).some((reading) => occurrences(reading, forms).length > 0);
}

/**
 * A scrub that replaces each non-empty value and its encoded forms with `[REDACTED_SECRET]`. Every
 * occurrence of every form is found on its own, and overlapping finds are merged into one span, so
 * a value that overlaps another is removed whole wherever each starts. The scrub returns
 * decodeEscapes of the text with the values replaced: a warning with percent-encoding, JSON
 * escapes or HTML references shows them decoded, with the values removed. That finds a value
 * written partly encoded, which no single encoded form matches. Where another decoded reading in
 * readingsOf finds more occurrences, as the UTF-8 reading does for a value with two non-ASCII
 * characters of which one is percent-encoded, the scrub returns that reading instead.
 *
 * If the result still holds a form in one of its readings, the scrub returns `[REDACTED_SECRET]`
 * in place of the whole text. That happens for a value encoded twice, which the decoded text shows
 * encoded once, and for a value that holds part of a marker, such as `ET]x`, which the marker that
 * replaced it can spell again.
 */
export function scrubSecretValues(values: readonly string[]): (text: string) => string {
  const forms = formsOf(values);
  if (forms.length === 0) return (text) => text;
  const holds = holdsSecretValue(values);
  return (text) => {
    let reading = decodeEscapes(text);
    let found = occurrences(reading, forms);
    // The text as written is not returned: its values are found again in its decodings.
    for (const other of readingsOf(text)) {
      if (other === reading || other === text) continue;
      const otherFound = occurrences(other, forms);
      if (otherFound.length > found.length) [reading, found] = [other, otherFound];
    }
    const result = replaceSpans(reading, merged(found));
    return holds(result) ? REDACTED : result;
  };
}
