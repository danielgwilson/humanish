// Scope: actual receiving renderer + production loopback server. No provider delivery claim.
// Run with: node --import tsx scripts/comms-receiving-inbox-proof.mjs
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { deployReceivingInbox, renderReceivingInbox } from "../src/comms-receiving-inbox.ts";
import { localInboxDesktop, unusedInboxPort } from "../tests/helpers/comms-receiving-inbox-desktop.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".humanish/receiving-surface-proof", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const matrix = [
  ["Empty inbox → delivered list", "desktop + phone", "pending"],
  ["Original HTML → intact CID image and first-hop link", "desktop + phone", "pending"],
  ["Color-shorthand CTA remains visible; link-only mail has no invented OTP", "desktop + phone", "pending"],
  ["Plain / JSON → same normalized link and code", "desktop + phone", "pending"],
  ["Malicious markup / remote image / disallowed link", "desktop + phone", "pending"],
  ["Other participant / unsupported route / ingress", "two isolated servers", "pending"],
  ["Atomic snapshot update → stale route absent", "real filesystem", "pending"],
  ["Allowed click → target receives exactly one navigation", "real loopback target", "pending"],
  ["Stop → server inaccessible and files removed", "two isolated servers", "pending"],
  ["Provider delivery, CUA reasoning, lifecycle recovery, setup and analysis", "parent integration proof", "deferred"]
];
const receipt = { scope: "participant-only real-email renderer and desktop hosting", synthetic: true, providerCalls: 0, matrix, screenshots: [], checks: [], unexpectedNetwork: [], errors: [] };
let clicks = 0;
const target = createServer((req, res) => { if (req.url === "/verify?token=synthetic-link-code") { clicks++; res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Confirmed</title><h1>Email confirmed</h1>"); } else { res.writeHead(404); res.end(); } });
await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
const targetOrigin = `http://127.0.0.1:${target.address().port}`;
const local = localInboxDesktop(), second = localInboxDesktop();
const surface = await deployReceivingInbox(local.desktop, { leaseId: "browser-a", port: await unusedInboxPort() });
const other = await deployReceivingInbox(second.desktop, { leaseId: "browser-b", port: await unusedInboxPort() });
const image = new PNG({ width: 168, height: 48 });
for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
  const i = (y * image.width + x) * 4;
  const check = (x > 12 && x < 39 && y > 8 && y < 37) || (x > 60 && x < 150 && y > 19 && y < 28);
  image.data[i] = check ? 255 : 24; image.data[i + 1] = check ? 255 : 86; image.data[i + 2] = check ? 255 : 65; image.data[i + 3] = 255;
}
const safeMessage = {
  id: "message-000001", channel: "email", from: "Example Workspace <hello@example.test>", subject: "Confirm your email address",
  text: "Welcome to Example Workspace. Your code is 481920. Confirm your email at http://localhost:3000/verify?token=synthetic-link-code",
  html: '<div style="padding:24px;background:#f4f8f5;color:#173d32"><img src="cid:brand" width="168" alt="Example Workspace"><h2>Welcome to your workspace</h2><p>Confirm your email address to finish creating your account.</p><p><a style="display:inline-block;background:#175942;color:#fff;padding:14px" href="http://localhost:3000/verify?token=synthetic-link-code">Confirm email address</a></p><p>Your verification code is <strong>481920</strong>.</p><p>If you did not request this, you can ignore this email.</p></div>',
  inlineImages: [{ contentId: "brand", contentType: "image/png", base64: PNG.sync.write(image).toString("base64") }], limitations: []
};
const project = (messages, address = "reader-a@example.test") => renderReceivingInbox({ address, messages, allowedOrigins: [targetOrigin], originMap: [["http://localhost:3000", targetOrigin]] });
const otherMessage = { ...safeMessage, id: "message-b", subject: "Recipient B only", text: "PRIVATE_B_CANARY", html: "<p>PRIVATE_B_CANARY</p>", inlineImages: [] };
const candidates = [process.env.HUMANISH_BROWSER_EXECUTABLE, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
let executablePath;
for (const candidate of candidates) { try { await access(candidate); executablePath = candidate; break; } catch { /* next */ } }
const browser = await chromium.launch({ executablePath, headless: true });
try {
  await other.publish(project([otherMessage], "reader-b@example.test").files);
  for (const phone of [false, true]) {
    const label = phone ? "phone" : "desktop";
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => receipt.errors.push(error.message));
    page.on("request", (request) => { const origin = new URL(request.url()).origin; if (![new URL(surface.url).origin, targetOrigin, "null"].includes(origin)) receipt.unexpectedNetwork.push(request.url()); });
    async function snap(name) {
      await page.evaluate(async () => { await Promise.all([...document.images].map((img) => img.decode().catch(() => {}))); await document.fonts.ready; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No page overflow");
      const file = `${label}-${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); receipt.screenshots.push({ file, label, name });
    }
    await surface.publish(project([]).files); await page.goto(surface.url);
    await page.getByText("No messages yet.", { exact: false }).waitFor(); await snap("empty");
    await surface.publish(project([safeMessage]).files); await page.reload();
    await page.getByRole("link", { name: "Confirm your email address", exact: true }).waitFor(); await snap("list");
    await page.getByRole("link", { name: "Confirm your email address", exact: true }).click();
    assert.equal(await page.getByRole("img", { name: "Example Workspace", exact: true }).evaluate((img) => img.complete && img.naturalWidth === 168), true);
    assert.equal(await page.getByRole("link", { name: "Confirm email address", exact: true }).getAttribute("href"), `${targetOrigin}/verify?token=synthetic-link-code`);
    const cta = await page.getByRole("link", { name: "Confirm email address", exact: true }).evaluate((el) => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      const luminance = (color) => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const fore = luminance(style.color), back = luminance(style.backgroundColor);
      return { color: style.color, background: style.backgroundColor, display: style.display, contrast: (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05), width: rect.width, height: rect.height };
    });
    assert.equal(cta.display, "inline-block"); assert.equal(cta.background, "rgb(23, 89, 66)"); assert.ok(cta.contrast >= 4.5); assert.ok(cta.width >= 100 && cta.height >= 44);
    receipt.checks.push({ name: `${label}: visible CTA foreground/background contrast`, ...cta });
    await snap("original");
    await page.getByRole("link", { name: "Plain view", exact: true }).click(); await snap("plain");
    const json = await (await fetch(new URL("/inbox/latest.json", surface.url))).json();
    assert.deepEqual(json.links, [`${targetOrigin}/verify?token=synthetic-link-code`]); assert.deepEqual(json.codes, ["481920"]);
    assert.equal(clicks, phone ? 1 : 0, "No verification link prefetch");
    await page.getByRole("link", { name: "Open email link", exact: true }).click(); await page.getByRole("heading", { name: "Email confirmed" }).waitFor(); await snap("confirmed");
    const linkOnly = { ...safeMessage, text: "Confirm your email: http://localhost:3000/verify?token=481920", html: '<p><a href="http://localhost:3000/verify?token=481920">Confirm email</a></p>' };
    await surface.publish(project([linkOnly]).files); await page.goto(new URL("/inbox/latest/plain", surface.url).href);
    assert.equal(await page.locator(".otp").count(), 0);
    assert.deepEqual((await (await fetch(new URL("/inbox/latest.json", surface.url))).json()).codes, []);
    await snap("link-only-no-code");
    const malicious = { ...safeMessage, html: '<script>window.BAD=1</script><meta http-equiv="refresh" content="0;url=https://untrusted.example.test"><form action="https://untrusted.example.test"><input><button>Send</button></form><h2>Your access link</h2><p>This email contains a remote image and a destination outside the declared study.</p><img src="https://untrusted.example.test/pixel" alt="Company illustration"><p><a href="https://untrusted.example.test/verify">Open access link</a></p><iframe src="https://untrusted.example.test"></iframe><p style="background-image:url(https://untrusted.example.test/track)">Your code is <b>481920</b></p>', text: "Your code is 481920. Open https://untrusted.example.test/verify", inlineImages: [] };
    await surface.publish(project([malicious]).files); await page.goto(new URL("/inbox/latest", surface.url).href);
    assert.equal(await page.locator("script,iframe,form,input,button,base").count(), 0);
    assert.equal(await page.locator('meta[http-equiv="refresh"]').count(), 0);
    assert.equal(await page.locator(".email-body a").count(), 0);
    assert.equal(await page.evaluate(() => window.BAD), undefined);
    await snap("blocked"); await page.getByRole("link", { name: "Plain view", exact: true }).click(); await snap("blocked-plain");
    assert.deepEqual((await (await fetch(new URL("/inbox/latest.json", surface.url))).json()).links, []);
    assert.equal(await page.locator("body").innerText().then((text) => text.includes("PRIVATE_B_CANARY")), false);
    for (const route of ["/inbox/message-b", "/inbox/for/reader-b", "/snapshot.json", "/server.py"]) assert.equal((await fetch(new URL(route, surface.url))).status, 404);
    assert.equal((await fetch(surface.url, { method: "POST", body: "canary" })).status, 405);
    assert.equal((await readFile(path.join(path.dirname(local.files[0]), "snapshot.json"), "utf8")).includes("PRIVATE_B_CANARY"), false);
    await surface.publish(project([]).files); assert.equal((await fetch(new URL("/inbox/latest", surface.url))).status, 404);
    await context.close();
    receipt.checks.push(`${label}: empty/list/original/plain/blocked/JSON/allowed click/isolation/stale-route checks passed`);
  }
  assert.equal(clicks, 2); assert.deepEqual(receipt.errors, []); assert.deepEqual(receipt.unexpectedNetwork, []);
  for (const row of matrix) if (row[2] === "pending") row[2] = "passed";
} catch (error) { receipt.errors.push(error.stack ?? String(error)); throw error; }
finally {
  await browser.close(); await surface.stop(); await other.stop(); await new Promise((resolve) => target.close(resolve));
  await assert.rejects(fetch(surface.url)); await assert.rejects(access(path.dirname(local.files[0])));
  receipt.ok = receipt.errors.length === 0 && receipt.unexpectedNetwork.length === 0;
  await writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  await writeFile(path.join(output, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Receiving inbox proof</title><style>body{font:16px/1.5 system-ui;margin:40px;color:#15201d;background:#f5f7f5}h1{font-size:36px}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;text-align:left;border-bottom:1px solid #ddd}.deferred{color:#777}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:20px}figure{margin:0;padding:16px;background:white;border:1px solid #ddd}img{width:100%;max-height:680px;object-fit:contain;object-position:top}figcaption{margin-top:12px}</style><h1>Receiving inbox proof</h1><p>Actual participant surface and production loopback server, using synthetic email content. Provider delivery, participant reasoning, setup and lifecycle recovery remain parent integration gates.</p><p>${receipt.ok ? "Passed" : "Failed"} · ${receipt.screenshots.length} screenshots · zero provider calls</p><table><tr><th>Coverage</th><th>Scope</th><th>Result</th></tr>${matrix.map((row) => `<tr class="${row[2] === "deferred" ? "deferred" : ""}">${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table><h2>Rendered states</h2><div class="gallery">${receipt.screenshots.map((s) => `<figure><a href="${s.file}"><img src="${s.file}"></a><figcaption>${esc(s.label)} · ${esc(s.name)}</figcaption></figure>`).join("")}</div><p><a href="receipt.json">Assertions and receipt</a></p></html>`);
  console.log(JSON.stringify({ ok: receipt.ok, output, screenshots: receipt.screenshots.length, providerCalls: 0 }));
}
