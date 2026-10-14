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
// `https://host"},{"contact":"ops@e2b.dev`. From the end of its scheme to one character past
// `e2b`, that match holds no slash and no whitespace. So the only text it can carry over a cut is
// what follows a scheme with no slash or whitespace after it, and the only text it can reach is the
// next piece up to its first slash or whitespace. Each cut's junction scans exactly that.

import { isRecord } from "../run/type-guards.js";
import { containsSandboxUrl, containsSensitive } from "./redaction.js";

// The sandbox URL's scheme, `https://` or `https:\/\/` as JSON may escape it, at a text's end.
const SCHEME_AT_END = /https?:\\?\/\\?\/$/i;
const SLASH_OR_SPACE = /[/\s]/;

/**
 * containsSensitive(JSON.stringify(value)), with each element of the array `value[key]` serialized
 * and scanned on its own, so no one string holds two elements. On data as JSON.parse returns it,
 * the answer is the whole text's. Any other shape is scanned as the whole text.
 */
export function containsSensitiveJson(value: unknown, key: string): boolean {
  // JSON.stringify writes only own enumerable keys, and `around` cuts the text at this one.
  const elements = isRecord(value) && Object.keys(value).includes(key) ? value[key] : undefined;
  if (!isRecord(value) || !Array.isArray(elements) || !elements.every(isRecord))
    return wholeTextSensitive(value);
  const [prefix, suffix] = around(value, key);
  if (elements.length === 0) return containsSensitive(prefix + suffix);
  // The text since the last scheme no slash or whitespace has followed, across earlier pieces.
  let carry = "";
  for (const [index, element] of elements.entries()) {
    const own = JSON.stringify(element);
    // An object whose toJSON gives anything else would put a cut somewhere the reasoning above
    // does not cover. JSON.parse never makes one.
    if (!own.startsWith("{") || !own.endsWith("}")) return wholeTextSensitive(value);
    const piece = (index === 0 ? prefix : "") + own + (index === elements.length - 1 ? suffix : "");
    if (containsSensitive(piece)) return true;
    if (carry !== "" && containsSandboxUrl(`${carry},${head(piece)}`)) return true;
    carry = carried(carry, piece);
  }
  return false;
}

const wholeTextSensitive = (value: unknown): boolean =>
  containsSensitive(JSON.stringify(value) ?? "");

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

/** The text a sandbox URL could continue from after `piece`, given what came before it. */
function carried(carry: string, piece: string): string {
  let last = piece.length - 1;
  while (last >= 0 && !SLASH_OR_SPACE.test(piece[last]!)) last -= 1;
  if (last === -1) return carry === "" ? "" : `${carry},${piece}`;
  // `https:\/\/` is the longest scheme: ten characters ending at the slash.
  const scheme = SCHEME_AT_END.exec(piece.slice(Math.max(0, last - 9), last + 1));
  return scheme === null ? "" : piece.slice(last + 1 - scheme[0].length);
}
