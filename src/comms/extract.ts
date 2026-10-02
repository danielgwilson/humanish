// Link and one-time-code extraction from a message body, shared by captured mail (fake-inbox.ts)
// and real receiving (receiving-render.ts). Pure; bodies and results are runtime-only.

/** Extract actionable http(s) links from a message body (href="…" and bare URLs), de-duped, in order.
 *  The verification magic-link the persona would tap. Pure; body is runtime-only. */
export function extractLinks(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const url = raw.trim().replace(/[).,;'"]+$/, "");
    if (/^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };
  let m: RegExpExecArray | null;
  const href = /href\s*=\s*["']([^"']+)["']/gi;
  while ((m = href.exec(body)) !== null) push(m[1] ?? "");
  const bare = /https?:\/\/[^\s"'<>)\]]+/gi;
  while ((m = bare.exec(body)) !== null) push(m[0]);
  return out.slice(0, 50);
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract OTP-shaped tokens from a message body. Labeled codes ("your code is 481920",
 *  "verification code 8A3F2K") are high-precision and preferred; if none are labeled, fall back to an
 *  isolated 4–8 digit run (a bare OTP). Pure; tokens are runtime-only literal-scrub targets. */
export function extractOtpCodes(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const text = stripTags(body);
  const labeled: string[] = [];
  const seen = new Set<string>();
  const push = (list: string[], code: string): void => {
    const c = code.toUpperCase();
    if (c && !seen.has(c)) {
      seen.add(c);
      list.push(c);
    }
  };
  // The alphanumeric alternative requires at least one digit (lookahead) so a labeled prose word like
  // `your code is INVALID` isn't captured as a code; pure-digit codes (4–8) match directly.
  const labeledRe =
    /(?:one[-\s]?time\s+(?:pass)?code|verification\s+code|security\s+code|access\s+code|login\s+code|confirmation\s+code|passcode|\bOTP\b|\bPIN\b|\bcode\b)\D{0,15}\b([0-9]{4,8}|(?=[A-Za-z0-9]*[0-9])[A-Z0-9]{6,8})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = labeledRe.exec(text)) !== null) push(labeled, m[1] ?? "");
  if (labeled.length > 0) return labeled.slice(0, 10);
  // Fallback: an isolated 4–8 digit run (a bare, unlabeled OTP), not embedded in a longer token.
  const bare: string[] = [];
  const bareRe = /(?<![0-9A-Za-z])([0-9]{4,8})(?![0-9A-Za-z])/g;
  while ((m = bareRe.exec(text)) !== null) push(bare, m[1] ?? "");
  return bare.slice(0, 10);
}
