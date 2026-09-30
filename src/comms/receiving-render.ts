/**
 * The participant's real-email inbox pages, rendered from the host's messages. Pure: it returns the
 * route files that receiving-surface.ts publishes. Raw content stays in memory and on the
 * participant's desktop.
 */
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import {
  capturedInlineImages,
  inlineImageData,
  MAX_INLINE_IMAGES,
  MAX_INLINE_IMAGES_BYTES,
} from "./images.js";
import { extractLinks, extractOtpCodes } from "./extract.js";
import type {
  ParticipantEmail,
  ReceivingSurfaceFile,
  RenderedReceivingInbox,
} from "./receiving-types.js";
import type { CommsInlineImage } from "./types.js";

export const RECEIVING_INBOX_CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 256 * 1024;
/** The most messages one snapshot renders. */
export const MAX_RECEIVING_MESSAGES = 100;
/** Three files per message, the list and its JSON, and the three `latest` aliases. */
export const MAX_SURFACE_FILES = MAX_RECEIVING_MESSAGES * 3 + 5;
/** A local message or lease id: safe as one path segment. */
export const LOCAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TAGS = new Set(
  "a abbr b blockquote br caption center code col colgroup dd div dl dt em h1 h2 h3 h4 h5 h6 hr i img li ol p pre s small span strong sub sup table tbody td th thead tfoot tr u ul".split(
    " ",
  ),
);
const DROP = new Set(
  "script style iframe frame frameset object embed svg math template noscript textarea select button input video audio source track canvas meta base link".split(
    " ",
  ),
);
const VOID = new Set(["br", "hr", "col", "img"]);
const CSS =
  "body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff;margin:0}a{color:#0645ad;text-underline-offset:3px}a:focus-visible{outline:3px solid #225acb;outline-offset:4px}.bar{padding:12px 20px;background:#f4f4f4;border-bottom:1px solid #ccc;font-size:14px}.bar a{display:inline-block;margin-right:20px;min-height:28px}.hdr{padding:16px 20px;border-bottom:3px solid #111;overflow-wrap:anywhere}.hdr h1{font-size:24px;line-height:1.25;margin:0 0 10px}.hdr div{margin:2px 0}.hdr b{display:inline-block;min-width:70px;color:#444}.body{padding:20px;max-width:860px;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%;width:100%}th,td{text-align:left;padding:12px 16px;border-bottom:1px solid #ddd;overflow-wrap:anywhere}th{border-bottom:2px solid #111}.inbox-list a{display:inline-block;min-height:32px;font-weight:600}.notice,.blocked-image{display:block;padding:12px;border:1px solid #bbb;background:#f7f7f7;color:#444;font-size:14px}.blocked-link{color:#444}.muted{color:#555;font-size:14px}.email-body{isolation:isolate}.email-body table{width:auto}.email-body img{object-fit:contain}.otp{font:28px/1.4 ui-monospace,monospace;letter-spacing:4px;background:#f0f0f0;padding:8px 12px;display:inline-block}.cta{display:inline-block;padding:12px 20px;color:white;background:#111;border-radius:6px;text-decoration:none}@media(max-width:560px){.inbox-list thead{display:none}.inbox-list,.inbox-list tbody,.inbox-list tr,.inbox-list td{display:block}.inbox-list tr{padding:10px 0;border-bottom:1px solid #ddd}.inbox-list td{border:0;padding:2px 0}.body{padding:16px}.hdr,.bar{padding:12px 16px}}";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${RECEIVING_INBOX_CSP}"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
function origin(value: string): string | undefined {
  try {
    const u = new URL(value);
    return /^(https?:)$/.test(u.protocol) && !u.username && !u.password ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Allowlisted presentation values only. No CSS escapes, functions (except rgb), positioning or URLs. */
function safeStyle(style: string): string {
  const declarations: string[] = [];
  for (const item of style.split(";")) {
    const colon = item.indexOf(":");
    if (colon < 1) continue;
    let name = item.slice(0, colon).trim().toLowerCase();
    const value = item
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (value.length > 120) continue;
    const color = /^(?:#[a-f0-9]{3,8}|[a-z]{3,20}|rgba?\([\d.,% ]{1,35}\))$/;
    const size =
      /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))(?: (?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))){0,3}$/;
    // A color-only shorthand is common on email CTAs. Dropping it while retaining white text
    // makes a working confirmation link invisible. Complex/image backgrounds remain unsupported.
    if (name === "background" && color.test(value)) name = "background-color";
    if (
      (["color", "background-color", "border-color"].includes(name) && color.test(value)) ||
      ([
        "padding",
        "padding-top",
        "padding-bottom",
        "padding-left",
        "padding-right",
        "margin",
        "margin-top",
        "margin-bottom",
        "margin-left",
        "margin-right",
        "font-size",
        "border-radius",
        "border-width",
        "max-width",
        "width",
        "height",
      ].includes(name) &&
        size.test(value)) ||
      (name === "text-align" && /^(left|right|center|justify)$/.test(value)) ||
      (name === "display" && /^(inline|inline-block|block)$/.test(value)) ||
      (name === "font-weight" && /^(normal|bold|[1-9]00)$/.test(value)) ||
      (name === "font-style" && /^(normal|italic)$/.test(value)) ||
      (name === "text-decoration" && /^(none|underline|line-through)$/.test(value)) ||
      (name === "line-height" && /^(?:[12](?:\.\d{1,2})?|normal)$/.test(value)) ||
      (name === "border-style" && /^(none|solid|dashed|dotted)$/.test(value)) ||
      (name === "font-family" && /^[a-z ,'-]{1,90}$/.test(value))
    )
      declarations.push(`${name}:${value}`);
  }
  return declarations.join(";");
}

interface Content {
  html: string;
  plainHtml: string;
  text: string;
  links: string[];
  codes: string[];
  blockedAssetCount: number;
  blockedLinkCount: number;
}

/** What one snapshot's render accumulates across its messages. */
interface InboxRender {
  allowed: Set<string>;
  rewrites: ReadonlyArray<readonly [string | undefined, string | undefined]>;
  secrets: Set<string>;
  allLinks: Set<string>;
  allCodes: Set<string>;
}

/** The sanitizer's state for one message's HTML. */
interface MessageRender {
  inbox: InboxRender;
  images: CommsInlineImage[];
  links: Set<string>;
  blocked: Set<string>;
  visibleText: string[];
  assets: number;
  nodes: number;
  displayedImages: number;
  displayedImageBytes: number;
}

type RenderedMessage = {
  message: ParticipantEmail;
  original: string;
  plain: string;
  json: Record<string, unknown>;
};

/** Totals describe the whole snapshot (not increments). Register secrets BEFORE publishing files. */
export function renderReceivingInbox(options: {
  address: string;
  messages: ParticipantEmail[];
  allowedOrigins: string[];
  originMap?: Array<[string, string]>;
}): RenderedReceivingInbox {
  if (
    !options.address ||
    options.address.length > 512 ||
    options.messages.length > MAX_RECEIVING_MESSAGES
  )
    throw new Error("Receiving inbox input exceeds limits.");
  const inbox: InboxRender = {
    allowed: new Set(options.allowedOrigins.map(origin).filter((o): o is string => !!o)),
    rewrites: (options.originMap ?? []).map(([from, to]) => [origin(from), origin(to)] as const),
    secrets: new Set<string>([options.address]),
    allLinks: new Set<string>(),
    allCodes: new Set<string>(),
  };
  const ids = new Set<string>();
  let blockedAssetCount = 0,
    blockedLinkCount = 0;

  const files: ReceivingSurfaceFile[] = [];
  let fileBytes = 0;
  const add = (path: string, body: string, json = false): void => {
    fileBytes += Buffer.byteLength(body);
    if (fileBytes > MAX_SNAPSHOT_BYTES) throw new Error("Receiving inbox snapshot exceeds limits.");
    files.push({
      path,
      body,
      contentType: json ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    });
  };
  const rendered = options.messages.map((message): RenderedMessage => {
    if (!LOCAL_ID.test(message.id) || message.id === "latest" || ids.has(message.id))
      throw new Error("Receiving inbox requires unique local message IDs.");
    ids.add(message.id);
    const c = messageContent(inbox, message);
    blockedAssetCount += c.blockedAssetCount;
    blockedLinkCount += c.blockedLinkCount;
    const { original, plain } = messagePages(options.address, message, c);
    const json = {
      id: message.id,
      from: message.from,
      to: options.address,
      subject: message.subject ?? "",
      text: c.text,
      links: c.links,
      codes: c.codes,
      blockedAssetCount: c.blockedAssetCount,
      blockedLinkCount: c.blockedLinkCount,
    };
    add(`inbox/${message.id}`, original);
    add(`inbox/${message.id}/plain`, plain);
    add(`inbox/${message.id}.json`, JSON.stringify(json), true);
    return { message, original, plain, json };
  });
  add(
    "inbox",
    inboxListPage(
      options.address,
      rendered.map(({ message }) => message),
    ),
  );
  add(
    "inbox.json",
    JSON.stringify({ address: options.address, messages: rendered.map((r) => r.json) }),
    true,
  );
  const latest = rendered.at(-1);
  if (latest) {
    add("inbox/latest", latest.original);
    add("inbox/latest/plain", latest.plain);
    add("inbox/latest.json", JSON.stringify(latest.json), true);
  }
  if (Buffer.byteLength(JSON.stringify(files)) > MAX_SNAPSHOT_BYTES)
    throw new Error("Receiving inbox snapshot exceeds limits.");
  return {
    files,
    blockedAssetCount,
    blockedLinkCount,
    secrets: [...inbox.secrets].filter(Boolean),
    linkCount: inbox.allLinks.size,
    codeCount: inbox.allCodes.size,
  };
}

/** The message list, newest first, or the empty-inbox notice. */
function inboxListPage(address: string, messages: readonly ParticipantEmail[]): string {
  const rows = [...messages]
    .reverse()
    .map(
      (message) =>
        `<tr><td><a href="/inbox/${message.id}">${esc(message.subject || "(no subject)")}</a></td><td>${esc(message.from)}</td></tr>`,
    )
    .join("");
  return page(
    "Inbox",
    `<header class="hdr"><h1>Inbox</h1><div>${esc(address)}</div></header><main class="body"><p class="muted">Only messages delivered to your study address appear here. Reload this page to check for new mail.</p>${rows ? `<table class="inbox-list"><thead><tr><th>Subject</th><th>From</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="notice">No messages yet. Reload after the app sends an email.</p>'}</main>`,
  );
}

/** One message's original and plain pages, which share its navigation bar and header. */
function messagePages(
  address: string,
  message: ParticipantEmail,
  c: Content,
): { original: string; plain: string } {
  const head = `<header class="hdr"><h1>${esc(message.subject || "(no subject)")}</h1><div><b>From</b> ${esc(message.from)}</div><div><b>To</b> ${esc(address)}</div></header>`;
  const bar = `<nav class="bar" aria-label="Inbox navigation"><a href="/inbox">← Inbox</a><a href="/inbox/${message.id}">Original email</a><a href="/inbox/${message.id}/plain">Plain view</a></nav>`;
  const limitations =
    c.blockedAssetCount || c.blockedLinkCount
      ? '<p class="notice">Some images or links were blocked by the study’s email safety policy. This may affect how the email appears.</p>'
      : "";
  const original = page(
    message.subject || "Email",
    bar +
      head +
      `<main class="body">${limitations}<div class="email-body">${message.html ? c.html : `<pre>${c.plainHtml}</pre>`}</div></main>`,
  );
  const plain = page(
    message.subject || "Email",
    bar +
      head +
      `<main class="body">${limitations}${c.links[0] ? `<p><a class="cta" href="${esc(c.links[0])}" rel="noreferrer noopener" referrerpolicy="no-referrer">Open email link</a></p>` : ""}${c.codes[0] ? `<p>Code: <span class="otp">${esc(c.codes[0])}</span></p>` : ""}<pre>${c.plainHtml}</pre></main>`,
  );
  return { original, plain };
}

/** The allowed, rewritten navigation target for a link, or undefined when it is blocked. */
function link(inbox: InboxRender, raw: string): string | undefined {
  const { secrets } = inbox;
  if (raw) secrets.add(raw);
  if (raw.length > 8192 || /[\u0000- \u007f\\]/.test(raw)) return undefined;
  try {
    const u = new URL(raw);
    if (!/^(https?:)$/.test(u.protocol) || u.username || u.password) return undefined;
    secrets.add(u.href);
    for (const [key, value] of u.searchParams)
      if (/token|code|secret|password|auth|invite|verification|key/i.test(key) && value.length >= 4)
        secrets.add(value);
    const mapped = inbox.rewrites.find(([from, to]) => from === u.origin && to !== undefined)?.[1];
    const target = mapped ? new URL(u.pathname + u.search + u.hash, `${mapped}/`) : u;
    // Never decode paths/queries into a second navigation target or follow redirects here.
    secrets.add(target.href);
    if (!inbox.allowed.has(target.origin)) return undefined;
    return target.href;
  } catch {
    return undefined;
  }
}

function messageContent(inbox: InboxRender, message: ParticipantEmail): Content {
  registerMessageSecrets(inbox, message);
  const m: MessageRender = {
    inbox,
    images: capturedInlineImages(message.inlineImages),
    links: new Set<string>(),
    blocked: new Set<string>(),
    visibleText: [],
    assets: 0,
    nodes: 0,
    displayedImages: 0,
    displayedImageBytes: 0,
  };
  const parsed = parseFragment(message.html ?? "");
  const html = parsed.childNodes.map((node) => renderNode(m, node, 0)).join("");
  const text = message.text || m.visibleText.join(" ");
  const codes = messageCodes(inbox, message, text, m.visibleText);
  for (const raw of extractLinks(message.html ?? "")) inbox.secrets.add(raw);
  const { plainHtml, normalizedText } = plainText(m, text);
  for (const href of m.links) inbox.allLinks.add(href);
  return {
    html,
    plainHtml,
    text: normalizedText,
    links: [...m.links],
    codes,
    blockedAssetCount: m.assets,
    blockedLinkCount: m.blocked.size,
  };
}

/** Checks the message limits and registers its sender, subject and every address in it. */
function registerMessageSecrets(inbox: InboxRender, message: ParticipantEmail): void {
  for (const value of [message.text, message.html ?? ""])
    if (Buffer.byteLength(value) > MAX_MESSAGE_BYTES)
      throw new Error("Receiving inbox message exceeds limits.");
  if (message.from.length > 2048 || (message.subject?.length ?? 0) > 4096)
    throw new Error("Receiving inbox metadata exceeds limits.");
  inbox.secrets.add(message.from);
  if (message.subject) inbox.secrets.add(message.subject);
  for (const match of `${message.from}\n${message.subject ?? ""}\n${message.text}\n${message.html ?? ""}`.matchAll(
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  ))
    inbox.secrets.add(match[0]);
}

function renderNode(
  m: MessageRender,
  node: DefaultTreeAdapterTypes.ChildNode,
  depth: number,
): string {
  if (++m.nodes > 20000 || depth > 100) throw new Error("Receiving inbox HTML exceeds limits.");
  if ("value" in node) {
    m.visibleText.push(node.value);
    for (const match of node.value.matchAll(/https?:\/\/[^\s"'<>]+/gi))
      m.inbox.secrets.add(match[0]);
    return esc(node.value);
  }
  if (!("tagName" in node)) return "";
  const tag = node.tagName;
  const attrs = new Map(node.attrs.map((a) => [a.name, a.value]));
  // These strings become scrub targets even when the element is dropped.
  for (const attr of node.attrs)
    for (const url of extractLinks(attr.value)) m.inbox.secrets.add(url);
  if (attrs.get("style")?.match(/url\s*\(|@import/i)) m.assets++;
  for (const name of ["background", "srcset", "poster"]) if (attrs.get(name)) m.assets++;
  if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || DROP.has(tag)) {
    if (
      [
        "iframe",
        "frame",
        "object",
        "embed",
        "source",
        "video",
        "audio",
        "link",
        "style",
        "svg",
      ].includes(tag)
    )
      m.assets++;
    return "";
  }
  if (tag === "img") return renderImage(m, attrs);
  const children = node.childNodes.map((child) => renderNode(m, child, depth + 1)).join("");
  if (!TAGS.has(tag)) return children; // forms are unwrapped; their controls are dropped
  if (tag === "a") {
    const raw = attrs.get("href") ?? "";
    const href = link(m.inbox, raw.trim());
    if (!href) {
      if (raw) m.blocked.add(raw);
      return `<span class="blocked-link">${children} <small>(link unavailable: destination is outside this study or unsupported)</small></span>`;
    }
    m.links.add(href);
    const style = safeStyle(attrs.get("style") ?? "");
    return `<a href="${esc(href)}" rel="noreferrer noopener" referrerpolicy="no-referrer"${style ? ` style="${esc(style)}"` : ""}>${children || esc(href)}</a>`;
  }
  const style = safeStyle(attrs.get("style") ?? "");
  let safeAttrs = style ? ` style="${esc(style)}"` : "";
  for (const name of ["colspan", "rowspan"])
    if ((tag === "td" || tag === "th") && /^[1-9]\d?$/.test(attrs.get(name) ?? ""))
      safeAttrs += ` ${name}="${attrs.get(name)}"`;
  if (tag === "td" || tag === "th") {
    const background = attrs.get("bgcolor");
    if (background && /^(#[a-f\d]{3,8}|[a-z]{3,20})$/i.test(background))
      safeAttrs += ` bgcolor="${esc(background)}"`;
  }
  return `<${tag}${safeAttrs}>${children}${VOID.has(tag) ? "" : `</${tag}>`}`;
}

/** An embedded image within the per-message limits, or the blocked-image notice. */
function renderImage(m: MessageRender, attrs: Map<string, string>): string {
  const src = (attrs.get("src") ?? "").trim();
  let data: string | undefined;
  if (/^cid:/i.test(src)) {
    let cid = "";
    try {
      cid = decodeURIComponent(src.slice(4)).replace(/^<|>$/g, "");
    } catch {
      /* unsupported content id */
    }
    const matches = m.images.filter((image) => image.contentId === cid);
    if (matches.length === 1) data = inlineImageData(matches[0]!);
  } else {
    const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/i.exec(src);
    if (match)
      data = inlineImageData({
        contentId: "inline",
        contentType: match[1]!.toLowerCase(),
        base64: match[2]!,
      });
  }
  if (data) {
    m.displayedImages++;
    m.displayedImageBytes += Buffer.byteLength(data);
    if (
      m.displayedImages > MAX_INLINE_IMAGES ||
      m.displayedImageBytes > Math.ceil(MAX_INLINE_IMAGES_BYTES / 3) * 4 + 1024
    )
      data = undefined;
  }
  const alt = attrs.get("alt")?.slice(0, 1024) || "Email image";
  if (!data) {
    m.assets++;
    return `<span class="blocked-image" role="img" aria-label="${esc(alt)}">${esc(alt)} — Image unavailable. Remote images are blocked; embedded images must be supported and within the size limit.</span>`;
  }
  // srcset, background and all network-bearing image attributes are deliberately absent.
  const width = /^\d{1,3}$/.test(attrs.get("width") ?? "") ? ` width="${attrs.get("width")}"` : "";
  const style = safeStyle(attrs.get("style") ?? "");
  return `<img src="${data}" alt="${esc(alt)}"${width}${style ? ` style="${esc(style)}"` : ""}>`;
}

/** The message's one-time codes, each registered as a secret in every case it appears in. */
function messageCodes(
  inbox: InboxRender,
  message: ParticipantEmail,
  text: string,
  visibleText: readonly string[],
): string[] {
  // Ports, numeric host labels and token/query fragments are not OTP evidence. Full links and
  // token query values still enter the scrub registry through link(), independently of codes.
  const codeSource = `${message.subject ?? ""}\n${text}\n${visibleText.join(" ")}`.replace(
    /https?:\/\/[^\s<>"']+/gi,
    " ",
  );
  const codes = extractOtpCodes(esc(codeSource));
  for (const code of codes) {
    inbox.secrets.add(code);
    inbox.secrets.add(code.toLowerCase());
    inbox.allCodes.add(code);
    for (const match of codeSource.matchAll(new RegExp(code, "gi"))) inbox.secrets.add(match[0]);
  }
  return codes;
}

/** The text body as escaped HTML and as JSON text, with each link allowed or replaced. */
function plainText(m: MessageRender, text: string): { plainHtml: string; normalizedText: string } {
  let cursor = 0,
    plainHtml = "",
    normalizedText = "";
  // One parsing policy governs plain links, original anchors and JSON's actionable links.
  const matcher = /https?:\/\/[^\s<>"'\])]+/gi;
  for (const match of text.matchAll(matcher)) {
    const raw = match[0].replace(/[.,;!?]+$/, ""),
      start = match.index!;
    plainHtml += esc(text.slice(cursor, start));
    normalizedText += text.slice(cursor, start);
    const href = link(m.inbox, raw);
    if (href) {
      m.links.add(href);
      plainHtml += `<a href="${esc(href)}" rel="noreferrer noopener" referrerpolicy="no-referrer">${esc(href)}</a>`;
      normalizedText += href;
    } else {
      m.blocked.add(raw);
      plainHtml +=
        '<span class="blocked-link">[link unavailable: destination is outside this study or unsupported]</span>';
      normalizedText += "[link unavailable: destination is outside this study or unsupported]";
    }
    cursor = start + raw.length;
  }
  plainHtml += esc(text.slice(cursor));
  normalizedText += text.slice(cursor);
  return { plainHtml, normalizedText };
}
