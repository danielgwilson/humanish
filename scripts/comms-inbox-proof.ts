// Real loopback SMTP + HTTP capture, recipient HTML/JSON routes and Chromium.
// Synthetic mail/pixels only. No external provider delivery or hosted-desktop claim.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { freePort } from "../tests/helpers/free-port.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.HUMANISH_COMMS_PROOF_SOURCE ?? root;
const baseline = process.argv.includes("--baseline");
const output = path.join(root, ".humanish/comms-inbox-proof", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const { SANDBOX_CATCH_SCRIPT } = await import(pathToFileURL(path.join(source, "src/comms-sandbox-catch.ts")).href);
const { renderInboxSurfaceLocally } = await import(pathToFileURL(path.join(source, "src/comms-catch-host.ts")).href);
const ports: number[] = [];
while (ports.length < 3) { const port = await freePort(); if (!ports.includes(port)) ports.push(port); }
const [port, inboxPort, smtpPort] = ports;
const base = `http://127.0.0.1:${inboxPort}`;
const deliveriesPath = path.join(output, "deliveries.ndjson");
const surfaceDir = path.join(output, "surface");
const catchPath = path.join(output, "catch.py");
const png = new PNG({ width: 80, height: 40 });
for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 28; png.data[i + 1] = 90; png.data[i + 2] = 140; png.data[i + 3] = 255; }
const bytes = PNG.sync.write(png);
const remoteRequests: { url: string | undefined; referer: string | undefined }[] = [];
const imageServer = createServer((req, res) => {
  remoteRequests.push({ url: req.url, referer: req.headers.referer });
  if (req.url === "/logo.png") { res.setHeader("content-type", "image/png"); res.end(bytes); }
  else { res.writeHead(404); res.end(); }
});
await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
const imagePort = (imageServer.address() as { port: number }).port;
await writeFile(catchPath, SANDBOX_CATCH_SCRIPT);
const child = spawn("python3", [catchPath, String(port), deliveriesPath, surfaceDir, String(inboxPort), "proof-drain-token", String(smtpPort)], { stdio: "ignore" });
const until = async (fn: () => Promise<boolean>, message: string) => {
  for (let n = 0; n < 100; n++) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(message);
};
const scope = (address: string) => `/inbox/for/${createHash("sha256").update(address.trim().toLowerCase()).digest("hex")}`;
const unexpected: string[] = [];
const errors: string[] = [];
const proof: Record<string, unknown> = { baseline, sourceRevision: (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim(), sourceDirty: Boolean((await promisify(execFile)("git", ["status", "--porcelain"], { cwd: source })).stdout.trim()), output, scope: "Synthetic mail over real loopback SMTP and HTTP; real catch and renderer; Chromium desktop and phone", limitation: "Dead remote URLs retain their native alt fallback; script-src none is unchanged. No hosted desktop or live provider delivery claim." };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, "Catch did not become ready");
  // Python's email and SMTP libraries produce a real multipart/related message,
  // so this fixture traverses the deployed MIME parser rather than hand-built normalized metadata.
  await promisify(execFile)("python3", ["-c", `import sys, smtplib, base64
from email.message import EmailMessage
m=EmailMessage()
m['From']='sender@example.test'
m['To']='ada@example.test'
m['Subject']='Ada invitation'
m.set_content('Ada can join the fictional workspace.')
m.add_alternative('<h1>Ada invitation</h1><p>Your workspace invitation.</p><img src="cid:logo@mail" alt="Captured logo"><img src="http://127.0.0.1:${imagePort}/logo.png" alt="Remote logo"><img src="data:image/png;base64,${bytes.toString("base64")}" alt="Inline logo"><img src="cid:missing" alt="Missing logo"><img src="/unknown-relative.png" alt="Relative logo"><img src="javascript:alert(1)" alt="Unsafe logo"><img src="http://127.0.0.1:${imagePort}/missing.png" alt="Remote image unavailable"><script>window.inboxScriptRan=true</script><a href="https://app.example.test/verify?token=synthetic-ada">Accept invitation</a>',subtype='html')
m.get_payload()[1].add_related(base64.b64decode('${bytes.toString("base64")}'),maintype='image',subtype='png',cid='<logo@mail>')
with smtplib.SMTP('127.0.0.1',int(sys.argv[1])) as s:s.send_message(m)
`, String(smtpPort)]);
  assert((await fetch(`http://127.0.0.1:${port}/emails`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "sender@example.test", to: ["grace@example.test"], subject: "Grace private update", html: "<h1>Grace private update</h1><p>Grace-only code: 918273.</p>" }) })).ok);
  await renderInboxSurfaceLocally({ deliveriesPath, surfaceDir, recipients: ["ada@example.test", "grace@example.test", "empty@example.test"] });
  proof.readOnlyDrainStatus = (await fetch(`${base}/deliveries`, { headers: { authorization: "Bearer proof-drain-token" } })).status;
  proof.privateDrainWithoutToken = (await fetch(`http://127.0.0.1:${port}/deliveries`)).status;
  const adaScope = scope("ada@example.test"), graceScope = scope("grace@example.test");
  proof.scopedStatus = (await fetch(base + adaScope)).status;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const cases: Record<string, unknown>[] = [];
  for (const phone of [false, true]) {
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" && [String(inboxPort), String(imagePort)].includes(url.port)) return route.continue();
      unexpected.push(url.origin + url.pathname); return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + (baseline ? "/inbox" : adaScope));
    await page.screenshot({ path: path.join(output, `${phone ? "phone" : "desktop"}-inbox.png`), fullPage: true });
    if (!baseline) {
      assert(!(await page.locator("body").innerText()).includes("Grace"));
      assert((await page.locator("body").innerText()).includes("ada@example.test"));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (phone) assert(await page.locator(".inbox-list td").first().evaluate((node) => node.getBoundingClientRect().width > 250));
    }
    await page.getByRole("link", { name: "Ada invitation", exact: true }).click();
    await page.waitForLoadState("networkidle");
    const images = await page.locator("img").evaluateAll((nodes) => nodes.map((img) => ({ alt: img.alt, loaded: img.complete && img.naturalWidth > 0, source: img.getAttribute("src")?.startsWith("data:") ? "captured-inline" : img.getAttribute("src"), referrer: img.referrerPolicy })));
    const text = await page.locator("body").innerText();
    await page.screenshot({ path: path.join(output, `${phone ? "phone" : "desktop"}-message.png`), fullPage: true });
    const width = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
    cases.push({ phone, images, placeholders: await page.locator(".email-image-unavailable").count(), width, route: new URL(page.url()).pathname });
    if (!baseline) {
      assert(images.filter((image) => image.loaded).length === 3, "Captured CID, data URI and remote HTTP image did not all render");
      assert(images.find((image) => image.alt === "Remote image unavailable")?.loaded === false, "Broken remote image was reported as loaded");
      assert.equal(await page.locator(".email-image-unavailable").count(), 3);
      assert(!text.includes("Grace")); assert(width.page <= width.viewport);
      assert.equal(await page.evaluate(() => (window as unknown as { inboxScriptRan?: boolean }).inboxScriptRan), undefined);
      await page.getByRole("link", { name: "plain view", exact: true }).click();
      assert(new URL(page.url()).pathname.startsWith(adaScope + "/"));
      await page.getByRole("link", { name: /Inbox/ }).click();
      assert.equal(new URL(page.url()).pathname, adaScope);
    }
    await context.close();
  }
  proof.cases = cases;
  proof.remoteRequests = remoteRequests;
  proof.unexpectedNetwork = unexpected;
  proof.pageErrors = errors;
  if (!baseline) {
    assert.equal(proof.readOnlyDrainStatus, 404); assert.equal(proof.privateDrainWithoutToken, 401);
    assert(remoteRequests.some((request) => request.url === "/logo.png"));
    assert(remoteRequests.every((request) => request.referer === undefined), "Email/scope URL leaked through Referer");
    const adaList = await (await fetch(`${base}/api${adaScope}`)).json() as { id: string; subject: string }[];
    const graceList = await (await fetch(`${base}/api${graceScope}`)).json() as { id: string; subject: string }[];
    assert.equal(adaList.length, 1); assert.equal(graceList.length, 1);
    for (const route of [`${adaScope}/${graceList[0]!.id}`, `${adaScope}/${graceList[0]!.id}/synth`, `/api${adaScope}/${graceList[0]!.id}`]) {
      const response = await fetch(base + route); assert.equal(response.status, 404); assert(!(await response.text()).includes("href='/inbox'"));
    }
    for (const route of [`${adaScope}/latest`, `${adaScope}/latest/synth`, `/api${adaScope}/latest`]) {
      const response = await fetch(base + route); assert.equal(response.status, 200); const text = await response.text(); assert(text.includes("Ada invitation") && !text.includes("Grace private update"));
    }
    assert.deepEqual(await (await fetch(`${base}/api${scope("empty@example.test")}`)).json(), []);
    assert.deepEqual(await (await fetch(`${base}/api${scope("unknown@example.test")}`)).json(), []);
    assert.equal((await fetch(`${base}${scope("unknown@example.test")}/${adaList[0]!.id}`)).status, 404);
    assert.equal((await fetch(`${base}/inbox/%2e%2e/%2e%2e/deliveries.ndjson`)).status >= 400, true);
    await renderInboxSurfaceLocally({ deliveriesPath, surfaceDir, recipients: ["ada@example.test"] });
    for (const route of [graceScope + `/${graceList[0]!.id}`, graceScope + "/latest", `/api${graceScope}/latest`]) assert.equal((await fetch(base + route)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api${graceScope}`)).json(), []);
    proof.reusedDirectoryRemovedRecipient = true;
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  }
  proof.ok = !baseline;
  proof.baselineFailures = baseline ? ["Shared participant inbox", "No recipient route", "Captured CID unavailable", "Read-only listener exposes drain"] : [];
} catch (error) { proof.ok = false; proof.error = String(error); process.exitCode = 1; }
finally {
  await browser?.close(); child.kill(); await new Promise<void>((resolve) => imageServer.close(() => resolve()));
  try { proof.capturedSmtpInlineImages = JSON.parse(JSON.parse((await readFile(deliveriesPath, "utf8")).trim().split("\n")[0]!).body).inlineImages?.length ?? 0; } catch { proof.capturedSmtpInlineImages = null; }
  await writeFile(path.join(output, "proof.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ ok: proof.ok, baseline, output, error: proof.error }));
}
