// Development conformance driver. This is not the packaged guest driver or a local runtime.
// The parent supplies a private socket and a synthetic loopback page; no operator profile is used.
import { createHash } from "node:crypto";
import net from "node:net";
import { chromium } from "playwright-core";
import { attachBrowserControlDispatcher } from "../../dist/browser-control-dispatcher.js";
import { CuaExecutorError } from "../../dist/cua-executor-error.js";

const [socketPath, profilePath, targetUrl, identityJson, mode, executablePath] = process.argv.slice(2);
const identity = JSON.parse(identityJson);
const authority = new AbortController();
const allowedOrigin = new URL(targetUrl).origin;
let unexpectedRequests = 0;
let executed = 0;
let preparing = false;
let dispatched = false;
let stopping;
let transport;
let controller;
const context = await chromium.launchPersistentContext(profilePath, {
  headless: true,
  chromiumSandbox: true,
  executablePath,
  viewport: { width: 960, height: 640 },
  serviceWorkers: "block",
  args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"]
});
await context.route("**/*", async route => {
  if (new URL(route.request().url()).origin === allowedOrigin) await route.continue();
  else { unexpectedRequests++; await route.abort(); }
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto(targetUrl);

function assertAuthorized(signal) {
  if (authority.signal.aborted || signal?.aborted) {
    throw new CuaExecutorError("session_revoked", dispatched ? "outcome_uncertain" : "not_dispatched");
  }
}
async function input(signal, operation) {
  // No asynchronous preparation occurs between this check and the browser call.
  assertAuthorized(signal);
  dispatched = true;
  return operation();
}
async function snapshot() {
  return {
    text: await page.locator("body").innerText(),
    saves: await page.locator("#save-count").textContent(),
    note: await page.locator("#note").inputValue(),
    boxes: { note: await page.locator("#note").boundingBox(), save: await page.locator("#save").boundingBox() },
    executed, unexpectedRequests
  };
}
const executor = {
  async observe() {
    assertAuthorized();
    const screenshot = await page.screenshot({ type: "png" });
    return {
      screenshot,
      stateSignature: createHash("sha256").update(screenshot).digest("hex"),
      url: page.url(), title: await page.title(),
      text: await page.locator("body").innerText(),
      scrollY: await page.evaluate(() => window.scrollY)
    };
  },
  async execute(action, signal) {
    dispatched = false;
    if (mode.endsWith("during-preparation") && !preparing) {
      preparing = true;
      process.send?.({ event: "preparing" });
      await new Promise(resolve => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", resolve, { once: true });
      });
    }
    assertAuthorized(signal);
    switch (action.kind) {
      case "click": await input(signal, () => page.mouse.click(action.x, action.y, { button: action.button ?? "left" })); break;
      case "double_click": await input(signal, () => page.mouse.dblclick(action.x, action.y)); break;
      case "move": await input(signal, () => page.mouse.move(action.x, action.y)); break;
      case "type": await input(signal, () => page.keyboard.insertText(action.text)); break;
      case "keypress": {
        const names = { CTRL: "Control", ALT: "Alt", SHIFT: "Shift", META: "Meta", ENTER: "Enter", TAB: "Tab", BACKSPACE: "Backspace", ESC: "Escape" };
        await input(signal, () => page.keyboard.press(action.keys.map(key => names[key.toUpperCase()] ?? key).join("+")));
        break;
      }
      case "scroll":
        await input(signal, () => page.mouse.move(action.x, action.y));
        await input(signal, () => page.mouse.wheel(action.dx, action.dy));
        break;
      case "drag":
        await input(signal, () => page.mouse.move(action.path[0].x, action.path[0].y));
        await input(signal, () => page.mouse.down());
        for (const point of action.path.slice(1)) await input(signal, () => page.mouse.move(point.x, point.y));
        await input(signal, () => page.mouse.up());
        break;
      case "wait": await new Promise(resolve => setTimeout(resolve, action.ms ?? 0)); assertAuthorized(signal); break;
      case "screenshot": break;
      default: throw new Error("Unexpected conformance action.");
    }
    executed++;
    if (mode === "lose-acknowledgment" && action.kind === "click") {
      // The browser mutation is corroborated independently before the reply is lost.
      await page.waitForFunction(() => document.querySelector("#save-count")?.textContent === "1");
      process.send?.({ event: "mutation", state: await snapshot() });
      transport.destroy();
    }
  }
};
transport = net.createConnection(socketPath);
await new Promise((resolve, reject) => { transport.once("connect", resolve); transport.once("error", reject); });
controller = attachBrowserControlDispatcher({ transport, identity, executor, isAuthorized: () => !authority.signal.aborted, authoritySignal: authority.signal });

async function stop() {
  stopping ??= (async () => {
    authority.abort();
    controller.close();
    await context.close();
    process.send?.({ event: "closed", unexpectedRequests });
    process.disconnect?.();
  })();
  return stopping;
}
process.on("message", async message => {
  try {
    if (message?.command === "snapshot") process.send?.({ event: "snapshot", state: await snapshot() });
    if (message?.command === "revoke") { authority.abort(); process.send?.({ event: "revoked" }); }
    if (message?.command === "stop") await stop();
  } catch { process.send?.({ event: "fixture-error" }); await stop(); process.exitCode = 1; }
});
process.once("disconnect", () => { void stop(); });
process.send?.({ event: "ready", browserVersion: context.browser()?.version() ?? "unavailable", chromiumSandbox: true });
