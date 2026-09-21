import { access, readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { request } from "node:http";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it } from "vitest";
import { deployReceivingInbox, RECEIVING_INBOX_CSP, renderReceivingInbox } from "../src/comms-receiving-inbox.js";
import type { ParticipantEmail } from "../src/comms-receiving-types.js";
import { localInboxDesktop, unusedInboxPort } from "./helpers/comms-receiving-inbox-desktop.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VwAAAABJRU5ErkJggg==";
const address = "reader@example.test", app = "https://app.example.test";
function message(overrides: Partial<ParticipantEmail> = {}): ParticipantEmail {
  return { id: "message-000001", channel: "email", from: "Fictional app <sender@example.test>", subject: "Confirm your address", text: "Your code is 481920", html: '<p>Your code is <b>481920</b></p>', inlineImages: [], limitations: [], ...overrides };
}
function render(messages: ParticipantEmail[], overrides: Partial<Parameters<typeof renderReceivingInbox>[0]> = {}) {
  return renderReceivingInbox({ address, messages, allowedOrigins: [app], ...overrides });
}
function elements(html: string): DefaultTreeAdapterTypes.Element[] {
  const result: DefaultTreeAdapterTypes.Element[] = [];
  function walk(node: DefaultTreeAdapterTypes.Node): void { if ("tagName" in node) result.push(node); if ("childNodes" in node) node.childNodes.forEach(walk); }
  walk(parseFragment(html)); return result;
}

describe("real-mail participant projection", () => {
  it("has only one recipient's empty/list/message/plain/JSON/latest routes and no provider IDs", () => {
    const empty = render([]); expect(empty.files.map((f) => f.path)).toEqual(["inbox", "inbox.json"]);
    expect(empty.files[0]?.body).toContain("No messages yet");
    const projection = render([message()]);
    expect(projection.files.map((f) => f.path)).toEqual(["inbox/message-000001", "inbox/message-000001/plain", "inbox/message-000001.json", "inbox", "inbox.json", "inbox/latest", "inbox/latest/plain", "inbox/latest.json"]);
    expect(JSON.stringify(projection.files)).not.toMatch(/providerMessageId|resourceId|clientId|other@example/);
    expect(projection.secrets).toContain(address); expect(projection.secrets).toContain("481920");
    expect(projection.codeCount).toBe(1);
  });

  it("normalizes decoded HTML anchors and rewrites before allowlisting across HTML, plain and JSON", () => {
    const original = "http://localhost:3000/verify?token=test-secret&next=%2Faccount";
    const target = `${app}/verify?token=test-secret&next=%2Faccount`;
    const result = render([message({ text: `Open ${original}`, html: '<a href="http://localhost:3000/verify?token=test-secret&amp;next=%2Faccount">Verify</a>' })], { originMap: [["http://localhost:3000", app]] });
    const data = JSON.parse(result.files.find((f) => f.path === "inbox/message-000001.json")!.body);
    expect(data.links).toEqual([target]); expect(data.text).toBe(`Open ${target}`);
    expect(result.files[0]!.body).toContain(`href="${target.replaceAll("&", "&amp;")}"`);
    expect(result.secrets).toEqual(expect.arrayContaining([original, target])); expect(result.linkCount).toBe(1);
  });

  it("applies the final origin allowlist, rejects credentials and deceptive host prefixes", () => {
    const withCredentials = new URL(app); withCredentials.username = "user"; withCredentials.password = "password";
    const rejected = [`${app}.evil.test/verify`, `${app}@example.test/verify`, withCredentials.href, "javascript:alert(1)", "data:text/html,hello", "file:///tmp/secret", "//evil.test", "https:\\evil.test", "https://app.example.test\n.evil.test"];
    const result = render([message({ text: rejected.filter((u) => !u.includes("\n")).join("\n"), html: rejected.map((u) => `<a href="${u}">Continue</a>`).join("") })]);
    const email = elements(result.files[0]!.body).filter((n) => n.tagName === "a" && n.attrs.some((a) => a.name === "rel"));
    expect(email).toHaveLength(0);
    expect(JSON.parse(result.files.find((f) => f.path === "inbox/message-000001.json")!.body).links).toEqual([]);
    const rewriteOutside = render([message({ html: `<a href="${app}/ok">OK</a>` })], { originMap: [[app, "https://outside.example.test"]] });
    expect(rewriteOutside.blockedLinkCount).toBe(1);
  });

  it("drops executable/redirecting nodes and attributes using parsed HTML, including malformed markup", () => {
    const malicious = '<base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"><form action="https://evil.test"><input autofocus onfocus="alert(1)"><button>Submit</button><p>Safe content</p></form><svg><a xlink:href="javascript:alert(1)">SVG</a></svg><math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)></table></mtext></math><script>alert(1)</script><iframe src="https://evil.test"></iframe><a href="jav&#x61;script:alert(1)" ping="https://evil.test" download>Blocked</a><p onclick=alert(1) style="background-image:url(https://evil.test);position:fixed;color:#123456;padding:12px">Visible</p>';
    const output = render([message({ html: malicious })]);
    const email = elements(output.files[0]!.body).filter((n) => n.tagName !== "style" && n.tagName !== "meta");
    expect(email.some((n) => ["form", "input", "button", "svg", "math", "script", "iframe", "base"].includes(n.tagName))).toBe(false);
    for (const element of email) for (const a of element.attrs) expect(`${a.name}=${a.value}`).not.toMatch(/^on|^ping=|^download=|javascript:|url\(/i);
    expect(output.files[0]!.body).toContain("Safe content");
    expect(output.files[0]!.body).toContain("color:#123456;padding:12px");
    expect(output.files[0]!.body).not.toContain("position:fixed");
  });

  it("shows bounded validated CID rasters while blocking remote/data-SVG/missing and ambiguous images", () => {
    const result = render([message({ html: '<img src="cid:logo" alt="Logo"><img src="https://tracker.example.test/pixel" srcset="https://tracker.example.test/large 2x"><img src="cid:missing"><img src="data:image/svg+xml;base64,PHN2Zy8+">', inlineImages: [{ contentId: "logo", contentType: "image/png", base64: PNG }] })]);
    const image = elements(result.files[0]!.body).filter((n) => n.tagName === "img");
    expect(image).toHaveLength(1); expect(image[0]?.attrs.find((a) => a.name === "src")?.value).toBe(`data:image/png;base64,${PNG}`);
    expect(result.blockedAssetCount).toBe(4); expect(result.files[0]!.body).not.toContain("srcset");
    expect(result.secrets).toContain("https://tracker.example.test/pixel");
    const ambiguous = render([message({ html: '<img src="cid:logo">', inlineImages: [{ contentId: "logo", contentType: "image/png", base64: PNG }, { contentId: "logo", contentType: "image/png", base64: PNG }] })]);
    expect(ambiguous.blockedAssetCount).toBe(1);
    const repeated = render([message({ html: '<img src="cid:logo">'.repeat(20), inlineImages: [{ contentId: "logo", contentType: "image/png", base64: PNG }] })]);
    expect(repeated.blockedAssetCount).toBe(8);
  });

  it("escapes metadata, keeps forbidden plain links inert and does not expose forbidden JSON actions", () => {
    const result = render([message({ subject: '<img src=x onerror=alert(1)>', from: '<script>no</script>', text: `Your code is 8A3F2K. Go to https://evil.test/secret or ${app}/verify?token=abcd.` })]);
    const json = JSON.parse(result.files.find((f) => f.path === "inbox/message-000001.json")!.body);
    expect(json.links).toEqual([`${app}/verify?token=abcd`]); expect(json.text).not.toContain("https://evil.test");
    expect(result.files[0]?.body).toContain("&lt;script&gt;no&lt;/script&gt;");
    expect(result.secrets).toEqual(expect.arrayContaining(["https://evil.test/secret", "8A3F2K", "8a3f2k"]));
  });

  it("preserves a color-only shorthand CTA background without permitting network CSS", () => {
    const result = render([message({ html: `<a style="display:inline-block;background:#175942;color:#fff;padding:14px" href="${app}/verify">Confirm email address</a><a style="background:url(https://tracker.example.test/image);display:none" href="${app}/other">Other link</a>` })]);
    const anchors = elements(result.files[0]!.body).filter((node) => node.tagName === "a" && node.attrs.some((attr) => attr.name === "rel"));
    expect(anchors[0]?.attrs.find((attr) => attr.name === "style")?.value).toBe("display:inline-block;background-color:#175942;color:#fff;padding:14px");
    expect(anchors[1]?.attrs.some((attr) => attr.name === "style")).toBe(false);
    expect(result.blockedAssetCount).toBe(1);
  });

  it("never invents OTPs from URLs, ports, numeric hosts, path IDs or token queries", () => {
    const url = "https://3000-example.example.test:8026/123456/verify?token=481920&other=654321";
    const result = render([message({ text: `Confirm your email: ${url}`, html: `<a href="${url}">${url}</a>`, subject: "Confirm your email" })], { allowedOrigins: ["https://3000-example.example.test:8026"] });
    const data = JSON.parse(result.files.find((file) => file.path === "inbox/message-000001.json")!.body);
    expect(data.codes).toEqual([]); expect(result.codeCount).toBe(0);
    expect(result.files.find((file) => file.path.endsWith("/plain"))?.body).not.toContain('class="otp"');
    expect(result.secrets).toEqual(expect.arrayContaining([url, "481920"]));
    for (const text of [`Your code is 481920. ${url}`, `481920\n${url}`]) {
      const actual = render([message({ text, html: "" })]);
      expect(actual.codeCount).toBe(1); expect(actual.secrets).toContain("481920");
    }
  });

  it("fails closed for unsafe/duplicate IDs, excessive messages, oversized and deeply nested HTML", () => {
    for (const id of ["../another", "latest", "x.json", "x?y"]) expect(() => render([message({ id })])).toThrow("local message IDs");
    expect(() => render([message(), message()])).toThrow("local message IDs");
    expect(() => render(Array.from({ length: 101 }, (_, i) => message({ id: `message-${i}` })))).toThrow("limits");
    expect(() => render([message({ html: "x".repeat(256 * 1024 + 1) })])).toThrow("limits");
    expect(() => render([message({ html: "<div>".repeat(105) + "safe" + "</div>".repeat(105) })])).toThrow("limits");
  });
});

describe("production loopback receiving server", () => {
  it("serves only the current participant snapshot with CSP; removes stale routes, rejects ingress, cleans up", async () => {
    const local = localInboxDesktop(), other = localInboxDesktop();
    const a = await deployReceivingInbox(local.desktop, { leaseId: "participant-a", port: await unusedInboxPort() });
    const b = await deployReceivingInbox(other.desktop, { leaseId: "participant-b", port: await unusedInboxPort() });
    const dir = dirname(local.files[0]!);
    try {
      await a.publish(render([message()]).files);
      await b.publish(render([message({ id: "message-b", subject: "Only participant B sees this" })], { address: "other@example.test" }).files);
      const response = await fetch(a.url);
      expect(response.headers.get("content-security-policy")).toBe(RECEIVING_INBOX_CSP);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("participant B");
      for (const path of ["/inbox/message-b", "/inbox/for/other", "/snapshot.json", "/server.py", "/inbox/../server.py", "/inbox%2fmessage-b", "/inbox?recipient=other"]) expect((await fetch(new URL(path, a.url))).status).toBe(404);
      expect((await fetch(a.url, { method: "POST", body: "mail" })).status).toBe(405);
      const wrongHost = await new Promise<number | undefined>((resolve, reject) => { const req = request(a.url, { headers: { host: "evil.example.test" } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end(); });
      expect(wrongHost).toBe(421);
      expect((await fetch(new URL("/inbox/message-000001", b.url))).status).toBe(404);
      expect(await readFile(`${dir}/snapshot.json`, "utf8")).not.toContain("other@example.test");
      await a.publish(render([]).files);
      expect((await fetch(new URL("/inbox/message-000001", a.url))).status).toBe(404);
      expect((await fetch(new URL("/inbox/latest", a.url))).status).toBe(404);
      expect((await readdir(dir)).filter((f) => f.startsWith("snapshot"))).toEqual(["snapshot.json"]);
    } finally { await a.stop(); await b.stop(); }
    await expect(access(dir)).rejects.toThrow();
    await expect(fetch(a.url)).rejects.toThrow();
    await a.stop();
    await expect(a.publish(render([]).files)).rejects.toThrow("stopped");
  }, 20000);

  it("keeps the prior snapshot when a write fails and rejects unsafe routes before transport", async () => {
    const local = localInboxDesktop();
    const surface = await deployReceivingInbox(local.desktop, { leaseId: "publication-test", port: await unusedInboxPort() });
    try {
      await surface.publish(render([message()]).files);
      const original = local.desktop.files.write;
      local.desktop.files.write = async () => { throw new Error("private-content-canary"); };
      await expect(surface.publish(render([]).files)).rejects.toThrow("Receiving inbox transport failed");
      expect(await (await fetch(surface.url)).text()).toContain("Confirm your address");
      local.desktop.files.write = original;
      await expect(surface.publish([{ path: "../secret", body: "hello", contentType: "text/html; charset=utf-8" }])).rejects.toThrow("Invalid receiving inbox snapshot");
      await surface.publish(render([]).files);
      expect(await (await fetch(surface.url)).text()).toContain("No messages yet");
    } finally { await surface.stop(); }
  }, 10000);

  it("bounds hung transport and masks SDK messages", async () => {
    const local = localInboxDesktop();
    local.desktop.commands.run = () => new Promise(() => undefined);
    const start = Date.now();
    await expect(deployReceivingInbox(local.desktop, { leaseId: "timeout", requestTimeoutMs: 100 })).rejects.toThrow("could not start");
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
