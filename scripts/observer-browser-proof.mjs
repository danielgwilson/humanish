#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { appendFrame, fixture, screenshot } from "./observer-browser-fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}
const known = new Set(["--artifact", "--output", "--case"]);
for (let i = 0; i < args.length; i += 2) if (!known.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
const artifactPath = path.resolve(option("--artifact", path.join(root, "observer/dist/index.html")));
const selectedCase = option("--case", null);
const output = path.resolve(option("--output", path.join(root, ".humanish/observer-browser-proof",
  new Date().toISOString().replace(/[:.]/g, "-"))));
// Refuse to overwrite prior evidence, even when a caller supplies --output.
await mkdir(output, { recursive: false }).catch(async (error) => {
  if (error.code !== "ENOENT") throw error;
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
});
const html = await readFile(artifactPath, "utf8");
const slot = `<script id="observer-data" type="application/json">__HUMANISH_OBSERVER_DATA__</script>`;
assert.equal(html.split(slot).length, 2, "Build the unfilled Observer artifact before running browser proof");
const coverage = JSON.parse(await readFile(path.join(root, "scripts/observer-browser-coverage.json"), "utf8"));
assert(!selectedCase || coverage.cases.some((entry) => entry.id === selectedCase), "Unknown --case");
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const inject = (data) => html.replace(slot, `<script id="observer-data" type="application/json">${JSON.stringify(data)
  .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")}</script>`);
let data = fixture();
let responseMode = "ok";
let pollCount = 0;
const requests = [];
const images = new Map();
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const entry = { path: url.pathname, at: new Date().toISOString(), status: 200 };
  requests.push(entry);
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  if (url.pathname === "/observer/index.html") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(inject(data));
  } else if (url.pathname === "/observer/observer-data.json") {
    pollCount += 1;
    entry.mode = responseMode;
    response.setHeader("content-type", "application/json");
    if (responseMode === "failed") {
      entry.status = 503;
      response.writeHead(503);
      response.end('{"error":"Controlled transient snapshot failure"}');
    } else if (responseMode === "invalid") {
      response.end('{"schema":"humanish.observer-data.v1","streams":"malformed"}');
    } else response.end(JSON.stringify(data));
  } else if (url.pathname === "/_humanish/history.json") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ latestRunId: data.run.runId, runs: [] }));
  } else if (/^\/desktop\/lane-\d+$/.test(url.pathname)) {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end('<!doctype html><html><body style="margin:0;background:#b8cedb;color:#123;font:20px sans-serif"><p>Controlled local desktop fixture</p><p>This is not provider connection proof.</p><button>Keyboard must not enter this read-only view</button></body></html>');
  } else {
    const match = /^\/screenshots\/(portrait|landscape)-(\d+)\.png$/.exec(url.pathname);
    if (!match) { entry.status = 404; response.writeHead(404); response.end("Not found"); return; }
    if (!images.has(url.pathname)) images.set(url.pathname, screenshot(match[1] === "portrait" ? 390 : 1200,
      match[1] === "portrait" ? 844 : 750, Number(match[2])));
    response.setHeader("content-type", "image/png");
    response.end(images.get(url.pathname));
  }
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const candidates = [process.env.HUMANISH_BROWSER_EXECUTABLE, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  chromium.executablePath(), "/usr/bin/google-chrome", "/usr/bin/chromium", "/snap/bin/chromium"].filter(Boolean);
let executablePath;
for (const candidate of candidates) { try { await access(candidate); executablePath = candidate; break; } catch { /* next supported location */ } }
if (!executablePath) {
  server.close();
  throw new Error("Chromium missing. Run pnpm exec playwright-core install chromium or set HUMANISH_BROWSER_EXECUTABLE.");
}
const browser = await chromium.launch({ executablePath, headless: true }).catch((error) => {
  server.close(); throw error;
});
const results = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await predicate()) return; await wait(100); }
  throw new Error(message);
}

async function inspectImages(locator) {
  assert(await locator.count() > 0, "Expected real rendered screenshot images");
  const measurements = [];
  for (let n = 0; n < await locator.count(); n += 1) {
    const image = locator.nth(n);
    await image.scrollIntoViewIfNeeded();
    await image.evaluate(async (element) => { if (!element.complete) await element.decode(); });
    measurements.push(await image.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      const width = rect.width - parseFloat(css.borderLeftWidth) - parseFloat(css.borderRightWidth) - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      const height = rect.height - parseFloat(css.borderTopWidth) - parseFloat(css.borderBottomWidth) - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
      const nw = element.naturalWidth, nh = element.naturalHeight;
      const scale = css.objectFit === "cover" ? Math.max(width / nw, height / nh)
        : css.objectFit === "none" ? 1 : css.objectFit === "contain" || css.objectFit === "scale-down"
          ? Math.min(width / nw, height / nh, css.objectFit === "scale-down" ? 1 : Infinity) : null;
      const paintedWidth = scale === null ? width : nw * scale;
      const paintedHeight = scale === null ? height : nh * scale;
      const visibleFraction = Math.min(1, width / paintedWidth) * Math.min(1, height / paintedHeight);
      let parentClipped = false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
        // Scrollable containers remain inspectable; fixed clipping ancestors do not.
        if ([style.overflowX, style.overflowY].some((value) => value === "hidden" || value === "clip")) {
          const contentLeft = rect.left + (rect.width - paintedWidth) / 2;
          const contentTop = rect.top + (rect.height - paintedHeight) / 2;
          if ((["hidden", "clip"].includes(style.overflowX) && (contentLeft < box.left - 2 || contentLeft + paintedWidth > box.right + 2))
            || (["hidden", "clip"].includes(style.overflowY) && (contentTop < box.top - 2 || contentTop + paintedHeight > box.bottom + 2))) parentClipped = true;
        }
      }
      return { href: element.getAttribute("src"), natural: [nw, nh], box: [width, height], objectFit: css.objectFit,
        visibleFraction, aspectError: Math.abs(paintedWidth / paintedHeight - nw / nh), parentClipped };
    }));
  }
  return measurements;
}
function assertFullFrames(measurements) {
  for (const value of measurements) {
    assert(value.natural[0] > 0 && value.natural[1] > 0, "Screenshot decoded");
    assert(value.visibleFraction > 0.995, `Cropped screenshot: ${JSON.stringify(value)}`);
    assert(value.aspectError < 0.005, `Distorted screenshot: ${JSON.stringify(value)}`);
    assert(!value.parentClipped, `Ancestor clips screenshot: ${JSON.stringify(value)}`);
  }
}
async function pageWidth(page) {
  return page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
}
async function displayedFrame(page) { return page.locator(".stage-box img").first().getAttribute("src"); }
async function openLane(page, index = 1) {
  await page.goto(`${origin}/observer/index.html#/lane/lane-${index}`);
  await page.locator(".player").waitFor();
}
async function stateProof(page) {
  return page.evaluate(() => ({ url: location.pathname + location.hash, width: { viewport: innerWidth, page: document.documentElement.scrollWidth },
    text: document.body.innerText.slice(0, 24_000), images: [...document.images].map((image) => ({ src: image.getAttribute("src"), complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })).slice(0, 300),
    iframes: [...document.querySelectorAll("iframe")].map((frame) => ({ src: frame.getAttribute("src"), tabIndex: frame.tabIndex, allow: frame.getAttribute("allow") })),
    controls: [...document.querySelectorAll("input[type=range]")].map((input) => ({ label: input.getAttribute("aria-label"), value: input.value, min: input.min, max: input.max })),
    feedRows: document.querySelectorAll(".arow").length, buttons: document.querySelectorAll("button").length }));
}
async function runCase(id, options, action) {
  if (selectedCase && selectedCase !== id) return;
  data = fixture({ ...options, origin }); responseMode = "ok"; pollCount = 0;
  const requestStart = requests.length;
  const directory = path.join(output, id); await mkdir(directory);
  const context = await browser.newContext({ viewport: options.phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
  const unexpectedNetwork = [];
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    if (target.origin === origin) return route.continue();
    unexpectedNetwork.push(`${target.protocol}//${target.host}${target.pathname}`);
    return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const record = { id, status: "running", startedAt: new Date().toISOString(), checks: {}, screenshots: [] };
  async function snap(label) {
    const name = `${record.screenshots.length + 1}-${label}.png`;
    await page.screenshot({ path: path.join(directory, name), fullPage: false });
    record.screenshots.push(`${id}/${name}`);
  }
  try {
    await page.goto(`${origin}/observer/index.html`);
    await page.getByRole("region", { name: "Study grid" }).waitFor();
    await snap("grid-before");
    await action({ page, record, snap });
    assert.equal(errors.length, 0, `Browser errors: ${errors.join("; ")}`);
    assert.equal(unexpectedNetwork.length, 0, "Self-contained Observer attempted external network access");
    record.status = "passed";
  } catch (error) { record.status = "failed"; record.error = error.stack ?? String(error); }
  finally {
    await snap(record.status).catch(() => {});
    record.state = await stateProof(page).catch((error) => ({ unavailable: error.message }));
    record.errors = errors;
    record.unexpectedNetwork = unexpectedNetwork;
    record.requests = requests.slice(requestStart);
    record.finishedAt = new Date().toISOString();
    await writeFile(path.join(directory, "proof.json"), JSON.stringify(record, null, 2));
    await context.close(); results.push(record);
    process.stdout.write(`${record.status.toUpperCase()} ${id}${record.error ? `: ${record.error.split("\n")[0]}` : ""}\n`);
  }
}

try {
  for (const phone of [false, true]) {
    await runCase(phone ? "grid-phone" : "grid-desktop", { phone }, async ({ page, record, snap }) => {
      record.checks.geometry = await inspectImages(page.locator(".thumb .keyframe"));
      record.checks.width = await pageWidth(page); await snap("complete-screens");
      assertFullFrames(record.checks.geometry);
      assert(record.checks.width.page <= record.checks.width.viewport + 1, "Grid page overflows horizontally");
    });
    await runCase(phone ? "player-phone" : "player-desktop", { phone }, async ({ page, record, snap }) => {
      // Exercise the real grid-to-player user path, then inspect every saved frame.
      await page.getByRole("button", { name: /^Open participant/ }).first().click();
      await page.locator(".player").waitFor();
      record.checks.stage = await inspectImages(page.locator(".stage-box img"));
      record.checks.filmstrip = await inspectImages(page.locator(".filmstrip img"));
      record.checks.width = await pageWidth(page); await snap("participant-recording");
      assertFullFrames(record.checks.stage); assertFullFrames(record.checks.filmstrip);
      assert(record.checks.width.page <= record.checks.width.viewport + 1, "Player page overflows horizontally");
    });
  }
  await runCase("live-arrow", { running: true, live: true }, async ({ page, record, snap }) => {
    await openLane(page); await page.locator(".stage-live iframe").waitFor(); await snap("desktop-before-seek");
    await page.keyboard.press("ArrowLeft");
    await until(async () => await page.locator(".stage-live iframe").count() === 0, "Arrow seek kept live desktop mounted");
    record.checks.frame = await displayedFrame(page);
    assert(record.checks.frame.endsWith("portrait-3.png"), "Arrow seek did not show previous frame");
    await snap("recording-after-seek");
  });
  await runCase("live-refresh", { running: true, live: true }, async ({ page, record, snap }) => {
    await openLane(page); await page.locator(".stage-live iframe").waitFor(); await snap("live-before-refresh");
    record.checks.before = new URL(page.url()).hash;
    await page.reload();
    await until(async () => await page.locator(".stage-live iframe").count() === 1, "Refresh lost live viewing intent");
    record.checks.after = new URL(page.url()).hash; await snap("live-after-refresh");
  });
  await runCase("paused-growth", { running: true }, async ({ page, record, snap }) => {
    await openLane(page);
    await page.getByRole("button", { name: "Previous frame", exact: true }).click();
    await page.getByRole("button", { name: "Next frame", exact: true }).click();
    record.checks.before = await displayedFrame(page); await snap("paused-newest");
    const before = pollCount; appendFrame(data);
    await until(() => pollCount > before, "No snapshot poll after append"); await wait(400);
    record.checks.after = await displayedFrame(page); record.checks.controls = (await stateProof(page)).controls;
    assert.equal(record.checks.after, record.checks.before, "Paused last frame advanced with incoming evidence");
    assert(record.checks.controls.some((control) => Number(control.max) > 3), "New timeline was not received");
    await snap("paused-after-growth");
  });
  await runCase("same-lane-route", {}, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/2`);
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor(); await snap("moment-two");
    await page.evaluate(() => { location.hash = "#/lane/lane-1/f/4"; });
    await page.locator('.stage-box img[src$="portrait-4.png"]').waitFor();
    record.checks.frame = await displayedFrame(page); await snap("moment-four");
  });
  for (const invalid of [true, false]) {
    await runCase(invalid ? "invalid-snapshot" : "network-recovery", { running: true }, async ({ page, record, snap }) => {
      await openLane(page); const before = await displayedFrame(page); const polls = pollCount;
      responseMode = invalid ? "invalid" : "failed";
      await until(() => pollCount > polls, "No failed snapshot request observed"); await wait(500);
      record.checks.failure = await stateProof(page); await snap("failure-retains-evidence");
      assert.equal(await displayedFrame(page), before, "Bad snapshot discarded last good evidence");
      assert(/connection lost|reconnect|retry|unavailable|update failed|disconnected|could not update/i.test(record.checks.failure.text), "Poll failure has no visible recovery state");
      responseMode = "ok"; appendFrame(data); const failedPolls = pollCount;
      await until(() => pollCount > failedPolls, "No recovery snapshot request observed");
      await until(async () => (await displayedFrame(page))?.endsWith("portrait-5.png"), "Recovered live capture did not advance");
      record.checks.recovery = await stateProof(page); await snap("recovered");
    });
  }
  await runCase("stream-capacity", { running: true, live: true, laneCount: 24 }, async ({ page, record, snap }) => {
    await wait(600); record.checks.initial = await page.locator(".thumb iframe").count();
    assert(record.checks.initial > 0 && record.checks.initial <= 4, "Grid must bound attached desktop previews to four");
    const last = page.locator(".card").last(); await last.scrollIntoViewIfNeeded();
    await until(async () => await last.locator("iframe").count() === 1, "Visible later participant never received preview allocation");
    record.checks.afterScroll = await page.locator(".thumb iframe").count();
    assert(record.checks.afterScroll <= 4, "Scrolling exceeded desktop preview capacity"); await snap("later-visible-participant");
  });
  await runCase("large-trace", { rows: 5000, laneCount: 1 }, async ({ page, record, snap }) => {
    await openLane(page); record.checks.rows = await page.locator(".arow").count();
    // Scroll the actual inspector, not the page or a test substitute.
    const pane = page.locator(".acts").first();
    record.checks.interactiveRows = await pane.locator("button, [role=button]").count();
    record.checks.elements = await pane.locator("*").count();
    await pane.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const ending = pane.getByText("FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE", { exact: false });
    await ending.first().waitFor({ state: "visible" });
    record.checks.finalEvidenceVisible = await ending.first().isVisible(); await snap("end-of-long-recording");
    assert(record.checks.interactiveRows <= 300 && record.checks.elements <= 1500,
      `Long recording mounted ${record.checks.interactiveRows} interactive rows / ${record.checks.elements} feed elements`);
  });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const completeCases = coverage.cases.map((entry) => ({ ...entry, status: results.find((result) => result.id === entry.id)?.status ?? "not-run" }));
const summary = { schema: "humanish.observer-browser-proof.v1", scope: coverage.scope, generatedAt: new Date().toISOString(),
  artifactSha256: createHash("sha256").update(html).digest("hex"), browser: executablePath,
  selectedCase, localCasesPass: results.length > 0 && results.every((result) => result.status === "passed"),
  coverageComplete: false, cases: completeCases, externalAcceptance: coverage.externalAcceptance,
  note: "Controlled renderer proof is not provider, CLI entrypoint, or complete Observer release acceptance." };
assert.equal(results.length, selectedCase ? 1 : coverage.cases.length, "Every declared local case must produce a result");
await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
await writeFile(path.join(output, "fixture.json"), JSON.stringify(fixture(), null, 2));
await mkdir(path.join(output, "assets"));
await Promise.all([...images].map(([name, bytes]) => writeFile(path.join(output, "assets", path.basename(name)), bytes)));
const rows = [...completeCases, ...coverage.externalAcceptance].map((entry) => `<tr><td>${escape(entry.id)}</td><td class="${entry.status}">${escape(entry.status)}</td><td>${escape(entry.goal ?? entry.reason)}</td></tr>`).join("");
const panels = results.map((result) => `<article id="${escape(result.id)}"><h2>${escape(result.id)} · ${escape(result.status)}</h2>${result.error ? `<pre>${escape(result.error.split("\n").slice(0, 4).join("\n"))}</pre>` : ""}<p><a href="${escape(result.id)}/proof.json">Measured state and HTTP receipts</a></p><div class="screens">${result.screenshots.map((src) => `<a href="${escape(src)}"><img src="${escape(src)}" alt="${escape(src)}" loading="lazy"></a>`).join("")}</div></article>`).join("");
await writeFile(path.join(output, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Observer browser proof</title><style>body{font:16px system-ui;background:#edf1f3;color:#182b35;margin:0;padding:32px;max-width:1500px;margin-inline:auto}h1{font-size:36px;margin-bottom:8px}p{max-width:850px;line-height:1.5}table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid #cbd5da;padding:10px;text-align:left;vertical-align:top}.passed{color:#166344}.failed{color:#a32235}.external,.uncovered,.not-run{color:#74521a}article{padding-block:24px;border-bottom:1px solid #9aabb4}.screens{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}img{max-width:100%;height:auto;border:1px solid #cbd5da}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#174e75}</style><h1>Observer browser proof</h1><p>${escape(coverage.scope)}. Local cases: ${results.filter((result) => result.status === "passed").length}/${results.length} passed. Uncovered and external acceptance remain visible below; this report does not certify a complete release.</p><p><a href="summary.json">Coverage manifest</a></p><table><thead><tr><th>Surface/state</th><th>Result</th><th>Proof target or remaining gap</th></tr></thead><tbody>${rows}</tbody></table>${panels}</html>`);
process.stdout.write(`Observer browser evidence: ${output}\n`);
process.exitCode = summary.localCasesPass ? 0 : 1;
