// Literal scrubbing of secret values from text that leaves the host, such as an error quoted in a
// run's warnings. A value is found as written and in the encoded forms an HTTP client, a log line or
// a JSON body gives it, so a token that reaches the text percent-encoded or base64-encoded is still
// removed. Pattern redaction (redactText) runs after this and finds secrets by shape.

import { decodeEscapes } from "./encoded-text.js";

const REDACTED = "[REDACTED_SECRET]";
// The markers the scrubbers write: this scrub and RunSecrets write `[REDACTED_SECRET]`, and
// redactText also writes the two path markers. No value is matched inside one of these exact
// tokens, so a value such as `SECRET` cannot grow a marker. Other text shaped like a marker is
// scanned like any text, since a model or a page can write a value inside it.
const MARKERS = [REDACTED, "[REDACTED_LOCAL_PATH]", "[REDACTED_RUNTIME_PATH]"];
// One escape decodeEscapes undoes: a run of percent escapes, a `\u` or `\x` escape, an escaped
// slash, or an HTML character reference.
const ESCAPE =
  /(?:%[0-9a-f]{2})+|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}|\\\/|&#x[0-9a-f]{1,6};?|&#\d{1,7};?|&[a-z]+;/gi;
const HAS_ESCAPE = new RegExp(ESCAPE.source, "i");
const UTF8 = new TextDecoder("utf-8", { fatal: true });
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
 * `\u` escapes) and twice, base64 at each byte offset, base64url and hex. Twice, because a JSON event can carry a command's JSON output as a string. An
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
  return [value, ...escaped, ...binary.filter((form) => form.length >= MIN_ENCODED_FORM)];
}

type Span = [number, number];

/** Sorted, with spans that overlap or touch merged into one. */
function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const [start, end] of [...spans].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Every occurrence of every form that does not overlap one of the exact markers. */
function formSpans(text: string, forms: readonly string[]): Span[] {
  const markers: Span[] = [];
  for (const marker of MARKERS)
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1))
      markers.push([at, at + marker.length]);
  const spans: Span[] = [];
  for (const form of forms) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      const end = at + form.length;
      if (!markers.some(([start, stop]) => at < stop && end > start)) spans.push([at, end]);
    }
  }
  return spans;
}

/** Text with its escapes undone, and for each UTF-16 unit the span of the original it came from. */
interface DecodedView {
  text: string;
  starts: number[];
  ends: number[];
}

/**
 * The text with each escape undone once, as decodeEscapes undoes it, but one escape at a time so
 * every decoded character maps back to its escape. A run of percent escapes is read as UTF-8, one
 * character per byte sequence, as a URL encodes a value; a byte that starts no valid sequence
 * stands for itself, as decodeEscapes reads it.
 */
function decodedView(text: string): DecodedView {
  const view: DecodedView = { text: "", starts: [], ends: [] };
  const emit = (chars: string, start: number, end: number): void => {
    for (let unit = 0; unit < chars.length; unit += 1) {
      view.starts.push(start);
      view.ends.push(end);
    }
    view.text += chars;
  };
  const copy = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) emit(text[at]!, at, at + 1);
  };
  let cursor = 0;
  for (const match of text.matchAll(ESCAPE)) {
    const at = match.index;
    const escape = match[0];
    copy(cursor, at);
    cursor = at + escape.length;
    if (!escape.startsWith("%")) {
      const decoded = decodeEscapes(escape);
      if (decoded === escape) copy(at, cursor);
      else emit(decoded, at, cursor);
      continue;
    }
    const bytes = escape.match(/%[0-9a-f]{2}/gi)!.map((hex) => Number.parseInt(hex.slice(1), 16));
    for (let index = 0; index < bytes.length;) {
      const lead = bytes[index]!;
      const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      let character: string | undefined;
      if (size > 1 && index + size <= bytes.length) {
        try {
          character = UTF8.decode(Uint8Array.from(bytes.slice(index, index + size)));
        } catch {
          // Not UTF-8: the lead byte stands for itself below.
        }
      }
      const used = character === undefined ? 1 : size;
      emit(character ?? String.fromCharCode(lead), at + 3 * index, at + 3 * (index + used));
      index += used;
    }
  }
  copy(cursor, text.length);
  return view;
}

/**
 * Where the text holds a value, in the text's own positions: each form as written, and each form
 * in the decoded view, which finds a value split across escapes or written in an encoding no form
 * spells, such as lowercase percent-encoding.
 */
function secretSpans(text: string, view: DecodedView | null, forms: readonly string[]): Span[] {
  const spans = formSpans(text, forms);
  if (view !== null)
    for (const [start, end] of formSpans(view.text, forms))
      spans.push([view.starts[start]!, view.ends[end - 1]!]);
  return mergeSpans(spans);
}

/**
 * A scrub that replaces each non-empty value and its encoded forms with `[REDACTED_SECRET]`. Every
 * occurrence of every form is found on its own, in the text as written and in its decoded view,
 * and overlapping finds are merged into one span, so a value that overlaps another is removed whole
 * wherever each starts. The scrub returns the decoded text: a warning with percent-encoding, JSON
 * escapes or HTML references shows them decoded, with the values removed. With `keepSpelling`, it
 * returns the text as written with only each value's span replaced.
 */
export function scrubSecretValues(
  values: readonly string[],
  options: { keepSpelling?: boolean } = {},
): (text: string) => string {
  const forms = [...new Set(values.filter((value) => value.length > 0).flatMap(encodedForms))];
  if (forms.length === 0) return (text) => text;
  return (text) => {
    const view = HAS_ESCAPE.test(text) ? decodedView(text) : null;
    const spans = secretSpans(text, view, forms);
    if (view === null || options.keepSpelling) {
      let result = "";
      let cursor = 0;
      for (const [start, end] of spans) {
        result += text.slice(cursor, start) + REDACTED;
        cursor = end;
      }
      return result + text.slice(cursor);
    }
    // Each decoded unit whose escape a span covers becomes part of that span's one marker.
    let result = "";
    let span = 0;
    let marked = -1;
    for (let unit = 0; unit < view.text.length; unit += 1) {
      const start = view.starts[unit]!;
      const end = view.ends[unit]!;
      while (span < spans.length && spans[span]![1] <= start) span += 1;
      if (span < spans.length && spans[span]![0] < end) {
        if (marked !== span) result += REDACTED;
        marked = span;
      } else result += view.text[unit];
    }
    return result;
  };
}
