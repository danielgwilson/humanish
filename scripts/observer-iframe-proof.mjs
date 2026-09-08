// Browser proof for the live iframe trust boundary. Run after build. No providers or credentials.
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { renderObserver, serveObserver } from "../dist/observer.js";
import { serveObserverLibrary } from "../dist/observer-serve.js";
import { serveObserverStatic } from "../dist/observer-static.js";
import { runDryRun } from "../dist/run.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [process.env.HUMANISH_BROWSER_EXECUTABLE, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  chromium.executablePath(), "/usr/bin/google-chrome", "/usr/bin/chromium", "/snap/bin/chromium"].filter(Boolean);
let executablePath;
for (const candidate of candidates) { try { await access(candidate); executablePath = candidate; break; } catch {} }
assert.ok(executablePath, "Chromium is required for the iframe isolation proof");
const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-iframe-proof-"));
let observer;
let library;
let staticObserver;
let provider;
let browser;
let requestedModule = 0;
let requestedAttack = 0;
const checks = {};
try {
  await cp(path.join(repo, "fixtures", "minimal-app"), cwd, { recursive: true });
  assert.equal((await runDryRun({ cwd, dryRun: true, runId: "synthetic-iframe-study" })).ok, true);
  assert.equal((await runDryRun({ cwd, dryRun: true, runId: "synthetic-sibling-study" })).ok, true);
  const rendered = await renderObserver(cwd, "synthetic-iframe-study", { open: false });
  observer = await serveObserver(rendered, { open: false });
  const attackUrl = new URL("../synthetic-frame.html", observer.url).href;
  await writeFile(path.join(cwd, ".humanish", "runs", "synthetic-iframe-study", "synthetic-frame.html"),
    '<!doctype html><body><script>parent.document.body.dataset.syntheticFrameEscaped="true";</script>');
  provider = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/module.js") {
      requestedModule++;
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end('document.body.dataset.moduleLoaded="true"; try { parent.document.body.dataset.syntheticFrameEscaped="true"; } catch { document.body.dataset.parentIsolated="true"; }');
      return;
    }
    if (url.pathname === "/redirect") {
      requestedAttack++;
      response.writeHead(302, { location: attackUrl }); response.end(); return;
    }
    if (url.pathname === "/script-navigation") {
      requestedAttack++;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body><script>location.replace(${JSON.stringify(attackUrl)});</script>`); return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><body><script type="module" src="/module.js"></script>');
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const providerOrigin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  let blockedFrames = 0;
  page.on("console", (message) => { if (/frame-ancestors|X-Frame-Options/.test(message.text())) blockedFrames++; });
  await page.goto(observer.url);
  const frame = async (url, sandbox) => {
    const previous = page.frames().find((candidate) => candidate.name() === "synthetic-provider");
    await page.evaluate(({ url, sandbox }) => {
      document.querySelector('[name="synthetic-provider"]')?.remove();
      const element = document.createElement("iframe");
      element.name = "synthetic-provider"; element.sandbox.value = sandbox; element.src = url;
      document.body.appendChild(element);
    }, { url, sandbox });
    await page.waitForFunction(() => document.querySelector('[name="synthetic-provider"]') !== null);
    for (let attempt = 0; attempt < 50; attempt++) {
      const next = page.frames().find((candidate) => candidate.name() === "synthetic-provider" && candidate !== previous);
      if (next) return next;
      await page.waitForTimeout(20);
    }
    throw new Error("Synthetic provider iframe did not attach");
  };
  const compatible = await frame(`${providerOrigin}/desktop`, "allow-scripts allow-same-origin");
  await compatible.waitForFunction(() => document.body?.dataset.moduleLoaded === "true");
  assert.equal(await compatible.evaluate(() => document.body.dataset.parentIsolated), "true");
  checks.crossOriginModuleLoadsWithoutParentAccess = true;

  const strict = await frame(`${providerOrigin}/desktop`, "allow-scripts");
  await strict.waitForLoadState("load");
  await page.waitForTimeout(100);
  assert.notEqual(await strict.evaluate(() => document.body?.dataset.moduleLoaded), "true");
  assert.ok(requestedModule >= 2, "Both policies must attempt the module request");
  checks.strictSandboxRetainsOpaqueOrigin = true;

  for (const [label, url] of [["direct", attackUrl], ["redirect", `${providerOrigin}/redirect`], ["scriptNavigation", `${providerOrigin}/script-navigation`]]) {
    const before = blockedFrames;
    await frame(url, "allow-scripts allow-same-origin");
    for (let attempt = 0; attempt < 100 && blockedFrames === before; attempt++) await page.waitForTimeout(20);
    assert.ok(blockedFrames > before, `${label} must produce a browser frame-policy refusal`);
    assert.notEqual(await page.evaluate(() => document.body.dataset.syntheticFrameEscaped), "true");
    checks[`${label}BackToObserverBlocked`] = true;
  }
  assert.equal(requestedAttack, 2);

  // A person can open an artifact in its own tab. Framing denial alone must not
  // leave a saved HTML/SVG document with access to the Observer's origin.
  const runRoot = path.join(cwd, ".humanish", "runs", "synthetic-iframe-study");
  const marker = "SYNTHETIC_EVIDENCE_MARKER";
  await writeFile(path.join(cwd, ".humanish", "runs", "synthetic-sibling-study", "marker.txt"), marker);
  await writeFile(path.join(runRoot, "marker.txt"), marker);
  const probe = (target) => `window.artifactScriptExecuted=true;
    try { localStorage.setItem('synthetic-artifact-probe','true'); window.artifactStorage='allowed'; } catch { window.artifactStorage='blocked'; }
    fetch(${JSON.stringify(target)}).then(r=>r.text()).then(text=>{window.artifactRead=text;},()=>{window.artifactRead='blocked';});`;
  const siblingPath = "/_humanish/runs/synthetic-sibling-study/marker.txt";
  await writeFile(path.join(runRoot, "raw.html"), `<!doctype html><body>synthetic artifact<script>${probe(siblingPath)}</script>`);
  await writeFile(path.join(runRoot, "static.html"), `<!doctype html><body>synthetic artifact<script>${probe("/marker.txt")}</script>`);
  await writeFile(path.join(runRoot, "active.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[${probe("/marker.txt")}]]></script><text y="20">synthetic SVG</text></svg>`);
  const libraryResult = await serveObserverLibrary(cwd, { port: 0, safe: false, expose: false, edgeAuthed: false });
  assert.equal(libraryResult.ok, true);
  library = libraryResult.server;
  staticObserver = await serveObserverStatic({ root: runRoot, port: 0 });
  for (const [label, url] of [
    ["attachedRawHtml", new URL("/raw.html", observer.url).href],
    ["attachedEncodedAlias", new URL("/%72aw.html", observer.url).href],
    ["libraryRawHtml", new URL("/_humanish/runs/synthetic-iframe-study/raw.html", library.url).href],
    ["libraryEncodedAlias", new URL("/_humanish/runs/synthetic-iframe-study/%72aw.html", library.url).href],
    ["staticRawHtml", new URL("/static.html", staticObserver.url).href],
    ["staticActiveSvg", new URL("/active.svg", staticObserver.url).href]
  ]) {
    const artifactPage = await browser.newPage();
    const response = await artifactPage.goto(url);
    assert.equal(response.headers()["content-security-policy"], "frame-ancestors 'none'; sandbox allow-scripts");
    assert.equal(response.headers()["x-content-type-options"], "nosniff");
    await artifactPage.waitForFunction(() => typeof window.artifactRead === "string");
    assert.deepEqual(await artifactPage.evaluate(() => ({
      scripts: window.artifactScriptExecuted,
      read: window.artifactRead,
      storage: window.artifactStorage
    })), { scripts: true, read: "blocked", storage: "blocked" });
    checks[`${label}Isolated`] = true;
    await artifactPage.close();
  }
  for (const [label, base, artifactPath] of [
    ["attached", observer.url, "/active.svg"],
    ["library", library.url, "/_humanish/runs/synthetic-iframe-study/active.svg"]
  ]) {
    const artifactPage = await browser.newPage();
    const response = await artifactPage.goto(new URL(artifactPath, base).href);
    assert.equal(response.headers()["content-type"], "text/plain; charset=utf-8");
    assert.equal(await artifactPage.evaluate(() => window.artifactScriptExecuted), undefined);
    checks[`${label}SvgRemainsInert`] = true;
    await artifactPage.close();
  }
  for (const [label, url] of [["attached", observer.url], ["library", new URL("/_humanish/runs/synthetic-iframe-study/observer//index.html", library.url).href]]) {
    const generatedPage = await browser.newPage();
    const response = await generatedPage.goto(url);
    assert.equal(response.headers()["content-security-policy"], "frame-ancestors 'none'");
    assert.equal(await generatedPage.evaluate(async (target) => (await fetch(target)).text(), siblingPath), marker);
    checks[`${label}GeneratedObserverRetainsOrigin`] = true;
    await generatedPage.close();
  }
  const receipt = { schema: "humanish.observer-iframe-proof.v1", checkedAt: new Date().toISOString(), checks,
    limits: ["Synthetic cross-origin module/redirect fixture; actual hosted desktop compatibility is a separate provider proof."] };
  const output = path.join(repo, ".humanish", "review", "observer-iframe-proof.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  await browser?.close();
  if (provider) await new Promise((resolve) => { provider.close(resolve); provider.closeAllConnections(); });
  await observer?.close();
  await library?.close();
  await staticObserver?.close();
  await rm(cwd, { recursive: true, force: true });
}
