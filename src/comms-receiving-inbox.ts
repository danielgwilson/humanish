/** Participant-local real email. Raw content stays in memory and the participant's desktop. */
import { randomUUID } from "node:crypto";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { capturedInlineImages, inlineImageData, MAX_INLINE_IMAGES, MAX_INLINE_IMAGES_BYTES } from "./comms-images.js";
import { extractLinks, extractOtpCodes } from "./comms-fake-inbox.js";
import type { E2BDesktopSandbox } from "./e2b-desktop-launch.js";
import type { ParticipantEmail, ReceivingSurface, ReceivingSurfaceFile, RenderedReceivingInbox } from "./comms-receiving-types.js";

export const RECEIVING_INBOX_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 256 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ROUTE = /^inbox(?:\.json|\/(?:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(?:\/plain|\.json)?)?$/;
const TAGS = new Set("a abbr b blockquote br caption center code col colgroup dd div dl dt em h1 h2 h3 h4 h5 h6 hr i img li ol p pre s small span strong sub sup table tbody td th thead tfoot tr u ul".split(" "));
const DROP = new Set("script style iframe frame frameset object embed svg math template noscript textarea select button input video audio source track canvas meta base link".split(" "));
const VOID = new Set(["br", "hr", "col", "img"]);
const CSS = "body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff;margin:0}a{color:#0645ad;text-underline-offset:3px}a:focus-visible{outline:3px solid #225acb;outline-offset:4px}.bar{padding:12px 20px;background:#f4f4f4;border-bottom:1px solid #ccc;font-size:14px}.bar a{display:inline-block;margin-right:20px;min-height:28px}.hdr{padding:16px 20px;border-bottom:3px solid #111;overflow-wrap:anywhere}.hdr h1{font-size:24px;line-height:1.25;margin:0 0 10px}.hdr div{margin:2px 0}.hdr b{display:inline-block;min-width:70px;color:#444}.body{padding:20px;max-width:860px;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%;width:100%}th,td{text-align:left;padding:12px 16px;border-bottom:1px solid #ddd;overflow-wrap:anywhere}th{border-bottom:2px solid #111}.inbox-list a{display:inline-block;min-height:32px;font-weight:600}.notice,.blocked-image{display:block;padding:12px;border:1px solid #bbb;background:#f7f7f7;color:#444;font-size:14px}.blocked-link{color:#444}.muted{color:#555;font-size:14px}.email-body{isolation:isolate}.email-body table{width:auto}.email-body img{object-fit:contain}.otp{font:28px/1.4 ui-monospace,monospace;letter-spacing:4px;background:#f0f0f0;padding:8px 12px;display:inline-block}.cta{display:inline-block;padding:12px 20px;color:white;background:#111;border-radius:6px;text-decoration:none}@media(max-width:560px){.inbox-list thead{display:none}.inbox-list,.inbox-list tbody,.inbox-list tr,.inbox-list td{display:block}.inbox-list tr{padding:10px 0;border-bottom:1px solid #ddd}.inbox-list td{border:0;padding:2px 0}.body{padding:16px}.hdr,.bar{padding:12px 16px}}";

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${RECEIVING_INBOX_CSP}"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
function origin(value: string): string | undefined {
  try { const u = new URL(value); return /^(https?:)$/.test(u.protocol) && !u.username && !u.password ? u.origin : undefined; } catch { return undefined; }
}

/** Allowlisted presentation values only. No CSS escapes, functions (except rgb), positioning or URLs. */
function safeStyle(style: string): string {
  const declarations: string[] = [];
  for (const item of style.split(";")) {
    const colon = item.indexOf(":");
    if (colon < 1) continue;
    let name = item.slice(0, colon).trim().toLowerCase();
    const value = item.slice(colon + 1).trim().toLowerCase();
    if (value.length > 120) continue;
    const color = /^(?:#[a-f0-9]{3,8}|[a-z]{3,20}|rgba?\([\d.,% ]{1,35}\))$/;
    const size = /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))(?: (?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))){0,3}$/;
    // A color-only shorthand is common on email CTAs. Dropping it while retaining white text
    // makes a working confirmation link invisible. Complex/image backgrounds remain unsupported.
    if (name === "background" && color.test(value)) name = "background-color";
    if ((["color", "background-color", "border-color"].includes(name) && color.test(value)) ||
      (["padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "margin", "margin-top", "margin-bottom", "margin-left", "margin-right", "font-size", "border-radius", "border-width", "max-width", "width", "height"].includes(name) && size.test(value)) ||
      (name === "text-align" && /^(left|right|center|justify)$/.test(value)) ||
      (name === "display" && /^(inline|inline-block|block)$/.test(value)) ||
      (name === "font-weight" && /^(normal|bold|[1-9]00)$/.test(value)) ||
      (name === "font-style" && /^(normal|italic)$/.test(value)) ||
      (name === "text-decoration" && /^(none|underline|line-through)$/.test(value)) ||
      (name === "line-height" && /^(?:[12](?:\.\d{1,2})?|normal)$/.test(value)) ||
      (name === "border-style" && /^(none|solid|dashed|dotted)$/.test(value)) ||
      (name === "font-family" && /^[a-z ,'-]{1,90}$/.test(value))) declarations.push(`${name}:${value}`);
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

/** Totals describe the whole snapshot (not increments). Register secrets BEFORE publishing files. */
export function renderReceivingInbox(options: {
  address: string;
  messages: ParticipantEmail[];
  allowedOrigins: string[];
  originMap?: Array<[string, string]>;
}): RenderedReceivingInbox {
  if (!options.address || options.address.length > 512 || options.messages.length > 100) throw new Error("Receiving inbox input exceeds limits.");
  const allowed = new Set(options.allowedOrigins.map(origin).filter((o): o is string => !!o));
  const rewrites = (options.originMap ?? []).map(([from, to]) => [origin(from), origin(to)] as const);
  const secrets = new Set<string>([options.address]);
  const allLinks = new Set<string>(), allCodes = new Set<string>();
  const ids = new Set<string>();
  let blockedAssetCount = 0, blockedLinkCount = 0;

  function link(raw: string): string | undefined {
    if (raw) secrets.add(raw);
    if (raw.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(raw)) return undefined;
    try {
      const u = new URL(raw);
      if (!/^(https?:)$/.test(u.protocol) || u.username || u.password) return undefined;
      secrets.add(u.href);
      for (const [key, value] of u.searchParams) if (/token|code|secret|password|auth|invite|verification|key/i.test(key) && value.length >= 4) secrets.add(value);
      const mapped = rewrites.find(([from, to]) => from === u.origin && to !== undefined)?.[1];
      const target = mapped ? new URL(u.pathname + u.search + u.hash, `${mapped}/`) : u;
      // Never decode paths/queries into a second navigation target or follow redirects here.
      secrets.add(target.href);
      if (!allowed.has(target.origin)) return undefined;
      return target.href;
    } catch { return undefined; }
  }
  function content(message: ParticipantEmail): Content {
    for (const value of [message.text, message.html ?? ""]) if (Buffer.byteLength(value) > MAX_MESSAGE_BYTES) throw new Error("Receiving inbox message exceeds limits.");
    if (message.from.length > 2048 || (message.subject?.length ?? 0) > 4096) throw new Error("Receiving inbox metadata exceeds limits.");
    secrets.add(message.from);
    if (message.subject) secrets.add(message.subject);
    for (const match of `${message.from}\n${message.subject ?? ""}\n${message.text}\n${message.html ?? ""}`.matchAll(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)) secrets.add(match[0]);
    const images = capturedInlineImages(message.inlineImages);
    const links = new Set<string>(), blocked = new Set<string>();
    let assets = 0, nodes = 0, displayedImages = 0, displayedImageBytes = 0;
    const parsed = parseFragment(message.html ?? "");
    const visibleText: string[] = [];
    function render(node: DefaultTreeAdapterTypes.ChildNode, depth: number): string {
      if (++nodes > 20000 || depth > 100) throw new Error("Receiving inbox HTML exceeds limits.");
      if ("value" in node) {
        visibleText.push(node.value);
        for (const match of node.value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) secrets.add(match[0]);
        return esc(node.value);
      }
      if (!("tagName" in node)) return "";
      const tag = node.tagName;
      const attrs = new Map(node.attrs.map((a) => [a.name, a.value]));
      // These strings become scrub targets even when the element is dropped.
      for (const attr of node.attrs) for (const url of extractLinks(attr.value)) secrets.add(url);
      if (attrs.get("style")?.match(/url\s*\(|@import/i)) assets++;
      for (const name of ["background", "srcset", "poster"]) if (attrs.get(name)) assets++;
      if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || DROP.has(tag)) {
        if (["iframe", "frame", "object", "embed", "source", "video", "audio", "link", "style", "svg"].includes(tag)) assets++;
        return "";
      }
      if (tag === "img") {
        const src = (attrs.get("src") ?? "").trim();
        let data: string | undefined;
        if (/^cid:/i.test(src)) {
          let cid = "";
          try { cid = decodeURIComponent(src.slice(4)).replace(/^<|>$/g, ""); } catch { /* unsupported content id */ }
          const matches = images.filter((image) => image.contentId === cid);
          if (matches.length === 1) data = inlineImageData(matches[0]!);
        } else {
          const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/i.exec(src);
          if (match) data = inlineImageData({ contentId: "inline", contentType: match[1]!.toLowerCase(), base64: match[2]! });
        }
        if (data) {
          displayedImages++; displayedImageBytes += Buffer.byteLength(data);
          if (displayedImages > MAX_INLINE_IMAGES || displayedImageBytes > Math.ceil(MAX_INLINE_IMAGES_BYTES / 3) * 4 + 1024) data = undefined;
        }
        const alt = attrs.get("alt")?.slice(0, 1024) || "Email image";
        if (!data) { assets++; return `<span class="blocked-image" role="img" aria-label="${esc(alt)}">${esc(alt)} — Image unavailable. Remote images are blocked; embedded images must be supported and within the size limit.</span>`; }
        // srcset, background and all network-bearing image attributes are deliberately absent.
        const width = /^\d{1,3}$/.test(attrs.get("width") ?? "") ? ` width="${attrs.get("width")}"` : "";
        const style = safeStyle(attrs.get("style") ?? "");
        return `<img src="${data}" alt="${esc(alt)}"${width}${style ? ` style="${esc(style)}"` : ""}>`;
      }
      const children = node.childNodes.map((child) => render(child, depth + 1)).join("");
      if (!TAGS.has(tag)) return children; // forms are unwrapped; their controls are dropped
      if (tag === "a") {
        const raw = attrs.get("href") ?? "";
        const href = link(raw.trim());
        if (!href) { if (raw) blocked.add(raw); return `<span class="blocked-link">${children} <small>(link unavailable: destination is outside this study or unsupported)</small></span>`; }
        links.add(href);
        const style = safeStyle(attrs.get("style") ?? "");
        return `<a href="${esc(href)}" rel="noreferrer noopener" referrerpolicy="no-referrer"${style ? ` style="${esc(style)}"` : ""}>${children || esc(href)}</a>`;
      }
      const style = safeStyle(attrs.get("style") ?? "");
      let safeAttrs = style ? ` style="${esc(style)}"` : "";
      for (const name of ["colspan", "rowspan"]) if ((tag === "td" || tag === "th") && /^[1-9]\d?$/.test(attrs.get(name) ?? "")) safeAttrs += ` ${name}="${attrs.get(name)}"`;
      if (tag === "td" || tag === "th") {
        const background = attrs.get("bgcolor");
        if (background && /^(#[a-f\d]{3,8}|[a-z]{3,20})$/i.test(background)) safeAttrs += ` bgcolor="${esc(background)}"`;
      }
      return `<${tag}${safeAttrs}>${children}${VOID.has(tag) ? "" : `</${tag}>`}`;
    }
    const html = parsed.childNodes.map((node) => render(node, 0)).join("");
    const text = message.text || visibleText.join(" ");
    // Ports, numeric host labels and token/query fragments are not OTP evidence. Full links and
    // token query values still enter the scrub registry through link(), independently of codes.
    const codeSource = `${message.subject ?? ""}\n${text}\n${visibleText.join(" ")}`.replace(/https?:\/\/[^\s<>"']+/gi, " ");
    const codes = extractOtpCodes(esc(codeSource));
    for (const code of codes) {
      secrets.add(code); secrets.add(code.toLowerCase()); allCodes.add(code);
      for (const match of codeSource.matchAll(new RegExp(code, "gi"))) secrets.add(match[0]);
    }
    for (const raw of extractLinks(message.html ?? "")) secrets.add(raw);
    let cursor = 0, plainHtml = "", normalizedText = "";
    // One parsing policy governs plain links, original anchors and JSON's actionable links.
    const matcher = /https?:\/\/[^\s<>"'\])]+/gi;
    for (const match of text.matchAll(matcher)) {
      const raw = match[0].replace(/[.,;!?]+$/, ""), start = match.index!;
      plainHtml += esc(text.slice(cursor, start)); normalizedText += text.slice(cursor, start);
      const href = link(raw);
      if (href) { links.add(href); plainHtml += `<a href="${esc(href)}" rel="noreferrer noopener" referrerpolicy="no-referrer">${esc(href)}</a>`; normalizedText += href; }
      else { blocked.add(raw); plainHtml += '<span class="blocked-link">[link unavailable: destination is outside this study or unsupported]</span>'; normalizedText += "[link unavailable: destination is outside this study or unsupported]"; }
      cursor = start + raw.length;
    }
    plainHtml += esc(text.slice(cursor)); normalizedText += text.slice(cursor);
    for (const href of links) allLinks.add(href);
    return { html, plainHtml, text: normalizedText, links: [...links], codes, blockedAssetCount: assets, blockedLinkCount: blocked.size };
  }

  const files: ReceivingSurfaceFile[] = [];
  let fileBytes = 0;
  const add = (path: string, body: string, json = false): void => {
    fileBytes += Buffer.byteLength(body);
    if (fileBytes > MAX_SNAPSHOT_BYTES) throw new Error("Receiving inbox snapshot exceeds limits.");
    files.push({ path, body, contentType: json ? "application/json; charset=utf-8" : "text/html; charset=utf-8" });
  };
  const rendered = options.messages.map((message) => {
    if (!ID.test(message.id) || message.id === "latest" || ids.has(message.id)) throw new Error("Receiving inbox requires unique local message IDs.");
    ids.add(message.id);
    const c = content(message);
    blockedAssetCount += c.blockedAssetCount; blockedLinkCount += c.blockedLinkCount;
    const head = `<header class="hdr"><h1>${esc(message.subject || "(no subject)")}</h1><div><b>From</b> ${esc(message.from)}</div><div><b>To</b> ${esc(options.address)}</div></header>`;
    const bar = `<nav class="bar" aria-label="Inbox navigation"><a href="/inbox">← Inbox</a><a href="/inbox/${message.id}">Original email</a><a href="/inbox/${message.id}/plain">Plain view</a></nav>`;
    const limitations = c.blockedAssetCount || c.blockedLinkCount ? '<p class="notice">Some images or links were blocked by the study’s email safety policy. This may affect how the email appears.</p>' : "";
    const original = page(message.subject || "Email", bar + head + `<main class="body">${limitations}<div class="email-body">${message.html ? c.html : `<pre>${c.plainHtml}</pre>`}</div></main>`);
    const plain = page(message.subject || "Email", bar + head + `<main class="body">${limitations}${c.links[0] ? `<p><a class="cta" href="${esc(c.links[0])}" rel="noreferrer noopener" referrerpolicy="no-referrer">Open email link</a></p>` : ""}${c.codes[0] ? `<p>Code: <span class="otp">${esc(c.codes[0])}</span></p>` : ""}<pre>${c.plainHtml}</pre></main>`);
    const json = { id: message.id, from: message.from, to: options.address, subject: message.subject ?? "", text: c.text, links: c.links, codes: c.codes, blockedAssetCount: c.blockedAssetCount, blockedLinkCount: c.blockedLinkCount };
    add(`inbox/${message.id}`, original); add(`inbox/${message.id}/plain`, plain); add(`inbox/${message.id}.json`, JSON.stringify(json), true);
    return { message, original, plain, json };
  });
  const rows = [...rendered].reverse().map(({ message }) => `<tr><td><a href="/inbox/${message.id}">${esc(message.subject || "(no subject)")}</a></td><td>${esc(message.from)}</td></tr>`).join("");
  add("inbox", page("Inbox", `<header class="hdr"><h1>Inbox</h1><div>${esc(options.address)}</div></header><main class="body"><p class="muted">Only messages delivered to your study address appear here. Reload this page to check for new mail.</p>${rows ? `<table class="inbox-list"><thead><tr><th>Subject</th><th>From</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="notice">No messages yet. Reload after the app sends an email.</p>'}</main>`));
  add("inbox.json", JSON.stringify({ address: options.address, messages: rendered.map((r) => r.json) }), true);
  const latest = rendered.at(-1);
  if (latest) { add("inbox/latest", latest.original); add("inbox/latest/plain", latest.plain); add("inbox/latest.json", JSON.stringify(latest.json), true); }
  if (Buffer.byteLength(JSON.stringify(files)) > MAX_SNAPSHOT_BYTES) throw new Error("Receiving inbox snapshot exceeds limits.");
  return { files, blockedAssetCount, blockedLinkCount, secrets: [...secrets].filter(Boolean), linkCount: allLinks.size, codeCount: allCodes.size };
}

// JSON route map, not a static directory server. Every request reads one atomic snapshot, so removed
// messages cannot remain reachable. No ingress, directory listing, aggregate inbox or provider IDs.
const SERVER = `import http.server, json, os, re, sys, socket
from pathlib import Path
root, port, nonce, csp = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
class Handler(http.server.BaseHTTPRequestHandler):
  def log_message(self, *args): pass
  def end_headers(self):
    self.send_header('Content-Security-Policy', csp)
    self.send_header('X-Content-Type-Options', 'nosniff')
    self.send_header('Referrer-Policy', 'no-referrer')
    self.send_header('Cache-Control', 'no-store')
    super().end_headers()
  def do_HEAD(self): self.respond(False)
  def do_GET(self): self.respond(True)
  def do_POST(self): self.send_error(405)
  def do_PUT(self): self.send_error(405)
  def do_DELETE(self): self.send_error(405)
  def respond(self, send_body):
    route = self.path
    if self.headers.get('Host') not in ['127.0.0.1:'+str(port), 'localhost:'+str(port)]:
      self.send_error(421); return
    if route == '/health': body, mime = nonce, 'text/plain; charset=utf-8'
    else:
      if route == '/': route = '/inbox'
      try:
        with (root / 'snapshot.json').open('r') as f: snapshot = json.load(f)
        item = snapshot.get('routes', {}).get(route)
        if item is None: self.send_error(404); return
        body, mime = item['body'], item['contentType']
      except Exception:
        self.send_error(503); return
    data = body.encode('utf-8')
    self.send_response(200)
    self.send_header('Content-Type', mime)
    self.send_header('Content-Length', str(len(data)))
    self.end_headers()
    if send_body: self.wfile.write(data)
class Server(http.server.HTTPServer):
  def get_request(self):
    connection, address = super().get_request(); connection.settimeout(2); return connection, address
server = Server(('127.0.0.1', port), Handler)
server.timeout = 0.2
(root / 'pid').write_text(str(os.getpid()))
try:
  while not (root / 'stop').exists(): server.handle_request()
finally: server.server_close()
`;

function shq(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Desktop SDK transport only; never opens a host/public listener or sends management credentials. */
export async function deployReceivingInbox(
  desktop: E2BDesktopSandbox,
  options: { leaseId: string; port?: number; requestTimeoutMs?: number }
): Promise<ReceivingSurface> {
  const port = options.port ?? 8026, timeout = options.requestTimeoutMs ?? 15000;
  if (!ID.test(options.leaseId) || !Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error("Invalid receiving inbox deployment options.");
  const nonce = randomUUID(), dir = `/tmp/humanish-mail-${options.leaseId}-${nonce}`, url = `http://127.0.0.1:${port}/inbox`;
  let stopped = false, generation = 0, tail = Promise.resolve();
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Receiving inbox transport timed out.")), timeout); })]); }
    catch { throw new Error("Receiving inbox transport failed or timed out."); }
    finally { if (timer) clearTimeout(timer); }
  }
  async function command(cmd: string): Promise<string> {
    const result = await bounded(desktop.commands.run(cmd, { requestTimeoutMs: timeout, timeoutMs: timeout }));
    if (result.exitCode !== 0) throw new Error("Receiving inbox desktop command failed.");
    return result.stdout ?? "";
  }
  const write = async (path: string, data: string): Promise<void> => { await bounded(desktop.files.write(path, data, { requestTimeoutMs: timeout })); };
  const stop = async (): Promise<void> => {
    stopped = true;
    await tail.catch(() => undefined);
    // The server owns its process lifetime. A file signal avoids PID-reuse deletion authority.
    await command(`python3 -c ${shq("import pathlib,time,sys,shutil\np=pathlib.Path(sys.argv[1])\nif not p.exists(): sys.exit(0)\n(p/'stop').touch()\nend=time.monotonic()+4\nwhile time.monotonic()<end:\n try:\n  pid=int((p/'pid').read_text()); cmd=pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes()\n except (FileNotFoundError,ProcessLookupError): break\n if str(p/'server.py').encode() not in cmd: break\n time.sleep(.1)\nelse: sys.exit(1)\nshutil.rmtree(p)\n")} ${shq(dir)}`);
  };
  try {
    await command(`mkdir -m 700 ${shq(dir)}`);
    await write(`${dir}/snapshot.json`, '{"generation":0,"routes":{}}');
    await write(`${dir}/server.py`, SERVER);
    await command(`setsid -f python3 ${shq(`${dir}/server.py`)} ${shq(dir)} ${port} ${shq(nonce)} ${shq(RECEIVING_INBOX_CSP)} < /dev/null > /dev/null 2>&1`);
    const ready = await command(`python3 -c ${shq("import sys,time,urllib.request\nend=time.monotonic()+float(sys.argv[3])\nwhile time.monotonic()<end:\n try:\n  response=urllib.request.urlopen(sys.argv[1],timeout=.5)\n  if response.read(128).decode()==sys.argv[2]: sys.exit(0)\n except Exception: pass\n time.sleep(.1)\nsys.exit(1)\n")} ${shq(`http://127.0.0.1:${port}/health`)} ${shq(nonce)} ${Math.max(0.1, timeout / 1000 - 0.2)}`);
    void ready;
  } catch {
    await stop().catch(() => undefined);
    throw new Error("Receiving inbox could not start.");
  }
  return {
    url,
    publish(files) {
      if (stopped) return Promise.reject(new Error("Receiving inbox is stopped."));
      const routes: Record<string, ReceivingSurfaceFile> = Object.create(null) as Record<string, ReceivingSurfaceFile>;
      for (const file of files) {
        if (!ROUTE.test(file.path) || routes[`/${file.path}`] || !["text/html; charset=utf-8", "application/json; charset=utf-8"].includes(file.contentType) || typeof file.body !== "string") return Promise.reject(new Error("Invalid receiving inbox snapshot."));
        routes[`/${file.path}`] = { ...file };
      }
      const snapshot = JSON.stringify({ generation: ++generation, routes });
      if (files.length > 305 || Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES) return Promise.reject(new Error("Receiving inbox snapshot exceeds limits."));
      const next = tail.then(async () => {
        if (stopped) throw new Error("Receiving inbox is stopped.");
        const temporary = `${dir}/snapshot-${randomUUID()}.json`;
        try {
          await write(temporary, snapshot);
          if (stopped) throw new Error("Receiving inbox is stopped.");
          // Monotonic generations also reject an SDK operation that completes after its caller's
          // timeout. The desktop-side lock covers read/compare/rename; transport timeouts do not.
          await command(`python3 -c ${shq("import fcntl,json,os,pathlib,sys,urllib.request\np=pathlib.Path(sys.argv[1]); pending=pathlib.Path(sys.argv[2])\nwith (p/'publish.lock').open('a') as lock:\n fcntl.flock(lock,fcntl.LOCK_EX)\n if (p/'stop').exists(): sys.exit(1)\n with pending.open() as f: new=json.load(f)\n with (p/'snapshot.json').open() as f: old=json.load(f)\n if new['generation']<=old['generation']: sys.exit(1)\n os.replace(pending,p/'snapshot.json')\nwith urllib.request.urlopen(sys.argv[3],timeout=2) as response:\n if response.read(128).decode()!=sys.argv[4]: sys.exit(1)\n")} ${shq(dir)} ${shq(temporary)} ${shq(`http://127.0.0.1:${port}/health`)} ${shq(nonce)}`);
        } finally { await command(`rm -f ${shq(temporary)}`).catch(() => undefined); }
      });
      tail = next.catch(() => undefined);
      return next;
    },
    stop
  };
}
