#!/usr/bin/env node
// Fails when a line of the homepage hero's prose ends with one word alone on its last line, at a
// phone, tablet and desktop width. A lone last word reads as a layout mistake on the first screen
// a visitor sees, and a type-scale or copy change can cause one at a width nobody looked at.
//
// Needs a production build of the site (`pnpm --filter humanish-site build`) and Chromium
// (`pnpm exec playwright-core install chromium`). Starts `next start` on a free port, or checks
// the URL passed as the first argument.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright-core";

const WIDTHS = [390, 768, 1440];
const BLOCKS = [".hero-copy h1", ".hero-copy .lede", ".hero-copy .hero-limits"];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startSite() {
  const port = await freePort();
  const child = spawn(
    "pnpm",
    ["--filter", "humanish-site", "start", "-p", String(port), "-H", "127.0.0.1"],
    // Its own process group: pnpm starts next, and stopping the group stops both.
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  const group = child.pid;
  const stop = () => {
    if (group === undefined) return;
    try {
      process.kill(-group, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return { url, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stop();
  throw new Error(`next start did not answer on ${url}`);
}

/** In the page: the words on each block's last line, from the layout boxes of its text. */
function lastLines(selectors) {
  return selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return { selector, missing: true };
    const words = [];
    // Text split across elements with no space between, as in human(ish), is one word when its
    // pieces share a line; a <br> or a wrap between them makes two.
    let glued = false;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of node.data.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        const word = { text: match[0], middle: (rect.top + rect.bottom) / 2 };
        const previous = words.at(-1);
        const sameLine = previous && Math.abs(previous.middle - word.middle) < rect.height / 2;
        if (glued && match.index === 0 && sameLine) previous.text += word.text;
        else words.push(word);
        glued = false;
      }
      glued = /\S$/.test(node.data);
    }
    if (words.length === 0) return { selector, missing: true };
    const lineHeight = parseFloat(getComputedStyle(element).fontSize) * 0.6;
    const last = Math.max(...words.map((word) => word.middle));
    const first = Math.min(...words.map((word) => word.middle));
    return {
      selector,
      lines: last - first > lineHeight ? "several" : "one",
      lastLine: words.filter((word) => last - word.middle < lineHeight).map((word) => word.text),
    };
  });
}

const site = process.argv[2] ? { url: process.argv[2], stop: () => {} } : await startSite();
const browser = await chromium.launch({ headless: true });
const failures = [];
try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
      isMobile: width < 500,
      hasTouch: width < 500,
    });
    const page = await context.newPage();
    await page.goto(`${site.url}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    for (const block of await page.evaluate(lastLines, BLOCKS)) {
      if (block.missing) failures.push(`${width}px ${block.selector}: not found`);
      else if (block.lines === "several" && block.lastLine.length === 1)
        failures.push(
          `${width}px ${block.selector}: "${block.lastLine[0]}" alone on the last line`,
        );
      else
        process.stdout.write(
          `${width}px ${block.selector}: last line "${block.lastLine.join(" ")}"\n`,
        );
    }
    await context.close();
  }
} finally {
  await browser.close();
  site.stop();
}
if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("site hero wrap ok\n");
