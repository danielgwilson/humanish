// Literal scrubbing of secret values from text that leaves the host, such as an error quoted in a
// run's warnings. A value is found as written and in the encoded forms an HTTP client, a log line or
// a JSON body gives it, so a token that reaches the text percent-encoded or base64-encoded is still
// removed. Pattern redaction (redactText) runs after this and finds secrets by shape.

import { decodeEscapes } from "./encoded-text.js";

const REDACTED = "[REDACTED_SECRET]";
// A marker already in the text, from this scrub or from redactText. No value is matched inside one.
const MARKER = /\[REDACTED_[A-Z0-9_]+\]/g;
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
 * A value as written, and percent-encoded, JSON-escaped once and twice, base64 at each byte offset,
 * base64url and hex. Twice, because a JSON event can carry a command's JSON output as a string.
 */
export function encodedForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const escaped = JSON.stringify(value).slice(1, -1);
  const encoded = [
    escaped,
    JSON.stringify(escaped).slice(1, -1),
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    ...base64Middles(bytes, "base64"),
    ...base64Middles(bytes, "base64url"),
  ];
  // The encoders throw on a lone surrogate. Such a value is still found as written. encodeURI
  // keeps a `/` or a `:` as written, as a URL path does.
  try {
    encoded.push(encodeURIComponent(value), encodeURI(value));
  } catch {
    // no percent-encoded form
  }
  return [value, ...encoded.filter((form) => form.length >= MIN_ENCODED_FORM)];
}

/** Every occurrence of every form, outside the markers, merged where they overlap or touch. */
function secretSpans(text: string, forms: readonly string[]): [number, number][] {
  const markers: [number, number][] = [];
  for (const match of text.matchAll(MARKER)) {
    const start = match.index ?? 0;
    markers.push([start, start + match[0].length]);
  }
  const spans: [number, number][] = [];
  for (const form of forms) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      const end = at + form.length;
      if (!markers.some(([start, stop]) => at < stop && end > start)) spans.push([at, end]);
    }
  }
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
 * a value that overlaps another is removed whole wherever each starts. The scrub reads the text
 * through decodeEscapes, the decoder verify uses, and returns the decoded text: a warning with
 * percent-encoding, JSON escapes or HTML references shows them decoded, with the values removed.
 * That finds a value written partly encoded, which no single encoded form matches.
 */
export function scrubSecretValues(values: readonly string[]): (text: string) => string {
  const forms = [...new Set(values.filter((value) => value.length > 0).flatMap(encodedForms))];
  if (forms.length === 0) return (text) => text;
  return (text) => {
    const decoded = decodeEscapes(text);
    let result = "";
    let cursor = 0;
    for (const [start, end] of secretSpans(decoded, forms)) {
      result += decoded.slice(cursor, start) + REDACTED;
      cursor = end;
    }
    return result + decoded.slice(cursor);
  };
}
