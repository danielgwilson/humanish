import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

import { SCREENSHOT_MAX_WIDTH_CAP, pngDecodeRefusal } from "./image.js";
import { isRecord } from "../run/type-guards.js";

// Single source of truth for public-safety redaction patterns. Producers and the verify gate
// both use these, so the denylist cannot drift between them. See docs/contracts/policy.md for
// the enforcement-scope policy.

// A whole value that stands in for a secret rather than being one, as written or percent-encoded:
// a redaction marker, a shell or template variable, a placeholder in angle brackets, or a mask of
// asterisks. A context pattern skips a value only when one of these is all of it, up to a
// character that ends that pattern's value, so a password that merely starts with `*` or `$`
// still counts.
const PLACEHOLDER = [
  String.raw`\[REDACTED_[A-Z0-9_]{1,40}\]`,
  String.raw`%5[Bb]REDACTED_[A-Z0-9_]{1,40}%5[Dd]`,
  String.raw`\$\{[A-Za-z_][A-Za-z0-9_]{0,63}\}`,
  String.raw`%24%7[Bb][A-Za-z_][A-Za-z0-9_]{0,63}%7[Dd]`,
  String.raw`\$[A-Za-z_][A-Za-z0-9_]{0,63}`,
  String.raw`%24[A-Za-z_][A-Za-z0-9_]{0,63}`,
  String.raw`\{\{[A-Za-z0-9_. -]{1,64}\}\}`,
  String.raw`<[A-Za-z0-9_. -]{1,64}>`,
  String.raw`%3[Cc][A-Za-z0-9_.-]{1,64}%3[Ee]`,
  String.raw`\*{3,64}`,
  String.raw`(?:%2[Aa]){3,64}`,
].join("|");
const notAPlaceholder = (valueEnd: string): string =>
  String.raw`(?!(?:${PLACEHOLDER})(?:${valueEnd}|$))`;

// An optional quote around a name or a value, also as JSON writes it inside other JSON strings,
// four levels deep (\", \\\", ...).
const QUOTE = String.raw`(?:\\{0,15}["'])?`;

// A JSON number, which a credential-named key can hold and redaction must not turn into a string.
// The bounds are far past any number a run writes and keep the lookahead linear.
const NOT_A_NUMBER = String.raw`(?!-?[0-9]{1,512}(?:\.[0-9]{0,512})?(?:[eE][+-]?[0-9]{1,64})?(?:[\s,}\]]|$))`;

// The characters that end each context pattern's value.
const USERINFO_END = String.raw`[\s@/?#"'<>\\]`;
const PARAMETER_END = String.raw`[\s&#"'<>\\]`;
const VARIABLE_END = String.raw`[\s"'\\,;&]`;

// Query and fragment parameters that carry a credential. `page_token` and other cursors match too;
// their values are long and opaque, so a reader cannot tell them from a credential either.
const CREDENTIAL_PARAMETER = [
  String.raw`(?:[a-z0-9]{1,24}[_-]){0,2}token`,
  String.raw`api[_-]?key`,
  String.raw`(?:client[_-])?secret`,
  "password",
  "passwd",
  "pwd",
  "sig",
  "signature",
  String.raw`session[_-]?id`,
  "jwt",
  "x-vercel-protection-bypass",
  "_vercel_share",
  String.raw`x-amz-(?:signature|security-token|credential)`,
  String.raw`x-goog-(?:signature|credential)`,
  "auth",
].join("|");

// Upper-case variable names that hold a credential, as an env file, a shell or a JSON dump writes
// them: GITHUB_TOKEN, VERCEL_TOKEN, AWS_SECRET_ACCESS_KEY, DATABASE_PASSWORD.
const CREDENTIAL_VARIABLE = String.raw`\b(?:[A-Z][A-Z0-9_]{0,48}_)?(?:TOKEN|SECRET|SECRET_KEY|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)`;

// The public E2B pages its errors link to, which name no sandbox and carry no credential: the
// dashboard as the SDK's missing-key error names it (https://e2b.dev/dashboard?tab=keys), with no
// path below /dashboard and no query but one short `tab`, and a docs page as the API's 401 names
// it (https://docs.e2b.dev/api-key), whose path segments hold only letters and hyphens and which
// has no query. Neither has user info, and only closing punctuation may follow before the next
// space or ")".
const E2B_PUBLIC_PAGE = [
  String.raw`(?:www\.)?e2b\.dev\/dashboard\/?(?:\?tab=[a-z]{1,16})?`,
  String.raw`(?:docs\.e2b\.dev|(?:www\.)?e2b\.dev\/docs)(?:\/[a-z][a-z-]{0,39}){0,8}\/?`,
].join("|");

// A pattern that matches a credential by its context puts the context in a `keep` group, which
// redaction leaves in place: `?token=[REDACTED_SECRET]`. Context goes in a group and not in a
// lookbehind, because a pattern that starts with a lookbehind is tried at every position of the
// text and scans many times slower. An open-ended repeat is written `[...]{n}[...]*`: V8 runs
// `{n,}` with a backtrack entry per character and overflows its stack on a run of several
// megabytes, and a star loop does not.
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*\b/g,
  /\be2b_[A-Za-z0-9]{16}[A-Za-z0-9]*\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20}[A-Za-z0-9_]*\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20}[A-Za-z0-9_]*\b/g,
  /\bglpat-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // Vercel personal, integration, app access, app refresh and API key tokens.
  /\bvc[pciark]_[A-Za-z0-9]{24}[A-Za-z0-9]*\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20}[0-9A-Za-z_-]*\b/g,
  /\bya29\.[0-9A-Za-z_-]{20}[0-9A-Za-z_-]*/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16}[A-Za-z0-9]*\b/g,
  /\bwhsec_[A-Za-z0-9]{24}[A-Za-z0-9]*\b/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  /\bhf_[A-Za-z0-9]{30}[A-Za-z0-9]*\b/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{20}[A-Za-z0-9-]*\b/g,
  /\bxapp-[0-9]-[A-Za-z0-9-]{20}[A-Za-z0-9-]*\b/g,
  /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{20}[A-Za-z0-9_/-]*/g,
  // A JWT starts only where a token run starts, so a run of `eyJ-` repeated is read once.
  /eyJ(?<![A-Za-z0-9_-]eyJ)[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:@/\s"'<>\\]+:[^@/\s"'<>\\]+@[^\s"'<>\\]+/g,
  /_authToken\s*=\s*[A-Za-z0-9._~+/=-]{20}[A-Za-z0-9._~+/=-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24}[A-Za-z0-9._~+/-]*\b/g,
  new RegExp(
    String.raw`(?<keep>\bAuthorization${QUOTE}[ \t]{0,4}[:=][ \t]{0,4}${QUOTE}Basic[ \t]{1,4})[A-Za-z0-9+/]{16}[A-Za-z0-9+/]*={0,2}`,
    "gi",
  ),
  // The password in a URL's userinfo, any scheme, with or without a user name:
  // https://user:password@host, https://:password@host.
  new RegExp(
    String.raw`(?<keep>\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/?#"'<>\\[\]]{0,256}:)${notAPlaceholder(USERINFO_END)}[^\s@/?#"'<>\\]{1,256}(?=@)`,
    "gi",
  ),
  // A credential-named query or fragment parameter's value, up to the next delimiter, so a
  // password with punctuation in it counts whole. `;` also follows an HTML `&amp;`.
  new RegExp(
    String.raw`(?<keep>[?&#;](?:${CREDENTIAL_PARAMETER})=)${notAPlaceholder(PARAMETER_END)}[^\s&#"'<>\\]{16}[^\s&#"'<>\\]*`,
    "gi",
  ),
  // An Amazon Web Services secret access key next to its name, as a credentials file, an env
  // line or a temporary-credentials JSON response writes it. The key is 40 characters, no prefix.
  new RegExp(
    String.raw`(?<keep>\b(?:aws_?)?secret_?access_?key${QUOTE}[ \t]{0,4}[:=][ \t]{0,4}${QUOTE})${NOT_A_NUMBER}[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])`,
    "gi",
  ),
  // A credential-named variable set to a value of 16 characters or more, up to the next space,
  // quote or separator, with a digit and a letter in its first 256 characters. Words, placeholders
  // such as humanish-egress-auth-placeholder and JSON numbers do not count. The lookaheads are
  // bounded, so a long run of `TOKEN=` costs linear time.
  new RegExp(
    String.raw`(?<keep>${CREDENTIAL_VARIABLE}${QUOTE}[ \t]{0,4}[:=][ \t]{0,4}${QUOTE})${notAPlaceholder(VARIABLE_END)}${NOT_A_NUMBER}(?=[^\s"'\\,;&]{0,255}[0-9])(?=[^\s"'\\,;&]{0,255}[A-Za-z])[^\s"'\\,;&]{16}[^\s"'\\,;&]*`,
    "g",
  ),
  // Any URL on an E2B host: a sandbox host names its sandbox, and a stream URL carries its auth
  // key. User info runs to its `@` and may hold any character but a slash or space. The host part
  // stops at a backslash, quote or angle bracket, so a URL followed by an escaped line break and an
  // `E2B_...` variable in JSON text is not read as an E2B host.
  new RegExp(
    String.raw`(?!https:\/\/(?:${E2B_PUBLIC_PAGE})[.,;:!?'"]*(?:[)\s]|$))https?:\/\/(?:[^/\s@]*@)?[^/\s\\"'<>@]*e2b[^)\s]+`,
    "gi",
  ),
  /BEGIN (RSA|OPENSSH|PRIVATE) KEY/gi,
];

const LOCAL_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/\/private\/var\/folders\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/var\/folders\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/private\/tmp\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/tmp\/[^\s"'`<>)]*/g, "[REDACTED_LOCAL_PATH]"],
  [/\/Users\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g, "[REDACTED_LOCAL_PATH]"],
  [/\/home\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g, "[REDACTED_RUNTIME_PATH]"],
  // A Windows profile path, with `\`, `\\` (JSON-escaped) or `/` between segments. A match never
  // ends in a backslash, so it cannot swallow the escape of a closing quote.
  [
    /\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[^\\/\s"'`<>)]+[^\s"'`<>)]*/g,
    "[REDACTED_LOCAL_PATH]",
  ],
];

/** Every pattern containsSensitive tests. A test pins each to ASCII, which scanEncodedText relies on. */
export function sensitivePatterns(): readonly RegExp[] {
  return [...SECRET_PATTERNS, ...LOCAL_PATH_PATTERNS.map(([pattern]) => pattern)];
}

// Sticky/global regexes carry lastIndex state across .test() calls. Always reset
// before a detection test so the shared singletons are safe to reuse.
function matchesPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** True if the text contains a secret-shaped token. Local paths do not count. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => matchesPattern(pattern, text));
}

/** True if the text contains any secret-shaped token or known local path. */
export function containsSensitive(text: string): boolean {
  return (
    containsSecret(text) || LOCAL_PATH_PATTERNS.some(([pattern]) => matchesPattern(pattern, text))
  );
}

// A local-path match may end in the backslashes escaping its closing quote in
// serialized JSON (including JSON nested inside a terminal event). Keep that
// suffix so redaction cannot turn a string's contents into JSON delimiters.
// This also works when the closing quote arrives in a later stream callback.
function redactLocalPaths(text: string, label?: string): string {
  return LOCAL_PATH_PATTERNS.reduce(
    (current, [pattern, replacement]) =>
      current.replace(
        pattern,
        (match: string) => (label ?? replacement) + (match.match(/\\+$/)?.[0] ?? ""),
      ),
    text,
  );
}

/**
 * What a shared copy of a run says in place of a provider sandbox id. scripts/public-surface-scan.mjs
 * passes only this value at a sandbox-id key.
 */
export const REDACTED_SANDBOX_ID = "[redacted-sandbox-id]";

/** The keys run writers put a sandbox id under; resource entries hold one as `id`. */
const SANDBOX_ID_KEYS = new Set(["sandboxId", "subjectSandboxId"]);

/** Arrays of sandbox records: run.json's `providerResources` and cleanup.json's `resources`. */
const RESOURCE_ARRAY_KEYS = new Set(["providerResources", "resources"]);

/** A sandbox id's public stand-in: its digest matches a receipt without naming the sandbox. */
export function sandboxIdDigest(id: string): string {
  return digestText(id, 16);
}

/** The digest field written beside a redacted id: `idDigest`, `sandboxIdDigest`, … */
const digestKey = (key: string): string => `${key}Digest`;

/**
 * The entries of `object` with each raw id at one of `keys` replaced by REDACTED_SANDBOX_ID and its
 * digest written beside it, unless the object already records one.
 */
function redactIdEntries(object: object, keys: ReadonlySet<string>): [string, unknown][] {
  const entries = Object.entries(object);
  const present = new Set(entries.map(([key]) => key));
  return entries.flatMap(([key, child]): [string, unknown][] => {
    if (!keys.has(key) || typeof child !== "string" || child === REDACTED_SANDBOX_ID)
      return [[key, child]];
    // A label that a text scrub left at the key already carries the id's digest.
    const digest = SANDBOX_ID_LABEL.exec(child)?.[1] ?? sandboxIdDigest(child);
    return [
      [key, REDACTED_SANDBOX_ID],
      ...(present.has(digestKey(key)) ? [] : [[digestKey(key), digest] as [string, unknown]]),
    ];
  });
}

/** How free text names a sandbox: the marker with the id's digest inside it. */
const SANDBOX_ID_LABEL = /^\[redacted-sandbox-id ([0-9a-f]{16})\]$/;

const RESOURCE_ID_KEYS = new Set(["id"]);

/** A raw id at a sandbox-id key: neither the marker nor a label that names its digest. */
const isRawSandboxId = (value: unknown): value is string =>
  typeof value === "string" && value !== REDACTED_SANDBOX_ID && !SANDBOX_ID_LABEL.test(value);

/** The raw ids at the keys redactSandboxIds replaces, anywhere in `value`. */
export function collectSandboxIds(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSandboxIds(item, into);
    return into;
  }
  if (value === null || typeof value !== "object") return into;
  for (const [key, child] of Object.entries(value)) {
    if (SANDBOX_ID_KEYS.has(key) && isRawSandboxId(child)) into.add(child);
    if (RESOURCE_ARRAY_KEYS.has(key) && Array.isArray(child))
      for (const resource of child) {
        const id: unknown =
          resource !== null && typeof resource === "object" ? Reflect.get(resource, "id") : null;
        if (isRawSandboxId(id)) into.add(id);
      }
    collectSandboxIds(child, into);
  }
  return into;
}

/**
 * `value` with every sandbox id replaced by REDACTED_SANDBOX_ID plus its digest: strings at
 * `sandboxId` and `subjectSandboxId`, and the `id` of each `providerResources` or `resources` entry. Raw ids live
 * only in a run's sandbox-receipts.ndjson; every record and output names a sandbox by digest.
 */
export function redactSandboxIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(redactSandboxIds);
    return items.every((item, index) => item === value[index]) ? value : items;
  }
  if (value === null || typeof value !== "object") return value;
  // fromEntries keeps a key such as __proto__ an own property, as JSON.parse made it.
  const entries = redactIdEntries(value, SANDBOX_ID_KEYS).map(([key, child]): [string, unknown] => {
    if (RESOURCE_ARRAY_KEYS.has(key) && Array.isArray(child))
      return [
        key,
        child.map((resource: unknown) =>
          resource !== null && typeof resource === "object" && !Array.isArray(resource)
            ? Object.fromEntries(
                redactIdEntries(redactSandboxIds(resource) as object, RESOURCE_ID_KEYS),
              )
            : redactSandboxIds(resource),
        ),
      ];
    return [key, redactSandboxIds(child)];
  });
  const changed =
    entries.length !== Object.keys(value).length ||
    entries.some(([key, child]) => child !== (value as Record<string, unknown>)[key]);
  return changed ? Object.fromEntries(entries) : value;
}

/** Each secret replaced by [REDACTED_SECRET], with the context a pattern keeps left in place. */
function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, (...args: unknown[]) => {
        const groups = args.at(-1);
        const keep = isRecord(groups) && typeof groups.keep === "string" ? groups.keep : "";
        return `${keep}[REDACTED_SECRET]`;
      }),
    text,
  );
}

/** Redact secrets to [REDACTED_SECRET] and local paths to their path labels. */
export function redactText(text: string): string {
  return redactLocalPaths(redactSecrets(text));
}

/** Redact every sensitive match (secrets and paths) to a single [REDACTED_SECRET] label. */
export function redactToSecretLabel(text: string): string {
  return redactLocalPaths(redactSecrets(text), "[REDACTED_SECRET]");
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
// Computer-use participants capture raw desktop frames that can contain secrets, PII,
// or a logged-in third-party UI. A raw frame must never reach a public artifact.
// redactScreenshot is the fail-closed primitive that gates that surface. It
// always returns a freshly re-encoded, downscaled, box-blurred thumbnail (or a
// neutral placeholder), and never the source pixels. The "too coarse to read"
// invariant is enforced in code, not by defaults: the emitted width is hard-
// capped (a caller may request a smaller thumbnail but never a larger one), and
// the blur radius is computed internally with a floor, so neither a caller
// option nor a natively small frame can widen the output back into legibility.
// On any uncertainty (non-PNG input, an oversized or unreadable PNG, or any
// error in the resize/blur path) it falls back to an opaque placeholder, so a
// redaction failure can never leak the original frame. Threat model: inputs are
// bounded desktop-viewport frames from our own sandbox, not adversarial uploads.
// ---------------------------------------------------------------------------

const SCREENSHOT_MAX_WIDTH_DEFAULT = 96;
// SCREENSHOT_MAX_WIDTH_CAP (image.ts) is the hard ceiling on the emitted thumbnail width. It, not
// the default, is what makes the output too coarse to read text off: a 1024px+ desktop frame is
// downscaled at least ~8x. A caller can only ask for something smaller.
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
  /**
   * Longest emitted edge in pixels. Clamped to [1, 128]: a caller may request a
   * smaller (safer) thumbnail but never a larger one, so no call site can widen
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
  options: RedactScreenshotOptions = {},
): RedactedScreenshot {
  const maxWidth = Math.min(
    SCREENSHOT_MAX_WIDTH_CAP,
    Math.max(1, Math.floor(options.maxWidth ?? SCREENSHOT_MAX_WIDTH_DEFAULT)),
  );
  try {
    const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
    // The same pre-decode refusal as verify: an unchecked IHDR or an interlaced image can make
    // the decoder allocate gigabytes, and export redacts frames from bundles on disk.
    if (source.length === 0 || pngDecodeRefusal(source) !== null) {
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
    return {
      buffer: PNG.sync.write(out),
      mode: "blurred",
      width: outW,
      height: outH,
      decoded: true,
    };
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
// the pixel count exceeds the cap, so a crafted IHDR cannot OOM the process before
// the try/catch can fall back to a placeholder. A too-short or non-PNG buffer
// returns false and falls through to PNG.sync.read, which throws and lands on the
// placeholder.
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
function downscaleRgba(
  src: Buffer,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): Buffer {
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

/** Stable short content digest (sha256 hex, first `length` chars; default 12). */
export function digestText(text: string, length = 12): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/** Last `maxChars` of a string (the whole string when shorter). No redaction. */
export function tailText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

/**
 * A redacted, ellipsis-prefixed tail of captured output for a (public-bound)
 * message field. Pattern-redacts the full text before truncating: slicing a tail
 * first could cut through a secret's prefix (e.g. drop "sk-proj-") and defeat the
 * pattern matcher on the remainder. Callers should literal-scrub known
 * provisioned values first; this is the pattern pass. Empty output -> "(no output)".
 */
export function redactedTail(text: string, maxChars: number): string {
  const trimmed = redactText(text).trim();
  return trimmed.length > maxChars ? `…${trimmed.slice(-maxChars)}` : trimmed || "(no output)";
}

/** How much of a failing step's output rides its (redacted) error message. */
const FAILURE_TAIL_CHARS = 2000;

/**
 * The redacted tail of a failing step's output for its error message. Callers literal-scrub
 * known provisioned values first. The in-sandbox `tail -c` upstream already caps the log, so
 * nothing before it can be redacted here.
 */
export function failureTail(text: string): string {
  return redactedTail(text, FAILURE_TAIL_CHARS);
}

/**
 * A log-safe reference to a raw prompt: a placeholder string, a stable digest,
 * and the length. Proves which prompt was used without persisting its text.
 */
export function promptForLog(raw: string): { placeholder: string; digest: string; length: number } {
  const digest = digestText(raw);
  return {
    placeholder: `[persona-prompt sha256:${digest} len:${raw.length}]`,
    digest,
    length: raw.length,
  };
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

interface ScreenshotMeta {
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
    meta?: ScreenshotMeta,
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
      meta?.maxWidth === undefined ? {} : { maxWidth: meta.maxWidth },
    );
    return { buffer: result.buffer, method: result.mode };
  },
  promptForLog,
};

function blurPass(
  src: Buffer,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): Buffer {
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

/**
 * Replace each literal value with [REDACTED_SECRET]. For values that have no secret shape to
 * pattern-match, such as provisioned keys and subject env values. `values` is read on each call,
 * so a value registered later is scrubbed too.
 */
export function scrubLiterals(values: readonly string[]): (text: string) => string {
  return (text) =>
    values.reduce((current, value) => current.split(value).join("[REDACTED_SECRET]"), text);
}

/**
 * Coerce an unknown thrown value to its message string. Prefer this over the
 * inline `error instanceof Error ? error.message : String(error)` so error
 * stringification stays uniform. Note: this does not redact; sites that emit
 * to public-bound artifacts must run the result through `redactText` first.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
