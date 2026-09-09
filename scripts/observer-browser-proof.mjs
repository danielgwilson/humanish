#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { appendFrame, fixture, screenshot, START } from "./observer-browser-fixtures.mjs";

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
    response.end('<!doctype html><html><body style="margin:0"><iframe title="Observer with browser permissions denied" src="/observer/index.html#/lane/lane-1/f/2" allow="fullscreen \'none\'; clipboard-write \'none\'" style="border:0;width:100vw;height:100vh"></iframe></body></html>');
  } else if (url.pathname === "/observer/index.html") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(inject(data));
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
  data = fixture({ ...options, origin }); otherData = null; imageModes.clear(); responseMode = "ok"; pollCount = 0; exerciseDesktopIsolation = false;
  if (options.prepare) options.prepare();
  const requestStart = requests.length;
  const directory = path.join(output, id); await mkdir(directory);
  const context = await browser.newContext({ viewport: options.phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, ...(options.touch ? { hasTouch: true, isMobile: true } : {}) });
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
    const name = `${record.screenshots.length + 1}-${label}.png`;
    await page.screenshot({ path: path.join(directory, name), fullPage: false });
    record.screenshots.push(`${id}/${name}`);
  }
  try {
    await page.goto(`${origin}/observer/index.html`);
    await page.getByRole("region", { name: "Study grid" }).waitFor();
    await snap("grid-before");
    await action({ page, context, directory, record, snap });
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
      await page.locator(".frame.monitoring").waitFor();
      await page.locator(".pop-panel").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Exit monitor", exact: true }).click();
      assert.equal(await page.locator(".frame.monitoring").count(), 0, "Monitor exit is unreachable");
      if (!phone) {
        record.checks.rows = [];
        for (const [density, expectedHeight] of [["compact", 200], ["comfortable", 280], ["large", 360]]) {
          await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
          await page.getByLabel("Preview size").selectOption(density);
          await page.keyboard.press("Escape");
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
        await page.getByLabel("Preview size").selectOption("comfortable");
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
  await runCase("playing-refresh", {}, async ({ page, record, snap }) => {
    await openLane(page);
    await page.getByRole("button", { name: "Playback speed", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    assert.equal(await page.getByRole("button", { name: "Pause", exact: true }).count(), 1, "Playback stopped before the reload check");
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
    await zoom.selectOption("actual");
    record.checks.actual = await page.locator(".stage-box img").evaluate((img) => ({ width: img.getBoundingClientRect().width, natural: img.naturalWidth }));
    assert(Math.abs(record.checks.actual.width - record.checks.actual.natural) <= 2, "Actual size is not native pixel size");
    await zoom.selectOption("2");
    record.checks.double = await page.locator(".stage-box img").evaluate((img) => ({ width: img.getBoundingClientRect().width, natural: img.naturalWidth }));
    assert(Math.abs(record.checks.double.width - 2 * record.checks.double.natural) <= 2, "200% zoom did not scale the recording");
    record.checks.pin = await page.locator(".stage-box").evaluate((stage) => {
      const image = stage.querySelector("img").getBoundingClientRect(), pin = stage.querySelector(".spin").getBoundingClientRect();
      return { actual: [pin.left + pin.width / 2, pin.top + pin.height / 2], expected: [image.left + image.width * 120 / 390, image.top + image.height * 240 / 844] };
    });
    assert(record.checks.pin.actual.every((value, index) => Math.abs(value - record.checks.pin.expected[index]) < 3), "Click marker detached from screenshot coordinates under zoom");
    record.checks.width = await pageWidth(page);
    assert(record.checks.width.page <= record.checks.width.viewport + 1, "Zoom overflow escaped the evidence stage");
    await snap("zoomed-evidence"); await zoom.selectOption("fit");
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await until(() => page.evaluate(() => document.fullscreenElement !== null), "Native fullscreen never opened");
    assertFullFrames(await inspectImages(page.locator(".stage-box img"))); await snap("native-fullscreen");
    await page.locator(".stage").click({ position: { x: 8, y: 8 } }); await page.keyboard.press("ArrowRight");
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
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
    await page.getByLabel("Preview size").selectOption("compact");
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
    await page.getByLabel("Preview size").selectOption("compact");
    await page.getByRole("button", { name: "Close view options", exact: true }).click();
    record.checks.compactScreens = await assertClearGridScreens(page);
    await page.getByRole("button", { name: /^Participant details:/ }).first().click();
    await page.locator(".card-details").getByText(/Live desktop preview/).waitFor();
    await snap("live-source-details");
  });
  await runCase("view-preferences", {}, async ({ page, record, snap }) => {
    await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
    await page.getByLabel("Preview size").selectOption("compact");
    await page.getByRole("searchbox", { name: "Search participants", exact: true }).fill("participant 2");
    await until(async () => await page.locator(".card").count() === 1, "Search did not filter participants");
    await page.reload();
    await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
    assert.equal(await page.getByLabel("Preview size").inputValue(), "compact");
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
    await page.locator(".frame.monitoring").waitFor(); await snap("pinned-monitor");
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
    assertFullFrames(await inspectImages(page.locator(".compare-stage img"))); await snap("prior-capture-and-age");
    await page.goto(comparisonUrl(2)); await panels.nth(1).getByText("Outside recorded coverage", { exact: true }).waitFor();
    assert.equal(await panels.nth(1).locator("img").count(), 0); await snap("before-first-capture");
    await page.goto(comparisonUrl(28)); await panels.nth(1).getByText(/Past recording end/).waitFor(); await snap("past-recording-end");
  });
  for (const phone of [false, true]) await runCase(`review-library-${phone ? "phone" : "desktop"}`, { phone, touch: phone }, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/2`);
    const selectedFrame = await displayedFrame(page);
    const library = page.getByRole("button", { name: "Toggle run library", exact: true });
    assert.equal(await library.getAttribute("aria-expanded"), "false");
    if (phone) await library.tap(); else await library.click();
    const drawer = page.getByRole("dialog", { name: "Run library", exact: true });
    await drawer.getByRole("searchbox", { name: "Find a run" }).waitFor();
    await snap("library-from-player");
    await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
    assert.equal(await displayedFrame(page), selectedFrame);
    await page.goto(`${origin}/observer/index.html#/compare?lane=lane-1&lane=lane-2&clock=elapsed&at=9000`);
    await page.locator(".compare-participant").nth(1).waitFor();
    assert.equal(await page.getByRole("button", { name: "View and filter participants", exact: true }).count(), 0);
    assert.equal(await page.locator(".crumbs .here").innerText(), "comparison");
    if (phone) await library.tap(); else await library.click();
    await drawer.getByRole("searchbox", { name: "Find a run" }).waitFor(); await snap("library-from-comparison");
    await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
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
    await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
    await panels.nth(1).waitFor();
    assert.equal(new URL(page.url()).hash, comparisonHash);
    await snap("return-restores-cleared-selection");
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
    const select = page.getByLabel("Comparison run"); await select.waitFor(); await select.selectOption("synthetic-other-study");
    await page.getByText("Other run loaded as recorded evidence.", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Comparison clock").inputValue(), "elapsed");
    await page.getByText(/progress, not simultaneous events/).waitFor();
    const other = page.locator(".compare-participant").last();
    await other.locator("img").waitFor();
    record.checks.otherFrame = await other.locator("img").getAttribute("src");
    assert(record.checks.otherFrame.includes("/_humanish/runs/synthetic-other-study/screenshots/"));
    await snap("elapsed-cross-run-review");
    await page.getByLabel("Comparison clock").selectOption("shared");
    await page.getByText(/These recordings do not overlap/).waitFor();
    assert.equal(await other.locator("img").count(), 0, "Nonoverlapping future recording was shown as current"); await snap("nonoverlapping-clock");
  });
  await runCase("comparison-unknown-clock", { frames: 3, laneCount: 2, prepare: () => {
    const frames = data.streams[1].actor.items.filter((item) => item.kind === "screenshot");
    delete frames[1].at;
  } }, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/compare?lane=lane-1&lane=lane-2`);
    await page.getByText("No capture timestamps", { exact: true }).waitFor();
    await page.getByLabel("Comparison clock").selectOption("elapsed");
    await page.getByText(/estimated timing/).waitFor(); record.checks.mode = await page.getByLabel("Comparison clock").inputValue();
    await snap("explicit-estimated-clock");
    const stamps = [7, 28, 21];
    data.streams[1].actor.items.filter((item) => item.kind === "screenshot").forEach((item, index) => { item.at = new Date(START + stamps[index] * 1000).toISOString(); });
    await page.goto(`${origin}/observer/index.html?source=nonmonotonic#/compare?lane=lane-1&lane=lane-2`);
    await page.getByText("No capture timestamps", { exact: true }).waitFor(); await snap("nonmonotonic-clock-unavailable");
  });
  await runCase("keyboard-phone", { phone: true }, async ({ page, record, snap }) => {
    const library = page.getByRole("button", { name: "Toggle run library", exact: true }); await library.click();
    await page.getByRole("dialog", { name: "Run library", exact: true }).waitFor(); await snap("phone-library");
    await page.keyboard.press("Escape"); await until(async () => await page.getByRole("dialog").count() === 0, "Escape did not close library drawer");
    await page.getByRole("button", { name: /^Open participant/ }).first().click();
    const slider = page.getByRole("slider", { name: /Seek recording/ }); await slider.focus(); await slider.press("End");
    await page.locator('.stage-box img[src$="portrait-4.png"]').waitFor(); await slider.press("Home");
    await page.locator('.stage-box img[src$="portrait-1.png"]').waitFor();
    await slider.press("ArrowRight");
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    await slider.press("ArrowLeft");
    await page.locator('.stage-box img[src$="portrait-1.png"]').waitFor();
    record.checks.focusedScrubberKeys = ["End", "Home", "ArrowRight", "ArrowLeft"];
    const next = page.getByRole("button", { name: "Next frame", exact: true }); await next.focus(); await next.press("Space");
    await page.locator('.stage-box img[src$="portrait-2.png"]').waitFor();
    assert.equal(await page.getByRole("button", { name: "Pause", exact: true }).count(), 0, "Space on focused button also started playback");
    record.checks.width = await pageWidth(page); assert(record.checks.width.page <= 391); await snap("keyboard-transport");
    await page.getByRole("button", { name: "Back to participants", exact: true }).click(); await page.getByRole("region", { name: "Study grid" }).waitFor();
  });
  await runCase("review-controls", { rows: 12, prepare: () => {
    const items = data.streams[0].actor.items;
    items.splice(3, 0, { id: "synthetic-thought", kind: "reasoning", lifecycle: "completed", title: "Reported thinking", text: "SYNTHETIC THOUGHT FOR REVIEW", at: new Date(START + 15_000).toISOString() });
    items.splice(6, 0, { id: "synthetic-finding", kind: "notice", status: "warning", lifecycle: "completed", title: "Synthetic recorded warning", text: "SYNTHETIC EXPLICIT FINDING", at: new Date(START + 22_000).toISOString() });
  } }, async ({ page, directory, record, snap }) => {
    await openLane(page); await page.getByRole("button", { name: "Next action", exact: true }).click();
    assert((await displayedFrame(page)).endsWith("portrait-2.png"));
    await page.getByRole("button", { name: "Next finding", exact: true }).click();
    await page.getByLabel("Filter activity").selectOption("findings");
    await page.locator(".acts").getByText(/SYNTHETIC EXPLICIT FINDING/).waitFor(); await snap("recorded-finding-filter");
    await page.getByLabel("Filter activity").selectOption("thoughts"); await page.locator(".acts").getByText("SYNTHETIC THOUGHT FOR REVIEW", { exact: true }).first().waitFor();
    await page.getByLabel("Filter activity").selectOption("all");
    await page.locator(".acts").getByText(/12 recorded waits/).waitFor();
    await page.getByLabel("Group waits", { exact: true }).uncheck();
    assert(await page.locator(".acts").getByText(/Synthetic wait/).count() === 12, "Ungrouping lost original waits");
    await page.getByLabel("Skip waits", { exact: true }).check();
    await page.getByRole("button", { name: "Playback speed", exact: true }).click();
    await page.getByRole("button", { name: "Hide inspector", exact: true }).click(); assert.equal(await page.locator(".inspector").count(), 0);
    await page.reload(); assert.equal(await page.locator(".inspector").count(), 0);
    assert(await page.getByLabel("Skip waits", { exact: true }).isChecked());
    await page.getByRole("button", { name: "Show inspector", exact: true }).click();
    record.checks.speed = await page.getByRole("button", { name: "Playback speed", exact: true }).innerText(); assert.equal(record.checks.speed, "2×"); await snap("persisted-review-preferences");
    const downloading = page.waitForEvent("download"); await page.getByRole("link", { name: "Original frame", exact: true }).click();
    const download = await downloading; record.checks.originalDownload = download.suggestedFilename();
    assert(/^portrait-\d+\.png$/.test(record.checks.originalDownload)); await download.saveAs(path.join(directory, "downloaded-original.png"));
  });
  await runCase("missing-moment", {}, async ({ page, record, snap }) => {
    await page.goto(`${origin}/observer/index.html#/lane/lane-1/f/999`);
    await page.getByText(/addressed frame is unavailable/).waitFor(); assert.equal(await page.locator(".stage-box img").count(), 0);
    record.checks.hash = new URL(page.url()).hash; assert(record.checks.hash.endsWith("/f/999")); await snap("unavailable-addressed-moment");
    await page.goto(`${origin}/observer/index.html#/lane/%E0%A4%A`);
    await page.getByRole("region", { name: "Study grid" }).waitFor(); await snap("malformed-route-recovery");
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
    await page.getByText("Offline recording", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^Open participant/ }).first().click();
    await page.locator('.stage-box[data-image-state="ready"]').waitFor();
    record.checks.offline = await displayedFrame(page); assert(record.checks.offline.startsWith("data:image/png;base64,"));
    await wait(5500); assert.equal(requests.length, count, "Offline recording attempted HTTP updates");
    record.checks.offlineRequests = offlineRequests; assert.equal(offlineRequests.length, 0, "Offline recording fetched non-inlined resources");
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
    assert.equal(await page.getByRole("slider", { name: /Seek recording/ }).count(), 0, "Screenshot-free lane invented a timeline");
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
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const completeCases = coverage.cases.map((entry) => ({ ...entry, status: results.find((result) => result.id === entry.id)?.status ?? "not-run" }));
const summary = { schema: "humanish.observer-browser-proof.v1", scope: coverage.scope, generatedAt: new Date().toISOString(),
  artifactSha256: createHash("sha256").update(html).digest("hex"), browser: executablePath,
  selectedCase, localCasesPass: results.length > 0 && results.every((result) => result.status === "passed"),
  localCoverageComplete: results.length === coverage.cases.length && results.every((result) => result.status === "passed"),
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
