// containsSensitive over a JSON document that may not fit in one string. V8's longest string is
// 536,870,888 characters on Node 24, and a run with every participant's trace loaded can pass it.
//
// The document is scanned as pieces: the text before the array and its first element, each
// element after that, and the last element with the text after the array. Every cut then falls on
// the `,` between two objects, `},{`. Most patterns stop at a quote, so a match stays inside one
// JSON string. Those that read a name and its value cross only the quotes around its `:`. A
// credential variable's unquoted value runs over brackets and braces up to a comma, so at a cut it
// stops, but after the last element it can run over the array's `]`. That is why the text after
// the array joins the last element.
//
// The sandbox URL can cross a cut. Its user info runs over quotes, braces and commas up to an `@`:
// `https://host"},{"contact":"ops@e2b-host`. From the end of its scheme to one character past
// `e2b`, that match holds no slash and no whitespace. So a match across a cut starts at a scheme
// with no slash or whitespace after it up to the cut, and reaches the next piece only up to its
// first slash or whitespace. Between that scheme and the cut, the match can only be in its user
// info. The scheme and every `@` there are inside JSON strings, so a host that starts after one
// stops at its string's closing quote. Had that host reached `e2b` first, the scan of its piece or
// an earlier junction would have matched. So the scan keeps only the scheme between pieces. Each
// cut's junction scans the scheme, `"}` in place of the text after it, the cut's `,` and the next
// piece up to its first slash or whitespace. A public E2B page after the scheme would need a space
// or the text's end before the cut, so neither text exempts the URL. The scan holds one piece at a
// time.

import { isRecord } from "../run/type-guards.js";
import { containsSandboxUrl, containsSensitive } from "./redaction.js";

// The sandbox URL's scheme, `https://` or `https:\/\/` as JSON may escape it, at a text's end.
const SCHEME_AT_END = /https?:\\?\/\\?\/$/i;
const SLASH_OR_SPACE = /[/\s]/;

/**
 * containsSensitive(JSON.stringify(value)), with each element of the array `value[key]` serialized
 * and scanned on its own, so no one string holds two elements. Only an array of plain objects is
 * scanned that way. Any other array, and a value, array or element with a toJSON or a prototype of
 * its own, is scanned as the whole text, which can be longer than one string holds. Getters and
 * proxies are not detected, so the answer is the whole text's for values as JSON.parse returns
 * them.
 */
export function containsSensitiveJson(value: unknown, key: string): boolean {
  // JSON.stringify writes only own enumerable keys, and `around` cuts the text at this one.
  const elements =
    isPlainRecord(value) && Object.keys(value).includes(key) ? value[key] : undefined;
  // Array.from reads a hole as undefined, where every would skip it.
  if (
    !isPlainRecord(value) ||
    !isPlainArray(elements) ||
    !Array.from(elements).every(isPlainRecord)
  )
    return wholeTextSensitive(value);
  const [prefix, suffix] = around(value, key);
  if (elements.length === 0) return containsSensitive(prefix + suffix);
  // The scheme of a URL no slash or whitespace has followed, from an earlier piece.
  let scheme: string | undefined;
  for (const [index, element] of elements.entries()) {
    const own = JSON.stringify(element);
    const piece = (index === 0 ? prefix : "") + own + (index === elements.length - 1 ? suffix : "");
    if (containsSensitive(piece)) return true;
    if (scheme !== undefined && containsSandboxUrl(`${scheme}"},${head(piece)}`)) return true;
    scheme = schemeAfter(scheme, piece);
  }
  return false;
}

const wholeTextSensitive = (value: unknown): boolean =>
  containsSensitive(JSON.stringify(value) ?? "");

// JSON.stringify calls a toJSON with the value's key in its parent, and an element serialized
// alone gets "" in place of its index. It writes a boxed primitive as the primitive. A plain object
// or array with no toJSON is written as its own keys or items wherever it sits.
const hasToJson = (value: object): boolean =>
  typeof (value as { toJSON?: unknown }).toJSON === "function";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || hasToJson(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const isPlainArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && !hasToJson(value);

/** The document's text before the first element of `value[key]` and after its last. */
function around(value: Record<string, unknown>, key: string): [string, string] {
  const keys = Object.keys(value);
  const at = keys.indexOf(key);
  const entries = (from: number, to?: number) =>
    Object.fromEntries(keys.slice(from, to).map((name) => [name, value[name]]));
  const before = JSON.stringify({ ...entries(0, at), [key]: [] });
  const after = JSON.stringify(entries(at + 1));
  return [before.slice(0, -"]}".length), after === "{}" ? "]}" : `],${after.slice(1)}`];
}

/** `piece` up to and including its first slash or whitespace, or all of it when it has none. */
function head(piece: string): string {
  const at = piece.search(SLASH_OR_SPACE);
  return at === -1 ? piece : piece.slice(0, at + 1);
}

/** The scheme a sandbox URL could continue from after `piece`, given the one before it. */
function schemeAfter(before: string | undefined, piece: string): string | undefined {
  let last = piece.length - 1;
  while (last >= 0 && !SLASH_OR_SPACE.test(piece[last]!)) last -= 1;
  if (last === -1) return before;
  // `https:\/\/` is the longest scheme: ten characters ending at the slash.
  return SCHEME_AT_END.exec(piece.slice(Math.max(0, last - 9), last + 1))?.[0];
}
