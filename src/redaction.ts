import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

// Single source of truth for public-safety redaction patterns. Both the Codex
// actor trace (src/codex-app-server.ts) and the run-bundle scanner/redactor
// (src/run.ts) use these so the denylist cannot drift between producers and the
// verify gate. See docs/contracts/policy.md for the enforcement-scope policy.

export const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\be2b_[A-Za-z0-9]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:@/\s]+:[^@/\s]+@\S+/g,
  /_authToken\s*=\s*[A-Za-z0-9._~+/=-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/g,
  /https?:\/\/[^/\s]*e2b[^)\s]+/gi,
  /BEGIN (RSA|OPENSSH|PRIVATE) KEY/gi
];

export const LOCAL_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/\/private\/var\/folders\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/var\/folders\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/private\/tmp\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/tmp\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/Users\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g, "[REDACTED_LOCAL_PATH]"],
  [/\/home\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g, "[REDACTED_RUNTIME_PATH]"]
];

export const PII_PHI_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_PII]"],
  [/(?:\+\d{1,3}[-.\s()]*(?:\d{3}[-.\s()]*){2}\d{4}\b|\b(?:phone|tel|mobile|contact)\s*[:=]?\s*(?:\+?\d{1,3}[-.\s()]*)?(?:\d{3}[-.\s()]*){2}\d{4}\b)/gi, "[REDACTED_PII]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_PII]"],
  [/\b(?:DOB|date of birth|birth date)\s*[:=]?\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/gi, "[REDACTED_PII]"],
  [/\b(?:MRN|medical record(?: number)?|patient id|member id|insurance id)\s*[:#=]?\s*[A-Z0-9-]{6,}\b/gi, "[REDACTED_PHI]"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, "[REDACTED_PII]"]
];

const CREDIT_CARD_CANDIDATE_PATTERN = /\b(?:\d{4}[ -]){3}\d{4}\b|\b(?:card|credit card|cc)\s*[:=]?\s*\d{13,19}\b/gi;
const IPV4_CANDIDATE_PATTERN = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;

// Sticky/global regexes carry lastIndex state across .test() calls. Always reset
// before a detection test so the shared singletons are safe to reuse.
function matchesPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** True if the text contains any secret-shaped token, PII/PHI shape, or known local path. */
export function containsSensitive(text: string): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => matchesPattern(pattern, text)) ||
    PII_PHI_PATTERNS.some(([pattern]) => matchesPattern(pattern, text)) ||
    containsPublicIpv4(text) ||
    containsLuhnCard(text) ||
    LOCAL_PATH_PATTERNS.some(([pattern]) => matchesPattern(pattern, text))
  );
}

/** Redact secrets to [REDACTED_SECRET], PII/PHI to class labels, and local paths to their path labels. */
export function redactText(text: string): string {
  const withoutSecrets = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED_SECRET]"),
    text
  );
  const withoutPiiPhi = PII_PHI_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    withoutSecrets
  )
    .replace(IPV4_CANDIDATE_PATTERN, (candidate) => (isPublicIpv4(candidate) ? "[REDACTED_PII]" : candidate))
    .replace(CREDIT_CARD_CANDIDATE_PATTERN, (candidate) => (isLuhnCard(candidate) ? "[REDACTED_PII]" : candidate));
  return LOCAL_PATH_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    withoutPiiPhi
  );
}

/** Redact every sensitive match (secrets, PII/PHI, and paths) to a single [REDACTED_SECRET] label. */
export function redactToSecretLabel(text: string): string {
  const withoutSecrets = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED_SECRET]"),
    text
  );
  const withoutPiiPhi = PII_PHI_PATTERNS.reduce(
    (current, [pattern]) => current.replace(pattern, "[REDACTED_SECRET]"),
    withoutSecrets
  )
    .replace(IPV4_CANDIDATE_PATTERN, (candidate) => (isPublicIpv4(candidate) ? "[REDACTED_SECRET]" : candidate))
    .replace(CREDIT_CARD_CANDIDATE_PATTERN, (candidate) => (isLuhnCard(candidate) ? "[REDACTED_SECRET]" : candidate));
  return LOCAL_PATH_PATTERNS.reduce(
    (current, [pattern]) => current.replace(pattern, "[REDACTED_SECRET]"),
    withoutPiiPhi
  );
}

function containsPublicIpv4(text: string): boolean {
  IPV4_CANDIDATE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(IPV4_CANDIDATE_PATTERN)) {
    const candidate = match[0];
    if (candidate !== undefined && isPublicIpv4(candidate)) {
      return true;
    }
  }
  return false;
}

function isPublicIpv4(candidate: string): boolean {
  const octets = candidate.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0 || a === 255) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

function containsLuhnCard(text: string): boolean {
  CREDIT_CARD_CANDIDATE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(CREDIT_CARD_CANDIDATE_PATTERN)) {
    const candidate = match[0];
    if (candidate !== undefined && isLuhnCard(candidate)) {
      return true;
    }
  }
  return false;
}

function isLuhnCard(candidate: string): boolean {
  const digits = candidate.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const digit = Number(digits[i]);
    if (!Number.isInteger(digit)) {
      return false;
    }
    let value = digit;
    if (doubleDigit) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function canonicalizePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    // Follow symlinks so an actor cwd reported in realpath form (e.g. /private/tmp
    // on macOS) matches a configured root still in its symlinked form (/tmp).
    // Without this, path.relative yields a "../"-prefixed path that escapes the
    // [target-cwd] label and leaks an absolute temp path into the trace.
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Label a path relative to the run's target cwd, or redact it. Returns
 * "[target-cwd]" for the root itself, "[target-cwd]/<rel>" for a descendant, and
 * a redacted form for anything outside the root or a non-absolute value.
 */
export function publicPathForTrace(value: string, rootCwd: string): string {
  if (!path.isAbsolute(value)) {
    return redactText(value);
  }

  const root = canonicalizePath(rootCwd);
  const absolute = canonicalizePath(value);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (relative === "") {
    return "[target-cwd]";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `[target-cwd]/${relative}`;
  }
  return redactText(value);
}

// ---------------------------------------------------------------------------
// Screenshot redaction.
//
// Computer-use lanes capture raw desktop frames that can contain secrets, PII,
// or a logged-in third-party UI. A raw frame must never reach a public artifact.
// redactScreenshot is the fail-closed primitive that gates that surface. It
// always returns a freshly re-encoded, downscaled, box-blurred thumbnail (or a
// neutral placeholder), and NEVER the source pixels. The "too coarse to read"
// invariant is enforced in code, not by defaults: the emitted width is hard-
// capped (a caller may request a SMALLER thumbnail but never a larger one), and
// the blur radius is computed internally with a floor, so neither a caller
// option nor a natively small frame can widen the output back into legibility.
// On any uncertainty (non-PNG input, an oversized or unreadable PNG, or any
// error in the resize/blur path) it falls back to an opaque placeholder, so a
// redaction failure can never leak the original frame. Threat model: inputs are
// bounded desktop-viewport frames from our own sandbox, not adversarial uploads.
// ---------------------------------------------------------------------------

const SCREENSHOT_MAX_WIDTH_DEFAULT = 96;
// Hard ceiling on the emitted thumbnail width. This, not the default, is what
// makes the output too coarse to read text off: a 1024px+ desktop frame is
// downscaled at least ~8x. A caller can only ask for something smaller.
const SCREENSHOT_MAX_WIDTH_CAP = 128;
// Reject absurd source dimensions before decode so a crafted IHDR cannot OOM the
// process before the try/catch can fall back to a placeholder.
const SCREENSHOT_MAX_SOURCE_PIXELS = 50_000_000;
const SCREENSHOT_PLACEHOLDER_GRAY = 128;
const PNG_SIGNATURE_BE = 0x89_50_4e_47;

/**
 * A redacted screenshot safe to persist to a public run bundle. `buffer` is
 * always a re-encoded thumbnail, never the source bytes.
 */
export interface RedactedScreenshot {
  /** Public-safe PNG bytes: a downscaled, blurred thumbnail or a placeholder. */
  buffer: Buffer;
  /** How the frame was redacted. Today always "blurred" ("ocr_scrubbed" is reserved). */
  mode: "blurred";
  /** Width of the emitted thumbnail (not the source). */
  width: number;
  /** Height of the emitted thumbnail (not the source). */
  height: number;
  /**
   * True when the source PNG decoded and was downscaled+blurred. False when
   * redaction fell back to a neutral placeholder (non-PNG input, decode failure,
   * or any error). `buffer` is public-safe either way.
   */
  decoded: boolean;
}

export interface RedactScreenshotOptions {
  /**
   * Longest emitted edge in pixels. Clamped to [1, 128]: a caller may request a
   * SMALLER (safer) thumbnail but never a larger one, so no call site can widen
   * the frame back into legibility. Default 96. Blur is not a caller knob: it is
   * an internal safety floor computed from the output size.
   */
  maxWidth?: number;
}

/**
 * Redact a screenshot to a public-safe thumbnail. Fail-closed: any decode or
 * processing failure yields an opaque placeholder, never the source frame.
 */
export function redactScreenshot(
  input: Buffer | Uint8Array,
  options: RedactScreenshotOptions = {}
): RedactedScreenshot {
  const maxWidth = Math.min(
    SCREENSHOT_MAX_WIDTH_CAP,
    Math.max(1, Math.floor(options.maxWidth ?? SCREENSHOT_MAX_WIDTH_DEFAULT))
  );
  try {
    const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (source.length === 0 || sourcePixelsExceedCap(source)) {
      return placeholderScreenshot(maxWidth);
    }
    const decoded = PNG.sync.read(source);
    const srcW = decoded.width;
    const srcH = decoded.height;
    if (!srcW || !srcH) {
      return placeholderScreenshot(maxWidth);
    }
    const outW = Math.max(1, Math.min(maxWidth, srcW));
    const outH = Math.max(1, Math.round((srcH * outW) / srcW));
    const small = downscaleRgba(decoded.data, srcW, srcH, outW, outH);
    const blurred = boxBlurRgba(small, outW, outH, effectiveBlurRadius(outW));
    const out = new PNG({ width: outW, height: outH });
    blurred.copy(out.data);
    return { buffer: PNG.sync.write(out), mode: "blurred", width: outW, height: outH, decoded: true };
  } catch {
    return placeholderScreenshot(maxWidth);
  }
}

// Blur enough to erase sub-thumbnail detail even on the no-downscale path (a
// natively small source where downscale alone does little). Scales with output
// width so the floor stays meaningful, never below radius 2.
function effectiveBlurRadius(outW: number): number {
  return Math.max(2, Math.round(outW / 24));
}

// Peek a PNG's declared IHDR dimensions without decoding it, and report whether
// the pixel count exceeds the cap. A too-short or non-PNG buffer returns false
// and falls through to PNG.sync.read, which throws and lands on the placeholder.
function sourcePixelsExceedCap(buf: Buffer): boolean {
  if (buf.length < 24 || buf.readUInt32BE(0) !== PNG_SIGNATURE_BE) {
    return false;
  }
  // IHDR is the first chunk: width at byte 16, height at byte 20 (big-endian).
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width * height > SCREENSHOT_MAX_SOURCE_PIXELS;
}

function placeholderScreenshot(maxWidth: number): RedactedScreenshot {
  const width = Math.max(1, Math.min(maxWidth, SCREENSHOT_MAX_WIDTH_DEFAULT));
  const height = Math.max(1, Math.round((width * 9) / 16));
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    png.data[o] = SCREENSHOT_PLACEHOLDER_GRAY;
    png.data[o + 1] = SCREENSHOT_PLACEHOLDER_GRAY;
    png.data[o + 2] = SCREENSHOT_PLACEHOLDER_GRAY;
    png.data[o + 3] = 255;
  }
  return { buffer: PNG.sync.write(png), mode: "blurred", width, height, decoded: false };
}

/** Area-average downscale of an RGBA buffer. Output is outW x outH RGBA. */
function downscaleRgba(src: Buffer, srcW: number, srcH: number, outW: number, outH: number): Buffer {
  const out = Buffer.alloc(outW * outH * 4);
  const xRatio = srcW / outW;
  const yRatio = srcH / outH;
  for (let oy = 0; oy < outH; oy += 1) {
    const sy0 = Math.floor(oy * yRatio);
    const sy1 = Math.min(srcH, Math.max(sy0 + 1, Math.floor((oy + 1) * yRatio)));
    for (let ox = 0; ox < outW; ox += 1) {
      const sx0 = Math.floor(ox * xRatio);
      const sx1 = Math.min(srcW, Math.max(sx0 + 1, Math.floor((ox + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const si = (sy * srcW + sx) * 4;
          r += src[si] ?? 0;
          g += src[si + 1] ?? 0;
          b += src[si + 2] ?? 0;
          a += src[si + 3] ?? 0;
          n += 1;
        }
      }
      const oi = (oy * outW + ox) * 4;
      out[oi] = n ? Math.round(r / n) : 0;
      out[oi + 1] = n ? Math.round(g / n) : 0;
      out[oi + 2] = n ? Math.round(b / n) : 0;
      out[oi + 3] = n ? Math.round(a / n) : 255;
    }
  }
  return out;
}

/** Separable box blur over an RGBA buffer. */
function boxBlurRgba(data: Buffer, width: number, height: number, radius: number): Buffer {
  if (radius <= 0) {
    return data;
  }
  return blurPass(blurPass(data, width, height, radius, true), width, height, radius, false);
}

// ---------------------------------------------------------------------------
// Prompt logging.
//
// Raw persona prompts can carry synthetic identity details, so they are never
// written to the event log verbatim. digestText is the single source of truth
// for the short content digest used across producers; promptForLog turns a raw
// prompt into a log-safe reference (placeholder + digest + length).
// ---------------------------------------------------------------------------

/** Stable short content digest (sha256, first 12 hex chars). */
export function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * A log-safe reference to a raw prompt: a placeholder string, a stable digest,
 * and the length. Proves which prompt was used without persisting its text.
 */
export function promptForLog(raw: string): { placeholder: string; digest: string; length: number } {
  const digest = digestText(raw);
  return { placeholder: `[persona-prompt sha256:${digest} len:${raw.length}]`, digest, length: raw.length };
}

// ---------------------------------------------------------------------------
// Injectable redaction hooks.
//
// The single redaction surface handed to every actor so no adapter reimplements
// redaction (the contract's "use the injected RedactionHooks" rule). Mirrors
// docs/architecture/actor-contract.md. redactScreenshot is async to match the
// contract (a future ocr_scrubbed mode may be async); today it wraps the
// synchronous fail-closed thumbnailer above.
// ---------------------------------------------------------------------------

export interface ScreenshotMeta {
  /** Optional smaller-only thumbnail width (clamped to the safe ceiling). */
  maxWidth?: number;
  /** Free-form label for logs (e.g. "turn-03-call-01"). Never enters the pixels. */
  label?: string;
}

export interface RedactionHooks {
  redactText(text: string): string;
  publicPath(value: string, rootCwd: string): string;
  redactScreenshot(
    buffer: Buffer | Uint8Array,
    meta?: ScreenshotMeta
  ): Promise<{ buffer: Buffer; method: "blurred" | "ocr_scrubbed" }>;
  promptForLog(raw: string): { placeholder: string; digest: string; length: number };
}

/** The default hooks wired into every actor: redaction.ts is the source of truth. */
export const defaultRedactionHooks: RedactionHooks = {
  redactText,
  publicPath: publicPathForTrace,
  async redactScreenshot(buffer, meta) {
    const result = redactScreenshot(
      buffer,
      meta?.maxWidth === undefined ? {} : { maxWidth: meta.maxWidth }
    );
    return { buffer: result.buffer, method: result.mode };
  },
  promptForLog
};

function blurPass(src: Buffer, width: number, height: number, radius: number, horizontal: boolean): Buffer {
  const out = Buffer.alloc(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = horizontal ? Math.min(width - 1, Math.max(0, x + k)) : x;
        const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + k));
        const si = (sy * width + sx) * 4;
        r += src[si] ?? 0;
        g += src[si + 1] ?? 0;
        b += src[si + 2] ?? 0;
        a += src[si + 3] ?? 0;
        n += 1;
      }
      const oi = (y * width + x) * 4;
      out[oi] = Math.round(r / n);
      out[oi + 1] = Math.round(g / n);
      out[oi + 2] = Math.round(b / n);
      out[oi + 3] = Math.round(a / n);
    }
  }
  return out;
}
