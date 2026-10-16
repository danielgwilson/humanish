import type { TracePage } from "../actors/contract.js";
import { isRecord } from "../run/type-guards.js";
import { readingsOf, redactEncodedText, scanEncodedText } from "./encoded-text.js";
import { REDACTION_MARKERS } from "./redaction.js";

// The page a computer-use observation was on, as a trace records it: the URL's origin and path,
// with no query string, fragment or user info, and any path segment that can carry a credential or
// an address withheld. See docs/contracts/schemas.md#actor-trace.

const WEB_SCHEMES = new Set(["http:", "https:"]);
// The longest path a page keeps, its truncation marker included.
const MAX_PATH = 1024;
const TRUNCATED = "[TRUNCATED]";

// A percent-encoded unreserved character (a letter, digit, `-`, `.`, `_` or `~`) or `%` itself.
// RFC 3986 section 2.3 says producers should not encode the first, and an encoded `%` is an
// encoding nested in another, so either only hides text from a literal match: the run's
// sandbox-id scrub, verify's raw-id check, a study secret's scrub.
const ENCODED_TO_HIDE = /%(?:3[0-9]|4[1-9A-F]|5[0-9AF]|6[1-9A-F]|7[0-9AE]|2[5DE])/i;

const EMAIL = /[^\s@/]@[^\s@/.]+\.[^\s@/]/;
// 16 characters is the floor redactText uses for a credential parameter's value. Each open-ended
// repeat is written `[...]{n}[...]*`, as in redaction.ts, so a megabyte path costs linear time.
const TOKEN_RUN = /[A-Za-z0-9_-]{16}[A-Za-z0-9_-]*/g;
const LETTER = /[A-Za-z]/;
const DIGIT = /[0-9]/;

/**
 * A run of 16 or more letters, digits, `-` and `_` in which some piece between separators is 8 or
 * more characters long and mixes letters and digits: UUIDs, hex digests, base64url tokens and
 * sandbox ids. A slug's pieces are words or numbers, so `how-to-build-a-thing-2024` stays.
 */
function tokenShaped(text: string): boolean {
  for (const [run] of text.matchAll(TOKEN_RUN))
    for (const piece of run.split(/[-_]/))
      if (piece.length >= 8 && LETTER.test(piece) && DIGIT.test(piece)) return true;
  return false;
}

/** A segment is withheld when any reading of it holds an address, a token or redactable text. */
function withheld(segment: string, redact: (text: string) => string): boolean {
  if (ENCODED_TO_HIDE.test(segment)) return true;
  return readingsOf(segment).some(
    (reading) => EMAIL.test(reading) || tokenShaped(reading) || redact(reading) !== reading,
  );
}

/**
 * Each withheld segment as the marker, then the trace redaction over the whole path for patterns
 * that span segments, then the cut. A path verify's trace scan would still read as sensitive or
 * opaque is withheld whole, so a page never changes a run's grade.
 */
function redactPath(pathname: string, redact: (text: string) => string): string {
  const segments = pathname
    .split("/")
    .map((segment) => (withheld(segment, redact) ? REDACTION_MARKERS.urlPart : segment));
  const redacted = redact(segments.join("/"));
  // Cut after redaction: a cut first could shorten a token below the length the rules match.
  const path =
    redacted.length > MAX_PATH
      ? `${redacted.slice(0, MAX_PATH - TRUNCATED.length)}${TRUNCATED}`
      : redacted;
  const scan = scanEncodedText(path);
  return scan.sensitive || scan.opaque ? REDACTION_MARKERS.urlPart : path;
}

/**
 * The origin with each token-shaped host label withheld, since a tunnel or preview host can be as
 * unguessable as a shared link, then through the trace redaction, which withholds a sandbox host
 * whole.
 */
function redactOrigin(url: URL, redact: (text: string) => string): string {
  if (url.hostname.startsWith("[")) return redact(url.origin);
  const host = url.hostname
    .split(".")
    .map((label) => (tokenShaped(label) ? REDACTION_MARKERS.urlPart : label))
    .join(".");
  return redact(`${url.protocol}//${host}${url.port === "" ? "" : `:${url.port}`}`);
}

/**
 * A computer-use trace's text redaction, which its narration and its pages go through: the run's
 * known-value scrub, then `redactText`, then `redactEncodedText`, then the scrub again.
 * - A value the model transcribes (a DB password it read on screen) has no shape, so `redactText`
 *   alone cannot catch it; the scrub closes that.
 * - The participant receives its instructions as written, so it can repeat a key the study wrote
 *   base64- or percent-encoded, which verify decodes; `redactEncodedText` removes that one too.
 * - The scrub runs again last: a marker written before other text can spell a known value, as
 *   `[REDACTED_SECRET] and` spells `SECRET] and`.
 */
export function traceRedaction(
  scrubText: (text: string) => string,
  redactText: (text: string) => string,
): (text: string) => string {
  return (text) => scrubText(redactEncodedText(redactText(scrubText(text))));
}

/**
 * The page of an observed URL, or undefined when there is none or the URL parser rejects it.
 * `redact` is the trace's text redaction (traceRedaction).
 */
export function tracePage(
  url: string | undefined,
  redact: (text: string) => string,
): TracePage | undefined {
  if (url === undefined) return undefined;
  const parsed = URL.parse(url);
  if (parsed === null) return undefined;
  // A non-web URL keeps its scheme only: a file: path or a data: payload never lands.
  if (!WEB_SCHEMES.has(parsed.protocol)) return { origin: parsed.protocol, path: "" };
  const origin = redactOrigin(parsed, redact);
  const path = redactPath(parsed.pathname, redact);
  // A study secret can span both parts, such as a whole invite link, which neither part holds.
  const joined = `${origin}${path}`;
  if (redact(joined) !== joined)
    return { origin: REDACTION_MARKERS.urlPart, path: REDACTION_MARKERS.urlPart };
  return { origin, path };
}

/**
 * Whether no segment of a recorded path is one tracePage withholds by its shape alone: an encoding
 * that hides text, an address or a token. A segment the run's redaction changed is the marker
 * already, and the text scan finds secret shapes. verify holds each network log record's path to
 * it, as the writer does.
 */
export function pathKeepsNoWithheldSegment(path: string): boolean {
  return path
    .split("/")
    .every(
      (segment) => segment === REDACTION_MARKERS.urlPart || !withheld(segment, (text) => text),
    );
}

// Text redaction writes into a host: a marker, or a sandbox id's label with its digest.
const WRITTEN_BY_REDACTION = new RegExp(
  [
    ...Object.values(REDACTION_MARKERS).map((marker) => marker.replace(/[[\]]/g, "\\$&")),
    "\\[redacted-sandbox-id [0-9a-f]{16}\\]",
  ].join("|"),
  "g",
);

/**
 * Whether no host label of a recorded origin is one tracePage withholds: a token-shaped label in
 * any reading, apart from the text redaction itself writes. verify holds each network log origin to it, as the
 * writer does.
 */
export function originKeepsNoWithheldLabel(origin: string): boolean {
  // An IPv6 literal is kept as the URL wrote it, and a marker origin or a scheme alone has no host.
  if (/^[a-z][a-z0-9+.-]*:\/\/\[[0-9a-f:.]*\](?::\d+)?$/i.test(origin)) return true;
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/:]*)/i.exec(origin)?.[1];
  if (host === undefined) return true;
  // Each reading, as for a path segment: an escape can split a token below the length matched.
  return host
    .split(".")
    .every((label) => !readingsOf(label.replace(WRITTEN_BY_REDACTION, ".")).some(tokenShaped));
}

// The markers that can stand for a whole origin, such as a withheld sandbox host.
const MARKERS: ReadonlySet<string> = new Set(Object.values(REDACTION_MARKERS));
// `scheme:` alone (a non-web URL) or `scheme://host[:port]`, with nothing after the host. The URL
// parser reads a backslash there as a slash, so a backslash counts as a path too.
const ORIGIN = /^[a-z][a-z0-9+.-]*:(?:\/\/[^/\\?#@]*)?$/i;

/**
 * What is wrong with a recorded page, or undefined when it holds an origin and a path only, as
 * tracePage writes one. verify applies it to each recorded page and the browser network log's
 * record check to each record's origin and path.
 */
export function pageProblem(page: unknown): string | undefined {
  if (!isRecord(page) || typeof page.origin !== "string" || typeof page.path !== "string")
    return "is not an origin and a path";
  if (/[?#]/.test(page.path)) return "has a query string or fragment in its path";
  if (!MARKERS.has(page.origin) && !ORIGIN.test(page.origin))
    return "has an origin with user info, a path, a query string or a fragment";
  return undefined;
}
