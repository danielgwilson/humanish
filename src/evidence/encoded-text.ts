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

// The length of the UTF-8 sequence a lead byte starts, or 0 for a byte that starts none.
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** Receives the text one match decodes to, piece by piece, with the match characters each came from. */
type Emit = (decoded: string, length: number) => void;
/** Decodes one match of a pass. `group` is its first capture group. */
type Read = (match: string, group: string | undefined, emit: Emit) => void;

const whole =
  (decode: (match: string, group: string) => string): Read =>
  (match, group, emit) =>
    emit(decode(match, group ?? ""), match.length);
const codePointOf = (radix: number): Read =>
  whole((match, digits) => codePoint(Number.parseInt(digits, radix), match));

/** A run of percent escapes, one character per escape: the byte's code. */
const readPercentBytes: Read = (run, _group, emit) => {
  for (let at = 0; at < run.length; at += 3)
    emit(String.fromCharCode(Number.parseInt(run.slice(at + 1, at + 3), 16)), 3);
};

/**
 * A run of percent escapes read as UTF-8, as a browser reads a URL. A byte that starts no valid
 * sequence stands for itself, the character with that code, as readPercentBytes reads every byte.
 */
const readPercentUtf8: Read = (run, _group, emit) => {
  const bytes = Buffer.from(run.replace(/%/g, ""), "hex");
  for (let at = 0; at < bytes.length;) {
    const lead = bytes[at]!;
    const length = sequenceLength(lead);
    if (length <= 1) {
      emit(String.fromCharCode(lead), 3);
      at += 1;
      continue;
    }
    const sequence = bytes.subarray(at, at + length);
    const decoded = sequence.length === length ? sequence.toString("utf8") : undefined;
    // Node writes the replacement character for an overlong form, a surrogate half or a bad
    // continuation byte, so a sequence counts only when its character encodes back to its bytes.
    if (decoded !== undefined && Buffer.from(decoded, "utf8").equals(sequence)) {
      emit(decoded, length * 3);
      at += length;
    } else {
      emit(String.fromCharCode(lead), 3);
      at += 1;
    }
  }
};

/** The passes decodeEscapes applies in order, each to the output of the one before. */
const escapePasses = (percent: Read): readonly (readonly [RegExp, Read])[] => [
  [/\\u([0-9a-f]{4})/gi, codePointOf(16)],
  [/\\x([0-9a-f]{2})/gi, codePointOf(16)],
  [/\\\//g, whole(() => "/")],
  [/(?:%[0-9a-f]{2})+/gi, percent],
  [/&#x([0-9a-f]{1,6});?/gi, codePointOf(16)],
  [/&#(\d{1,7});?/g, codePointOf(10)],
  [/&([a-z]+);/gi, whole((match, name) => ASCII_ENTITIES[name.toLowerCase()] ?? match)],
];
const BYTE_PASSES = escapePasses(readPercentBytes);
const UTF8_PASSES = escapePasses(readPercentUtf8);

/**
 * Undoes JSON and JS escapes, percent-encoding and HTML character references, one pass each. Each
 * percent escape is one character, the byte's code, so `caf%C3%A9` reads as `cafÃ©`;
 * decodeEscapesUtf8 reads it as `café`. A scan checks both: either reading can split a value that
 * the other keeps whole, as `%E2%80%80` (U+2000, a space, in UTF-8) does.
 */
export function decodeEscapes(text: string): string {
  return decodeWith(text, BYTE_PASSES);
}

/** decodeEscapes with each run of percent escapes read as UTF-8. */
export function decodeEscapesUtf8(text: string): string {
  return decodeWith(text, UTF8_PASSES);
}

/**
 * The UTF-8 reading of text's escapes when it differs from decodeEscapes, which it can only where
 * a percent escape holds a byte of 0x80 or more.
 */
export function utf8ReadingOf(text: string, decoded: string): string | undefined {
  if (!/%[89a-f][0-9a-f]/i.test(text)) return undefined;
  const utf8 = decodeEscapesUtf8(text);
  return utf8 === decoded ? undefined : utf8;
}

function decodeWith(text: string, passes: readonly (readonly [RegExp, Read])[]): string {
  let decoded = text;
  for (const [pattern, read] of passes)
    decoded = decoded.replace(pattern, (match: string, ...rest: unknown[]) => {
      let replacement = "";
      read(match, typeof rest[0] === "string" ? rest[0] : undefined, (piece) => {
        replacement += piece;
      });
      return replacement;
    });
  return decoded;
}

/** Decoded text, with the stretch of the original text each of its UTF-16 code units came from. */
export interface DecodedWithOrigins {
  readonly text: string;
  /** Code unit `i` of `text` was decoded from `[starts[i], ends[i])` of the original. */
  readonly starts: Uint32Array;
  readonly ends: Uint32Array;
}

/**
 * decodeEscapes, or decodeEscapesUtf8 with `utf8`, with the stretch of `text` each decoded code
 * unit came from. A character an escape stands for comes from the whole escape, and from every
 * escape that wrote that escape in an earlier pass: the `A` of `\u002541` comes from all eight
 * characters. A scrub that finds a value in the decoded text replaces the stretches its characters
 * came from, so the text around it keeps its spelling.
 */
export function decodeEscapesWithOrigins(text: string, utf8 = false): DecodedWithOrigins {
  let current = { text, starts: new Uint32Array(text.length), ends: new Uint32Array(text.length) };
  for (let at = 0; at < text.length; at += 1) {
    current.starts[at] = at;
    current.ends[at] = at + 1;
  }
  for (const [pattern, read] of utf8 ? UTF8_PASSES : BYTE_PASSES) {
    const source = current;
    // No escape decodes to more code units than it has, so a pass never lengthens the text.
    const starts = new Uint32Array(source.text.length);
    const ends = new Uint32Array(source.text.length);
    const parts: string[] = [];
    let length = 0;
    let cursor = 0;
    const copyTo = (end: number): void => {
      starts.set(source.starts.subarray(cursor, end), length);
      ends.set(source.ends.subarray(cursor, end), length);
      parts.push(source.text.slice(cursor, end));
      length += end - cursor;
    };
    for (const match of source.text.matchAll(pattern)) {
      copyTo(match.index);
      let at = match.index;
      read(match[0], match[1], (piece, consumed) => {
        const start = source.starts[at]!;
        const end = source.ends[at + consumed - 1]!;
        for (let unit = 0; unit < piece.length; unit += 1) {
          starts[length + unit] = start;
          ends[length + unit] = end;
        }
        parts.push(piece);
        length += piece.length;
        at += consumed;
      });
      cursor = match.index + match[0].length;
    }
    if (cursor === 0 && parts.length === 0) continue;
    copyTo(source.text.length);
    current = {
      text: parts.join(""),
      starts: starts.subarray(0, length),
      ends: ends.subarray(0, length),
    };
  }
  return current;
}

// Sixteen characters hold twelve bytes, enough for the start of a key. Shorter runs are mostly
// words and identifiers.
// Each open-ended repeat is written `[...]{n}[...]*`: V8 runs `{n,}` with a backtrack entry per
// character and overflows its stack on a run of several megabytes.
const BASE64_RUN = /[A-Za-z0-9+/]{16}[A-Za-z0-9+/]*={0,2}/g;
// The URL-safe alphabet swaps `+/` for `-_`. Only runs that use `-` or `_` need this pass.
const BASE64URL_RUN = /[A-Za-z0-9_-]{16}[A-Za-z0-9_-]*={0,2}/g;
// Hex-encoded text, at least sixteen bytes of it.
const HEX_RUN = /[0-9a-f]{32}[0-9a-f]*/gi;
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
// A run such as `com/x/<base64>` from a URL path starts with segments that shift the alignment of
// the base64 after them. A run up to this long is also decoded one slash-separated piece at a time,
// and from just after each slash in its first SLASH_START_SPAN characters, for base64 that holds a
// slash itself. Longer runs are images, fonts and archives, not URLs.
const MAX_SLASH_START_RUN = 4096;
const SLASH_START_SPAN = 64;

function isBase64Code(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2b ||
    code === 0x2f
  );
}

/**
 * Base64 that MIME and PEM wrap at 64 or 76 characters a line: a run of 16 or more characters that
 * ends its line, then the leading run of 4 or more on each following line, for as long as a line
 * holds nothing else. Read line by line, so a long wrapped block costs linear time and no regex
 * stack.
 */
function wrappedBase64Runs(text: string): string[] {
  const runs: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 1) runs.push(current.join(""));
    current = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let end = line.length;
    while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end -= 1;
    let start = 0;
    while (start < end && (line[start] === " " || line[start] === "\t")) start += 1;
    if (current.length > 0) {
      let lead = start;
      while (lead < end && isBase64Code(line.charCodeAt(lead))) lead += 1;
      if (lead - start >= 4) {
        current.push(line.slice(start, lead));
        if (lead === end) continue;
      }
      flush();
    }
    let tail = end;
    while (tail > 0 && isBase64Code(line.charCodeAt(tail - 1))) tail -= 1;
    if (end - tail >= 16) current = [line.slice(tail, end)];
  }
  flush();
  return runs;
}
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

/** How scanEncodedText reads text. */
export interface EncodedTextScanOptions {
  /** Do not count an encoded binary run as opaque. */
  readonly allowOpaqueBase64?: boolean;
  /** What counts as sensitive in the text and in each decoding of it; containsSensitive by default. */
  readonly matches?: (text: string) => boolean;
}

const matcherOf = (options: EncodedTextScanOptions): ((text: string) => boolean) =>
  options.matches ?? containsSensitive;

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
  options: EncodedTextScanOptions,
  depth: number,
): EncodedTextScan {
  const matches = matcherOf(options);
  if (startsWithArchive(bytes))
    return { sensitive: false, opaque: options.allowOpaqueBase64 !== true };
  const plain = readPlainText(bytes);
  const inner = plain.ok ? plain.text : utf16Text(bytes);
  if (inner !== undefined) {
    if (depth < MAX_DEPTH) return scanEncodedText(inner, options, depth + 1);
    const innerDecoded = decodeEscapes(inner);
    return matches(inner) || (innerDecoded !== inner && matches(innerDecoded)) ? SENSITIVE : CLEAN;
  }
  // A key next to a few binary bytes is still a printable stretch.
  if (matches(printableStretches(bytes))) return SENSITIVE;
  return {
    sensitive: false,
    opaque:
      run.length >= MIN_OPAQUE_BASE64_RUN &&
      new Set(run).size >= MIN_OPAQUE_DISTINCT_CHARACTERS &&
      options.allowOpaqueBase64 !== true,
  };
}

/**
 * Scans text for secrets as written, after decodeEscapes (also with percent escapes read as UTF-8)
 * and transfer escapes, and inside each
 * base64 (standard, URL-safe or line-wrapped) and hex run. A run that decodes to text is scanned in
 * turn. A run that decodes to an archive, or to other binary past MIN_OPAQUE_BASE64_RUN characters,
 * is opaque unless the caller allows opaque runs.
 */
export function scanEncodedText(
  text: string,
  options: EncodedTextScanOptions = {},
  depth = 0,
): EncodedTextScan {
  const matches = matcherOf(options);
  const decoded = decodeEscapes(text);
  const utf8 = utf8ReadingOf(text, decoded);
  const expanded = decodeTransferEscapes(decoded);
  // A decoding that returns the same string would match the same way, so it is not matched again.
  if (
    matches(text) ||
    (decoded !== text && matches(decoded)) ||
    (utf8 !== undefined && matches(utf8)) ||
    (expanded !== decoded && matches(expanded))
  )
    return SENSITIVE;
  const runs: { run: string; bytes: Buffer }[] = [];
  // A piece or a run decoded from a slash only adds findings; its bytes are not judged opaque.
  const slashStarts: Buffer[] = [];
  for (const [match] of expanded.matchAll(BASE64_RUN)) {
    // Hex digests and ids decode to noise; the hex pass below reads hex as hex.
    if (/^[0-9a-f]+$/i.test(match.replace(/=+$/, ""))) continue;
    runs.push({ run: match, bytes: Buffer.from(match, "base64") });
    if (match.length > MAX_SLASH_START_RUN) continue;
    for (const piece of match.split("/"))
      if (piece.length >= 16 && piece.length < match.length)
        slashStarts.push(Buffer.from(piece, "base64"));
    for (
      let slash = match.indexOf("/");
      slash !== -1 && slash < SLASH_START_SPAN && match.length - slash > 16;
      slash = match.indexOf("/", slash + 1)
    )
      slashStarts.push(Buffer.from(match.slice(slash + 1), "base64"));
  }
  for (const [match] of expanded.matchAll(BASE64URL_RUN)) {
    if (/[-_]/.test(match)) runs.push({ run: match, bytes: Buffer.from(match, "base64url") });
  }
  for (const run of wrappedBase64Runs(expanded))
    runs.push({ run, bytes: Buffer.from(run, "base64") });
  let opaque = false;
  for (const { run, bytes } of runs) {
    const result = inspectDecoded(bytes, run, options, depth);
    if (result.sensitive) return result;
    opaque ||= result.opaque;
  }
  for (const bytes of slashStarts)
    if (inspectDecoded(bytes, "", { ...options, allowOpaqueBase64: true }, depth).sensitive)
      return SENSITIVE;
  // Hex is read before transfer escapes too: the quoted-printable pass reads `=68` in `state=6874...`
  // as one byte, which shifts every hex pair after it.
  const hexRuns = new Set([
    ...[...expanded.matchAll(HEX_RUN)].map(([match]) => match),
    ...(expanded === decoded ? [] : [...decoded.matchAll(HEX_RUN)].map(([match]) => match)),
  ]);
  for (const match of hexRuns) {
    const plain = readPlainText(Buffer.from(match, "hex"));
    if (plain.ok && depth < MAX_DEPTH && scanEncodedText(plain.text, options, depth + 1).sensitive)
      return SENSITIVE;
  }
  return { sensitive: false, opaque };
}

// Bump when scanEncodedText, decodeEscapes or the sensitive patterns change what they return. The
// cache lives in one process, so the version guards results across a hot reload or a test that
// swaps the scanner.
const ENCODED_SCAN_VERSION = 4;
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
  options: Pick<EncodedTextScanOptions, "allowOpaqueBase64"> = {},
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
