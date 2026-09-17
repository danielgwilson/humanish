#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { analysisFixture, appendFrame, fixture, screenshot, START, reviewPolishFixture } from "./observer-browser-fixtures.mjs";

import { assertScrubberAligned, scrubberPixels } from "./observer-browser-components.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}
const known = new Set(["--artifact", "--output", "--case", "--axe"]);
for (let i = 0; i < args.length; i += 2) if (!known.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
const artifactPath = path.resolve(option("--artifact", path.join(root, "observer/dist/index.html")));
const selectedCase = option("--case", null);
const axePath = option("--axe", null);
const axeSource = axePath ? await readFile(path.resolve(axePath), "utf8") : null;
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
const analysisSlot = `<script id="study-analysis" type="application/json">__HUMANISH_STUDY_ANALYSIS__</script>`;
let analysis = null;
let analysisMode = "ok";
const withAnalysis = (body) => body.replace(analysisSlot, `<script id="study-analysis" type="application/json">${JSON.stringify(analysis).replace(/</g, "\\u003c")}</script>`);
let data = fixture();
let otherData = null;
let responseMode = "ok";
let pollCount = 0;
let exerciseDesktopIsolation = false;
const requests = [];
const images = new Map();
const imageModes = new Map();
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const entry = { path: url.pathname, at: new Date().toISOString(), status: 200 };
  requests.push(entry);
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  if (url.pathname === "/restricted-browser") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("permissions-policy", "fullscreen=(), clipboard-write=()");
    response.end('<!doctype html><html lang="en"><head><title>Observer permissions fixture</title></head><body style="margin:0"><main><h1 style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">Observer permissions fixture</h1><iframe title="Observer with browser permissions denied" src="/observer/index.html#/lane/lane-1/f/2" allow="fullscreen \'none\'; clipboard-write \'none\'" style="border:0;width:100vw;height:100vh"></iframe></main></body></html>');
  } else if (url.pathname === "/observer/index.html") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(withAnalysis(inject(data)));
  } else if (url.pathname === "/observer/study-analysis.json") {
    if (analysisMode === "held") { response.once("close", () => { entry.closed = true; }); return; }
    if (analysisMode === "failed") { response.writeHead(503); response.end("Unavailable"); return; }
    if (analysis === null) { response.writeHead(404); response.end("No analysis"); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(analysis));
  } else if (url.pathname === "/observer/observer-data.json") {
    pollCount += 1;
    entry.mode = responseMode;
    response.setHeader("content-type", "application/json");
    if (responseMode === "held") {
      response.once("close", () => { entry.closed = true; });
    } else if (responseMode === "failed") {
      entry.status = 503;
      response.writeHead(503);
      response.end('{"error":"Controlled transient snapshot failure"}');
    } else if (responseMode === "invalid") {
      response.end('{"schema":"humanish.observer-data.v1","streams":"malformed"}');
    } else response.end(JSON.stringify(data));
  } else if (url.pathname === "/_humanish/history.json") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ latestRunId: data.run.runId, runs: otherData ? [data, otherData].map((run) => ({ runId: run.run.runId,
      href: `/_humanish/runs/${run.run.runId}/observer/index.html`, status: "pass", mode: "live", streamCount: run.streams.length })) : [] }));
  } else if (otherData && url.pathname === `/_humanish/runs/${otherData.run.runId}/observer/observer-data.json`) {
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(otherData));
  } else if (otherData && url.pathname === `/_humanish/runs/${otherData.run.runId}/observer/index.html`) {
    response.setHeader("content-type", "text/html; charset=utf-8"); response.end(inject(otherData));
  } else if (/^\/desktop\/lane-\d+$/.test(url.pathname)) {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end('<!doctype html><html><body style="margin:0;background:#b8cedb;color:#123;font:20px sans-serif"><p>Controlled local desktop fixture</p><p>This is not provider connection proof.</p><button>Keyboard must not enter this read-only view</button>'
      + (exerciseDesktopIsolation ? '<script>try { parent.document.body.dataset.syntheticDesktopEscaped="true"; document.body.dataset.isolated="false"; } catch { document.body.dataset.isolated="true"; }</script>' : '') + '</body></html>');
  } else {
    const match = /^(?:\/_humanish\/runs\/synthetic-other-study)?\/screenshots\/(portrait|landscape)-(\d+)\.png$/.exec(url.pathname);
    if (!match) { entry.status = 404; response.writeHead(404); response.end("Not found"); return; }
    const imageMode = imageModes.get(url.pathname);
    if (imageMode === "missing") { entry.status = 404; response.writeHead(404); response.end("Controlled missing screenshot"); return; }
    if (imageMode === "corrupt") { response.setHeader("content-type", "image/png"); response.end("Controlled invalid PNG"); return; }
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
        // A fullscreen element is in the browser top layer: its former ancestors
        // cannot clip it. Keep checking the fullscreen element's own descendants.
        if (parent === document.fullscreenElement) break;
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
async function assertClearGridScreens(page) {
  const screens = await page.locator(".card").evaluateAll((cards) => cards.map((card) => {
    const area = card.querySelector(".card-preview").getBoundingClientRect();
    const screen = card.querySelector(".thumb").getBoundingClientRect();
    const caption = card.querySelector(".card-caption").getBoundingClientRect();
    return { gutter: Math.abs(area.width - screen.width), left: Math.abs(area.left - screen.left),
      captionBelow: caption.top >= area.bottom - 1, captionHeight: caption.height,
      badgesOrControlsInScreen: card.querySelectorAll(".card-preview .th-pill, .card-preview .th-connection, .card-preview .icon-button").length };
  }));
  assert(screens.length > 0);
  for (const screen of screens) {
    assert(screen.gutter < 1 && screen.left < 1, "The card adds horizontal padding beside the captured screen");
    assert(screen.captionBelow && screen.captionHeight <= 44, "Caption covers the screen or expanded the card footer");
    assert.equal(screen.badgesOrControlsInScreen, 0, "UI chrome covers captured pixels");
  }
  return screens;
}
async function displayedFrame(page) { return page.locator(".stage-box img").first().getAttribute("src"); }
async function readyCapture(locator, expectedSource) {
  await locator.waitFor();
  await until(async () => locator.evaluate((element, source) => element.getAttribute("src")?.endsWith(source)
    && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0, expectedSource), "Expected capture did not finish loading before decode");
  return locator.evaluate(async (element, source) => {
    if (!element.getAttribute('src')?.endsWith(source)) throw new Error('Capture source changed before decoding');
    await element.decode();
    if (!element.complete || !element.naturalWidth || !element.naturalHeight) throw new Error('Capture did not decode');
    // Async image decoding can finish after the route and dimensions are ready.
    // Let the browser paint the decoded capture before retaining visual proof.
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const bounds = element.getBoundingClientRect(), css = getComputedStyle(element);
    if (!element.isConnected || !element.getAttribute('src')?.endsWith(source)) throw new Error('Capture changed before painting');
    if (bounds.width <= 0 || bounds.height <= 0 || css.visibility !== 'visible' || Number(css.opacity) !== 1) throw new Error('Decoded capture is not visible');
    return { source: element.getAttribute('src'), natural: [element.naturalWidth, element.naturalHeight], bounds: bounds.toJSON(), complete: element.complete };
  }, expectedSource);
}
const studySlider = (page) => page.getByRole("slider", { name: "Seek study recording", exact: true });
const studyCard = (page, id) => page.locator(`.card[data-stream-id="${id}"]`);
async function chooseSelect(page, label, value) {
  const trigger = page.getByRole("combobox", { name: label, exact: true });
  await trigger.click();
  const option = page.getByRole("listbox", { name: label, exact: true }).locator(`[role="option"][data-value="${value}"]`);
  await option.click();
  await page.getByRole("listbox", { name: label, exact: true }).waitFor({ state: "hidden" });
}
async function setStudySpeed(page, value) {
  await page.getByRole("button", { name: "Playback options", exact: true }).click();
  await chooseSelect(page, "Study playback speed", String(value));
  await page.getByRole("button", { name: "Close playback options", exact: true }).click();
}
async function followStudy(page) {
  await page.getByRole("button", { name: "Playback options", exact: true }).click();
  await page.getByRole("button", { name: /^(Follow live|Latest captures)$/ }).click();
  const close = page.getByRole("button", { name: "Close playback options", exact: true });
  if (await close.isVisible()) await close.click();
}
async function studyDockGeometry(page, phone) {
  const geometry = await page.locator(".study-playback").evaluate((dock) => {
    const bounds = dock.getBoundingClientRect(), content = document.querySelector("main.content").getBoundingClientRect();
    const controls = [...dock.querySelectorAll('button, input[type="range"]')].filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => ({ label: el.getAttribute("aria-label"), bounds: el.getBoundingClientRect().toJSON() }));
    return { bounds: bounds.toJSON(), content: content.toJSON(), controls, viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth };
  });
  assert(geometry.bounds.height <= 72, "The persistent study transport consumes more than one compact row");
  assert(geometry.bounds.bottom <= geometry.viewport.height + 1 && geometry.bounds.bottom >= geometry.viewport.height - 24,
    "Study transport is not attached to the visible bottom of the app");
  assert(geometry.bounds.left >= -1 && geometry.bounds.right <= geometry.viewport.width + 1 && geometry.pageWidth <= geometry.viewport.width + 1,
    "Study transport causes horizontal overflow");
  assert(geometry.content.bottom <= geometry.bounds.top + 1, "Persistent transport overlays the evidence scroll area");
  const centers = geometry.controls.map(({ bounds }) => bounds.top + bounds.height / 2);
  assert(Math.max(...centers) - Math.min(...centers) <= 2, "Study transport controls wrapped into multiple rows");
  if (phone) for (const { bounds } of geometry.controls) assert(bounds.height >= 44, "A study transport control is smaller than a 44px touch target");
  return geometry;
}
async function seekStudy(page, milliseconds) {
  // Set the native range through its ordinary input/change events for exact
  // fixture instants. Separate checks exercise actual keyboard and touch input.
  const slider = studySlider(page);
  await slider.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, milliseconds);
  await until(async () => Number(await slider.inputValue()) === milliseconds, "Study seek did not retain the requested time");
  await page.getByRole("button", { name: "Play study", exact: true }).waitFor();
}
async function readyStudyCard(page, id, source) {
  const image = studyCard(page, id).locator("img.keyframe");
  await until(async () => (await image.getAttribute("src"))?.endsWith(source), `${id} did not show ${source}`);
  await image.scrollIntoViewIfNeeded();
  return readyCapture(image, source);
}
async function inspectCaptureAges(page) {
  const measurements = await page.locator(".card-capture-age").evaluateAll((elements) => elements.map((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
    const caption = element.closest(".card-caption").getBoundingClientRect();
    const identity = element.closest(".card-identity").getBoundingClientRect();
    const clippingAncestors = [];
    for (let parent = element.parentElement; parent && !parent.matches(".card"); parent = parent.parentElement) {
      const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if ((["hidden", "clip"].includes(css.overflowX) && (text.left < bounds.left - 1 || text.right > bounds.right + 1))
        || (["hidden", "clip"].includes(css.overflowY) && (text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1))) clippingAncestors.push(parent.className);
    }
    return { text: element.textContent, paintedText: text.toJSON(), box: box.toJSON(), caption: caption.toJSON(), identity: identity.toJSON(),
      clippingAncestors, hidden: getComputedStyle(element).visibility !== "visible" || Number(getComputedStyle(element).opacity) !== 1 };
  }));
  assert(measurements.length > 0, "Capture age is not separately readable");
  for (const value of measurements) {
    assert(value.paintedText.width > 0 && value.paintedText.height > 0 && !value.hidden, "Capture age is not visibly rendered");
    for (const bounds of [value.box, value.caption, value.identity]) assert(value.paintedText.left >= bounds.left - 1 && value.paintedText.right <= bounds.right + 1
      && value.paintedText.top >= bounds.top - 1 && value.paintedText.bottom <= bounds.bottom + 1, `Capture age is clipped: ${JSON.stringify(value)}`);
    assert.deepEqual(value.clippingAncestors, [], "An ancestor clips the visible capture age");
  }
  return measurements;
}
function setCaptureTimes(stream, offsets) {
  const trace = stream.actor ?? stream.liveActor;
  trace.items.filter((item) => item.kind === "screenshot").forEach((item, index) => {
    if (offsets[index] === null) delete item.at;
    else item.at = new Date(START + offsets[index]).toISOString();
  });
}
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
  data = fixture({ ...options, origin }); otherData = null; analysis = null; analysisMode = "ok"; imageModes.clear(); responseMode = "ok"; pollCount = 0; exerciseDesktopIsolation = false;
  if (options.prepare) options.prepare();
  const requestStart = requests.length;
  const directory = path.join(output, id); await mkdir(directory);
  const context = await browser.newContext({ viewport: options.phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, deviceScaleFactor: options.dpr ?? 1, ...(options.touch ? { hasTouch: true, isMobile: true } : {}) });
  const unexpectedNetwork = [];
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    if (target.origin === origin || target.protocol === "file:") return route.continue();
    unexpectedNetwork.push(`${target.protocol}//${target.host}${target.pathname}`);
    return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const record = { id, status: "running", startedAt: new Date().toISOString(), checks: {}, screenshots: [] };
  async function snap(label) {
    if (id.startsWith("grid-playback-") || id.startsWith("global-playback-")) await page.evaluate(async () => {
      // Retain painted evidence, including after native seek events. Offscreen
      // lazy images do not need to load merely to photograph this viewport.
      const visible = [...document.images].filter((image) => {
        const box = image.getBoundingClientRect();
        let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right), top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
        for (let parent = image.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (["hidden", "clip", "auto", "scroll"].includes(css.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
          if (["hidden", "clip", "auto", "scroll"].includes(css.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        }
        return right > left && bottom > top;
      });
      await Promise.all(visible.map(async (image) => {
        // A newly visible lazy image may not have begun loading at the end of
        // scrollIntoView. decode() alone can reject before its load event.
        if (!image.complete || !image.naturalWidth) await new Promise((resolve, reject) => {
          const clear = () => { clearTimeout(timer); image.removeEventListener("load", loaded); image.removeEventListener("error", failed); };
          const loaded = () => { clear(); resolve(); }, failed = () => { clear(); reject(new Error("Visible proof capture failed to load")); };
          const timer = setTimeout(() => { clear(); reject(new Error("Visible proof capture did not finish loading")); }, 8000);
          image.addEventListener("load", loaded, { once: true }); image.addEventListener("error", failed, { once: true });
          if (image.complete && image.naturalWidth) loaded();
        });
        await image.decode();
      }));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    });
    const name = `${record.screenshots.length + 1}-${label}.png`;
    await page.screenshot({ path: path.join(directory, name), fullPage: false });
    record.screenshots.push(`${id}/${name}`);
  }
  try {
    await page.goto(`${origin}/observer/index.html`);
    await page.getByRole("region", { name: "Study grid" }).waitFor();
    await snap("grid-before");
    await action({ page, context, directory, record, snap });
    if (axeSource && page.url() === "about:blank") record.checks.accessibility = { status: "not-applicable", reason: "This scenario ends after leaving Observer to prove request teardown." };
    else if (axeSource) {
      await page.addScriptTag({ content: axeSource });
      record.checks.accessibility = await page.evaluate(async () => {
        const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] } });
        const describe = (v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => ({ target: n.target, html: typeof n.target[0] === "string" ? document.querySelector(n.target[0])?.outerHTML.slice(0, 4000) ?? n.html : n.html, failureSummary: n.failureSummary })) });
        // The optional landmark rule treats a body-portal tooltip as page content.
        // Retain that advisory only when the entire portal is a properly associated
        // transient tooltip. Any other outside-landmark content still fails.
        const tooltipAdvisory = (v) => v.id === "region" && v.nodes.every((n) => {
          const portal = typeof n.target[0] === "string" ? document.querySelector(n.target[0]) : null;
          if (!portal?.matches("[data-base-ui-portal]")) return false;
          const hints = [...portal.querySelectorAll('[role="tooltip"]')];
          return hints.length > 0 && hints.map((hint) => hint.textContent.trim()).join("") === portal.textContent.trim()
            && hints.every((hint) => hint.id && document.querySelector(`[aria-describedby~="${CSS.escape(hint.id)}"]`));
        });
        return { violations: result.violations.filter((v) => !tooltipAdvisory(v)).map(describe),
          reviewedAdvisories: result.violations.filter(tooltipAdvisory).map((v) => ({ ...describe(v), reason: "A transient WAI-ARIA tooltip is associated with its trigger and rendered in Base UI's body portal; it does not need a separate page landmark." })),
          incomplete: result.incomplete.map(describe), passes: result.passes.length };
      });
      assert.equal(record.checks.accessibility.violations.length, 0, "Automated accessibility violations remain; inspect the recorded targets");
    }
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
      record.checks.cardChrome = await page.locator(".card").evaluateAll((cards) => cards.map((card) => ({
        footer: card.getBoundingClientRect().height - card.querySelector(".card-preview").getBoundingClientRect().height,
        outcomeHeight: card.querySelector(".card-outcome").getBoundingClientRect().height,
      })));
      assert(record.checks.cardChrome.every((card) => card.footer <= 46 && card.outcomeHeight < 20), "Card footer grew or its outcome wrapped");
      assert.equal(await page.getByLabel("Preview size").count(), 0, "View controls consume default grid space");
      const first = page.locator(".card").first(); await first.hover();
      await first.getByRole("button", { name: /^Participant details:/ }).click();
      await page.locator(".card-details").getByText("FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE").waitFor();
      await snap("participant-details");
      await page.locator(".pop-panel").getByRole("button", { name: /^Compare participant/ }).click();
      await page.getByRole("button", { name: "Compare selected (1/3)", exact: true }).waitFor();
      await page.locator(".pop-panel").getByRole("button", { name: /^Compare participant/ }).click();
      await page.getByRole("button", { name: "Close participant details", exact: true }).click();
      assert.equal(await page.locator(".player").count(), 0, "An icon action opened the player");
      await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
      await page.getByLabel("Search participants").fill("Avery");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".card").count(), 1, "Dismissing the menu erased the filter");
      await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
      await page.getByRole("button", { name: "Clear filters", exact: true }).click();
      await snap("view-menu");
      await page.getByRole("button", { name: "Monitor", exact: true }).click();
      await page.locator(".observer-shell.monitoring").waitFor();
      await page.locator(".pop-panel").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Exit monitor", exact: true }).click();
      assert.equal(await page.locator(".observer-shell.monitoring").count(), 0, "Monitor exit is unreachable");
      if (!phone) {
        record.checks.rows = [];
        for (const [density, expectedHeight] of [["compact", 200], ["comfortable", 280], ["large", 360]]) {
          await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
          await chooseSelect(page, "Preview size", density);
          await page.getByRole("button", { name: "Close view options", exact: true }).click();
          await page.locator(".pop-panel").waitFor({ state: "hidden" });
          const images = await inspectImages(page.locator(".thumb .keyframe"));
          assertFullFrames(images);
          const sizes = images.map((image) => {
            const scale = Math.min(image.box[0] / image.natural[0], image.box[1] / image.natural[1]);
            return { width: image.natural[0] * scale, height: image.natural[1] * scale };
          });
          assert(sizes.every((size) => Math.abs(size.height - expectedHeight) < 1), "Mixed screens do not share the selected preview height");
          assert(sizes[0].width < sizes[1].width * .6, "Phone preview grew as wide as the desktop");
          record.checks.rows.push({ density, sizes });
        }
        await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
        await chooseSelect(page, "Preview size", "comfortable");
        await page.getByLabel("Search participants").fill("Avery");
        await page.keyboard.press("Escape");
        await until(async () => await page.locator(".card").count() === 1, "Portrait-only filter did not settle");
        const only = (await inspectImages(page.locator(".thumb .keyframe")))[0];
        assert(Math.abs(only.box[1] - 280) < 1, "A sparse portrait row enlarged to fill the width");
        await page.locator(".content").evaluate((element) => { element.scrollTop = 0; });
        await snap("portrait-row-keeps-its-height");
      }
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
      if (phone) {
        record.checks.frameToTransport = [];
        for (const shape of ["portrait", "landscape"]) {
          if (shape === "landscape") await page.getByRole("button", { name: "Next participant", exact: true }).click();
          await page.locator('.stage-box[data-image-state="ready"]').waitFor();
          const dock = await studyDockGeometry(page, true);
          await page.locator(".stage-box").scrollIntoViewIfNeeded();
          const image = await page.locator(".stage-box").boundingBox();
          assert(image.y + image.height <= dock.bounds.top + 1, `${shape} fitted capture is covered by the persistent transport`);
          record.checks.frameToTransport.push({ shape, image, transport: dock.bounds });
          assertFullFrames(await inspectImages(page.locator(".stage-box img")));
          await snap(`${shape}-frame-above-persistent-controls`);
        }
      }
    });
  }
  for (const phone of [false, true]) await runCase(`grid-playback-${phone ? "phone" : "desktop"}`, {
    phone, touch: phone, laneCount: 2, prepare() {
      setCaptureTimes(data.streams[0], [0, 2000, 4000, 6000]);
      setCaptureTimes(data.streams[1], [0, 2500, 4500, 6500]);
    },
  }, async ({ page, record, snap }) => {
    const slider = studySlider(page);
    await slider.waitFor();
    assert.equal(await slider.getAttribute("min"), "0");
    assert.equal(Number(await slider.getAttribute("max")), 6500, "Study clock does not span all capture timestamps");
    await readyStudyCard(page, "lane-1", "portrait-4.png");
    await readyStudyCard(page, "lane-2", "landscape-4.png");
    await setStudySpeed(page, 4);
    const play = page.getByRole("button", { name: "Play study", exact: true });
    if (phone) {
      const bounds = await play.boundingBox();
      assert(bounds.height >= 44 && bounds.width >= 44, "Study playback is not a 44px touch target");
      await play.tap();
    } else await play.click();
    await page.getByRole("button", { name: "Pause study", exact: true }).waitFor();
    const startSources = await page.locator(".card img.keyframe").evaluateAll((elements) => elements.map((element) => element.getAttribute("src")));
    assert.equal(startSources.length, 2);
    assert(startSources.every((source) => source.endsWith("-1.png")), "Play from latest previews did not begin at the first capture time");
    await until(async () => {
      const sources = await page.locator(".card img.keyframe").evaluateAll((elements) => elements.map((element) => element.getAttribute("src")));
      return sources.length === 2 && sources.every((source) => /-(?:2|3)\.png$/.test(source));
    }, "A shared playing clock did not advance both participant cards");
    await page.getByRole("button", { name: "Pause study", exact: true }).click();
    record.checks.advancedTogether = await page.locator(".card img.keyframe").evaluateAll((elements) => elements.map((element) => element.getAttribute("src")));
    const paused = await slider.inputValue(); await wait(250);
    assert.equal(await slider.inputValue(), paused, "Pause did not stop the shared clock");
    await play.click();
    await until(async () => await slider.inputValue() === "6500", "Whole-study playback did not reach the last retained timestamp");
    await play.waitFor();
    assert.equal(await page.locator(".thumb iframe").count(), 0, "Playback end unexpectedly entered live mode");
    record.checks.stoppedAtEnd = true;
    await seekStudy(page, 3000);
    record.checks.sharedCaptures = [await readyStudyCard(page, "lane-1", "portrait-2.png"), await readyStudyCard(page, "lane-2", "landscape-2.png")];
    assertFullFrames(await inspectImages(page.locator(".card img.keyframe")));
    record.checks.readableCaptureAges = await inspectCaptureAges(page);
    if (phone) { await studyCard(page, "lane-2").scrollIntoViewIfNeeded(); await snap("complete-second-card-and-age"); }
    await page.locator(".study-playback").scrollIntoViewIfNeeded(); await snap("two-participants-at-shared-time");
    const clippedAge = await page.addStyleTag({ content: ".card-capture-age { width:8px !important; max-width:8px !important; overflow:hidden !important }" });
    let clippedAgeRejected = false; try { await inspectCaptureAges(page); } catch { clippedAgeRejected = true; }
    assert(clippedAgeRejected, "Capture-age guard accepted deliberately clipped text");
    record.checks.clippedAgeRejected = clippedAgeRejected;
    await clippedAge.evaluate((element) => element.remove()); await inspectCaptureAges(page);
    record.checks.paintedStates = [];
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      for (const value of [0, 3000, 6500]) {
        await seekStudy(page, value); await page.evaluate(() => document.activeElement?.blur());
        const measurement = await scrubberPixels(page, "Seek study recording");
        assertScrubberAligned(measurement); record.checks.paintedStates.push({ theme, value, ...measurement });
      }
      await snap(`${theme}-study-scrubber`);
    }
    const broken = await page.addStyleTag({ content: ".study-playback .scrub-track { top:0 !important; transform:none !important }" });
    const negative = await scrubberPixels(page, "Seek study recording");
    let rejected = false; try { assertScrubberAligned(negative); } catch { rejected = true; }
    assert(rejected, "Study scrubber guard accepted deliberately displaced track pixels");
    record.checks.knownBrokenControl = { rejected, measurement: negative }; await snap("known-broken-study-control");
    await broken.evaluate((element) => element.remove());
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await slider.press("Home"); assert.equal(await slider.inputValue(), "0");
    await slider.press("ArrowRight"); assert(Number(await slider.inputValue()) > 0, "Keyboard seek did not advance the shared clock");
    const bounds = await slider.boundingBox();
    if (phone) {
      assert(bounds.height >= 44, "Study scrubber is not a 44px touch target");
      await slider.tap({ position: { x: bounds.width * .7, y: bounds.height / 2 } });
      record.checks.touch = await page.evaluate(() => ({ coarse: matchMedia("(pointer: coarse)").matches, noHover: matchMedia("(hover: none)").matches, points: navigator.maxTouchPoints }));
      assert(record.checks.touch.coarse && record.checks.touch.noHover && record.checks.touch.points > 0);
    } else await slider.click({ position: { x: bounds.width * .7, y: bounds.height / 2 } });
    const touched = Number(await slider.inputValue());
    assert(touched > 3250 && touched < 5850, "Pointer/touch seek missed the selected region of the shared clock");
    await slider.focus(); assert.equal(await slider.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
    assertScrubberAligned(await scrubberPixels(page, "Seek study recording"));
    record.checks.width = await pageWidth(page); assert(record.checks.width.page <= record.checks.width.viewport + 1);
    await snap("restored-study-transport");
  });
  await runCase("grid-playback-coverage", { frames: 3, laneCount: 4, running: true, live: true, prepare() {
    setCaptureTimes(data.streams[0], [0, 10_000, 30_000]);
    setCaptureTimes(data.streams[1], [5000, 15_000, 25_000]);
    for (const item of data.streams[2].liveActor.items) delete item.at;
    data.streams[3].liveActor.items = data.streams[3].liveActor.items.filter((item) => !item.screenshotRef);
  } }, async ({ page, record, snap }) => {
    await seekStudy(page, 2000);
    assert.equal(await studyCard(page, "lane-2").locator("img.keyframe").count(), 0, "A later participant borrowed a future capture");
    assert.match(await studyCard(page, "lane-2").innerText(), /before|not started|outside recorded coverage|no capture yet/i);
    for (const id of ["lane-3", "lane-4"]) assert.equal(await studyCard(page, id).locator("img.keyframe").count(), 0, `${id} fabricated a shared-time image`);
    assert.match(await studyCard(page, "lane-3").innerText(), /unknown|unavailable|not recorded/i);
    assert.match(await studyCard(page, "lane-4").innerText(), /no (?:recorded )?(?:captures|screenshots)|no captured screens|no visual|unavailable/i);
    await readyStudyCard(page, "lane-1", "portrait-1.png"); await snap("before-and-unknown-coverage");
    record.checks.unalignedRecordingOpen = [];
    for (const id of ["lane-2", "lane-3", "lane-4"]) {
      await studyCard(page, id).locator(".open-overlay").click();
      await page.getByRole("button", { name: "Back to participants", exact: true }).waitFor();
      if (id === "lane-3") {
        assert.equal(await studySlider(page).count(), 0, "An untimed recording advertised a known shared capture clock");
        await readyCapture(page.locator(".stage-box img").first(), "portrait-1.png");
      } else {
        assert.equal(await studySlider(page).inputValue(), "2000", "Opening a coverage gap moved the study clock");
        assert.equal(await page.locator(".stage-box img").count(), 0, "Opening a coverage gap borrowed a future capture");
      }
      assert.equal(await page.locator("iframe").count(), 0, "Opening a coverage gap silently connected to the live desktop");
      await snap(`${id}-honest-recording-coverage`);
      await page.getByRole("button", { name: "Back to participants", exact: true }).click();
      await studySlider(page).waitFor();
      assert.equal(await studySlider(page).inputValue(), "2000", "Returning from an unaligned lane changed the shared cursor");
      await page.getByRole("button", { name: "Play study", exact: true }).waitFor();
      assert.equal(await page.locator(".thumb iframe").count(), 0);
      assert.equal(await studyCard(page, id).locator("img.keyframe").count(), 0, "Returning fabricated shared-time coverage");
      record.checks.unalignedRecordingOpen.push({ id, localUntimedRecording: id === "lane-3", returnedCursor: 2000, liveConnection: false });
    }
    imageModes.set("/screenshots/portrait-2.png", "missing");
    await seekStudy(page, 12_000);
    await studyCard(page, "lane-1").getByText("Frame unavailable", { exact: true }).waitFor();
    const failedRequest = requests.findLast((entry) => entry.path === "/screenshots/portrait-2.png" && entry.status === 404);
    assert(failedRequest, "Missing replay frame did not issue a real failed HTTP request");
    assert.equal(await studyCard(page, "lane-1").locator("img.keyframe").count(), 0, "Missing replay capture silently fell back to another image");
    await snap("selected-replay-frame-missing"); imageModes.delete("/screenshots/portrait-2.png");
    await studyCard(page, "lane-1").getByRole("button", { name: "Retry frame", exact: true }).click();
    await readyStudyCard(page, "lane-1", "portrait-2.png");
    assert.equal(await studySlider(page).inputValue(), "12000", "Retry changed the selected study moment");
    assert.equal(await page.locator(".thumb iframe").count(), 0, "Retry silently entered live mode");
    record.checks.imageRetry = { actual404: true, restored: "portrait-2.png", cursor: 12_000 };
    await readyStudyCard(page, "lane-2", "landscape-1.png");
    const captions = await page.locator('.card[data-stream-id="lane-1"] .card-capture-time, .card[data-stream-id="lane-2"] .card-capture-time').allTextContents();
    assert.equal(captions.length, 2); assert.match(captions[0], /0:02|2s|2 s/); assert.match(captions[1], /0:07|7s|7 s/);
    record.checks.priorCaptureCaptions = captions; await snap("different-capture-ages");
    await seekStudy(page, 28_000); await readyStudyCard(page, "lane-2", "landscape-3.png");
    const after = await studyCard(page, "lane-2").locator(".card-capture-time").innerText();
    assert.equal(after, "3s ago", "A held final capture lost its visible age");
    await studyCard(page, "lane-2").getByRole("button", { name: /^Participant details:/ }).click();
    const heldDetails = page.locator(".card-details");
    await heldDetails.getByText("Last capture · 00:03 before cursor", { exact: true }).waitFor();
    record.checks.afterEnd = { caption: after, details: await heldDetails.innerText() };
    await snap("held-last-capture-details"); await page.keyboard.press("Escape");
    await heldDetails.waitFor({ state: "hidden" });
    // A dataset with no trustworthy capture timestamp cannot invent playback.
    for (const stream of data.streams) for (const item of stream.liveActor.items) delete item.at;
    await page.reload();
    assert(await studySlider(page).isDisabled(), "Unstamped evidence offered a fabricated seekable study clock");
    assert(await page.getByRole("button", { name: "Play study", exact: true }).isDisabled());
    await snap("unstamped-study-disabled");
  });
  await runCase("grid-playback-live-growth", { running: true, live: true, laneCount: 6 }, async ({ page, record, snap }) => {
    await until(async () => await page.locator(".thumb-live").count() > 0, "Initial live previews did not attach");
    assert(await page.locator(".thumb-live").count() <= 4);
    await seekStudy(page, 7000);
    await readyStudyCard(page, "lane-1", "portrait-2.png");
    assert.equal(await page.locator(".thumb iframe").count(), 0, "Grid replay left a desktop connected");
    const requestBoundary = requests.length, cursor = await studySlider(page).inputValue(), max = Number(await studySlider(page).getAttribute("max"));
    appendFrame(data);
    await until(async () => Number(await studySlider(page).getAttribute("max")) > max, "New evidence did not extend the shared clock");
    assert.equal(await studySlider(page).inputValue(), cursor, "Evidence growth moved a paused study cursor");
    await readyStudyCard(page, "lane-1", "portrait-2.png");
    assert.equal(await page.locator(".thumb iframe").count(), 0, "Polling reattached desktop streams during replay");
    assert.equal(requests.slice(requestBoundary).filter((entry) => entry.path.startsWith("/desktop/")).length, 0);
    record.checks.pausedGrowth = { cursor, oldDuration: max, newDuration: Number(await studySlider(page).getAttribute("max")) };
    await page.locator(".study-playback").scrollIntoViewIfNeeded(); await snap("live-evidence-grows-while-paused");
    await followStudy(page);
    await until(async () => await page.locator(".thumb-live").count() > 0, "Explicit follow did not restore visible live previews");
    assert(await page.locator(".thumb-live").count() <= 4, "Follow live exceeded the existing connection limit");
    record.checks.followConnections = await page.locator(".thumb-live").count(); await snap("explicit-follow-restores-streams");
  });
  await runCase("grid-playback-navigation", { laneCount: 40, prepare() {
    setCaptureTimes(data.streams[39], [7000, 14_000, 21_000, 70_000]);
  } }, async ({ page, record, snap }) => {
    await seekStudy(page, 14_000);
    const duration = await studySlider(page).getAttribute("max");
    assert.equal(Number(duration), 63_000, "Off-page evidence did not contribute to the study extent");
    await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
    await page.getByLabel("Search participants").fill("Avery");
    await page.getByRole("button", { name: "Close view options", exact: true }).click();
    assert.equal(await page.locator(".card").count(), 1);
    assert.equal(await studySlider(page).getAttribute("max"), duration, "Filtering silently changed the study clock");
    assert.equal(await studySlider(page).inputValue(), "14000");
    await readyStudyCard(page, "lane-1", "portrait-3.png");
    await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await page.getByRole("button", { name: "Close view options", exact: true }).click();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    assert.equal(await page.locator(".card").count(), 4);
    await readyStudyCard(page, "lane-40", "landscape-3.png");
    await studyCard(page, "lane-40").locator(".card-preview").click();
    await page.locator(".player").waitFor();
    assert.match(page.url(), /#\/lane\/lane-40\/f\/3(?:\/|$|\?)/, "Card opened a different recording moment");
    await readyCapture(page.locator(".stage-box img").first(), "landscape-3.png");
    await snap("exact-card-recording");
    await page.getByRole("button", { name: "Back to participants", exact: true }).click();
    await studySlider(page).waitFor();
    assert.equal(await studySlider(page).inputValue(), "14000");
    assert.equal(await page.locator(".card").count(), 4, "Returning from a recording lost the participant page");
    await page.getByRole("button", { name: "Play study", exact: true }).waitFor();
    await readyStudyCard(page, "lane-40", "landscape-3.png");
    await studyCard(page, "lane-40").locator(".card-preview").click();
    await page.locator(".player").waitFor(); await page.goBack(); await studySlider(page).waitFor();
    assert.equal(await studySlider(page).inputValue(), "14000");
    assert.equal(await page.locator(".card").count(), 4, "Browser Back lost the participant page");
    await page.getByRole("button", { name: "Play study", exact: true }).waitFor();
    await studyCard(page, "lane-40").getByRole("button", { name: /^Participant details:/ }).click();
    await page.getByRole("button", { name: "Pin participant Synthetic participant 40", exact: true }).click();
    const closeDetails = page.getByRole("button", { name: "Close participant details", exact: true });
    if (await closeDetails.isVisible()) await closeDetails.click();
    assert.equal(await studySlider(page).getAttribute("max"), duration, "Pinning changed the shared clock extent");
    assert.equal(await studySlider(page).inputValue(), "14000");
    await page.getByRole("button", { name: "Previous page", exact: true }).click();
    assert.equal(await page.locator(".card").first().getAttribute("data-stream-id"), "lane-40");
    await readyStudyCard(page, "lane-40", "landscape-3.png");
    await page.locator(".study-playback").scrollIntoViewIfNeeded(); await snap("paused-grid-cursor-and-pin-restored");
    record.checks.navigation = { extent: Number(duration), cursor: 14_000, exactFrame: 2, sourcePageRestored: true, browserBackRestored: true };
  });
  for (const phone of [false, true]) await runCase(`global-playback-${phone ? "phone" : "desktop"}`, {
    phone, touch: phone, laneCount: 8, prepare() {
      setCaptureTimes(data.streams[0], [0, 7000, 14_000, 21_000]);
      setCaptureTimes(data.streams[1], [0, 10_000, 20_000, 30_000]);
    },
  }, async ({ page, record, snap }) => {
    record.checks.initialDock = await studyDockGeometry(page, phone);
    await page.locator(".card").last().scrollIntoViewIfNeeded();
    record.checks.scrolledDock = await studyDockGeometry(page, phone);
    assert(Math.abs(record.checks.initialDock.bounds.top - record.checks.scrolledDock.bounds.top) <= 1, "Scrolling evidence moved the persistent dock");
    const lastCaption = await page.locator(".card-caption").last().boundingBox();
    assert(lastCaption.y + lastCaption.height <= record.checks.scrolledDock.bounds.top + 1, "The last participant caption is hidden behind the dock");
    await snap("last-evidence-reachable-above-dock");
    await seekStudy(page, 15_000);
    await readyStudyCard(page, "lane-1", "portrait-3.png");
    await readyStudyCard(page, "lane-2", "landscape-2.png");
    await studyCard(page, "lane-1").locator(".open-overlay").click();
    await page.locator(".player").waitFor();
    assert.equal(await studySlider(page).inputValue(), "15000", "Opening a participant rounded the global clock to its previous screenshot");
    await readyCapture(page.locator(".stage-box img").first(), "portrait-3.png");
    assert.equal(await page.getByRole("slider", { name: "Seek recording time", exact: true }).count(), 0, "A timed participant has a second independent playback clock");
    record.checks.participantDock = await studyDockGeometry(page, phone);
    await snap("halfway-open-retains-study-time");
    await seekStudy(page, 10_000);
    await readyCapture(page.locator(".stage-box img").first(), "portrait-2.png");
    await page.getByRole("button", { name: "Back to participants", exact: true }).click();
    await studySlider(page).waitFor();
    assert.equal(await studySlider(page).inputValue(), "10000", "Returning restored an obsolete grid cursor instead of the participant's shared seek");
    await readyStudyCard(page, "lane-1", "portrait-2.png");
    await readyStudyCard(page, "lane-2", "landscape-2.png");
    record.checks.sharedSeek = { initialMs: 15_000, participantSeekMs: 10_000, returnedMs: 10_000 };
    await snap("one-third-across-whole-grid");
    await setStudySpeed(page, 1);
    await page.getByRole("button", { name: "Play study", exact: true }).click();
    await until(async () => Number(await studySlider(page).inputValue()) > 10_100, "Global playback did not advance");
    const beforeOpen = Number(await studySlider(page).inputValue());
    await studyCard(page, "lane-1").locator(".open-overlay").click();
    await page.locator(".player").waitFor();
    await page.getByRole("button", { name: "Pause study", exact: true }).waitFor();
    await until(async () => Number(await studySlider(page).inputValue()) > beforeOpen + 200, "Opening a participant paused or restarted the study clock");
    const beforeReturn = Number(await studySlider(page).inputValue());
    await page.getByRole("button", { name: "Back to participants", exact: true }).click();
    await page.getByRole("button", { name: "Pause study", exact: true }).waitFor();
    await until(async () => Number(await studySlider(page).inputValue()) > beforeReturn + 200, "Returning to the grid paused or restarted the study clock");
    await page.getByRole("button", { name: "Pause study", exact: true }).click();
    const afterReturn = Number(await studySlider(page).inputValue());
    assert(afterReturn >= beforeReturn && afterReturn < 20_000, "Ordinary navigation jumped to a different part of the study");
    record.checks.playingNavigation = { beforeOpen, beforeReturn, afterReturn };
    await snap("playing-state-survives-navigation");
    // Browser Back also restores the current shared time, not an old frame URL.
    await seekStudy(page, 15_000);
    await studyCard(page, "lane-1").locator(".open-overlay").click();
    await page.locator(".player").waitFor(); await seekStudy(page, 10_000);
    await page.goBack(); await studySlider(page).waitFor();
    await page.getByRole("region", { name: "Study grid" }).waitFor();
    assert.equal(await studySlider(page).inputValue(), "10000", "Browser Back discarded the participant's shared seek");
    record.checks.browserBack = { returnedMs: 10_000 };
    await readyStudyCard(page, "lane-1", "portrait-2.png");
    record.checks.finalDock = await studyDockGeometry(page, phone);
    await snap("browser-back-keeps-global-time");
  });
  await runCase("local-playback-untimed-phone", { phone: true, touch: true, laneCount: 2, prepare() {
    for (const stream of data.streams) for (const item of stream.actor.items) if (item.screenshotRef) delete item.at;
  } }, async ({ page, record, snap }) => {
    await openLane(page);
    assert.equal(await studySlider(page).count(), 0, "Untimed evidence advertised known shared timing");
    record.checks.frameToTransport = [];
    for (const shape of ["portrait", "landscape"]) {
      if (shape === "landscape") await page.getByRole("button", { name: "Next participant", exact: true }).click();
      await readyCapture(page.locator(".stage-box img").first(), `${shape}-1.png`);
      await until(async () => {
        const image = await page.locator(".stage-box").boundingBox(), transport = await page.locator(".transport").boundingBox();
        return image && transport && transport.y - image.y - image.height <= 14;
      }, `${shape} local fit recording leaves empty space before phone controls`);
      const image = await page.locator(".stage-box").boundingBox(), transport = await page.locator(".transport").boundingBox();
      record.checks.frameToTransport.push({ shape, image, transport, gap: transport.y - image.y - image.height });
      assertFullFrames(await inspectImages(page.locator(".stage-box img")));
      assertScrubberAligned(await scrubberPixels(page));
      await snap(`${shape}-local-frame-adjacent-controls`);
    }
  });
  await runCase("global-playback-exact-address", { laneCount: 2, prepare() {
    setCaptureTimes(data.streams[0], [0, 7000, 7000, 21_000]);
    setCaptureTimes(data.streams[1], [0, 7000, 14_000, 21_000]);
  } }, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/2`);
    await page.locator(".player").waitFor();
    await readyCapture(page.locator(".stage-box img").first(), "portrait-2.png");
    assert.equal(await studySlider(page).inputValue(), "7000");
    await wait(250); assert((await displayedFrame(page)).endsWith("portrait-2.png"), "Shared time replaced an explicitly addressed duplicate-timestamp capture");
    await page.reload(); await page.locator(".player").waitFor();
    await readyCapture(page.locator(".stage-box img").first(), "portrait-2.png");
    await snap("explicit-duplicate-capture-survives-reload");
    await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/2/e/lane-1-action-2`);
    await page.locator(".player").waitFor();
    await readyCapture(page.locator(".stage-box img").first(), "portrait-2.png");
    assert.match(page.url(), /\/f\/2\/e\/lane-1-action-2$/, "An exact entry address lost its event identity");
    record.checks.explicitAddress = { frame: 1, eventId: "lane-1-action-2", sharedMs: Number(await studySlider(page).inputValue()) };
    await snap("exact-event-keeps-addressed-capture");
    await seekStudy(page, 8000); await readyCapture(page.locator(".stage-box img").first(), "portrait-3.png");
    assert(!page.url().includes("/e/"), "A new shared seek retained an unrelated explicit entry selection");
    record.checks.explicitOverrideReleasedOnSeek = true;
  });
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
  await runCase("playing-refresh", {}, async ({ page, record, snap }) => {
    await openLane(page);
    await setStudySpeed(page, 2);
    await page.getByRole("button", { name: "Play study", exact: true }).click();
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    assert.equal(await page.getByRole("button", { name: "Pause study", exact: true }).count(), 1, "Playback stopped before the reload check");
    record.checks.before = await displayedFrame(page);
    assert(page.url().endsWith("/f/2"), "Playing frame was missing from the address");
    await page.reload();
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    record.checks.after = await displayedFrame(page);
    assert.equal(record.checks.after, record.checks.before, "Reload returned to an earlier addressed frame");
    await snap("reload-keeps-playing-moment");
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
  await runCase("live-raster-geometry", { running: true, live: true, laneCount: 2, prepare() {
    for (const stream of data.streams) { delete stream.viewport; delete stream.desktopGeometry; }
  } }, async ({ page, record, snap }) => {
    const nativeRatio = 390 / 844;
    const grid = page.locator('[data-stream-id="lane-1"] .thumb');
    await until(async () => { const box = await grid.boundingBox(); return box && Math.abs(box.width / box.height - nativeRatio) < .01; }, "Live portrait grid did not learn its raster aspect ratio");
    record.checks.grid = await grid.boundingBox(); await snap("live-grid-native-raster");
    await openLane(page);
    await until(async () => { const box = await page.locator(".stage-live").boundingBox(); return box && Math.abs(box.width / box.height - nativeRatio) < .01; }, "Live portrait player did not learn its raster aspect ratio");
    record.checks.player = await page.locator(".stage-live").boundingBox(); await snap("live-player-native-raster");
  });
  await runCase("stream-capacity", { running: true, live: true, laneCount: 24 }, async ({ page, record, snap }) => {
    await wait(600); record.checks.initial = await page.locator(".thumb iframe").count();
    assert(record.checks.initial > 0 && record.checks.initial <= 4, "Grid must bound attached desktop previews to four");
    const last = page.locator(".card").last(); await last.scrollIntoViewIfNeeded(); await last.hover();
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
  await runCase("image-retry", { prepare: () => imageModes.set("/screenshots/portrait-1.png", "missing") }, async ({ page, record, snap }) => {
    await openLane(page);
    await page.getByRole("button", { name: "Retry image", exact: true }).waitFor();
    record.checks.missing = await page.locator(".stage-box").getAttribute("data-image-state");
    assert.equal(record.checks.missing, "error"); await snap("missing-image");
    imageModes.set("/screenshots/portrait-1.png", "corrupt");
    await page.getByRole("button", { name: "Retry image", exact: true }).click();
    await until(() => requests.some((r) => r.path === "/screenshots/portrait-1.png" && r.status === 200), "Retry made no real image request");
    await page.getByRole("button", { name: "Retry image", exact: true }).waitFor(); await snap("corrupt-image");
    imageModes.clear(); await page.getByRole("button", { name: "Retry image", exact: true }).click();
    await page.locator('.stage-box[data-image-state="ready"]').waitFor();
    record.checks.recovered = await displayedFrame(page); await snap("image-recovered");
    assert(record.checks.recovered.endsWith("portrait-1.png"));
  });
  await runCase("zoom-fullscreen", {}, async ({ page, record, snap }) => {
    await openLane(page); await page.locator('.stage-box[data-image-state="ready"]').waitFor();
    const zoom = page.getByLabel("Image zoom");
    await chooseSelect(page, "Image zoom", "actual");
    record.checks.actual = await page.locator(".stage-box img").evaluate((img) => ({ width: img.getBoundingClientRect().width, natural: img.naturalWidth }));
    assert(Math.abs(record.checks.actual.width - record.checks.actual.natural) <= 2, "Actual size is not native pixel size");
    await chooseSelect(page, "Image zoom", "2");
    record.checks.double = await page.locator(".stage-box img").evaluate((img) => ({ width: img.getBoundingClientRect().width, natural: img.naturalWidth }));
    assert(Math.abs(record.checks.double.width - 2 * record.checks.double.natural) <= 2, "200% zoom did not scale the recording");
    record.checks.pin = await page.locator(".stage-box").evaluate((stage) => {
      const image = stage.querySelector("img").getBoundingClientRect(), pin = stage.querySelector(".spin").getBoundingClientRect();
      return { actual: [pin.left + pin.width / 2, pin.top + pin.height / 2], expected: [image.left + image.width * 120 / 390, image.top + image.height * 240 / 844] };
    });
    assert(record.checks.pin.actual.every((value, index) => Math.abs(value - record.checks.pin.expected[index]) < 3), "Click marker detached from screenshot coordinates under zoom");
    record.checks.width = await pageWidth(page);
    assert(record.checks.width.page <= record.checks.width.viewport + 1, "Zoom overflow escaped the evidence stage");
    await snap("zoomed-evidence"); await chooseSelect(page, "Image zoom", "fit");
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await until(() => page.evaluate(() => document.fullscreenElement !== null), "Native fullscreen never opened");
    assertFullFrames(await inspectImages(page.locator(".stage-box img"))); await snap("native-fullscreen");
    await page.locator(".stage").click({ position: { x: 8, y: 8 } }); await page.keyboard.press("ArrowRight");
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    await page.getByRole("button", { name: "Playback options", exact: true }).click();
    const options = page.locator('.pop-panel[aria-label="Playback options"]'); await options.waitFor();
    record.checks.fullscreenOptions = await options.evaluate((panel) => {
      const box = panel.getBoundingClientRect();
      return { inFullscreen: !!document.fullscreenElement?.contains(panel), bounds: box.toJSON(),
        visible: getComputedStyle(panel).visibility === "visible", viewport: [innerWidth, innerHeight] };
    });
    assert(record.checks.fullscreenOptions.inFullscreen, "Playback options portal is outside the fullscreen element");
    assert(record.checks.fullscreenOptions.visible && record.checks.fullscreenOptions.bounds.width > 0 && record.checks.fullscreenOptions.bounds.height > 0);
    await page.getByRole("combobox", { name: "Study playback speed", exact: true }).click();
    const speedMenu = page.getByRole("listbox", { name: "Study playback speed", exact: true }); await speedMenu.waitFor();
    assert(await speedMenu.evaluate((element) => !!document.fullscreenElement?.contains(element)), "Nested speed menu escaped native fullscreen");
    await snap("fullscreen-speed-dropdown");
    await page.keyboard.press("Escape"); await speedMenu.waitFor({ state: "hidden" });
    assert(await options.isVisible(), "Escape closed fullscreen playback options with their nested dropdown");
    await chooseSelect(page, "Study playback speed", "2");
    assert.equal(await page.getByRole("combobox", { name: "Study playback speed", exact: true }).innerText(), "2×");
    await snap("fullscreen-playback-options");
    await page.getByRole("button", { name: "Latest captures", exact: true }).click();
    const closeOptions = page.getByRole("button", { name: "Close playback options", exact: true });
    if (await closeOptions.isVisible()) await closeOptions.click();
    await readyCapture(page.locator(".stage-box img").first(), "portrait-4.png");
    assert(await page.evaluate(() => document.fullscreenElement !== null), "Changing playback options unexpectedly exited fullscreen");
    record.checks.fullscreenOptions.speedChanged = true; record.checks.fullscreenOptions.latestCapture = "portrait-4.png";
    await snap("fullscreen-latest-capture");
    await page.keyboard.press("Escape");
    record.checks.syntheticEscapeExitedFullscreen = await page.evaluate(() => document.fullscreenElement === null);
    // CDP-generated Escape does not trigger browser fullscreen exit in current
    // headless Chromium (also reproduced on a two-button native HTML control).
    // Exercise the product's real exit button; retain the keyboard limitation.
    if (!record.checks.syntheticEscapeExitedFullscreen) await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await until(() => page.evaluate(() => document.fullscreenElement === null), "Fullscreen exit control failed");
    assert(await page.locator(".player").count() === 1, "Fullscreen Escape also navigated away from participant");
  });
  await runCase("native-permission-denial", {}, async ({ page, record, snap }) => {
    await page.goto(`${origin}/restricted-browser`);
    const app = page.frameLocator('iframe[title="Observer with browser permissions denied"]');
    await app.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await app.getByText(/Fullscreen is unavailable/).waitFor(); await snap("fullscreen-denied");
    await app.getByRole("button", { name: "Copy moment link", exact: true }).click();
    const link = app.getByRole("textbox", { name: "Moment link", exact: true }); await link.waitFor();
    record.checks.manualLink = await link.inputValue();
    assert(record.checks.manualLink.endsWith("#/lane/lane-1/f/2"), "Clipboard fallback does not identify visible frame");
    assert(!record.checks.manualLink.includes("/desktop/"), "Moment link leaked live desktop URL");
    await snap("clipboard-manual-fallback");
  });
  for (const phone of [false, true]) await runCase(`rich-controls-${phone ? "phone" : "desktop"}`, { phone, touch: phone, laneCount: 18, prepare() {
    data.streams[1].statusLabel = "Review requested";
    data.streams[2].statusLabel = "Waiting for a synthetic follow-up with a deliberately long description";
    data.streams.slice(3).forEach((stream, index) => { stream.statusLabel = `Synthetic state ${index + 4}`; });
  } }, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html`);
    const trigger = page.getByRole("button", { name: "View and filter participants", exact: true });
    await trigger.click();
    const panel = page.locator('.pop-panel[aria-label="View and filter participants"]');
    const status = page.getByRole("combobox", { name: "Participant status", exact: true });
    await status.focus(); await page.keyboard.press("Enter");
    const menu = page.getByRole("listbox", { name: "Participant status", exact: true });
    await menu.waitFor();
    await page.keyboard.press("r"); await page.keyboard.press("Enter");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await status.innerText(), "Running / preparing", "Typeahead/Enter did not select the matching status");
    assert.equal(await page.locator(".card").count(), 0, "Rich status control did not filter participants");
    assert(await panel.isVisible(), "Selecting an option dismissed the containing view panel");
    await status.click(); await menu.waitFor();
    record.checks.menu = await menu.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { bounds: box.toJSON(), viewport: [innerWidth, innerHeight], optionHeights: [...element.querySelectorAll('[role="option"]')].map((item) => item.getBoundingClientRect().height) };
    });
    assert(record.checks.menu.bounds.left >= 0 && record.checks.menu.bounds.right <= record.checks.menu.viewport[0], "Options overflow the viewport");
    assert(record.checks.menu.bounds.top >= 0 && record.checks.menu.bounds.bottom <= record.checks.menu.viewport[1], "Options are clipped above or below the viewport");
    if (phone) assert(record.checks.menu.optionHeights.every((height) => height >= 44), "Phone select options miss the 44px target");
    await snap("status-dropdown");
    await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
    assert(await panel.isVisible(), "First Escape dismissed the parent instead of only the dropdown");
    assert(await status.evaluate((element) => element === document.activeElement), "Escape did not restore focus to the select trigger");
    await page.keyboard.press("Escape"); await panel.waitFor({ state: "hidden" });
    assert(await trigger.evaluate((element) => element === document.activeElement), "Second Escape did not restore focus to view options");
    await trigger.click(); await status.click(); await menu.waitFor();
    await page.keyboard.press("End");
    const last = menu.getByRole("option", { name: "Synthetic state 18", exact: true });
    await until(async () => last.evaluate((element) => element.hasAttribute("data-highlighted")), "End did not highlight the last option");
    record.checks.scrolling = await last.evaluate((element) => {
      const list = element.closest('[role="listbox"]'), item = element.getBoundingClientRect(), bounds = list.getBoundingClientRect();
      return { scrollTop: list.scrollTop, item: item.toJSON(), list: bounds.toJSON() };
    });
    assert(record.checks.scrolling.scrollTop > 0 && record.checks.scrolling.item.top >= record.checks.scrolling.list.top - 1 && record.checks.scrolling.item.bottom <= record.checks.scrolling.list.bottom + 1, "Keyboard selected option is hidden in the long menu");
    await snap("scrolled-dropdown"); await page.keyboard.press("Enter");
    assert.equal(await page.locator(".card").count(), 1, "Long menu selection did not update the filter");
    await chooseSelect(page, "Participant status", "");
    if (phone) {
      await page.getByRole("combobox", { name: "Participant kind", exact: true }).tap();
      await page.getByRole("listbox", { name: "Participant kind", exact: true }).getByRole("option", { name: "Browser", exact: true }).tap();
      await page.getByRole("listbox", { name: "Participant kind", exact: true }).waitFor({ state: "hidden" });
    } else await chooseSelect(page, "Participant kind", "Browser");
    assert.equal(await page.locator(".card").count(), 18, "Rich kind control changed the matching participants");
    assert.equal(await page.locator(".filter-count").innerText(), "1");
    await chooseSelect(page, "Preview size", "compact");
    await page.getByRole("button", { name: "Close view options", exact: true }).click();
    await page.reload(); await trigger.click();
    assert.equal(await page.getByRole("combobox", { name: "Preview size", exact: true }).innerText(), "Compact", "Rich preview control lost persisted selection");
    assert.equal(await page.getByRole("combobox", { name: "Participant kind", exact: true }).innerText(), "Browser");
    await snap("persisted-controls");
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await page.getByRole("button", { name: "Close view options", exact: true }).click();
    await openLane(page);
    await chooseSelect(page, "Filter activity", "thoughts");
    const thinking = page.getByRole("combobox", { name: "Filter activity", exact: true });
    await thinking.focus(); await page.keyboard.press("Enter");
    const frameBefore = await displayedFrame(page);
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    assert.equal(await displayedFrame(page), frameBefore, "Dropdown navigation leaked into recording playback");
    assert.equal(await page.locator(".player").count(), 1, "Dropdown Escape navigated away from the recording");
    const waits = page.getByRole("checkbox", { name: "Group waits", exact: true });
    await waits.focus(); const before = await waits.isChecked(); await page.keyboard.press("Space");
    assert.equal(await waits.isChecked(), !before, "Custom checkbox does not support Space");
    assert.equal(await page.getByRole("button", { name: "Pause study", exact: true }).count(), 0, "Checkbox Space started playback");
    record.checks.visibleNativeControls = await page.locator('select, input[type="checkbox"]').evaluateAll((nodes) => nodes.filter((element) => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return !element.hidden && element.getAttribute("aria-hidden") !== "true" && style.visibility !== "hidden" && style.display !== "none" && box.width > 1 && box.height > 1;
    }).length);
    assert.equal(record.checks.visibleNativeControls, 0, "Raw native select/checkbox remained visible");
    record.checks.width = await pageWidth(page); assert(record.checks.width.page <= record.checks.width.viewport + 1);
    await snap("rich-player-controls");
  });
  await runCase("grid-control-semantics", { laneCount: 4, prepare: () => {
    data.streams[0].timeline.push({ id: "setup-recovery", at: new Date(START).toISOString(), type: "warning", level: "warn", message: "Synthetic browser bounds were corrected before participant entry." });
  } }, async ({ page, record, snap }) => {
    const details = page.getByRole("button", { name: /^Participant details:/ });
    assert.equal(await details.locator("svg.lucide-info").count(), 4, "Recorded notices changed the Details action icon");
    record.checks.screens = await assertClearGridScreens(page);
    for (let i = 0; i < 3; i += 1) {
      await details.nth(i).click();
      await page.locator(".pop-panel").getByRole("button", { name: /^Compare participant/ }).click();
      await page.getByRole("button", { name: "Close participant details", exact: true }).click();
    }
    await page.getByRole("button", { name: "Compare selected (3/3)", exact: true }).waitFor();
    await details.nth(3).click();
    assert(await page.locator(".pop-panel").getByRole("button", { name: /^Compare participant/ }).isDisabled(), "A fourth selection silently appears enabled");
    await snap("comparison-limit"); await page.getByRole("button", { name: "Close participant details", exact: true }).click();
    await details.first().click();
    const selected = page.locator(".pop-panel").getByRole("button", { name: /^Compare participant/ });
    assert.equal(await selected.getAttribute("aria-pressed"), "true");
    assert.equal((await selected.innerText()).trim(), "Compare", "Toggle label changes meaning when selected");
    assert(!(await selected.isDisabled()), "Full comparison cannot remove a selected participant");
    await selected.click(); await page.getByRole("button", { name: "Close participant details", exact: true }).click();
    await details.nth(3).click();
    assert(!(await page.locator(".pop-panel").getByRole("button", { name: /^Compare participant/ }).isDisabled()));
    await page.getByRole("button", { name: "Close participant details", exact: true }).click();
    await openLane(page);
    const next = page.getByRole("button", { name: "Next frame", exact: true });
    await next.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    await page.locator(".observer-tooltip").getByText("Next frame", { exact: true }).waitFor();
    const route = page.url(), before = await displayedFrame(page);
    await page.keyboard.press("Escape");
    await page.locator(".observer-tooltip").waitFor({ state: "hidden" });
    assert.equal(page.url(), route, "Dismissing a tooltip navigated away from the player");
    assert.equal(await displayedFrame(page), before, "Dismissing a tooltip changed the frame");
    assert(await next.evaluate((button) => button === document.activeElement), "Tooltip dismissal lost focus");
    await page.keyboard.press("Enter");
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    await snap("keyboard-hint-dismissed"); record.checks.keyboardHint = "Focus label, Escape, and one Enter action passed";
  });
  await runCase("grid-touch-controls", { phone: true, touch: true, laneCount: 2 }, async ({ page, record, snap }) => {
    record.checks.pointer = await page.evaluate(() => ({ coarse: matchMedia("(pointer: coarse)").matches, noHover: matchMedia("(hover: none)").matches, touch: navigator.maxTouchPoints }));
    assert(record.checks.pointer.coarse && record.checks.pointer.noHover && record.checks.pointer.touch > 0, "Phone proof lacks actual touch emulation");
    record.checks.screens = await assertClearGridScreens(page);
    assertFullFrames(await inspectImages(page.locator(".thumb .keyframe")));
    const details = page.getByRole("button", { name: /^Participant details:/ }).first();
    const target = await details.boundingBox(); assert(target.width >= 44 && target.height >= 44, "Touch target is smaller than 44px");
    await details.tap();
    const pin = page.locator(".pop-panel").getByRole("button", { name: /^Pin participant/ });
    await pin.tap();
    assert.equal(await pin.getAttribute("aria-pressed"), "true");
    assert.equal((await pin.innerText()).trim(), "Pin", "Visible and accessible toggle labels disagree");
    await page.locator(".pop-panel").getByRole("button", { name: /^Compare participant/ }).tap();
    const close = page.getByRole("button", { name: "Close participant details", exact: true });
    const closeTarget = await close.boundingBox(); assert(closeTarget.width >= 44 && closeTarget.height >= 44);
    await snap("touch-labeled-actions"); await close.tap();
    await page.locator(".pop-panel").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "View and filter participants", exact: true }).tap();
    await chooseSelect(page, "Preview size", "compact");
    await page.getByRole("button", { name: "Close view options", exact: true }).tap();
    record.checks.compactScreens = await assertClearGridScreens(page);
    const width = await pageWidth(page); assert(width.page <= width.viewport + 1);
    await snap("touch-compact-grid");
  });
  await runCase("grid-live-surfaces", { running: true, live: true, laneCount: 4 }, async ({ page, record, snap }) => {
    await until(async () => await page.locator(".thumb-live").count() === 4, "Live fixture previews did not attach");
    record.checks.screens = await assertClearGridScreens(page);
    assert.equal(await page.locator(".card-outcome").getByText("Live", { exact: true }).count(), 4);
    await snap("live-labels-outside-screens");
    await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
    await chooseSelect(page, "Preview size", "compact");
    await page.getByRole("button", { name: "Close view options", exact: true }).click();
    record.checks.compactScreens = await assertClearGridScreens(page);
    await page.getByRole("button", { name: /^Participant details:/ }).first().click();
    await page.locator(".card-details").getByText(/Live desktop preview/).waitFor();
    await snap("live-source-details");
  });
  await runCase("view-preferences", {}, async ({ page, record, snap }) => {
    await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
    await chooseSelect(page, "Preview size", "compact");
    await page.getByRole("searchbox", { name: "Search participants", exact: true }).fill("participant 2");
    await until(async () => await page.locator(".card").count() === 1, "Search did not filter participants");
    await page.reload();
    await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Preview size", exact: true }).innerText(), "Compact");
    assert.equal(await page.getByRole("searchbox", { name: "Search participants", exact: true }).inputValue(), "participant 2");
    assert.equal(await page.locator(".card").count(), 1); await snap("preserved-size-and-search");
    await page.getByRole("searchbox", { name: "Search participants", exact: true }).fill("no-matching-synthetic-person");
    await page.getByText("No participants match the current filters.").waitFor(); await snap("empty-filter");
    record.checks.storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("humanish-observer-"))));
    assert(!JSON.stringify(record.checks.storage).includes("/desktop/"));
  });
  await runCase("pin-pages-monitor", { laneCount: 40 }, async ({ page, record, snap }) => {
    assert.equal(await page.locator(".card").count(), 36, "Large grid did not bound one page");
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.getByRole("button", { name: "Participant details: Synthetic participant 40", exact: true }).click();
    const pin = page.getByRole("button", { name: "Pin participant Synthetic participant 40", exact: true }); await pin.waitFor();
    await pin.click();
    assert.equal(await page.locator(".player").count(), 0, "Pin control unexpectedly opened participant");
    await page.getByRole("button", { name: "Previous page", exact: true }).click();
    assert.equal(await page.locator(".card").first().getAttribute("data-stream-id"), "lane-40");
    await page.reload(); assert.equal(await page.locator(".card").first().getAttribute("data-stream-id"), "lane-40");
    await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
    await page.getByRole("button", { name: "Monitor", exact: true }).click();
    await page.locator(".observer-shell.monitoring").waitFor(); await snap("pinned-monitor");
    await page.getByRole("button", { name: "Exit monitor", exact: true }).click();
    record.checks.pinned = await page.locator(".card").first().getAttribute("data-stream-id");
    assert.equal(record.checks.pinned, "lane-40");
  });
  await runCase("saved-moments", {}, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/2`);
    await page.getByRole("button", { name: "Saved moments", exact: true }).click();
    await page.getByRole("button", { name: "Save current moment", exact: true }).click();
    await page.getByText("Moment saved.", { exact: true }).waitFor(); await snap("saved-moment");
    await page.keyboard.press("Escape"); await page.reload();
    await page.getByRole("button", { name: "Next frame", exact: true }).click();
    await page.locator('.stage-box img[src$="portrait-3.png"]').waitFor();
    await page.getByRole("button", { name: "Saved moments", exact: true }).click();
    await page.getByRole("button", { name: `${data.streams[0].label} · frame 2`, exact: true }).click();
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    record.checks.stored = await page.evaluate(() => JSON.parse(localStorage.getItem("humanish-observer-moments")));
    assert.deepEqual(Object.keys(record.checks.stored[0]).sort(), ["frame", "itemId", "runId", "savedAt", "streamId"].sort(), "Saved moment stored more than bounded evidence identifiers");
    await page.getByRole("button", { name: "Saved moments", exact: true }).click();
    await page.getByRole("button", { name: `Remove saved frame 2 from ${data.streams[0].label}`, exact: true }).click();
    await page.getByText("No saved moments yet.", { exact: true }).waitFor(); await snap("removed-moment");
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("humanish-observer-moments"))), []);
  });
  const comparePrepare = () => {
    for (const [lane, times] of [[0, [0, 10, 30]], [1, [5, 15, 25]]]) {
      data.streams[lane].actor.items.filter((item) => item.kind === "screenshot").forEach((item, index) => { item.at = new Date(START + times[index] * 1000).toISOString(); });
    }
  };
  await runCase("comparison-capture-clock", { frames: 3, laneCount: 2, prepare: comparePrepare }, async ({ page, record, snap }) => {
    const comparisonUrl = (seconds) => `${origin}/observer/index.html#/compare?lane=lane-1&lane=lane-2&clock=shared&at=${START + seconds * 1000}`;
    await page.goto(comparisonUrl(12)); const panels = page.locator(".compare-participant");
    await panels.nth(1).waitFor();
    record.checks.within = await panels.evaluateAll((nodes) => nodes.map((node) => ({ image: node.querySelector("img")?.getAttribute("src"), caption: node.querySelector(".compare-caption")?.textContent })));
    assert(record.checks.within[0].image.endsWith("portrait-2.png")); assert(record.checks.within[1].image.endsWith("landscape-1.png"));
    assert(record.checks.within[0].caption.includes("0:02 before cursor")); assert(record.checks.within[1].caption.includes("0:07 before cursor"));
    assertFullFrames(await inspectImages(page.locator(".compare-stage img")));
    record.checks.previewHeights = await page.locator(".compare-stage").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    assert(Math.max(...record.checks.previewHeights) - Math.min(...record.checks.previewHeights) < 1, "Comparison previews must share a height across screen shapes");
    await snap("prior-capture-and-age");
    await page.goto(comparisonUrl(2)); await panels.nth(1).getByText("Outside recorded coverage", { exact: true }).waitFor();
    assert.equal(await panels.nth(1).locator("img").count(), 0); await snap("before-first-capture");
    await page.goto(comparisonUrl(28)); await panels.nth(1).getByText(/Past recording end/).waitFor(); await snap("past-recording-end");
  });
  for (const phone of [false, true]) await runCase(`review-library-${phone ? "phone" : "desktop"}`, { phone, touch: phone }, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/2`);
    const selectedFrame = await displayedFrame(page);
    const library = page.getByRole("button", { name: "Toggle run library", exact: true });
    // Desktop library preference is stable across study views; phones use a drawer.
    if (!phone && await library.getAttribute("aria-expanded") === "true") await library.click();
    assert.equal(await library.getAttribute("aria-expanded"), "false");
    if (phone) await library.tap(); else await library.click();
    const drawer = phone ? page.getByRole("dialog", { name: "Study library", exact: true }) : page.locator(".frame > .side");
    await drawer.getByRole("navigation", { name: "Run library", exact: true }).waitFor();
    await snap("library-from-player");
    if (phone) await page.keyboard.press("Escape"); else await library.click();
    await drawer.waitFor({ state: "hidden" });
    assert.equal(await displayedFrame(page), selectedFrame);
    await page.goto(`${origin}/observer/index.html#/compare?lane=lane-1&lane=lane-2&clock=elapsed&at=9000`);
    await page.locator(".compare-participant").nth(1).waitFor();
    assert.equal(await page.getByRole("button", { name: "View and filter participants", exact: true }).count(), 0);
    await page.getByRole("heading", { name: "Compare participants", exact: true }).waitFor();
    if (phone) {
      const preview = await page.locator(".compare-stage").first().boundingBox();
      const open = await page.locator(".compare-open").first().boundingBox();
      assert(preview && preview.height <= 240, "Phone comparison must keep previews compact");
      assert(open && open.height >= 44, "Comparison frame links need a 44px touch target");
    }
    if (phone) await library.tap(); else await library.click();
    await drawer.getByRole("navigation", { name: "Run library", exact: true }).waitFor(); await snap("library-from-comparison");
    if (phone) await page.keyboard.press("Escape"); else await library.click();
    await drawer.waitFor({ state: "hidden" });
    assert.equal(await page.getByLabel("Seek comparison").inputValue(), "9000");
    record.checks.width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert(record.checks.width.page <= record.checks.width.viewport);
  });
  await runCase("comparison-evidence-handoff", { laneCount: 2, prepare: () => {
    data.run.persona.name = "Synthetic fan-out placeholder";
    for (const [index, stream] of data.streams.entries()) {
      stream.label = `CUA lane ${index + 1}`; stream.laneId = index ? "landscape" : "portrait";
      stream.sim.personaId = index ? "skeptical-power-user" : "synthetic-new-user";
    }
  } }, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/compare?lane=lane-1&lane=lane-2&clock=elapsed&at=9000`);
    const panels = page.locator(".compare-participant"); await panels.nth(1).waitFor();
    assert.equal(await panels.first().getByRole("heading").innerText(), "Synthetic new user");
    assert.equal(await panels.nth(1).getByRole("heading").innerText(), "Skeptical power user");
    const capture = await panels.first().locator("img").getAttribute("src");
    const comparisonHash = new URL(page.url()).hash;
    const open = panels.first().getByRole("link", { name: "Open frame 2 from Synthetic new user", exact: true });
    assert.equal(await open.getAttribute("href"), "#/lane/lane-1/f/2");
    await snap("named-comparison"); await open.click();
    await page.locator(".stage-box img").waitFor();
    assert.equal(await displayedFrame(page), capture);
    await page.getByRole("tab", { name: "details", exact: true }).click();
    assert((await page.locator(".kv").innerText()).includes("Synthetic new user"));
    assert(!(await page.locator(".kv").innerText()).includes("fan-out placeholder"));
    await page.getByRole("button", { name: "Saved moments", exact: true }).click();
    await page.getByRole("button", { name: "Save current moment", exact: true }).click();
    await page.getByText("Moment saved.", { exact: true }).waitFor(); await page.keyboard.press("Escape");
    await snap("opened-and-saved-evidence");
    await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
    await page.getByLabel("Seek comparison").waitFor();
    assert.equal(new URL(page.url()).hash, comparisonHash);
    await page.getByRole("button", { name: "Back to participants", exact: true }).click();
    await page.getByRole("button", { name: /^Compare selected/ }).click();
    await page.getByLabel("Seek comparison").waitFor();
    assert.equal(new URL(page.url()).hash, comparisonHash);
    await page.reload(); await page.getByLabel("Seek comparison").waitFor();
    assert.equal(await page.getByLabel("Seek comparison").inputValue(), "9000");
    await page.getByRole("button", { name: "Saved moments", exact: true }).click();
    await page.getByRole("button", { name: "Synthetic new user · frame 2", exact: true }).click();
    await page.locator(".stage-box img").waitFor(); assert.equal(await displayedFrame(page), capture);
    record.checks.moments = await page.evaluate(() => JSON.parse(localStorage.getItem("humanish-observer-moments")));
    await page.goBack(); await page.getByLabel("Seek comparison").waitFor();
    assert.equal(await page.getByLabel("Seek comparison").inputValue(), "9000");
    await snap("browser-back-retains-comparison");
    await page.getByRole("button", { name: "Back to participants", exact: true }).click();
    for (const name of ["Synthetic new user", "Skeptical power user"]) {
      await page.getByRole("button", { name: `Participant details: ${name}`, exact: true }).click();
      await page.getByRole("button", { name: `Compare participant ${name}`, exact: true }).click();
      await page.getByRole("button", { name: "Close participant details", exact: true }).click();
    }
    assert.equal(await page.getByRole("button", { name: /^Compare selected/ }).count(), 0);
    await page.getByRole("button", { name: "Open participant Synthetic new user", exact: true }).click();
    // Clearing the comparison and opening from Participants must not resurrect
    // an unrelated previous comparison as the recording's return destination.
    assert.equal(await page.getByRole("button", { name: "Back to comparison", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Back to participants", exact: true }).click();
    await page.getByRole("region", { name: "Study grid", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Compare selected/ }).count(), 0);
    await snap("return-respects-cleared-selection");
  });
  await runCase("comparison-capacity", { laneCount: 3, prepare: () => {
    otherData = fixture({ laneCount: 1, origin }); otherData.run.runId = "synthetic-other-study";
  } }, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/compare?lane=lane-1&lane=lane-2&lane=lane-3`);
    await page.locator(".compare-participant").nth(2).waitFor();
    assert(await page.getByLabel("Comparison run").isDisabled());
    await page.getByText(/Comparison holds up to three participants/).waitFor();
    await page.goto(`${origin}/observer/index.html#/compare?lane=lane-1&lane=lane-2&lane=lane-3&run=synthetic-other-study`);
    await page.getByText(/Keep at most two participants/).waitFor();
    assert.equal(await page.locator(".compare-participant").count(), 3);
    record.checks.names = await page.locator(".compare-participant h2").allTextContents();
    assert.deepEqual(record.checks.names, data.streams.map((stream) => stream.label));
    await snap("selection-preserved-at-capacity");
  });
  await runCase("comparison-other-run", { laneCount: 2, prepare: () => {
    otherData = fixture({ laneCount: 1, origin }); otherData.run.runId = "synthetic-other-study";
    otherData.streams[0].actor.items.forEach((item) => { if (item.at) item.at = new Date(Date.parse(item.at) + 300_000).toISOString(); });
  } }, async ({ page, record, snap }) => {
    await page.getByRole("button", { name: /^Participant details:/ }).first().click();
    await page.locator(".pop-panel").getByRole("button", { name: /^Compare participant/ }).click();
    await page.getByRole("button", { name: "Close participant details", exact: true }).click();
    await page.getByRole("button", { name: /^Compare selected/ }).click();
    const select = page.getByLabel("Comparison run"); await select.waitFor(); await chooseSelect(page, "Comparison run", "synthetic-other-study");
    await page.getByText("Other run loaded as recorded evidence.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Comparison clock", exact: true }).innerText(), "Elapsed time");
    await page.getByText(/progress, not simultaneous events/).waitFor();
    const other = page.locator(".compare-participant").last();
    await other.locator("img").waitFor();
    record.checks.otherFrame = await other.locator("img").getAttribute("src");
    assert(record.checks.otherFrame.includes("/_humanish/runs/synthetic-other-study/screenshots/"));
    await snap("elapsed-cross-run-review");
    await chooseSelect(page, "Comparison clock", "shared");
    await page.getByText(/These recordings do not overlap/).waitFor();
    assert.equal(await other.locator("img").count(), 0, "Nonoverlapping future recording was shown as current"); await snap("nonoverlapping-clock");
  });
  await runCase("comparison-unknown-clock", { frames: 3, laneCount: 2, prepare: () => {
    const frames = data.streams[1].actor.items.filter((item) => item.kind === "screenshot");
    delete frames[1].at;
  } }, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/compare?lane=lane-1&lane=lane-2`);
    await page.getByText("No capture timestamps", { exact: true }).waitFor();
    await chooseSelect(page, "Comparison clock", "elapsed");
    await page.getByText(/estimated timing/).waitFor(); record.checks.mode = await page.getByRole("combobox", { name: "Comparison clock", exact: true }).innerText();
    await snap("explicit-estimated-clock");
    const stamps = [7, 28, 21];
    data.streams[1].actor.items.filter((item) => item.kind === "screenshot").forEach((item, index) => { item.at = new Date(START + stamps[index] * 1000).toISOString(); });
    await page.goto(`${origin}/observer/index.html?source=nonmonotonic#/compare?lane=lane-1&lane=lane-2`);
    await page.getByText("No capture timestamps", { exact: true }).waitFor(); await snap("nonmonotonic-clock-unavailable");
  });
  await runCase("keyboard-phone", { phone: true }, async ({ page, record, snap }) => {
    const library = page.getByRole("button", { name: "Toggle run library", exact: true }); await library.click();
    await page.getByRole("dialog", { name: "Study library", exact: true }).waitFor(); await snap("phone-library");
    await page.keyboard.press("Escape"); await until(async () => await page.getByRole("dialog").count() === 0, "Escape did not close library drawer");
    await page.getByRole("button", { name: /^Open participant/ }).first().click();
    const slider = studySlider(page); await slider.focus(); await slider.press("End");
    await page.locator('.stage-box img[src$="portrait-4.png"]').waitFor(); await slider.press("Home");
    await page.locator('.stage-box img[src$="portrait-1.png"]').waitFor();
    await slider.press("ArrowRight");
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    await slider.press("ArrowLeft");
    await page.locator('.stage-box img[src$="portrait-1.png"]').waitFor();
    record.checks.focusedScrubberKeys = ["End", "Home", "ArrowRight", "ArrowLeft"];
    const next = page.getByRole("button", { name: "Next frame", exact: true }); await next.focus(); await next.press("Space");
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    assert.equal(await page.getByRole("button", { name: "Pause study", exact: true }).count(), 0, "Space on focused button also started playback");
    record.checks.width = await pageWidth(page); assert(record.checks.width.page <= 391); await snap("keyboard-transport");
    await page.getByRole("button", { name: "Back to participants", exact: true }).click(); await page.getByRole("region", { name: "Study grid" }).waitFor();
  });
  await runCase("review-controls", { rows: 12, prepare: () => {
    const items = data.streams[0].actor.items;
    items.splice(3, 0, { id: "synthetic-thought", kind: "reasoning", lifecycle: "completed", title: "Reported thinking", text: "SYNTHETIC THOUGHT FOR REVIEW", at: new Date(START + 15_000).toISOString() });
    items.splice(6, 0, { id: "synthetic-finding", kind: "notice", status: "warning", lifecycle: "completed", title: "Synthetic recorded warning", text: "SYNTHETIC EXPLICIT FINDING", at: new Date(START + 22_000).toISOString() });
    // Local skip-waits and speed preferences remain supported for recordings
    // whose captures cannot be placed on the shared study clock.
    for (const item of items) if (item.screenshotRef) delete item.at;
  } }, async ({ page, directory, record, snap }) => {
    await openLane(page); await page.getByRole("button", { name: "Next action", exact: true }).click();
    assert((await displayedFrame(page)).endsWith("portrait-1.png"));
    assert(page.url().includes("/e/lane-1-action-1"));
    await page.getByRole("button", { name: "Next flagged frame", exact: true }).click();
    await chooseSelect(page, "Filter activity", "findings");
    await page.locator(".acts").getByText(/SYNTHETIC EXPLICIT FINDING/).waitFor(); await snap("recorded-finding-filter");
    await chooseSelect(page, "Filter activity", "thoughts"); await page.locator(".acts").getByText("SYNTHETIC THOUGHT FOR REVIEW", { exact: true }).first().waitFor();
    await chooseSelect(page, "Filter activity", "all");
    await page.locator(".acts").getByText(/12 recorded waits/).waitFor();
    await page.getByRole("checkbox", { name: "Group waits", exact: true }).uncheck();
    assert(await page.locator(".acts").getByText(/Synthetic wait/).count() === 12, "Ungrouping lost original waits");
    await page.getByRole("checkbox", { name: "Skip waits", exact: true }).check();
    await page.getByRole("button", { name: "Playback speed", exact: true }).click();
    await page.getByRole("button", { name: "Hide inspector", exact: true }).click(); assert.equal(await page.locator(".inspector").count(), 0);
    await page.reload(); assert.equal(await page.locator(".inspector").count(), 0);
    assert(await page.getByRole("checkbox", { name: "Skip waits", exact: true }).isChecked());
    await page.getByRole("button", { name: "Show inspector", exact: true }).click();
    record.checks.speed = await page.getByRole("button", { name: "Playback speed", exact: true }).innerText(); assert.equal(record.checks.speed, "2×"); await snap("persisted-review-preferences");
    const downloading = page.waitForEvent("download"); await page.getByRole("link", { name: "Original frame", exact: true }).click();
    const download = await downloading; record.checks.originalDownload = download.suggestedFilename();
    assert(/^portrait-\d+\.png$/.test(record.checks.originalDownload)); await download.saveAs(path.join(directory, "downloaded-original.png"));
  });
  for (const phone of [false, true]) await runCase(phone ? "event-context-phone" : "event-context-desktop", { phone, touch: phone, prepare() {
    const items = data.streams[0].actor.items;
    items.splice(2, 0, { id: "second-click", kind: "ui_action", lifecycle: "completed", title: "click (240, 480)", at: new Date(START + 8000).toISOString(), coord: { x: 240, y: 480 } });
  } }, async ({ page, record, snap }) => {
    await openLane(page);
    const captured = await displayedFrame(page);
    await page.locator('[data-entry-id="lane-1-action-1"]').click();
    assert.equal(await page.locator(".pins .spin").count(), 1);
    await page.locator('[data-entry-id="second-click"]').click();
    assert.equal(await displayedFrame(page), captured);
    assert.equal(await page.locator(".pins .spin").count(), 1);
    assert.equal(await page.locator('.pins .tip').innerText(), "click (240, 480)");
    assert.equal(await page.locator('.acts [aria-current="true"]').count(), 1);
    assert((await page.getByLabel("Selected evidence").innerText()).includes("1s before entry"));
    assert(page.url().endsWith("/f/1/e/second-click"));
    await page.getByLabel("Selected evidence").scrollIntoViewIfNeeded();
    await snap("selected-second-action");
    await page.reload();
    await page.locator('[data-selected][data-entry-id="second-click"]').waitFor();
    assert.equal(await displayedFrame(page), captured);
    await page.getByRole("button", { name: "Saved moments", exact: true }).click();
    await page.getByRole("button", { name: "Save current moment", exact: true }).click();
    await page.getByRole("button", { name: "Close saved moments", exact: true }).click();
    await page.getByRole("button", { name: "Next frame", exact: true }).click();
    await page.getByRole("button", { name: "Saved moments", exact: true }).click();
    await page.getByRole("button", { name: /frame 1 · click \(240, 480\)/ }).click();
    await page.locator('[data-selected][data-entry-id="second-click"]').waitFor();
    assert.equal(await displayedFrame(page), captured);
    assert(page.url().endsWith("/f/1/e/second-click"));
    const entries = JSON.parse(await page.evaluate(() => localStorage.getItem("humanish-observer-moments") ?? "[]"));
    record.checks.savedEntries = entries;
    await page.getByRole("button", { name: "Show capture interval", exact: true }).click();
    assert(!page.url().includes("/e/"));
    assert.equal(await page.locator(".pins .spin").count(), 1, "Shared playback exposed an action that had not occurred at its cursor");
    await seekStudy(page, 1000);
    assert.equal(await displayedFrame(page), captured, "Seeking within the capture interval replaced its screenshot");
    assert.equal(await page.locator(".pins .spin").count(), 2);
    const width = await pageWidth(page); assert(width.page <= width.viewport + 1);
    record.checks = { ...record.checks, captured, eventId: "second-click", width };
    await snap("capture-interval-restored");
  });
  await runCase("participant-assignment", { phone: true, touch: true, prepare() {
    data.streams[0].assignment = { mission: "Create a short task list.", focus: "Use the keyboard throughout.", tasks: [{ id: "rename", goal: "Rename the first task." }] };
    data.streams[1].assignment = { mission: "Create a short task list.", focus: "Use the visible pointer controls." };
    data.run.scenario.goal = "FIRST PARTICIPANT COMPILED PROMPT MUST NOT BECOME ANOTHER ASSIGNMENT";
  } }, async ({ page, record, snap }) => {
    await openLane(page);
    await page.locator('.participant-assignment summary').click();
    assert((await page.locator('.assignment-body').innerText()).includes("Rename the first task."));
    await snap("first-participant-assignment");
    await page.getByRole("button", { name: "Next participant", exact: true }).click();
    await page.locator('.participant-assignment summary').click();
    assert((await page.locator('.assignment-body').innerText()).includes("Use the visible pointer controls."));
    assert(!(await page.locator('main').innerText()).includes("Use the keyboard throughout."));
    await page.getByRole("button", { name: "Next participant", exact: true }).click();
    await page.getByRole("tab", { name: "details", exact: true }).click();
    assert((await page.locator('.assignment-missing').innerText()).includes("not recorded"));
    assert(!(await page.locator('main').innerText()).includes("FIRST PARTICIPANT COMPILED PROMPT"));
    const width = await pageWidth(page); assert(width.page <= width.viewport + 1);
    record.checks = { distinctAssignments: true, legacyUnrecorded: true, width };
    await snap("older-assignment-absent");
  });
  await runCase("missing-moment", {}, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/999`);
    await page.getByText(/addressed frame is unavailable/).waitFor(); assert.equal(await page.locator(".stage-box img").count(), 0);
    record.checks.hash = new URL(page.url()).hash; assert(record.checks.hash.endsWith("/f/999")); await snap("unavailable-addressed-moment");
    await page.goto(`${origin}/observer/index.html#/lane/%E0%A4%A`);
    await page.getByRole("region", { name: "Study grid" }).waitFor(); await snap("malformed-route-recovery");
    data = fixture({ running: true, live: true, origin });
    record.checks.coldActiveAddresses = [];
    for (const frame of [999, 2]) {
      // Cold direct entry must never briefly connect to a running desktop while
      // the explicit recording address is being projected into shared state.
      await page.goto("about:blank"); const requestStart = requests.length;
      await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/${frame}`);
      if (frame === 999) {
        await page.getByText(/addressed frame is unavailable/).waitFor();
        assert.equal(await page.locator(".stage-box img").count(), 0);
      } else await readyCapture(page.locator(".stage-box img").first(), "portrait-2.png");
      await wait(200);
      assert(new URL(page.url()).hash.endsWith(`/f/${frame}`), "Active direct entry replaced the explicitly addressed frame");
      assert.equal(await page.locator("iframe").count(), 0, "An active explicit recording opened a live desktop");
      const desktopRequests = requests.slice(requestStart).filter((request) => request.path.startsWith("/desktop/"));
      assert.equal(desktopRequests.length, 0, "Active direct entry briefly requested a live desktop before settling");
      record.checks.coldActiveAddresses.push({ frame, desktopRequests: 0, exactAddressRetained: true });
      await snap(`active-direct-frame-${frame}`);
    }
  });
  await runCase("offline-recording", {}, async ({ page, directory, record, snap }) => {
    const offline = structuredClone(data);
    for (const [index, stream] of offline.streams.entries()) for (const item of stream.actor.items) if (item.screenshotRef) {
      item.screenshotRef.path = `data:image/png;base64,${screenshot(index % 2 ? 1200 : 390, index % 2 ? 750 : 844, 1).toString("base64")}`;
    }
    const file = path.join(directory, "synthetic-offline-observer.html"); await writeFile(file, inject(offline));
    const count = requests.length; await page.goto(pathToFileURL(file).href);
    const offlineRequests = [];
    page.on("request", (request) => { if (!request.url().startsWith("data:")) offlineRequests.push(request.url()); });
    await page.getByText("Saved recording", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^Open participant/ }).first().click();
    await page.locator('.stage-box[data-image-state="ready"]').waitFor();
    record.checks.offline = await displayedFrame(page); assert(record.checks.offline.startsWith("data:image/png;base64,"));
    await wait(5500); assert.equal(requests.length, count, "Saved recording attempted HTTP updates");
    record.checks.offlineRequests = offlineRequests; assert.equal(offlineRequests.length, 0, "Saved recording fetched non-inlined resources");
    await snap("self-contained-offline-recording");
  });
  await runCase("http-poll-cleanup", { running: true }, async ({ page, record, snap }) => {
    await openLane(page); await until(() => pollCount > 0, "Initial poll did not reach HTTP server");
    responseMode = "held"; const prior = pollCount;
    await until(() => pollCount > prior, "Held HTTP request did not start"); await snap("pending-update-before-leaving");
    const pending = requests.findLast((r) => r.path === "/observer/observer-data.json" && r.mode === "held");
    await page.goto("about:blank"); await until(() => pending.closed === true, "Leaving Observer did not close pending HTTP request");
    const left = pollCount; await wait(700); assert.equal(pollCount, left, "Observer kept polling after navigation");
    record.checks.requestClosed = pending.closed; record.checks.pollsAfterLeaving = pollCount - left;
  });
  await runCase("terminal-recording", { frames: 0, laneCount: 1, prepare: () => {
    const stream = data.streams[0]; stream.kind = "terminal"; stream.kindLabel = "Terminal"; stream.transport = "pty";
    stream.terminalPlain = "$ fictional-tool check\nok synthetic terminal evidence\nSYNTHETIC TERMINAL END";
    stream.sim.mode = "cli-sim"; stream.actor.redaction.screenshots = "n/a";
  } }, async ({ page, record, snap }) => {
    await page.getByRole("button", { name: /^Open participant/ }).first().click();
    await page.getByText("SYNTHETIC TERMINAL END", { exact: true }).waitFor();
    assert.equal(await page.getByRole("slider", { name: /Seek (?:study )?recording/ }).count(), 0, "Screenshot-free lane invented a timeline");
    record.checks.evidence = await page.locator(".stub-term").innerText(); await snap("terminal-evidence");
  });
  await runCase("desktop-isolation", { running: true, live: true, prepare: () => { exerciseDesktopIsolation = true; } }, async ({ page, record, snap }) => {
    await openLane(page);
    await page.frameLocator(".stage-live iframe").locator('body[data-isolated="true"]').waitFor();
    record.checks.parentEscaped = await page.evaluate(() => document.body.dataset.syntheticDesktopEscaped ?? null);
    assert.equal(record.checks.parentEscaped, null, "Embedded desktop script reached parent Observer document");
    record.checks.iframe = await page.locator(".stage-live iframe").evaluate((frame) => ({ sandbox: frame.getAttribute("sandbox"), tabIndex: frame.tabIndex, allow: frame.getAttribute("allow") }));
    assert.equal(record.checks.iframe.tabIndex, -1); assert(!/clipboard/.test(record.checks.iframe.allow ?? ""));
    await snap("isolated-desktop");
  });
  for (const phone of [false, true]) await runCase(`analysis-overview-${phone ? "phone" : "desktop"}`, { phone, touch: phone, prepare() {
    analysis = analysisFixture(data, { status: "partial", count: 5 });
    analysis.analysis.result.summary = "The original long narrative remains available with its qualifications. ".repeat(16);
    analysis.automatic = { state: "failed", analysisId: "separate-failed-attempt", reason: "AUTOMATIC_ANALYSIS_FAILED", updatedAt: new Date(START).toISOString() };
  } }, async ({ page, record, snap }) => {
    await page.getByRole("link", { name: /^Findings/ }).click();
    const overview = page.locator('.report-overview'); await overview.waitFor();
    assert((await overview.locator('.report-overview-title [role="status"]').innerText()).includes('Report available · limitations'));
    const firstY = (await page.locator('.report-finding').first().boundingBox()).y;
    assert(firstY <= (phone ? 360 : 280), 'Report prelude pushed the first finding below its compact budget');
    assert.equal(await page.locator('.report-summary').getAttribute('open'), null);
    assert.equal(await page.locator('.report-analysis-details').getAttribute('open'), null);
    assert.equal(await page.locator('[data-automatic-analysis-state="failed"]').isVisible(), false, 'Attempt failure impersonates the selected report status');
    const facts = await overview.locator('dt').allTextContents();
    assert(facts.includes('Participants included') && facts.includes('Captures sampled'));
    assert(facts.includes('Completed (analysis)') && facts.includes('Blocked (analysis)'));
    await snap('compact-findings-overview');
    const summary = page.locator('.report-summary > summary'); await summary.focus(); await page.keyboard.press('Enter');
    await page.locator('.report-summary[open]').waitFor();
    const animated = await page.locator('.report-summary').evaluate(async element => {
      await new Promise(requestAnimationFrame);
      const animations = element.getAnimations({ subtree: true });
      for (const animation of animations) { animation.pause(); animation.currentTime = 40; }
      return animations.length;
    });
    if (animated) {
      const rowClickable = () => page.locator('.report-finding').first().evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.left + 60, rect.top + 24));
      });
      assert(await rowClickable(), 'Expanding summary paints over or intercepts the next finding');
      await snap('opening-summary-contained');
      const broken = await page.addStyleTag({ content: '.report-summary::details-content { overflow: visible !important; }' });
      assert.equal(await rowClickable(), false, 'Motion overlap guard accepted uncontained prose');
      await broken.evaluate(element => element.remove());
      await page.locator('.report-summary').evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
    }
    await until(async () => (await page.locator('.findings-summary p').innerText()) === analysis.analysis.result.summary.trim(), 'Expanded summary failed to expose the complete original text');
    await snap('original-summary-expanded');
    await summary.press('Space'); await page.locator('.report-summary:not([open])').waitFor();
    const details = page.locator('.report-analysis-details > summary'); await details.focus(); await page.keyboard.press('Enter');
    await page.locator('[data-automatic-analysis-state="failed"]').waitFor();
    const history = await page.locator('.report-analysis-body').innerText();
    assert(history.includes('The displayed report is from a separate analysis.'));
    assert(history.includes(analysis.analysis.result.limitations[0]));
    assert(history.includes('Synthetic renderer fixture'));
    await snap('coverage-and-attempt-history');
    await details.press('Space'); await page.locator('.report-analysis-details:not([open])').waitFor();
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await snap('compact-overview-dark');
    const width = await pageWidth(page); assert(width.page <= width.viewport + 1);
    record.checks = { firstFindingY: firstY, fullSummaryRetained: true, separateAttemptHistory: true, keyboardDisclosures: true, motionOverlapGuard: animated > 0, facts, width };
  });
  for (const phone of [false, true]) await runCase(`analysis-ready-${phone ? "phone" : "desktop"}`, { phone, touch: phone, prepare() { analysis = analysisFixture(data); } }, async ({ page, record, snap, context }) => {
    const shell = () => page.locator(".observer-shell > .topbar, .frame > .side, .frame > .main, .study-viewbar").evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect(); return { role: node.className, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    const before = await shell();
    const findings = page.getByRole("link", { name: /^Findings/ });
    await findings.click(); await page.getByRole("region", { name: "Study findings" }).waitFor();
    assert.deepEqual(await shell(), before, "Study branch changed the surrounding shell");
    assert.equal(await page.locator('.report-finding[aria-expanded="true"]').count(), 0);
    const rows = await page.locator(".report-finding").evaluateAll((nodes) => nodes.map((node) => ({ bottom: node.getBoundingClientRect().bottom, text: node.textContent })));
    assert(rows.length === 2 && rows.every((row) => row.bottom <= (phone ? 844 : 1000)), "Both initial priorities must be visible without scrolling");
    assert(rows[0].text.includes("1 of 3 exposed participants affected"));
    await snap("ranked-findings");
    const trigger = page.locator('[data-finding="F1"]'); await trigger.focus(); await page.keyboard.press("Enter");
    await page.locator('[data-finding="F1"][aria-expanded="true"]').waitFor();
    const preview = page.locator(".report-evidence").first(); await preview.waitFor();
    await until(async () => page.locator(".finding-panel").first().evaluate((element) => element.clientHeight >= element.scrollHeight - 1), "Finding expansion did not settle");
    assertFullFrames(await inspectImages(preview.locator("img")));
    const evidenceWidth = (await preview.boundingBox()).width;
    assert(evidenceWidth <= 361, "Evidence preview escaped its bounded composition");
    await snap("expanded-finding");
    const expected = analysis.analysis.evidence.find((e) => e.id === analysis.analysis.result.findings[0].observations[0].evidenceIds[0]);
    await preview.click(); await page.locator(".player").waitFor();
    assert.equal(new URL(page.url()).hash, `#/lane/${expected.streamId}/f/${expected.frame + 1}/e/${expected.eventId}`);
    assert.equal(await findings.getAttribute("aria-current"), "page");
    assert.deepEqual(await shell(), before, "Evidence entry changed the surrounding shell");
    await page.getByRole("tab", { name: "Feedback", exact: true }).waitFor();
    await page.reload(); await page.getByRole("button", { name: /^Back to finding:/ }).waitFor();
    await page.getByRole("button", { name: "Next frame", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator('[data-finding="F1"][aria-expanded="true"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-finding")), "F1");
    await page.getByRole("link", { name: "All participants", exact: true }).click();
    await page.getByRole("button", { name: /^Open participant/ }).first().click();
    assert.equal(await page.getByRole("button", { name: /^Back to finding:/ }).count(), 0, "An unrelated previous finding became the recording origin");
    await page.getByRole("button", { name: "Back to participants", exact: true }).waitFor();
    // A copied address has no history-state origin and must use Participants.
    const direct = await context.newPage(); await direct.goto(page.url());
    await direct.getByRole("button", { name: "Back to participants", exact: true }).waitFor(); await direct.close();
    record.checks = { shell: before, bothPriorityRowsVisible: true, exactReference: expected.eventId, evidenceWidth };
    await snap("source-aware-recording");
  });
  for (const phone of [false, true]) await runCase(`analysis-review-polish-${phone ? "phone" : "desktop"}`, { phone, touch: phone, prepare() {
    analysis = reviewPolishFixture(data);
  } }, async ({ page, record, snap }) => {
    await page.getByRole("link", { name: /^Findings/ }).click();
    const trigger = page.locator('[data-finding="F1"]'); await trigger.focus(); await page.keyboard.press("Enter");
    const preview = page.locator('.report-evidence'); await preview.waitFor();
    const settled = () => until(async () => page.locator('.finding-panel').first().evaluate(element => element.clientHeight >= element.scrollHeight - 1), 'Finding content remains clipped after expansion');
    await settled();
    const contentBounds = await page.locator('.finding-panel').first().evaluate(panel => {
      const outer = panel.getBoundingClientRect();
      return [...panel.querySelectorAll('.report-evidence img, .report-evidence-caption, .report-moments')].map(element => {
        const bounds = element.getBoundingClientRect();
        return { element: element.className || element.tagName, top: bounds.top - outer.top, bottom: bounds.bottom - outer.top, panelHeight: outer.height };
      });
    });
    assert(contentBounds.every(bounds => bounds.top >= -1 && bounds.bottom <= bounds.panelHeight + 1), 'Settled finding clips its capture, caption or evidence list');
    assert.equal(await preview.getAttribute('data-report-evidence'), 'lane-1-frame-3', 'Preview retained setup instead of the directly supported issue capture');
    assert((await preview.locator('img').getAttribute('src')).endsWith('portrait-3.png'));
    assert.equal(await page.locator('.report-evidence-caption > span:not(.observation-basis)').innerText(), 'The third capture is the cited validation state.');
    assert.equal(await page.locator('.report-moments [aria-current="true"]').getAttribute('data-report-moment'), 'lane-1-frame-3');
    assert.equal(await page.locator('.report-scope').innerText(), analysis.analysis.result.findings[0].observations[0].limitation);
    assert.equal(await page.locator('.report-assessment dd').allTextContents().then(values => values.join('/')), 'medium/Recovered');
    const limits = page.locator('.report-limits');
    assert.equal(await limits.getAttribute('open'), null, 'Secondary caveats begin expanded');
    await snap('representative-capture-and-visible-uncertainty');
    const disclosure = limits.locator('summary'); await disclosure.focus(); await page.keyboard.press('Enter');
    await page.locator('.report-limits[open]').waitFor();
    await settled();
    assert.equal(await limits.locator('li').count(), 2, 'Duplicate limitations were repeated');
    assert((await limits.innerText()).includes('including this final sentence about the unmeasured downstream result.'));
    const width = await pageWidth(page); assert(width.page <= width.viewport + 1, 'Expanded caveats overflow the page');
    if (phone) assert((await disclosure.boundingBox()).height >= 44, 'Phone caveat disclosure is too small');
    await limits.scrollIntoViewIfNeeded();
    const focusRing = () => disclosure.evaluate(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      const extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const ring = { left: rect.left - extent, right: rect.right + extent, top: rect.top - extent, bottom: rect.bottom + extent };
      const clippedBy = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const bounds = parent.getBoundingClientRect(), css = getComputedStyle(parent);
        if ((['clip', 'hidden'].includes(css.overflowX) && (ring.left < bounds.left - 1 || ring.right > bounds.right + 1))
          || (['clip', 'hidden'].includes(css.overflowY) && (ring.top < bounds.top - 1 || ring.bottom > bounds.bottom + 1))) clippedBy.push(parent.className);
      }
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset), clippedBy };
    });
    const focus = await focusRing();
    assert(focus.style === 'solid' && focus.width >= 2 && focus.clippedBy.length === 0, 'Caveat focus ring is clipped or absent');
    if (phone) {
      const formerFocus = await page.addStyleTag({ content: '.finding-panel :focus-visible { outline-offset: 2px !important; }' });
      assert((await focusRing()).clippedBy.length > 0, 'Focus guard accepted the former clipped outline');
      await formerFocus.evaluate(element => element.remove());
    }
    await snap('complete-caveats-keyboard-expanded');
    await disclosure.press('Space'); await page.locator('.report-limits:not([open])').waitFor();
    await page.locator('.report-observations > summary').click();
    assert.equal(await page.locator('.report-observations .observation-basis').count(), 8, 'Original observations were lost during deduplication');
    await page.locator('.report-observations > summary').click();
    await settled();
    await preview.scrollIntoViewIfNeeded();
    await readyCapture(preview.locator('img'), 'portrait-3.png');
    await snap('representative-capture-and-open-recording');
    const evidenceList = page.locator('.report-moments');
    await evidenceList.scrollIntoViewIfNeeded();
    const hoverCapability = await page.evaluate(() => matchMedia('(hover: hover)').matches);
    assert.equal(hoverCapability, !phone, 'Review fixture has unexpected hover capability');
    if (phone) {
      const row = evidenceList.locator('[data-report-moment="lane-1-action-2"]');
      const rect = await row.boundingBox(); await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const rowColors = () => evidenceList.evaluate(element => ({
        hovered: element.querySelector('[data-report-moment="lane-1-action-2"]').matches(':hover'),
        pointer: getComputedStyle(element.querySelector('[data-report-moment="lane-1-action-2"] strong')).color,
        other: getComputedStyle(element.querySelector('[data-report-moment="lane-1-frame-1"] strong')).color,
      }));
      const colors = await rowColors(); assert(colors.hovered, 'Touch hover regression did not reach the target row');
      assert.equal(colors.pointer, colors.other, 'Touch-only device retains misleading hover-only row color');
      const formerHover = await page.addStyleTag({ content: '.report-moments button:hover strong { color: var(--accent-ink) !important; }' });
      const negative = await rowColors(); assert.notEqual(negative.pointer, negative.other, 'Touch hover guard accepted the former unconditional color');
      await formerHover.evaluate(element => element.remove());
    }
    await page.mouse.move(0, 0);
    await snap('all-cited-moments');
    await preview.click(); await page.locator('.player').waitFor();
    assert.equal(new URL(page.url()).hash, '#/lane/lane-1/f/3');
    assert((await displayedFrame(page)).endsWith('portrait-3.png'));
    await page.locator('.content').evaluate(element => { element.scrollTop = 0; });
    const recordingCapture = await readyCapture(page.locator('.stage-box img').first(), 'portrait-3.png');
    await snap('exact-recording-before-return');
    await page.getByRole('button', { name: /^Back to finding:/ }).click();
    await page.locator('[data-finding="F1"][aria-expanded="true"]').waitFor();
    await until(async () => trigger.evaluate(element => document.activeElement === element), 'Finding return lost keyboard focus');
    record.checks = { representativeCapture: 'lane-1-frame-3', latestCaptureExcluded: true, duplicateSupportExcluded: true,
      visibleUncertainty: true, allLimitsRetained: true, originalObservations: 8, exactMoment: '#/lane/lane-1/f/3', keyboardDisclosure: true, width, contentBounds, focus, recordingCapture, hoverCapability };
    await snap('return-restores-finding-focus');
    await evidenceList.scrollIntoViewIfNeeded();
    assert.equal(await evidenceList.locator('[aria-current="true"]').getAttribute('data-report-moment'), 'lane-1-frame-3');
    await page.mouse.move(0, 0);
    await snap('returned-finding-cited-moment');
  });
  for (const phone of [false, true]) await runCase(`analysis-concerns-${phone ? "phone" : "desktop"}`, { phone, touch: phone, prepare() {
    analysis = analysisFixture(data);
    const f = analysis.analysis.result.findings[0];
    analysis.analysis.result.concernReviews = [
      { ...f.observations[0], disposition: "finding", findingId: f.id, reason: "Included because the recorded action affected the assigned task." },
      { ...f.observations[0], claim: "The participant explored another option and returned.", disposition: "context", findingId: null,
        limitation: "This controlled example establishes navigation behavior only.", reason: "The detour was recovered; no separate product obstacle is established." }
    ];
  } }, async ({ page, record, snap }) => {
    const expected = analysis.analysis.evidence.find(e => e.id === analysis.analysis.result.concernReviews[1].evidenceIds[0]);
    await page.getByRole("link", { name: /^Findings/ }).click();
    const count = await page.locator("[data-finding-row]").count();
    const summary = page.locator(".report-concerns > summary");
    await summary.focus(); await page.keyboard.press("Enter");
    await page.locator(".report-concerns[open]").waitFor();
    await page.getByText("Context only", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-finding-row]").count(), count, "Excluded concern became a ranked finding");
    await snap("concerns-and-exclusion");
    const button = page.locator(".concern-review").nth(1).getByRole("button", { name: /^Open concern evidence:/ });
    if (phone) assert((await button.boundingBox()).height >= 44);
    await button.click(); await page.locator(".player").waitFor();
    assert.equal(new URL(page.url()).hash, `#/lane/${expected.streamId}/f/${expected.frame + 1}/e/${expected.eventId}`);
    assert.equal(await page.getByRole("link", { name: /^Findings/ }).getAttribute("aria-current"), "page");
    await page.reload(); await page.getByRole("button", { name: "Back to concerns considered", exact: true }).waitFor();
    await snap("concern-exact-evidence");
    await page.getByRole("button", { name: "Back to concerns considered", exact: true }).click();
    await page.locator(".report-concerns[open]").waitFor();
    await until(async () => summary.evaluate(el => el === document.activeElement), "Concern return lost keyboard focus");
    await page.getByRole("button", { name: "Included in F1", exact: true }).click();
    await page.locator('[data-finding="F1"][aria-expanded="true"]').waitFor();
    await until(async () => page.locator('[data-finding="F1"]').evaluate(el => el === document.activeElement), "Included finding lost keyboard focus");
    assert((await page.locator('[data-finding="F1"]').boundingBox()).y < (phone ? 844 : 1000));
    record.checks = { rankedFindingsUnchanged: count, exactReference: expected.eventId, reloadReturn: "concerns", keyboardFocusRestored: true };
    await snap("concern-return-and-finding");
  });

  await runCase("analysis-attribution", { prepare() {
    analysis = analysisFixture(data);
    const finding = analysis.analysis.result.findings[0];
    finding.affectedStreamIds = data.streams.map((s) => s.id);
    finding.observations[0].basis = "inference";
    for (const stream of data.streams) {
      const e = analysis.analysis.evidence.find((e) => e.streamId === stream.id && e.eventId.endsWith(stream.id === "lane-3" ? "action-2" : "final"));
      finding.observations.push({ claim: `Bounded statement about ${stream.id}.`, basis: stream.id === "lane-3" ? "action" : "participant_statement", evidenceIds: [e.id], limitation: "Synthetic source only." });
    }
    analysis.corrections.push({ schema: "humanish.study-analysis-correction.v1", id: "review-1", analysisId: analysis.analysis.id, analysisSha256: "a".repeat(64), findingId: "F1", findingSha256: "b".repeat(64), createdAt: "2026-01-01T00:02:00Z", status: "dismissed", reason: "Synthetic reviewer found this inconclusive.", replacementClaim: null });
  } }, async ({ page, record, snap }) => {
    await page.getByRole("link", { name: /^Findings/ }).click();
    assert.equal(await page.locator('[data-finding="F1"] [data-disposition]').innerText(), "Dismissed");
    await page.locator('[data-finding="F1"]').click();
    await page.locator('.report-evidence-caption').getByText("Inference · Capture shown for context", { exact: true }).waitFor();
    await page.locator('.report-account summary').click();
    assert.equal(await page.locator('.report-account figure').count(), 2, "Uncited third participant feedback leaked into the finding");
    const speakers = await page.locator('.report-account figcaption').allTextContents();
    assert.equal(new Set(speakers).size, 2, "Separate speakers were concatenated or lost");
    assert.equal(new Set(await page.locator('.moment-source strong').allTextContents()).size, 3, "Evidence buttons lost participant identity");
    await page.locator('.report-observations summary').click();
    assert.equal(await page.locator('.report-observations .observation-basis').count(), 4);
    await snap("attributed-findings");
    const accessibleName = await page.locator('.report-evidence').getAttribute('aria-label');
    assert(accessibleName.startsWith('Open recording: ') && accessibleName.includes('00:'), 'Evidence name lost the visible action or recorded time');
    assert.equal(await page.locator('.report-moments [aria-current="true"]').count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    const targetHeights = await page.locator('.study-report details > summary').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert(targetHeights.every(height => height >= 44), 'Phone disclosure targets are shorter than44px');
    await page.locator('.report-evidence').click();
    await page.locator('.stage-box img').waitFor(); await page.locator('.content').evaluate(node => { node.scrollTop = 0; });
    await snap('phone-recording-stage');
    await page.getByRole('button', { name: 'Next participant', exact: true }).click();
    assert(new URL(page.url()).hash.endsWith('/lane/lane-2/f/4/e/lane-2-final'), 'Participant pager lost the next cited finding moment');
    await page.getByRole('button', { name: 'Previous participant', exact: true }).click();
    assert(new URL(page.url()).hash.endsWith('/lane/lane-1/f/2/e/lane-1-action-2'));
    await page.getByRole('tab', { name: 'details', exact: true }).click();
    await page.locator('.participant-analysis summary').click();
    await page.getByText('Synthetic interpretation kept separate from actor status.', { exact: true }).waitFor();
    await page.locator('.participant-analysis-evidence a').first().click();
    await page.getByRole('button', { name: /^Back to finding:/ }).waitFor();
    await page.getByRole('tab', { name: 'Feedback', exact: true }).click();
    await page.getByRole('region', { name: 'Original participant feedback' }).getByText('FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Open recorded statement', exact: true }).click();
    assert(new URL(page.url()).hash.endsWith('/e/lane-1-final'));
    await page.getByRole('button', { name: /^Back to finding:/ }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); await snap("phone-original-feedback");
    record.checks = { citedSpeakers: speakers, uncitedQuoteExcluded: true, basisPreserved: true, dispositionVisible: true, independentOutcomeExplained: true, originalStatementSourceLinked: true, accessibleName, phoneDisclosureHeights: targetHeights, pagerCitedMoment: true };
  });
  await runCase("analysis-states", { prepare() { analysis = analysisFixture(data, { empty: true }); } }, async ({ page, record, snap }) => {
    await page.getByRole("link", { name: /^Findings/ }).click();
    await page.getByRole("heading", { name: "No findings in the reviewed evidence", exact: true }).waitFor(); await snap("complete-empty");
    record.checks.states = ["complete-empty"];
    for (const status of ["partial", "failed", "cancelled"]) {
      analysis = analysisFixture(data, { status });
      await page.reload(); await page.locator(`[data-analysis-state="${status}"]`).waitFor();
      await snap(status); record.checks.states.push(status);
    }
    analysis = analysisFixture(data, { state: "stale" });
    analysis.analysis.result.findings[0].observations[0].evidenceIds = ["lane-1/removed-entry"];
    analysis.analysis.evidence.push({ ...analysis.analysis.evidence[0], id: "lane-1/removed-entry", eventId: "removed-entry" });
    await page.reload(); await page.locator('[data-analysis-state="stale"]').waitFor();
    await page.locator('[data-finding="F1"]').click(); await page.locator('.report-evidence:disabled').waitFor();
    await snap("stale-evidence-unavailable"); record.checks.states.push("stale");
    // A changed source can remove an entire participant, not just one event.
    analysis.analysis.result.findings[0].observations[0].evidenceIds = ["lane-3/lane-3-final"];
    data = fixture({ laneCount: 2 });
    await page.reload(); await page.locator('[data-analysis-state="stale"]').waitFor();
    await page.locator('.report-evidence:disabled').waitFor();
    assert((await page.locator('.report-text-evidence').innerText()).includes("no longer available"));
    await snap("stale-participant-unavailable"); record.checks.states.push("stale-participant-unavailable");
    data = fixture();
    analysis = { ...analysis, state: "ready", analysis: { ...analysis.analysis, runId: "another-study" } };
    await page.reload(); await page.locator('[data-analysis-state="invalid"]').waitFor();
    await page.getByRole("link", { name: "All participants", exact: true }).click();
    await page.getByRole("button", { name: /^Open participant/ }).first().click();
    await page.locator(".stage-box img").waitFor(); await snap("invalid-analysis-keeps-recording"); record.checks.states.push("invalid");
  });
  await runCase("analysis-nonvisual", { frames: 0, laneCount: 1, prepare() {
    const stream = data.streams[0]; stream.kind = "terminal"; stream.kindLabel = "Terminal";
    stream.terminalPlain = "$ fictional-tool check\nSYNTHETIC TERMINAL END"; analysis = analysisFixture(data);
  } }, async ({ page, record, snap }) => {
    await page.getByRole("link", { name: /^Findings/ }).click(); await page.locator('[data-finding="F1"]').click();
    const preview = page.locator(".report-evidence"); await preview.waitFor(); assert.equal(await preview.locator("img").count(), 0);
    await preview.click(); await page.locator('[data-selected-entry="lane-1-final"]').waitFor();
    assert.equal(new URL(page.url()).hash, "#/lane/lane-1/e/lane-1-final");
    assert.equal(await page.getByRole("slider", { name: /Seek (?:study )?recording/ }).count(), 0);
    assert((await page.getByLabel("Selected evidence").innerText()).includes("FINAL SYNTHETIC EVIDENCE REMAINS INSPECTABLE"));
    await page.reload(); await page.locator('[data-selected-entry="lane-1-final"]').waitFor();
    record.checks.exactNonvisualEntry = true; await snap("exact-terminal-entry");
    await page.getByRole("button", { name: /^Back to finding:/ }).click(); await page.locator('[data-finding="F1"][aria-expanded="true"]').waitFor();
  });
  await runCase("analysis-feed-isolation", { running: true, live: true, prepare() { analysisMode = "held"; } }, async ({ page, record, snap }) => {
    await openLane(page); const before = pollCount;
    appendFrame(data, 5); await until(async () => pollCount >= before + 2, "Analysis latency stalled the ordinary recording feed", 12_000);
    assert.equal(await page.getByText(/Updates interrupted/).count(), 0);
    await studySlider(page).press("End");
    await until(async () => (await displayedFrame(page))?.endsWith("portrait-5.png"), "Latest evidence failed to arrive while analysis was stalled");
    record.checks = { recordingPollsDuringStall: pollCount - before }; await snap("recording-updates-during-analysis-stall");
  });
  await runCase("analysis-large", { prepare() {
    analysis = analysisFixture(data, { count: 30 });
    analysis.analysis.result.findings[29].title = "A deliberately long finding title retains readable wrapping while reviewing the final observation in a larger synthetic study";
    analysis.corrections = [{ schema: "humanish.study-analysis-correction.v1", id: "correction-1", analysisId: analysis.analysis.id, analysisSha256: "b".repeat(64), findingId: "F30", findingSha256: "c".repeat(64), createdAt: new Date(START).toISOString(), status: "dismissed", reason: "Reviewer found the synthetic observation unhelpful.", replacementClaim: null }];
  } }, async ({ page, record, snap }) => {
    await page.getByRole("link", { name: /^Findings/ }).click();
    for (const phone of [false, true]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const final = page.locator('[data-finding="F30"]'); await final.scrollIntoViewIfNeeded();
      if (await final.getAttribute("aria-expanded") !== "true") await final.click();
      await page.getByRole("heading", { name: "Dismissed by reviewer", exact: true }).waitFor();
      const width = await pageWidth(page); assert(width.page <= width.viewport + 1, "Long findings overflow the page");
      await snap(`${phone ? "phone" : "desktop"}-${theme}-annotation`);
    }
    assert.equal(await page.locator(".report-finding").count(), 30, "A reviewer annotation removed the original claim");
    record.checks = { findings: 30, originalClaimRetained: true };
  });
  for (const phone of [false, true]) for (const dpr of [1, 2]) await runCase(`scrubber-${phone ? "phone" : "desktop"}-${dpr}x`, { phone, dpr, touch: phone }, async ({ page, record, snap }) => {
    await openLane(page, 2);
    const slider = studySlider(page);
    record.checks.paintedStates = [];
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      for (const position of ["start", "middle", "end"]) {
        await slider.press(position === "start" ? "Home" : "End");
        if (position === "middle") await slider.press("ArrowLeft");
        await page.evaluate(() => document.activeElement?.blur());
        const measurement = await scrubberPixels(page, "Seek study recording"); assertScrubberAligned(measurement);
        record.checks.paintedStates.push({ theme, position, ...measurement });
      }
      await snap(`${theme}-aligned`);
    }
    await slider.press("ArrowLeft");
    const broken = await page.addStyleTag({ content: `.study-playback .scrubwrap { height:26px !important } .study-playback .scrub { height:${phone ? 44 : 36}px !important } .scrub-track { top:11px !important; transform:none !important; left:0 !important; right:0 !important }` });
    const negative = await scrubberPixels(page, "Seek study recording"); let rejected = false;
    try { assertScrubberAligned(negative); } catch { rejected = true; }
    assert(rejected, "Paint guard accepted the known broken thumb/track geometry");
    record.checks.knownBrokenControl = { rejected, measurement: negative }; await snap("known-broken-control");
    await broken.evaluate((element) => element.remove()); assertScrubberAligned(await scrubberPixels(page, "Seek study recording"));
    await slider.press("Home"); await slider.press("ArrowRight"); assert.equal(await slider.inputValue(), "7000");
    const bounds = await slider.boundingBox();
    if (phone) { assert(bounds.height >= 44); await slider.tap({ position: { x: bounds.width * .8, y: bounds.height / 2 } }); }
    else await slider.click({ position: { x: bounds.width * .8, y: bounds.height / 2 } });
    const preciseCursor = Number(await slider.inputValue());
    assert(preciseCursor > 14000 && preciseCursor < 21000, "Pointer seeking did not retain a precise study time between captures");
    await readyCapture(page.locator(".stage-box img").first(), "landscape-3.png");
    await slider.focus(); assert.equal(await slider.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
    record.checks.pointerAndKeyboard = true; await snap("restored-interactive-control");
    data = fixture({ frames: 1, origin }); await page.reload(); await slider.waitFor();
    assert(await slider.isDisabled(), "One retained capture must not offer a seekable timeline");
    assertScrubberAligned(await scrubberPixels(page, "Seek study recording")); record.checks.disabledSingleCapture = true;
    await snap("disabled-single-capture");
  });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const completeCases = coverage.cases.map((entry) => ({ ...entry, status: results.find((result) => result.id === entry.id)?.status ?? "not-run" }));
const summary = { schema: "humanish.observer-browser-proof.v1", scope: coverage.scope, generatedAt: new Date().toISOString(),
  artifactSha256: createHash("sha256").update(html).digest("hex"), browser: executablePath,
  selectedCase, localCasesPass: results.length > 0 && results.every((result) => result.status === "passed"),
  localCoverageComplete: results.length === coverage.cases.length && results.every((result) => result.status === "passed"),
  accessibility: { requested: !!axeSource, auditedCases: results.filter((r) => Array.isArray(r.checks.accessibility?.violations)).length,
    violations: results.reduce((n, r) => n + (r.checks.accessibility?.violations?.length ?? 0), 0),
    reviewedTooltipAdvisories: results.reduce((n, r) => n + (r.checks.accessibility?.reviewedAdvisories?.length ?? 0), 0),
    manualChecks: results.filter((r) => r.checks.accessibility?.incomplete?.length).map((r) => ({ case: r.id, checks: r.checks.accessibility.incomplete })) },
  coverageComplete: false, cases: completeCases, externalAcceptance: coverage.externalAcceptance,
  note: "Controlled renderer proof is not provider, CLI entrypoint, or complete Observer release acceptance." };
assert.equal(results.length, selectedCase ? 1 : coverage.cases.length, "Every declared local case must produce a result");
await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
await writeFile(path.join(output, "fixture.json"), JSON.stringify(fixture(), null, 2));
await mkdir(path.join(output, "assets"));
await Promise.all([...images].map(([name, bytes]) => writeFile(path.join(output, "assets", path.basename(name)), bytes)));
const rows = [...completeCases, ...coverage.externalAcceptance].map((entry) => `<tr><td>${escape(entry.id)}</td><td class="${entry.status}">${escape(entry.status)}</td><td>${escape(entry.goal ?? entry.reason)}</td></tr>`).join("");
const panels = results.map((result) => `<article id="${escape(result.id)}"><h2>${escape(result.id)} · ${escape(result.status)}</h2>${result.error ? `<pre>${escape(result.error.split("\n").slice(0, 4).join("\n"))}</pre>` : ""}<p><a href="${escape(result.id)}/proof.json">Measured state and HTTP receipts</a></p><div class="screens">${result.screenshots.map((src) => `<a href="${escape(src)}"><img src="${escape(src)}" alt="${escape(src)}" loading="lazy"></a>`).join("")}</div></article>`).join("");
await writeFile(path.join(output, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Observer browser proof</title><style>body{font:16px system-ui;background:#edf1f3;color:#182b35;margin:0;padding:32px;max-width:1500px;margin-inline:auto}h1{font-size:36px;margin-bottom:8px}p{max-width:850px;line-height:1.5}table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid #cbd5da;padding:10px;text-align:left;vertical-align:top}.passed{color:#166344}.failed{color:#a32235}.external,.uncovered,.not-run{color:#74521a}article{padding-block:24px;border-bottom:1px solid #9aabb4}.screens{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}img{max-width:100%;height:auto;border:1px solid #cbd5da}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#174e75}</style><h1>Observer browser proof</h1><p>${escape(coverage.scope)}. Local cases: ${results.filter((result) => result.status === "passed").length}/${results.length} passed. Uncovered and external acceptance remain visible below; this report does not certify a complete release.</p><p><a href="summary.json">Coverage manifest</a></p><p>Automated accessibility scans: ${summary.accessibility.auditedCases}. Unresolved violations: ${summary.accessibility.violations}. Reviewed tooltip-portal advisories: ${summary.accessibility.reviewedTooltipAdvisories}. The manifest retains checks requiring manual review.</p><table><thead><tr><th>Surface/state</th><th>Result</th><th>Proof target or remaining gap</th></tr></thead><tbody>${rows}</tbody></table>${panels}</html>`);
process.stdout.write(`Observer browser evidence: ${output}\n`);
process.exitCode = summary.localCasesPass ? 0 : 1;
