// Literal scrubbing of secret values from text that leaves the host, such as an error quoted in a
// run's warnings. A value is found as written and in the encoded forms an HTTP client, a log line or
// a JSON body gives it, so a token that reaches the text percent-encoded or base64-encoded is still
// removed. Pattern redaction (redactText) runs after this and finds secrets by shape.

import { escapeRegExp } from "../run/text.js";
import { decodeEscapes } from "./encoded-text.js";

const REDACTED = "[REDACTED_SECRET]";

/** A value as written, and percent-encoded, JSON-escaped, base64, base64url and hex. */
function encodedForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  return [
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    base64,
    base64.replace(/=+$/, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
  ];
}

/**
 * A scrub that replaces each non-empty value and its encoded forms with `[REDACTED_SECRET]`. One
 * regex holds every form, longest first, so a value that contains a shorter one is removed whole
 * and a replacement is never matched again. Text that decodeEscapes changes (the decoder verify
 * uses) is checked in its decoded form too, which finds escapes the forms above do not write, such
 * as lowercase percent-encoding or HTML references. When that form holds a value, the scrubbed
 * decoded text is returned.
 */
export function scrubSecretValues(values: readonly string[]): (text: string) => string {
  const forms = [...new Set(values.filter((value) => value.length > 0).flatMap(encodedForms))]
    .filter((form) => form.length > 0)
    .sort((left, right) => right.length - left.length);
  if (forms.length === 0) return (text) => text;
  const pattern = new RegExp(forms.map(escapeRegExp).join("|"), "g");
  const replace = (text: string): string => text.replace(pattern, REDACTED);
  return (text) => {
    const scrubbed = replace(text);
    const decoded = decodeEscapes(scrubbed);
    if (decoded === scrubbed) return scrubbed;
    const decodedScrubbed = replace(decoded);
    return decodedScrubbed === decoded ? scrubbed : decodedScrubbed;
  };
}
