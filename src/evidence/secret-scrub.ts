// Literal scrubbing of secret values from text that leaves the host, such as an error quoted in a
// run's warnings. A value is found as written and in the encoded forms an HTTP client, a log line or
// a JSON body gives it, so a token that reaches the text percent-encoded or base64-encoded is still
// removed. Pattern redaction (redactText) runs after this and finds secrets by shape.

import { decodeEscapesWithOrigins, type DecodedWithOrigins } from "./encoded-text.js";

const REDACTED = "[REDACTED_SECRET]";
// The markers this scrub and redactText write. A form wholly inside one is the marker's own text,
// as when a value is part of the marker's name. Other bracketed text, such as
// `[REDACTED_373433393231]`, is searched like any text.
const MARKER = /\[REDACTED_(?:SECRET|LOCAL_PATH|RUNTIME_PATH)\]/g;
// Every escape decodeEscapes undoes starts with one of these.
const ESCAPE_START = /[\\%&]/;
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
 * `\u` escapes) and twice, its UTF-8 bytes read one per character, base64 at each byte offset, base64url and hex. Twice, because a JSON event can carry a command's JSON output as a string. An
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

/** Each occurrence of each form in `text` that is not wholly inside a marker, passed to `found`. */
function findForms(
  text: string,
  forms: readonly string[],
  found: (at: number, end: number) => void,
): void {
  const markers: [number, number][] = [];
  for (const match of text.matchAll(MARKER)) {
    const start = match.index ?? 0;
    markers.push([start, start + match[0].length]);
  }
  for (const form of forms)
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      const end = at + form.length;
      if (!insideMarker(markers, at, end)) found(at, end);
    }
}

/**
 * Every stretch of the text that holds a form as written, in decodeEscapes or in decodeEscapesUtf8,
 * merged where they overlap or touch. A form found in a decoding covers every character of the
 * text its decoded characters came from, so a value split by escapes is covered whole.
 */
function secretSpans(text: string, forms: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  findForms(text, forms, (at, end) => spans.push([at, end]));
  const decodings: DecodedWithOrigins[] = [];
  if (ESCAPE_START.test(text)) {
    const decoded = decodeEscapesWithOrigins(text);
    if (decoded.text !== text) decodings.push(decoded);
    // The UTF-8 reading differs only where a percent escape holds a byte of 0x80 or more, which
    // the byte reading writes as a character from U+0080 to U+00FF.
    if (/[\x80-\xff]/.test(decoded.text)) {
      const utf8 = decodeEscapesWithOrigins(text, true);
      if (utf8.text !== decoded.text) decodings.push(utf8);
    }
  }
  for (const { text: decoded, starts, ends } of decodings)
    findForms(decoded, forms, (at, end) => spans.push([starts[at]!, ends[end - 1]!]));
  spans.sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/**
 * A scrub that replaces each non-empty value and its encoded forms with `[REDACTED_SECRET]`. Every
 * occurrence of every form is found on its own, and overlapping finds are merged into one span, so
 * a value that overlaps another is removed whole wherever each starts. The scrub reads the text as
 * written and through decodeEscapes and decodeEscapesUtf8, the decoders verify uses, which finds a
 * value written partly encoded that no single encoded form matches. Each value is replaced where
 * it is written, and the rest of the text keeps its spelling.
 */
export function scrubSecretValues(values: readonly string[]): (text: string) => string {
  const forms = [...new Set(values.filter((value) => value.length > 0).flatMap(encodedForms))];
  if (forms.length === 0) return (text) => text;
  return (text) => {
    const spans = secretSpans(text, forms);
    if (spans.length === 0) return text;
    let result = "";
    let cursor = 0;
    for (const [start, end] of spans) {
      result += text.slice(cursor, start) + REDACTED;
      cursor = end;
    }
    result += text.slice(cursor);
    // A value that holds part of a marker, such as `ET]x`, can be spelled again by the marker
    // that replaced it and the text after it. The scrub then replaces the whole text.
    return secretSpans(result, forms).length === 0 ? result : REDACTED;
  };
}
