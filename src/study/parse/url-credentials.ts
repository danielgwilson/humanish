// A URL a study declares is recorded in the run, shown in the participant's address bar and so in
// every screenshot and model request. It may not carry a credential. Ordinary query parameters,
// such as a filter or a page number, stay as they are. So does an E2B app URL in a parameter, such
// as a sign-in return address: its host names a sandbox, as the target's own host may, and holds no
// credential. verify keeps sandbox URLs out of a shared run.

import { scanEncodedText } from "../../evidence/encoded-text.js";
import { containsCredential } from "../../evidence/redaction.js";

// A relative participant entry is resolved against this before it is read.
const ENTRY_BASE = "http://127.0.0.1/";

// User info in a URL nested in a part of this one, a user name alone included, as the study URL's
// own may not have any. The share gate's user info pattern needs a password, since run text holds
// URLs such as `ssh://git@github.com`.
const NESTED_USER_INFO = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s@/?#"<>\\]{1,256}@/i;

const holdsCredential = (text: string): boolean =>
  containsCredential(text) || NESTED_USER_INFO.test(text);

// A raw `&` ends a query value. A space before each one, entity starts aside, keeps a decoded value
// from running into the next parameter, where `https://host:3000` and `&email=a@b` would read as
// user info. Credential parameter values already end at the `&`.
const separateValues = (text: string): string => text.replace(/&(?![a-z]+;|#)/gi, " &");

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
 * Whether the URL's path, query or fragment holds a credential: read whole, as the parser normalized
 * it and as written (`..` segments can drop a segment from the normalized path), and one segment,
 * value or fragment piece at a time, so the text around an encoded key cannot shift its decoding.
 */
function urlPartsHoldCredential(value: string, url: URL): boolean {
  const written = value.replace(/^[a-z][a-z0-9+.-]{0,31}:\/\/[^/?#]*/i, "");
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  const pieces = [
    separateValues(written),
    separateValues(normalized),
    ...written.split(/[/?#&=;]/),
    ...normalized.split(/[/?#&=;]/),
  ];
  return pieces.some(
    (piece) =>
      piece.length > 0 &&
      scanEncodedText(piece, { matches: holdsCredential, allowOpaqueBase64: true }).sensitive,
  );
}
