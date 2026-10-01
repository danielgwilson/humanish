// A pattern scan reads characters, so a file can hide a secret by encoding it. scanEncodedText
// undoes the encodings a reader undoes for free (JSON and JS escapes, percent-encoding, HTML
// entities) and looks inside base64 runs. verify and bundle export share decodeEscapes, so they
// judge the same decoded text.

import { readPlainText } from "./plain-text.js";
import { containsSensitive } from "./redaction.js";

// HTML5 named references that stand for printable ASCII. Letters and digits have only numeric
// references, which decodeEscapes handles.
const ASCII_ENTITIES: Readonly<Record<string, string>> = {
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
};

function codePoint(value: number, original: string): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : original;
}

/** Undoes JSON and JS escapes, percent-encoding and HTML character references, one pass each. */
export function decodeEscapes(text: string): string {
  return text
    .replace(/\\u([0-9a-f]{4})/gi, (match, hex: string) =>
      codePoint(Number.parseInt(hex, 16), match),
    )
    .replace(/\\x([0-9a-f]{2})/gi, (match, hex: string) =>
      codePoint(Number.parseInt(hex, 16), match),
    )
    .replace(/\\\//g, "/")
    .replace(/%([0-9a-f]{2})/gi, (match, hex: string) => codePoint(Number.parseInt(hex, 16), match))
    .replace(/&#x([0-9a-f]{1,6});?/gi, (match, hex: string) =>
      codePoint(Number.parseInt(hex, 16), match),
    )
    .replace(/&#(\d{1,7});?/g, (match, digits: string) =>
      codePoint(Number.parseInt(digits, 10), match),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => ASCII_ENTITIES[name.toLowerCase()] ?? match);
}

// Sixteen characters hold twelve bytes, enough for the start of a key. Shorter runs are mostly
// words and identifiers.
const BASE64_RUN = /[A-Za-z0-9+/]{16,}={0,2}/g;
// A base64 run that decodes to bytes that are neither text nor an archive is unreadable only past
// this length. Across 173 real run folders surveyed on 2026-10-01, the longest such run outside
// observer/index.html was a 69-character URL path in a terminal log; base64 of a 94-byte payload,
// such as a UTF-16 key line, is 128 characters.
const MIN_OPAQUE_BASE64_RUN = 128;
// Filler such as one letter repeated decodes to repeated bytes. Base64 of compressed, encrypted or
// image bytes uses most of the 64 characters within 128 of them.
const MIN_OPAQUE_DISTINCT_CHARACTERS = 16;
// gzip, zip, 7z, bzip2, xz and zstd.
const ARCHIVE_MAGIC: readonly (readonly number[])[] = [
  [0x1f, 0x8b],
  [0x50, 0x4b, 0x03, 0x04],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x42, 0x5a, 0x68],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  [0x28, 0xb5, 0x2f, 0xfd],
];
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
// Base64 inside base64 is read this many levels deep.
const MAX_DEPTH = 2;

function startsWithArchive(bytes: Uint8Array): boolean {
  return ARCHIVE_MAGIC.some((magic) => magic.every((byte, index) => bytes[index] === byte));
}

/** Text in UTF-16LE that is mostly ASCII, as a key would be; random bytes rarely qualify. */
function utf16Text(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (CONTROL_CHARACTERS.test(text)) return undefined;
  let ascii = 0;
  for (const character of text) if (character.charCodeAt(0) < 0x80) ascii += 1;
  return ascii >= text.length * 0.9 ? text : undefined;
}

export interface EncodedTextScan {
  /** A secret or private path, in the text or in a decoding of it. */
  sensitive: boolean;
  /** An encoded archive, or an encoded binary run long enough to hide one, that the scan cannot read. */
  opaque: boolean;
}

/**
 * Scans text for secrets as written, after decodeEscapes, and inside each base64 run. A run that
 * decodes to text is scanned in turn. A run that decodes to an archive, or to other binary past
 * MIN_OPAQUE_BASE64_RUN characters, is opaque unless the caller allows opaque runs.
 */
export function scanEncodedText(
  text: string,
  options: { allowOpaqueBase64?: boolean } = {},
  depth = 0,
): EncodedTextScan {
  const decoded = decodeEscapes(text);
  if (containsSensitive(text) || containsSensitive(decoded))
    return { sensitive: true, opaque: false };
  let opaque = false;
  for (const match of decoded.matchAll(BASE64_RUN)) {
    const run = match[0];
    // Hex digests and ids decode to noise and hold no text.
    if (/^[0-9a-f]+$/i.test(run.replace(/=+$/, ""))) continue;
    const bytes = Buffer.from(run, "base64");
    if (startsWithArchive(bytes)) {
      opaque ||= options.allowOpaqueBase64 !== true;
      continue;
    }
    const plain = readPlainText(bytes);
    const inner = plain.ok ? plain.text : utf16Text(bytes);
    if (inner !== undefined) {
      if (depth < MAX_DEPTH) {
        const nested = scanEncodedText(inner, options, depth + 1);
        if (nested.sensitive) return nested;
        opaque ||= nested.opaque;
      } else if (containsSensitive(inner) || containsSensitive(decodeEscapes(inner))) {
        return { sensitive: true, opaque: false };
      }
      continue;
    }
    if (
      run.length >= MIN_OPAQUE_BASE64_RUN &&
      new Set(run).size >= MIN_OPAQUE_DISTINCT_CHARACTERS &&
      options.allowOpaqueBase64 !== true
    ) {
      opaque = true;
    }
  }
  return { sensitive: false, opaque };
}
