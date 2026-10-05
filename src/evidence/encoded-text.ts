// A pattern scan reads characters, so a file can hide a secret by encoding it. scanEncodedText
// undoes the encodings a reader undoes for free (JSON and JS escapes, percent-encoding, HTML
// entities) and looks inside base64 runs. verify and bundle export share decodeEscapes, so they
// judge the same decoded text.

import { createHash } from "node:crypto";

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
// The URL-safe alphabet swaps `+/` for `-_`. Only runs that use `-` or `_` need this pass.
const BASE64URL_RUN = /[A-Za-z0-9_-]{16,}={0,2}/g;
// MIME and PEM wrap base64 at 64 or 76 characters a line. The lookbehind starts a match only at the
// start of a run, and each lookahead-backreference pair takes a line whole, so a long unwrapped run
// cannot backtrack.
const WRAPPED_BASE64 =
  /(?<![A-Za-z0-9+/])(?=([A-Za-z0-9+/]{16,}))\1(?:[ \t]*\r?\n[ \t]*(?=([A-Za-z0-9+/]{4,}))\2)+={0,2}/g;
// Hex-encoded text, at least sixteen bytes of it.
const HEX_RUN = /(?:[0-9a-f]{2}){16,}/gi;
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

/** UTF-16 text, either byte order, that is mostly ASCII as a key would be; random bytes rarely qualify. */
function utf16Text(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return undefined;
  // Every ASCII character in UTF-16, in either byte order, has a 0x00 byte. Without one the decoded
  // text has no ASCII, so the 90% rule below would reject it, and none of the sensitive patterns
  // could match it: each needs ASCII characters (sensitivePatterns, pinned in
  // tests/evidence/encoded-text.test.ts). Skipping the decode changes no result.
  if (!bytes.includes(0)) return undefined;
  for (const encoding of ["utf-16le", "utf-16be"]) {
    let text: string;
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    if (CONTROL_CHARACTERS.test(text)) continue;
    let ascii = 0;
    for (const character of text) if (character.charCodeAt(0) < 0x80) ascii += 1;
    if (ascii >= text.length * 0.9) return text;
  }
  return undefined;
}

/** The printable ASCII stretches of binary bytes, one per line, as `strings` would show them. */
function printableStretches(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("latin1")
    .replace(/[^\x20-\x7e]+/g, "\n");
}

/**
 * Escapes a transfer encoding adds: JSON whitespace escapes, and quoted-printable soft line breaks
 * and `=XX` bytes. Bundle export does not apply these, so they stay out of decodeEscapes.
 */
function decodeTransferEscapes(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (match, hex: string) => codePoint(Number.parseInt(hex, 16), match));
}

export interface EncodedTextScan {
  /** A secret or private path, in the text or in a decoding of it. */
  readonly sensitive: boolean;
  /** An encoded archive, or an encoded binary run long enough to hide one, that the scan cannot read. */
  readonly opaque: boolean;
}

const CLEAN: EncodedTextScan = Object.freeze({ sensitive: false, opaque: false });
const SENSITIVE: EncodedTextScan = Object.freeze({ sensitive: true, opaque: false });

function inspectDecoded(
  bytes: Buffer,
  run: string,
  options: { allowOpaqueBase64?: boolean },
  depth: number,
): EncodedTextScan {
  if (startsWithArchive(bytes))
    return { sensitive: false, opaque: options.allowOpaqueBase64 !== true };
  const plain = readPlainText(bytes);
  const inner = plain.ok ? plain.text : utf16Text(bytes);
  if (inner !== undefined) {
    if (depth < MAX_DEPTH) return scanEncodedText(inner, options, depth + 1);
    const innerDecoded = decodeEscapes(inner);
    return containsSensitive(inner) || (innerDecoded !== inner && containsSensitive(innerDecoded))
      ? SENSITIVE
      : CLEAN;
  }
  // A key next to a few binary bytes is still a printable stretch.
  if (containsSensitive(printableStretches(bytes))) return SENSITIVE;
  return {
    sensitive: false,
    opaque:
      run.length >= MIN_OPAQUE_BASE64_RUN &&
      new Set(run).size >= MIN_OPAQUE_DISTINCT_CHARACTERS &&
      options.allowOpaqueBase64 !== true,
  };
}

/**
 * Scans text for secrets as written, after decodeEscapes and transfer escapes, and inside each
 * base64 (standard, URL-safe or line-wrapped) and hex run. A run that decodes to text is scanned in
 * turn. A run that decodes to an archive, or to other binary past MIN_OPAQUE_BASE64_RUN characters,
 * is opaque unless the caller allows opaque runs.
 */
export function scanEncodedText(
  text: string,
  options: { allowOpaqueBase64?: boolean } = {},
  depth = 0,
): EncodedTextScan {
  const decoded = decodeEscapes(text);
  const expanded = decodeTransferEscapes(decoded);
  // A decoding that returns the same string would match the same way, so it is not matched again.
  if (
    containsSensitive(text) ||
    (decoded !== text && containsSensitive(decoded)) ||
    (expanded !== decoded && containsSensitive(expanded))
  )
    return SENSITIVE;
  const runs: { run: string; bytes: Buffer }[] = [];
  for (const [match] of expanded.matchAll(BASE64_RUN)) {
    // Hex digests and ids decode to noise; the hex pass below reads hex as hex.
    if (/^[0-9a-f]+$/i.test(match.replace(/=+$/, ""))) continue;
    runs.push({ run: match, bytes: Buffer.from(match, "base64") });
  }
  for (const [match] of expanded.matchAll(BASE64URL_RUN)) {
    if (/[-_]/.test(match)) runs.push({ run: match, bytes: Buffer.from(match, "base64url") });
  }
  for (const [match] of expanded.matchAll(WRAPPED_BASE64)) {
    const run = match.replace(/\s+/g, "");
    runs.push({ run, bytes: Buffer.from(run, "base64") });
  }
  let opaque = false;
  for (const { run, bytes } of runs) {
    const result = inspectDecoded(bytes, run, options, depth);
    if (result.sensitive) return result;
    opaque ||= result.opaque;
  }
  for (const [match] of expanded.matchAll(HEX_RUN)) {
    const plain = readPlainText(Buffer.from(match, "hex"));
    if (plain.ok && depth < MAX_DEPTH && scanEncodedText(plain.text, options, depth + 1).sensitive)
      return SENSITIVE;
  }
  return { sensitive: false, opaque };
}

// Bump when scanEncodedText, decodeEscapes or the sensitive patterns change what they return. The
// cache lives in one process, so the version guards results across a hot reload or a test that
// swaps the scanner.
const ENCODED_SCAN_VERSION = 2;
// Distinct files one process verifies in a burst (a run's files, a serve library's runs).
const SCAN_CACHE_LIMIT = 256;
const scanCache = new Map<string, EncodedTextScan>();

/**
 * scanEncodedText, cached in this process. The key is the sha256 of the scanned string's UTF-16
 * code units, the options and ENCODED_SCAN_VERSION. Encoding as UTF-16LE keeps every code unit,
 * lone surrogates included, so distinct strings get distinct keys and a hit is the result a fresh
 * scan of the same string would give. Repeated verifies of an unchanged file, as serve admission
 * and the Observer render do, skip the scan.
 */
export function scanEncodedTextCached(
  text: string,
  options: { allowOpaqueBase64?: boolean } = {},
): EncodedTextScan {
  const key = [
    ENCODED_SCAN_VERSION,
    options.allowOpaqueBase64 === true ? "opaque-allowed" : "opaque-unscanned",
    createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex"),
  ].join(":");
  const cached = scanCache.get(key);
  if (cached !== undefined) {
    // Refresh its place so the least recently used entry is evicted first.
    scanCache.delete(key);
    scanCache.set(key, cached);
    return cached;
  }
  // Every caller gets the cached object, so it is frozen.
  const result = Object.freeze({ ...scanEncodedText(text, options) });
  scanCache.set(key, result);
  if (scanCache.size > SCAN_CACHE_LIMIT) {
    const oldest = scanCache.keys().next().value;
    if (oldest !== undefined) scanCache.delete(oldest);
  }
  return result;
}
