import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { analysisFixture, fixture, screenshot } from "./observer-browser-fixtures.mjs";
import { bounded } from "./observer-proof-wait.mjs";

// Temporary CI diagnostic: run the proof in fresh processes until the step budget is spent.
if (!process.env.HUMANISH_PROOF_LOOP_CHILD) {
  const { spawnSync } = await import("node:child_process");
  const started = Date.now();
  let runs = 0,
    failures = 0;
  while (Date.now() - started < 250_000 && runs < 40) {
    runs += 1;
    const t0 = Date.now();
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, HUMANISH_PROOF_LOOP_CHILD: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (child.status !== 0) failures += 1;
    const lines = `${child.stdout ?? ""}${child.stderr ?? ""}`
      .split("\n")
      .filter((line) => line && !line.startsWith("Proof:"));
    process.stdout.write(
      `--- run ${runs} exit=${child.status} signal=${child.signal} ms=${Date.now() - t0}\n${lines.join("\n")}\n`,
    );
  }
  process.stdout.write(`LOOP ${runs - failures}/${runs} passed\n`);
  process.exit(failures ? 1 : 0);
}

// Bounded supplement to observer-browser-proof: appearance, pin visibility,
// library motion and fitted card geometry over synthetic retained recordings.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(
  root,
  ".humanish/observer-chrome-proof",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(output, { recursive: true });
const html = await readFile(path.join(root, "observer/dist/index.html"), "utf8");
const data = fixture({ laneCount: 4 });
const slot =
  '<script id="observer-data" type="application/json">__HUMANISH_OBSERVER_DATA__</script>';
assert.equal(html.split(slot).length, 2, "Build the unfilled Observer first");
const analysis = analysisFixture(data);
const artifact = html
  .replace(
    slot,
    `<script id="observer-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`,
  )
  .replace(
    '<script id="study-analysis" type="application/json">__HUMANISH_STUDY_ANALYSIS__</script>',
    `<script id="study-analysis" type="application/json">${JSON.stringify(analysis).replace(/</g, "\\u003c")}</script>`,
  );
const pixels = new Map();
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("cache-control", "no-store");
  if (url.pathname === "/observer/index.html") {
    response.setHeader("content-type", "text/html");
    response.end(artifact);
  } else if (url.pathname === "/observer/observer-data.json") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(data));
  } else if (url.pathname === "/observer/study-analysis.json") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(analysis));
  } else if (url.pathname === "/_humanish/history.json") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ latestRunId: data.run.runId, runs: [] }));
  } else {
    const match = /^\/screenshots\/(portrait|landscape)-(\d+)\.png$/.exec(url.pathname);
    if (!match) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!pixels.has(url.pathname))
      pixels.set(
        url.pathname,
        screenshot(
          match[1] === "portrait" ? 390 : 1200,
          match[1] === "portrait" ? 844 : 750,
          Number(match[2]),
        ),
      );
    response.setHeader("content-type", "image/png");
    response.end(pixels.get(url.pathname));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const candidates = [
  process.env.HUMANISH_BROWSER_EXECUTABLE,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  chromium.executablePath(),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {
    /* next */
  }
}
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
async function settle(page, when) {
  await bounded(
    `Settling animations ${when}`,
    page.evaluate(async () => {
      // Base UI clears its starting style on an animation frame. Wait for that
      // transition to exist before waiting for it to finish and taking a receipt.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
      await new Promise(requestAnimationFrame);
    }),
    5000,
  );
}
async function chooseDensity(page, value) {
  await page.getByRole("button", { name: "View and filter participants", exact: true }).click();
  const control = page.getByRole("combobox", { name: "Preview size", exact: true });
  if (await control.evaluate((element) => element.tagName === "SELECT"))
    await control.selectOption(value);
  else {
    await control.click();
    await page
      .getByRole("option", { name: value[0].toUpperCase() + value.slice(1), exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Close view options", exact: true }).click();
}
try {
  for (const phone of [false, true])
    for (const reduced of [false, true]) {
      const id = `${phone ? "phone" : "desktop"}-${reduced ? "reduced-motion" : "motion"}`;
      const record = {
        id,
        status: "running",
        checks: {},
        screenshots: [],
        errors: [],
        unexpectedNetwork: [],
      };
      results.push(record);
      const context = await bounded(
        `${id}: opening a browser context`,
        browser.newContext({
          viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          hasTouch: phone,
          isMobile: phone,
          colorScheme: "light",
          reducedMotion: reduced ? "reduce" : "no-preference",
        }),
      );
      await context.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        record.unexpectedNetwork.push(route.request().url());
        return route.abort();
      });
      const page = await bounded(`${id}: opening a page`, context.newPage());
      page.setDefaultTimeout(8000);
      page.on("pageerror", (error) => record.errors.push(error.message));
      async function snap(name) {
        await settle(page, `before the ${name} screenshot`);
        const file = `${id}-${name}.png`;
        await page.screenshot({ path: path.join(output, file) });
        record.screenshots.push(file);
      }
      try {
        await page.goto(`${origin}/observer/index.html`);
        await page.locator(".card").first().waitFor();
        for (const density of ["compact", "comfortable", "large"]) {
          await chooseDensity(page, density);
          const images = await page.locator(".keyframe").all();
          for (const [index, image] of images.entries()) {
            await image.scrollIntoViewIfNeeded();
            await bounded(
              `${density} density: decoding keyframe ${index + 1} of ${images.length}`,
              image.evaluate((element) => element.decode()),
              5000,
            );
          }
          const geometry = await page.locator(".card").evaluateAll((cards) =>
            cards.map((card) => {
              const area = card.querySelector(".card-preview").getBoundingClientRect(),
                image = card.querySelector("img"),
                bounds = image.getBoundingClientRect();
              const caption = card.querySelector(".card-caption").getBoundingClientRect(),
                outcome = card.querySelector(".card-outcome").getBoundingClientRect();
              return {
                card: card.getBoundingClientRect().toJSON(),
                area: area.toJSON(),
                capture: bounds.toJSON(),
                caption: caption.toJSON(),
                outcome: outcome.toJSON(),
                natural: [image.naturalWidth, image.naturalHeight],
                objectFit: getComputedStyle(image).objectFit,
                viewport: innerWidth,
                page: document.documentElement.scrollWidth,
              };
            }),
          );
          for (const value of geometry) {
            assert(
              value.card.left >= 0 && value.card.right <= value.viewport,
              "A participant card exceeds the phone width",
            );
            assert(value.page <= value.viewport, "Page has horizontal overflow");
            assert(
              value.outcome.height <= 14 && value.outcome.bottom <= value.caption.bottom,
              "Analyzed outcome wraps or escapes the fixed caption",
            );
            assert(
              Math.abs(value.area.width - value.capture.width) < 1 &&
                Math.abs(value.area.height - value.capture.height) <= 1,
              "The card adds gutters around its capture",
            );
            assert(
              Math.abs(
                value.capture.width / value.capture.height - value.natural[0] / value.natural[1],
              ) < 0.005 && value.objectFit === "contain",
              "Capture is cropped or distorted",
            );
          }
          record.checks[density] = geometry;
        }
        await page.locator(".content").evaluate((element) => {
          element.scrollTop = 0;
        });
        await snap("fitted-captures");
        const second = page.locator('[data-stream-id="lane-2"]');
        await second.getByRole("button", { name: /^Participant details:/ }).click();
        await page
          .locator(".pop-panel")
          .getByRole("button", { name: /^Pin participant / })
          .click();
        await page.getByRole("button", { name: "Close participant details", exact: true }).click();
        assert.equal(await page.locator(".card").first().getAttribute("data-stream-id"), "lane-2");
        await second.getByLabel("Pinned participant", { exact: true }).waitFor();
        await snap("visible-pin");
        await page.reload();
        await second.getByLabel("Pinned participant", { exact: true }).waitFor();
        await second.getByRole("button", { name: /^Participant details:/ }).click();
        const pin = page
          .locator(".pop-panel")
          .getByRole("button", { name: /^Pinned participant / });
        assert.equal(await pin.getAttribute("aria-pressed"), "true");
        assert.equal((await pin.textContent()).trim(), "Pinned");
        await pin.click();
        await page.getByRole("button", { name: "Close participant details", exact: true }).click();
        assert.equal(await page.getByLabel("Pinned participant", { exact: true }).count(), 0);
        record.checks.pin = "Visible, persisted on reload, removed when unpinned";

        const toggle = page.getByRole("button", { name: "Toggle study library", exact: true });
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        const side = phone ? page.locator(".drawer-pop .side") : page.locator(".frame > .side");
        await side.waitFor();
        await settle(page, "after opening the library");
        const darkAction = side.getByRole("button", { name: "Switch to dark theme", exact: true });
        assert.equal(await darkAction.locator("svg").count(), 1);
        // The system remains authoritative until a user selects a theme.
        await page.emulateMedia({ colorScheme: "dark" });
        const lightAction = side.getByRole("button", {
          name: "Switch to light theme",
          exact: true,
        });
        await lightAction.waitFor();
        assert.equal(await lightAction.locator("svg").count(), 1);
        await lightAction.click();
        assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
        await darkAction.waitFor();
        await darkAction.click();
        await lightAction.waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem("humanish-theme")), "dark");
        await snap("single-theme-action");
        const duration = await (phone ? page.locator(".drawer-pop") : side).evaluate(
          (element) => getComputedStyle(element).transitionDuration,
        );
        assert.equal(
          duration.split(",").some((entry) => parseFloat(entry) > 0),
          !reduced,
        );
        record.checks.motionDuration = duration;
        if (!phone) {
          const handle = await side.elementHandle();
          const cursor = await page
            .getByRole("slider", { name: "Seek study recording", exact: true })
            .inputValue();
          await toggle.click();
          assert.equal(await side.getAttribute("inert"), "");
          await side.waitFor({ state: "hidden" });
          await page.keyboard.press("Tab");
          assert.equal(
            await page.evaluate(() => !!document.activeElement.closest(".side")),
            false,
            "Focus entered collapsed library",
          );
          await toggle.click();
          await side.waitFor();
          await settle(page, "after expanding the library");
          assert(
            await side.evaluate((element, prior) => element === prior, handle),
            "Collapse remounted the library",
          );
          assert.equal(await side.getAttribute("inert"), null);
          assert.equal(
            await page
              .getByRole("slider", { name: "Seek study recording", exact: true })
              .inputValue(),
            cursor,
          );
        } else {
          await page.keyboard.press("Escape");
          await side.waitFor({ state: "hidden" });
          await toggle.click();
          await side.waitFor();
          await settle(page, "after reopening the library drawer");
          await side.getByRole("button", { name: "Switch to light theme", exact: true }).waitFor();
        }
        const libraryBounds = await side.boundingBox();
        assert(
          libraryBounds && Math.abs(libraryBounds.x) < 1,
          "Library is still offscreen after opening",
        );
        record.checks.libraryRestored = libraryBounds;
        await snap("library-restored");
        assert.equal(record.errors.length, 0);
        assert.equal(record.unexpectedNetwork.length, 0);
        record.status = "passed";
      } catch (error) {
        record.status = "failed";
        record.error = String(error.stack ?? error);
        const { readFileSync, readdirSync } = await import("node:fs");
        const sample = () => {
          const parents = new Map();
          for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
            try {
              const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
              parents.set(pid, stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
            } catch {
              /* process exited */
            }
          }
          const ours = (pid) => {
            for (let at = pid; at && at !== "1"; at = parents.get(at))
              if (at === String(process.pid)) return true;
            return false;
          };
          const processes = [];
          for (const pid of parents.keys()) {
            if (pid === String(process.pid) || !ours(pid)) continue;
            try {
              const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
              const type = /--type=([a-z-]+)/.exec(command)?.[1] ?? "browser";
              const threads = readdirSync(`/proc/${pid}/task`).map((tid) => {
                const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
                const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                return {
                  tid,
                  name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
                  state: fields[0],
                  ticks: Number(fields[11]) + Number(fields[12]),
                  wchan: readFileSync(`/proc/${pid}/task/${tid}/wchan`, "utf8"),
                };
              });
              processes.push({ pid, type, threads });
            } catch {
              /* process exited */
            }
          }
          return processes;
        };
        const before = sample();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const after = sample();
        const report = after.map((process) => {
          const prior = before.find((entry) => entry.pid === process.pid);
          return {
            pid: process.pid,
            type: process.type,
            threads: process.threads
              .map((thread) => ({
                ...thread,
                delta:
                  thread.ticks -
                  (prior?.threads.find((entry) => entry.tid === thread.tid)?.ticks ?? thread.ticks),
              }))
              .filter(
                (thread) =>
                  thread.tid === process.pid ||
                  thread.delta > 0 ||
                  /Compositor|Main|IO/.test(thread.name),
              )
              .map(
                ({ tid, name, state, delta, wchan }) =>
                  `${tid === process.pid ? "main" : name}:${state}:+${delta}:${wchan}`,
              ),
          };
        });
        process.stdout.write(`PROC ${id} ${JSON.stringify(report)}\n`);
        const diagnosis = await bounded(
          "diagnosis",
          page.evaluate(async () => {
            const frame = await Promise.race([
              new Promise((r) => requestAnimationFrame(() => r("fired"))),
              new Promise((r) => setTimeout(() => r("none in 1 s"), 1000)),
            ]);
            return {
              frame,
              visibility: document.visibilityState,
              focus: document.hasFocus(),
              animations: document.getAnimations().map((a) => ({
                type: a.constructor.name,
                name: a.animationName ?? a.transitionProperty,
                state: a.playState,
                pending: a.pending,
                time: a.currentTime,
                end: a.effect?.getComputedTiming().endTime,
                target: String(a.effect?.target?.className ?? a.effect?.target?.tagName).slice(
                  0,
                  80,
                ),
              })),
              images: [...document.querySelectorAll(".card img")].map((i) => ({
                cls: i.className,
                complete: i.complete,
                width: i.naturalWidth,
                top: Math.round(i.getBoundingClientRect().top),
              })),
              scroll: document.querySelector(".content")?.scrollTop,
              portals: document.querySelectorAll("[data-base-ui-portal]").length,
              url: location.href,
            };
          }),
          4000,
        ).catch((failure) => ({ unavailable: failure.message }));
        process.stdout.write(`DIAG ${id} ${JSON.stringify(diagnosis)}\n`);
        await snap("failure").catch(() => {});
      } finally {
        await bounded(`${id}: closing the browser context`, context.close());
      }
      process.stdout.write(
        `${record.status.toUpperCase()} ${id}${record.error ? `: ${record.error.split("\n")[0]}` : ""}\n`,
      );
    }
} finally {
  await writeFile(
    path.join(output, "proof.json"),
    JSON.stringify(
      {
        scope:
          "Synthetic renderer proof, Chromium desktop and emulated phone; no provider or physical-device claim",
        results,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Proof: ${output}\n`);
  await bounded("Closing the browser", browser.close());
  await bounded("Closing the fixture server", new Promise((resolve) => server.close(resolve)));
}
if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
