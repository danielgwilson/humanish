// Literal scrubbing of secret values from text that leaves the host, such as an error quoted in a
// run's warnings. A value is found as written and in the encoded forms an HTTP client, a log line or
// a JSON body gives it, so a token that reaches the text percent-encoded or base64-encoded is still
// removed. Pattern redaction (redactText) runs after this and finds secrets by shape.

import { escapeRegExp } from "../run/text.js";
import { decodeEscapes, latin1RunsAsUtf8, readingsOf } from "./encoded-text.js";
import { REDACTION_MARKERS } from "./redaction.js";

const REDACTED = REDACTION_MARKERS.secret;
// A form wholly inside a marker humanish writes is the marker's own text, as when a value is part
// of the marker's name. Other bracketed text, such as `[REDACTED_373433393231]`, is searched like
// any text.
const MARKER = new RegExp(Object.values(REDACTION_MARKERS).map(escapeRegExp).join("|"), "g");
// The shortest encoded form searched for: the unpadded base64 of a four-byte value, such as a
// four-digit code. A given form of n characters turns up by chance in random base64 about once in
// 64^n characters, once in 69 billion at 6 and once in 17 million at 4. In the text of 9 real runs
// (2.5 million characters) no 6- or 7-character form of any 4-, 5- or 6-digit code occurred. A
// value itself is searched for at any length.
const MIN_ENCODED_FORM = 6;

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
 * `\u` escapes) and twice, its UTF-8 bytes read one per character and the reverse, base64 padded,
 * unpadded and at each byte offset, base64url and hex. Twice, because a JSON event can carry a
 * command's JSON output as a string. An escaped form is searched for at any length, as the value
 * is: it holds a backslash or a `%`, so it is not ordinary text. A base64 or hex form is searched
 * for from MIN_ENCODED_FORM characters, so a four-byte value is found in base64 written whole and
 * not inside a longer run, where four or five of its characters do not depend on its neighbours.
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
  const base64 = bytes.toString("base64");
  const binary = [
    base64,
    base64.replace(/=+$/, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    ...base64Middles(bytes, "base64"),
    ...base64Middles(bytes, "base64url"),
  ];
  // decodeEscapes reads each percent escape as one character, so a percent-encoded non-ASCII value
  // reads as its UTF-8 bytes one per character, é as Ã©.
  const bytewise = bytes.toString("latin1");
  if (bytewise !== value) escaped.push(bytewise);
  // The mirror: a value such as xÃ©z€ whose characters include bytes that read as UTF-8, written
  // with them read (xéz€). No reading of the text turns xéz€ back into the value.
  const mirrored = latin1RunsAsUtf8(value);
  if (mirrored !== value) escaped.push(mirrored);
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

/**
 * Each value's occurrences, the longest value that starts at a position replaced from the start of
 * the text on, in time linear in the text for each value.
 */
function replaceLongestFirst(text: string, values: readonly string[]): string {
  // The length of the longest value that starts at each position, allocated at the first find.
  let longest: Uint32Array | undefined;
  for (const value of values)
    eachOccurrence(text, value, (at) => {
      longest ??= new Uint32Array(text.length);
      longest[at] = Math.max(longest[at]!, value.length);
    });
  if (longest === undefined) return text;
  let result = "";
  let cursor = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (longest[at] === 0) continue;
    result += text.slice(cursor, at) + REDACTED;
    cursor = at + longest[at]!;
    at = cursor - 1;
  }
  return result + text.slice(cursor);
}

/**
 * A scrub that replaces each non-empty value as written with `[REDACTED_SECRET]`, markers
 * included. From the start of the text, the longest value that starts at a position is replaced
 * and the search goes on after it, so the marker it writes is never searched. One global regex of
 * the values, longest first, does that fastest. V8 compiles it at its first use and refuses it
 * once a value has 32,768 characters; the scrub then finds each value itself, with the same
 * output, in time linear in the text for each value.
 */
export function scrubValuesAsWritten(values: readonly string[]): (text: string) => string {
  const written = [...new Set(values)].filter((value) => value.length > 0);
  if (written.length === 0) return (text) => text;
  let pattern: RegExp | undefined = new RegExp(
    [...written]
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  return (text) => {
    if (pattern !== undefined)
      try {
        return text.replace(pattern, REDACTED);
      } catch {
        pattern = undefined;
      }
    return replaceLongestFirst(text, written);
  };
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
 * a value that overlaps another is removed whole wherever each starts. The scrub reads the text
 * through decodeEscapes, the decoder verify uses, and returns the decoded text: a warning with
 * percent-encoding, JSON escapes or HTML references shows them decoded, with the values removed.
 * That finds a value written partly encoded, which no single encoded form matches.
 *
 * The result's other readingsOf only detect. If one still holds a form, the scrub returns
 * `[REDACTED_SECRET]` in place of the whole text. That happens for a value encoded twice, which
 * the decoded text shows encoded once; for a value the UTF-8 or transfer reading holds, such as
 * one with one of two non-ASCII characters percent-encoded; and for a value that holds part of a
 * marker, such as `ET]x`, which the marker that replaced it can spell again.
 */
export function scrubSecretValues(values: readonly string[]): (text: string) => string {
  const forms = formsOf(values);
  if (forms.length === 0) return (text) => text;
  const holds = holdsSecretValue(values);
  return (text) => {
    const decoded = decodeEscapes(text);
    const result = replaceSpans(decoded, merged(occurrences(decoded, forms)));
    return holds(result) ? REDACTED : result;
  };
}
