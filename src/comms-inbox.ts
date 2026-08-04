// The persona-facing INBOX SURFACE (#297, slice B): a minimal, dependency-free, high-contrast set of
// pages a computer-use persona opens to read a captured verification email and click its link — the
// last step of the off-app comms funnel (redirect → capture → drain → evidence → SURFACE).
//
// Design (research-backed, 2026-08-04): agent/CUA benchmarks hand agents either NO ui or a DELIBERATELY
// simplified inbox (MiniWoB email-inbox); nobody hands a vision agent a chrome-heavy webmail client.
// Anthropic computer-use guidance: high contrast, single column, big hit-targets, minimal state. So the
// surface is minimal SEMANTIC HTML (native <a>/<table>, black-on-white, large targets) — NOT a component
// UI (shadcn/Base UI break both the no-build ethos AND vision-agent reliability). We render the app's
// REAL captured email by default (faithful to the app-under-test — an honest signal if its email is a
// legibility mess), with a synthesized clean view one path away, plus a JSON twin for programmatic
// actors. Route shape mirrors Mailpit/Inbucket (list, message, `latest` alias, JSON with pre-extracted
// links/otp).
//
// This module is PURE + typed + tested; it consumes the already-normalized CommsMessage[] the tested
// drain/route path produces (links + codes already extracted), and emits the route→content files the
// in-sandbox catch serves statically. Raw content here is runtime-only (rendered in-sandbox, served to
// the in-sandbox browser); it is never persisted — the persisted evidence stays digest-only.

import type { CommsMessage } from "./comms-types.js";

/** [fromOrigin, toOrigin] pairs: rewrite a link/href whose origin is the app's in-sandbox origin into a
 *  lane-reachable origin, so the persona's browser can actually follow the verify link when it clicks. */
export type OriginMap = Array<[string, string]>;

export interface InboxRenderOptions {
  originMap?: OriginMap;
}

/** One served file: a route path (no leading slash) + its body + content type. The host writes each to
 *  `<servedDir>/<path>`; the catch serves `<servedDir>/<pathname>` verbatim. */
export interface InboxSurfaceFile {
  path: string;
  contentType: "text/html; charset=utf-8" | "application/json; charset=utf-8";
  body: string;
}

const VERIFY_HINT = /verify|confirm|activate|validate|magic|token|account|sign[\s-]?up/i;

/** Replace `from` with `to` everywhere it ends on an ORIGIN BOUNDARY — end-of-string or one of the URL
 *  delimiters `/ ? # " ' <space> > \`. A bare prefix replace would mangle a sibling origin that shares
 *  `from` as a numeric prefix (`:30000` vs `:3000`) or a suffix-domain (`:3000.evil`); the boundary
 *  check prevents that. Works both for a single URL and inside a blob of email HTML. */
function replaceOriginBoundary(text: string, from: string, to: string): string {
  if (!from) return text;
  let out = "";
  let i = 0;
  for (;;) {
    const idx = text.indexOf(from, i);
    if (idx === -1) return out + text.slice(i);
    const after = text.charAt(idx + from.length); // "" past end-of-string
    const atBoundary = after === "" || "/?#\"' >\\".includes(after);
    out += text.slice(i, idx) + (atBoundary ? to : from);
    i = idx + from.length;
  }
}

/** Rewrite a URL's origin per the map (origins are exact strings the harness minted). Leaves
 *  non-matching URLs — including sibling origins sharing a prefix — untouched. */
export function rewriteOrigin(url: string, originMap: OriginMap = []): string {
  let out = url;
  for (const [from, to] of originMap) out = replaceOriginBoundary(out, from, to);
  return out;
}

function safeOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).origin; } catch { return undefined; }
}

function safePort(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).port || undefined; } catch { return undefined; }
}

/**
 * Build the [internalOrigin → reachableOrigin] rewrite rows for a run. The app-under-test bakes ITS OWN
 * origin into the verify links it emails (usually its loopback serve origin); the persona reaches the
 * app at a possibly-different origin — the same loopback on the CUA route (identity, a no-op), the
 * harness-minted getHost URL on the shared-world route (where the rewrite is REQUIRED). Emits the serve
 * origin plus its loopback aliases at the serve port (127.0.0.1 / localhost / 0.0.0.0) so an app that
 * stamps `localhost` still rewrites, and — because the harness cannot infer an absolute PUBLIC base URL
 * an app was configured with — an operator-declared `linkOrigin` escape hatch, matched first. Origins
 * only (no trailing slash, no path), so replaceOriginBoundary matches on a URL boundary.
 */
export function buildOriginMap(args: { internalServeUrl?: string | undefined; reachableBaseUrl?: string | undefined; linkOrigin?: string | undefined }): OriginMap {
  const to = safeOrigin(args.reachableBaseUrl);
  if (to === undefined) return [];
  const froms: string[] = [];
  const declared = safeOrigin(args.linkOrigin);
  if (declared !== undefined) froms.push(declared); // operator-declared origin wins (matched first)
  const serve = safeOrigin(args.internalServeUrl);
  if (serve !== undefined) {
    froms.push(serve);
    const port = safePort(args.internalServeUrl);
    if (port !== undefined) for (const host of ["127.0.0.1", "localhost", "0.0.0.0"]) froms.push(`http://${host}:${port}`);
  }
  const seen = new Set<string>();
  const map: OriginMap = [];
  for (const from of froms) {
    if (from !== to && !seen.has(from)) { seen.add(from); map.push([from, to]); }
  }
  return map;
}

/** Best-guess primary call-to-action: the first verify/confirm-looking link, else the first link. */
export function pickVerifyUrl(links: string[]): string | undefined {
  return links.find((link) => VERIFY_HINT.test(link)) ?? links[0];
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Defense-in-depth stripping before rendering the app's real email HTML. The LOAD-BEARING protection is
 *  the page CSP (`script-src 'none'`, set both as a page() meta and as a catch response header), which is
 *  browser-enforced and neuters inline handlers, `javascript:` URLs, and injected <script> regardless of
 *  what this misses. This strip additionally removes elements CSP does not cover (a redirecting
 *  <meta http-equiv=refresh>, a nav-rerooting <base>) and the obvious active tags, so the two layers
 *  together stop the app-authored (untrusted) email from executing script or redirecting the surface. */
function neutralizeEmailHtml(html: string, originMap: OriginMap): string {
  let out = html
    // paired dangerous/framing elements + their content
    .replace(/<(script|style|iframe|object|embed|svg|math|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    // stray or void dangerous tags, incl. unclosed openers and redirect/reroot tags
    .replace(/<\/?(script|style|iframe|object|embed|svg|math|base|meta|link|form)\b[^>]*>/gi, "")
    // inline event handlers, whether preceded by whitespace OR a "/" attribute separator
    .replace(/[\s/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, " ")
    // javascript:/vbscript: in nav/resource attrs — quoted OR unquoted (data: is left for inline images)
    .replace(/(href|src|xlink:href|formaction|action)\s*=\s*(?:"(?:javascript|vbscript):[^"]*"|'(?:javascript|vbscript):[^']*'|(?:javascript|vbscript):[^\s>]*)/gi, '$1="#"');
  // Rewrite the app's origin inside the (now-neutralized) HTML so its own links resolve to a reachable host.
  for (const [from, to] of originMap) out = replaceOriginBoundary(out, from, to);
  return out;
}

const PAGE_CSS =
  "body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff;margin:0}" +
  "a{color:#0645ad}" +
  ".bar{padding:10px 20px;background:#f4f4f4;border-bottom:1px solid #ccc;font-size:14px}" +
  ".hdr{padding:16px 20px;border-bottom:3px solid #111}" +
  ".hdr div{margin:2px 0}.hdr b{display:inline-block;min-width:72px;color:#444;font-weight:600}" +
  ".body{padding:20px;max-width:820px}" +
  "table{border-collapse:collapse;width:100%;max-width:900px}" +
  "th,td{text-align:left;padding:12px 16px;border-bottom:1px solid #ddd;font-size:16px}" +
  "th{border-bottom:2px solid #111}" +
  "tr:hover{background:#f7f7f7}" +
  ".verify{display:inline-block;padding:16px 32px;background:#111;color:#fff;text-decoration:none;font-size:18px;font-weight:600;border-radius:6px}" +
  ".otp{font:32px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:8px;background:#f0f0f0;padding:12px 18px;display:inline-block;border-radius:6px}" +
  ".muted{color:#666;font-size:13px}";

/** The surface CSP — the browser-enforced, load-bearing protection against the app-authored email running
 *  script or hijacking navigation on the surface page. `script-src 'none'` blocks inline handlers,
 *  `javascript:` URLs, and any injected <script>; `object-src`/`frame-src 'none'` block plugins/frames;
 *  `base-uri 'none'` blocks <base> reroot. Images/styles stay permissive so the real email still renders.
 *  Set BOTH as a page() meta (covers direct render use) and as a catch response header (covers serving). */
export const INBOX_SURFACE_CSP =
  "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:";

function page(title: string, inner: string): string {
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"" + INBOX_SURFACE_CSP + "\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + esc(title) + "</title><style>" + PAGE_CSS + "</style></head><body>" +
    inner +
    "</body></html>"
  );
}

function fmtTime(ms: number): string {
  // Deterministic, dependency-free UTC stamp (avoids Date locale/timezone drift in tests + sandbox).
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function toValues(message: CommsMessage): string[] {
  return message.to.map((address) => address.value);
}

/** The inbox LIST page (semantic table; each row links to its message). */
export function renderInboxList(messages: CommsMessage[]): string {
  const rows = messages
    .map(
      (message) =>
        "<tr><td><a href=\"/inbox/" + esc(message.id) + "\">" + esc(message.subject ?? "(no subject)") + "</a></td>" +
        "<td>" + esc(message.from) + "</td>" +
        "<td>" + esc(toValues(message).join(", ")) + "</td>" +
        "<td class=\"muted\">" + esc(fmtTime(message.deliveredAt)) + "</td></tr>"
    )
    .join("");
  const body =
    "<div class=\"bar\">Inbox — " + messages.length + " message" + (messages.length === 1 ? "" : "s") + "</div>" +
    "<main class=\"body\"><table><thead><tr><th>Subject</th><th>From</th><th>To</th><th>Received</th></tr></thead>" +
    "<tbody>" + (rows || "<tr><td colspan=\"4\" class=\"muted\">No messages yet.</td></tr>") + "</tbody></table></main>";
  return page("Inbox", body);
}

/** One message, DEFAULT view: the app's real captured email in a minimal high-contrast shell. */
export function renderInboxMessage(message: CommsMessage, options: InboxRenderOptions = {}): string {
  const originMap = options.originMap ?? [];
  const realHtml = message.body ? neutralizeEmailHtml(message.body, originMap) : "";
  const fallback = realHtml.trim().length > 0 ? realHtml : "<p class=\"muted\">(this message had no HTML body)</p>";
  const body =
    "<div class=\"bar\"><a href=\"/inbox\">&larr; Inbox</a> &middot; <a href=\"/inbox/" + esc(message.id) + "/synth\">plain view</a></div>" +
    "<div class=\"hdr\"><div><b>To</b> " + esc(toValues(message).join(", ")) + "</div>" +
    "<div><b>From</b> " + esc(message.from) + "</div>" +
    "<div><b>Subject</b> " + esc(message.subject ?? "(no subject)") + "</div></div>" +
    "<main class=\"body\">" + fallback + "</main>";
  return page(message.subject ?? "Message", body);
}

/** One message, SYNTHESIZED view: a guaranteed-legible reading pane (big verify button + big OTP). The
 *  reliability fallback when the app's real email is a vision minefield; opt-in, never the default. */
export function renderInboxMessageSynth(message: CommsMessage, options: InboxRenderOptions = {}): string {
  const originMap = options.originMap ?? [];
  const verify = pickVerifyUrl(message.links);
  const verifyRewritten = verify ? rewriteOrigin(verify, originMap) : undefined;
  const otp = message.codes[0];
  const parts: string[] = [
    "<div class=\"bar\"><a href=\"/inbox\">&larr; Inbox</a> &middot; <a href=\"/inbox/" + esc(message.id) + "\">real email</a></div>",
    "<div class=\"hdr\"><div><b>From</b> " + esc(message.from) + "</div>" +
      "<div><b>To</b> " + esc(toValues(message).join(", ")) + "</div>" +
      "<div><b>Subject</b> " + esc(message.subject ?? "(no subject)") + "</div></div>",
    "<main class=\"body\" style=\"text-align:center\">"
  ];
  if (verifyRewritten) {
    parts.push("<p style=\"margin:32px 0\"><a class=\"verify\" href=\"" + esc(verifyRewritten) + "\">Verify email</a></p>");
  }
  if (otp) {
    parts.push("<p>Your code:</p><p><span class=\"otp\">" + esc(otp) + "</span></p>");
  }
  if (!verifyRewritten && !otp) {
    parts.push("<p class=\"muted\">No verification link or code was found in this message. Open the <a href=\"/inbox/" + esc(message.id) + "\">real email</a>.</p>");
  }
  parts.push("</main>");
  return page(message.subject ?? "Message", parts.join(""));
}

/** JSON projection of one message (the programmatic/CLI actor surface + the reliability backstop). Raw
 *  runtime values (served in-sandbox only); links/verifyUrl origin-rewritten so a consumer can follow. */
export function inboxMessageJson(message: CommsMessage, options: InboxRenderOptions = {}): Record<string, unknown> {
  const originMap = options.originMap ?? [];
  const links = message.links.map((link) => rewriteOrigin(link, originMap));
  const verify = pickVerifyUrl(links);
  return {
    id: message.id,
    from: message.from,
    to: toValues(message),
    subject: message.subject ?? null,
    receivedAt: message.deliveredAt,
    text: message.body,
    links,
    ...(verify === undefined ? {} : { verifyUrl: verify }),
    ...(message.codes[0] === undefined ? {} : { otp: message.codes[0] })
  };
}

function inboxListJson(messages: CommsMessage[], options: InboxRenderOptions = {}): Array<Record<string, unknown>> {
  const originMap = options.originMap ?? [];
  return messages.map((message) => {
    const verify = pickVerifyUrl(message.links.map((link) => rewriteOrigin(link, originMap)));
    return {
      id: message.id,
      from: message.from,
      to: toValues(message),
      subject: message.subject ?? null,
      receivedAt: message.deliveredAt,
      ...(verify === undefined ? {} : { verifyUrl: verify }),
      ...(message.codes[0] === undefined ? {} : { otp: message.codes[0] })
    };
  });
}

/**
 * Build every served file for the inbox surface from the normalized messages. The host writes each to
 * `<servedDir>/<path>`; the in-sandbox catch serves `<servedDir>/<pathname>`, falling back to
 * `<pathname>/index` (so a URL like `/inbox` maps to the `inbox/index` file while `/inbox/{id}` stays a
 * directory) — standard web-server index semantics that avoid a file-vs-directory path collision. The
 * URLs the persona actually sees stay clean (`/inbox`, `/inbox/{id}`, `/inbox/{id}/synth`). Content type
 * is inferred from the `/api/` prefix. Message ids are `comms-NNNN` (never `index`/`latest`), so leaf
 * filenames never collide with an id.
 */
export function buildInboxSurface(messages: CommsMessage[], options: InboxRenderOptions = {}): InboxSurfaceFile[] {
  const html = (path: string, body: string): InboxSurfaceFile => ({ path, contentType: "text/html; charset=utf-8", body });
  const json = (path: string, value: unknown): InboxSurfaceFile => ({
    path,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value, null, 2)
  });
  const files: InboxSurfaceFile[] = [
    html("inbox/index", renderInboxList(messages)),
    json("api/inbox/index", inboxListJson(messages, options))
  ];
  const latest = messages[messages.length - 1];
  for (const message of messages) {
    files.push(html("inbox/" + message.id + "/index", renderInboxMessage(message, options)));
    files.push(html("inbox/" + message.id + "/synth", renderInboxMessageSynth(message, options)));
    files.push(json("api/inbox/" + message.id, inboxMessageJson(message, options)));
  }
  if (latest) {
    files.push(html("inbox/latest/index", renderInboxMessage(latest, options)));
    files.push(html("inbox/latest/synth", renderInboxMessageSynth(latest, options)));
    files.push(json("api/inbox/latest", inboxMessageJson(latest, options)));
  }
  return files;
}
