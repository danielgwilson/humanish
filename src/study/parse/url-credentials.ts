// A URL a study declares is recorded in the run, shown in the participant's address bar and so in
// every screenshot and model request. It may not carry a credential. Ordinary query parameters,
// such as a filter or a page number, stay as they are. So does an E2B app URL in a parameter, such
// as a sign-in return address: its host names a sandbox, as the target's own host may, and holds no
// credential. verify keeps sandbox URLs out of a shared run.

import { scanEncodedText } from "../../evidence/encoded-text.js";
import { readPlainText } from "../../evidence/plain-text.js";
import { containsCredential } from "../../evidence/redaction.js";

// A relative participant entry is resolved against this before it is read.
const ENTRY_BASE = "http://127.0.0.1/";

// A URL in a decoded parameter value, the fragment or a path segment, such as a sign-in return
// address, is read as the study URL is, this many levels deep. It is parsed, so its user info and
// its own parameters keep their boundaries; a scan of the decoded text alone would read the next
// parameter of the outer URL as part of it.
const MAX_NESTED_DEPTH = 4;

// A URL inside one decoded value. It runs to the next space, as the value is one parameter's.
const NESTED_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/\S+/gi;

// A URL in text decoded from a whole value or from base64, which may join several values or be
// JSON: it runs to the next space, `&`, or character no URL may hold as written (`"`, `<`, `>`, `\`
// and a backtick), which ends a JSON string. An apostrophe may be part of user info.
const URL_IN_TEXT = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s&"<>\\`]+/gi;

// A raw `&` that ends a parameter value. One that starts an HTML character reference, such as
// `&#61;` for `=`, is part of the text around it.
const VALUE_END = /(?=&(?![a-z]+;|#))/i;

/** Whether a URL in the text, parsed, has a user name or password. */
function holdsUserInfo(text: string): boolean {
  return [...text.matchAll(URL_IN_TEXT)].some(([candidate]) => {
    try {
      const url = new URL(candidate);
      return url.username !== "" || url.password !== "";
    } catch {
      return false;
    }
  });
}

/**
 * A credential verify flags, or a URL with user info, in text as written or in any decoding, and
 * with tabs and line breaks dropped, as the URL parser drops them from a URL.
 */
function holdsCredential(text: string): boolean {
  const joined = text.replace(/[\t\n\r]/g, "");
  return containsCredential(text) || containsCredential(joined) || holdsUserInfo(joined);
}

/**
 * Why the URL declared at `field` cannot be used: it has userinfo, or its path, query or fragment
 * holds a credential verify flags, as written or encoded. Undefined for a URL with neither, and for
 * text that is not a URL, which the field's own shape check refuses. `base` resolves a relative
 * entry path.
 */
export function urlCredentialReason(
  field: string,
  value: string,
  base?: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return undefined;
  }
  // The URL parser drops tabs and line breaks, which can split a key the scan would otherwise read.
  if (/[\u0000-\u001f\u007f]/.test(value))
    return `\`${field}\` has a tab, line break or other control character in it, which the URL parser drops. Write the URL without it.`;
  if (url.username !== "" || url.password !== "")
    return `\`${field}\` has a user name or password in it. humanish records the URL in the run, and the participant's browser shows it in every screenshot, so the credential would reach the bundle and the model. Remove it from the URL and give the participant a test account to sign in with.`;
  if (urlPartsHoldCredential(value, url))
    return `\`${field}\` carries a credential in its path, query or fragment, such as a token, a signature or a preview bypass parameter. humanish records the URL in the run, and the participant's browser shows it in every screenshot. Remove it from the URL. For a protected preview, make the deployment reachable without a token for the study, or build the app in the desktop with a clone subject.`;
  return undefined;
}

/** Why the participant entry at `field` cannot be used, resolved as a path on the subject. */
export function entryCredentialReason(field: string, entry: string): string | undefined {
  return urlCredentialReason(field, entry, ENTRY_BASE);
}

/**
 * Whether the URL's path, query or fragment holds a credential: as the parser normalized it and as
 * written (`..` segments can drop a segment from the normalized path). Each is matched whole as it
 * stands, then decoded up to each raw `&`, which ends a parameter value, so a decoded value is not
 * read into the next parameter; then one segment, value or fragment piece at a time, so the text
 * around an encoded key cannot shift its decoding. A URL nested in it is read the same way.
 */
function urlPartsHoldCredential(value: string, url: URL, depth = 0): boolean {
  const written = value.replace(/^[a-z][a-z0-9+.-]{0,31}:\/\/[^/?#]*/i, "");
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  const pieces = [
    ...written.split(VALUE_END),
    ...normalized.split(VALUE_END),
    ...written.split(/[/?#&=;]/),
    ...normalized.split(/[/?#&=;]/),
  ];
  if (
    holdsCredential(written) ||
    holdsCredential(normalized) ||
    pieces.some(
      (piece) =>
        piece.length > 0 &&
        scanEncodedText(piece, { matches: holdsCredential, allowOpaqueBase64: true }).sensitive,
    )
  )
    return true;
  return (
    depth < MAX_NESTED_DEPTH &&
    nestedUrls(url).some(
      (nested) =>
        nested.url.username !== "" ||
        nested.url.password !== "" ||
        urlPartsHoldCredential(nested.text, nested.url, depth + 1),
    )
  );
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// A hex, base64 or base64url value long enough to hold a URL, such as an OAuth `state`.
const HEX_VALUE = /^(?:[0-9a-f]{2}){16}(?:[0-9a-f]{2})*$/i;
const BASE64_VALUE = /^[A-Za-z0-9+/_-]{16}[A-Za-z0-9+/_-]*={0,2}$/;

// Hex or base64 inside hex or base64 is read this many levels deep, as verify's scan reads it.
const MAX_ENCODED_DEPTH = 2;

/** The text a hex, base64 or base64url value decodes to, when it is text, and what that decodes to. */
function encodedText(value: string, depth = 1): string[] {
  const bytes = [
    ...(HEX_VALUE.test(value) ? [Buffer.from(value, "hex")] : []),
    ...(BASE64_VALUE.test(value)
      ? [Buffer.from(value, /[-_]/.test(value) ? "base64url" : "base64")]
      : []),
  ];
  const texts = bytes.flatMap((decoded) => {
    const plain = readPlainText(decoded);
    return plain.ok ? [plain.text] : [];
  });
  return depth < MAX_ENCODED_DEPTH
    ? [...texts, ...texts.flatMap((text) => encodedText(text.trim(), depth + 1))]
    : texts;
}

/**
 * The absolute URLs in `url`'s decoded parameter names and values, its fragment's and its path
 * segments, each read as decoded once and twice and from hex or base64, so an encoded URL inside an
 * encoded value is found. The fragment and the path are also read as written: a URL written there
 * whole keeps its `://`, which splitting would cut. The fragment is cut at each `&`, so a value is
 * not read into the next parameter.
 */
function nestedUrls(url: URL): { text: string; url: URL }[] {
  const fragment = url.hash.slice(1);
  // A fragment may be a route with its own query (`#/callback?next=...`) or a query itself. A
  // fragment with neither `=` nor `&` reads as one parameter name.
  const fragmentQuery = new URLSearchParams(fragment.slice(fragment.indexOf("?") + 1));
  const once = [
    ...[...url.searchParams, ...fragmentQuery].flat(),
    ...url.pathname.split("/").map(decoded),
    ...fragment.split("&"),
    url.pathname,
  ];
  const twice = once.map(decoded);
  const values = [...new Set([...once, ...twice])];
  // The URL parser drops tabs and line breaks anywhere in a URL, so they are dropped before a URL is
  // looked for: `pass<tab>word=` is read as the parser reads it.
  const parsed = (pattern: RegExp) => (text: string) =>
    [...text.replace(/[\t\n\r]/g, "").matchAll(pattern)].flatMap(([candidate]) => {
      try {
        return [{ text: candidate, url: new URL(candidate) }];
      } catch {
        return [];
      }
    });
  // A JSON value, such as an OAuth `state`, is read string by string, so a URL in one string does
  // not run into the next. Other text decoded from hex or base64 is one URL when it starts with a
  // scheme, and may be a query otherwise, so its URLs end at `&`.
  const read = (pattern: (text: string) => RegExp) => (text: string) =>
    jsonStrings(text)?.flatMap(parsed(NESTED_URL)) ?? parsed(pattern(text))(text);
  const oneUrl = (text: string): RegExp =>
    /^\s*[a-z][a-z0-9+.-]{0,31}:\/\//i.test(text) ? NESTED_URL : URL_IN_TEXT;
  return [
    ...values.flatMap(read(() => NESTED_URL)),
    ...values.flatMap((value) => encodedText(value)).flatMap(read(oneUrl)),
  ];
}

/** The strings in a JSON object or array, keys included, or undefined for text that is not one. */
function jsonStrings(text: string): string[] | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const strings: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") strings.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object")
      for (const [key, child] of Object.entries(node)) {
        strings.push(key);
        visit(child);
      }
  };
  visit(value);
  return strings;
}
