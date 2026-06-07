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

// Sticky/global regexes carry lastIndex state across .test() calls. Always reset
// before a detection test so the shared singletons are safe to reuse.
function matchesPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** True if the text contains any secret-shaped token or known local path. */
export function containsSensitive(text: string): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => matchesPattern(pattern, text)) ||
    LOCAL_PATH_PATTERNS.some(([pattern]) => matchesPattern(pattern, text))
  );
}

/** Redact secrets to [REDACTED_SECRET] and local paths to their path labels. */
export function redactText(text: string): string {
  const withoutSecrets = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED_SECRET]"),
    text
  );
  return LOCAL_PATH_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    withoutSecrets
  );
}

/** Redact every sensitive match (secrets and paths) to a single [REDACTED_SECRET] label. */
export function redactToSecretLabel(text: string): string {
  const withoutSecrets = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED_SECRET]"),
    text
  );
  return LOCAL_PATH_PATTERNS.reduce(
    (current, [pattern]) => current.replace(pattern, "[REDACTED_SECRET]"),
    withoutSecrets
  );
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
// redactScreenshot is the fail-closed primitive that gates that surface: it
// always returns a freshly re-encoded, downscaled, box-blurred thumbnail (or a
// neutral placeholder), and NEVER the source pixels. Downscaling to a small max
// width destroys legible text by construction; the blur removes residual
// aliasing. On any uncertainty (non-PNG input, decode failure, or any error in
// the resize/blur path) it falls back to an opaque placeholder, so a redaction
// failure can never leak the original frame.
// ---------------------------------------------------------------------------

const SCREENSHOT_MAX_WIDTH_DEFAULT = 96;
const SCREENSHOT_BLUR_RADIUS_DEFAULT = 2;
const SCREENSHOT_PLACEHOLDER_GRAY = 128;

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
  /** Longest emitted edge in pixels. Smaller is safer and cheaper. Default 96. */
  maxWidth?: number;
  /** Box-blur radius applied at thumbnail scale. Default 2. */
  blurRadius?: number;
}

/**
 * Redact a screenshot to a public-safe thumbnail. Fail-closed: any decode or
 * processing failure yields an opaque placeholder, never the source frame.
 */
export function redactScreenshot(
  input: Buffer | Uint8Array,
  options: RedactScreenshotOptions = {}
): RedactedScreenshot {
  const maxWidth = Math.max(1, Math.floor(options.maxWidth ?? SCREENSHOT_MAX_WIDTH_DEFAULT));
  const blurRadius = Math.max(0, Math.floor(options.blurRadius ?? SCREENSHOT_BLUR_RADIUS_DEFAULT));
  try {
    const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (source.length === 0) {
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
    const blurred = boxBlurRgba(small, outW, outH, blurRadius);
    const out = new PNG({ width: outW, height: outH });
    blurred.copy(out.data);
    return { buffer: PNG.sync.write(out), mode: "blurred", width: outW, height: outH, decoded: true };
  } catch {
    return placeholderScreenshot(maxWidth);
  }
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
