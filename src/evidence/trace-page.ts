import type { TracePage } from "../actors/contract.js";
import { readingsOf, scanEncodedText } from "./encoded-text.js";
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
 * The page of an observed URL, or undefined when there is none or the URL parser rejects it.
 * `redact` is the trace's text redaction (the run's known-value scrub, then redactText).
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
