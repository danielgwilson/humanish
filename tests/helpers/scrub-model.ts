// A reference model for the known-value scrubs, scrubSecretValues and
// transientCommsKnownValueScrub. It writes each value's forms with its own encoders and reads text
// with its own decoders, built on the platform's (JSON.parse, decodeURIComponent, Buffer), so a
// form the production encoder omits or a reading its decoder gets wrong shows up as
// a disagreement. Only the list of markers comes from production, as data.

import { REDACTION_MARKERS } from "../../src/evidence/redaction.js";

/** The markers humanish writes. A form wholly inside one is the marker's own text. */
export const WRITTEN_MARKERS: readonly string[] = Object.values(REDACTION_MARKERS);

// The shortest base64 or hex form a scrub must find, as documented for encodedForms. A value
// itself and its escaped forms are found at any length.
const MIN_BINARY_FORM = 8;

/**
 * The characters of the value's base64 that do not depend on its neighbours, for 0, 1 and 2 bytes
 * before it. Found by encoding the value between different neighbour bytes and keeping the
 * stretch where every encoding agrees.
 */
function stableBase64(bytes: Buffer, encoding: "base64" | "base64url"): string[] {
  const neighbours = [0x00, 0xff, 0x55, 0xaa];
  return [0, 1, 2].map((before) => {
    const encodings = neighbours.map((byte) =>
      Buffer.concat([Buffer.alloc(before, byte), bytes, Buffer.alloc(2, byte)]).toString(encoding),
    );
    const first = encodings[0]!;
    let start = 0;
    while (start < first.length && encodings.some((other) => other[start] !== first[start]))
      start += 1;
    let end = start;
    while (end < first.length && encodings.every((other) => other[end] === first[end])) end += 1;
    return first.slice(start, end);
  });
}

/** Each form of the value a scrubbed text must not hold, written by this model's encoders. */
export function modelForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const json = JSON.stringify(value).slice(1, -1);
  let asciiJson = "";
  for (const unit of json)
    asciiJson +=
      unit.length === 1 && unit.charCodeAt(0) < 0x80
        ? unit
        : [...Array(unit.length).keys()]
            .map((at) => `\\u${unit.charCodeAt(at).toString(16).padStart(4, "0")}`)
            .join("");
  const forms = [value, json, asciiJson, JSON.stringify(json).slice(1, -1)];
  try {
    forms.push(encodeURIComponent(value), encodeURI(value));
  } catch {
    // A lone surrogate has no percent-encoding.
  }
  forms.push(bytes.toString("latin1"), recoverLatin1(value));
  const padded = [bytes.toString("base64"), bytes.toString("base64url")];
  const binary = [
    bytes.toString("hex"),
    ...padded,
    ...padded.map((form) => form.replace(/=+$/, "")),
    ...stableBase64(bytes, "base64"),
    ...stableBase64(bytes, "base64url"),
  ];
  return [
    ...new Set([...forms, ...binary.filter((form) => form.length >= MIN_BINARY_FORM)]),
  ].filter((form) => form.length > 0);
}

// The HTML5 named references for printable ASCII that the documented decoder reads.
const NAMED_REFERENCES = new Map(
  Object.entries({
    amp: "&",
    apos: "'",
    ast: "*",
    bsol: "\\",
    colon: ":",
    comma: ",",
    commat: "@",
    dollar: "$",
    equals: "=",
    excl: "!",
    grave: "`",
    gt: ">",
    hat: "^",
    lcub: "{",
    lowbar: "_",
    lpar: "(",
    lsqb: "[",
    lt: "<",
    num: "#",
    percnt: "%",
    period: ".",
    plus: "+",
    quest: "?",
    quot: '"',
    rcub: "}",
    rpar: ")",
    rsqb: "]",
    semi: ";",
    sol: "/",
    verbar: "|",
  }),
);

const fromCode = (code: number, written: string): string =>
  code <= 0x10ffff ? String.fromCodePoint(code) : written;

/**
 * A run of percent escapes read as UTF-8: at each escape the shortest stretch of one to four
 * escapes that decodeURIComponent accepts, or else the byte as its own character.
 */
function percentAsUtf8(run: string): string {
  const escapes = run.match(/%[0-9a-f]{2}/gi) ?? [];
  let text = "";
  for (let at = 0; at < escapes.length;) {
    let decoded: string | undefined;
    let length = 0;
    while (decoded === undefined && length < 4 && at + length < escapes.length) {
      length += 1;
      try {
        decoded = decodeURIComponent(escapes.slice(at, at + length).join(""));
      } catch {
        decoded = undefined;
      }
    }
    if (decoded === undefined) {
      text += String.fromCharCode(Number.parseInt(escapes[at]!.slice(1), 16));
      at += 1;
    } else {
      text += decoded;
      at += length;
    }
  }
  return text;
}

/** The documented decoding, one pass for each kind of escape, in the documented order. */
function decode(text: string, percent: (run: string) => string): string {
  return text
    .replace(/\\u[0-9a-f]{4}/gi, (escape) => JSON.parse(`"${escape}"`) as string)
    .replace(/\\x([0-9a-f]{2})/gi, (_escape, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 16)),
    )
    .replaceAll("\\/", "/")
    .replace(/(?:%[0-9a-f]{2})+/gi, percent)
    .replace(/&#x([0-9a-f]{1,6});?/gi, (written, digits: string) =>
      fromCode(Number.parseInt(digits, 16), written),
    )
    .replace(/&#([0-9]{1,7});?/g, (written, digits: string) =>
      fromCode(Number.parseInt(digits, 10), written),
    )
    .replace(
      /&([a-z]+);/gi,
      (written, name: string) => NAMED_REFERENCES.get(name.toLowerCase()) ?? written,
    );
}

/** The text with each percent escape read as one character, the byte's code. */
export const modelDecode = (text: string): string =>
  decode(text, (run) =>
    (run.match(/%[0-9a-f]{2}/gi) ?? [])
      .map((escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
      .join(""),
  );

/** JSON whitespace escapes and quoted-printable bytes and soft line breaks expanded. */
const expandTransfer = (text: string): string =>
  text
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_escape, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 16)),
    );

/** Each run of characters U+0080 to U+00FF read as UTF-8 bytes, as percent escapes would be. */
const recoverLatin1 = (text: string): string =>
  text.replace(/[\x80-\xff]+/g, (run) =>
    percentAsUtf8([...run].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("")),
  );

/**
 * The text as written, decoded with percent escapes as bytes and as UTF-8, expanded, and the text
 * as written and decoded with Latin-1 runs read as UTF-8.
 */
export function modelReadings(text: string): string[] {
  const decoded = modelDecode(text);
  return [
    ...new Set([
      text,
      decoded,
      decode(text, percentAsUtf8),
      expandTransfer(decoded),
      recoverLatin1(text),
      recoverLatin1(decoded),
    ]),
  ];
}

function markerSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const marker of WRITTEN_MARKERS)
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1))
      spans.push([at, at + marker.length]);
  return spans;
}

/** The reading with each character of an occurrence of a value's form, outside the markers, removed. */
export function outsideValues(values: readonly string[], reading: string): string {
  const markers = markerSpans(reading);
  const covered = new Uint8Array(reading.length);
  for (const value of values)
    for (const form of modelForms(value))
      for (let at = reading.indexOf(form); at !== -1; at = reading.indexOf(form, at + 1)) {
        const end = at + form.length;
        if (!markers.some(([start, stop]) => start <= at && end <= stop)) covered.fill(1, at, end);
      }
  // By code unit, the unit indexOf finds occurrences in.
  let kept = "";
  for (let at = 0; at < reading.length; at += 1) if (covered[at] === 0) kept += reading[at];
  return kept;
}

// Everything the documented decoder rewrites, in the order it rewrites it.
const ESCAPES = [
  /\\u[0-9a-f]{4}/gi,
  /\\x[0-9a-f]{2}/gi,
  /\\\//g,
  /(?:%[0-9a-f]{2})+/gi,
  /&#x[0-9a-f]{1,6};?/gi,
  /&#[0-9]{1,7};?/g,
  /&[a-z]+;/gi,
];

/** Whether a value as written overlaps an escape in the text, as `0000` does in `%200000`. */
export function touchesEscape(values: readonly string[], text: string): boolean {
  const escapes = ESCAPES.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]),
  );
  return values.some((value) => {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1))
      if (escapes.some(([start, end]) => at < end! && start! < at + value.length)) return true;
    return false;
  });
}

/** Whether every character of `kept` appears in `text` in the same order. */
export function inOrder(kept: string, text: string): boolean {
  let at = 0;
  for (const char of kept) {
    at = text.indexOf(char, at);
    if (at === -1) return false;
    at += char.length;
  }
  return true;
}

/**
 * Where a reading of the text holds a form of a value outside the written markers, or undefined
 * when none does.
 */
export function survivingForm(values: readonly string[], text: string): string | undefined {
  const forms = values.map((value) => [value, modelForms(value)] as const);
  for (const reading of modelReadings(text)) {
    const markers = markerSpans(reading);
    for (const [value, valueForms] of forms)
      for (const form of valueForms)
        for (let at = reading.indexOf(form); at !== -1; at = reading.indexOf(form, at + 1)) {
          const end = at + form.length;
          if (!markers.some(([start, stop]) => start <= at && end <= stop))
            return `${JSON.stringify(form)}, a form of ${JSON.stringify(value)}, at ${at} in ${JSON.stringify(reading)}`;
        }
  }
  return undefined;
}
