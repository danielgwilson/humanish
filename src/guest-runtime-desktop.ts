import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createGuestDesktopNativeTools } from "./guest-desktop-native.js";
import { createGuestChromiumText } from "./guest-chromium-text.js";
import { createGuestBrowserTools } from "./guest-browser-tools.js";
import { createGuestDesktopExecutor } from "./guest-desktop-executor.js";
import { CuaExecutorError } from "./cua-executor-error.js";
import type { GuestRuntimeDesktop } from "./guest-runtime.js";
import { GUEST_BOOTSTRAP_LIMITS, validateGuestInitialUrl } from "./guest-bootstrap.js";
import type { GuestMediaConfig } from "./guest-media-config.js";
import { startDesktopMedia } from "./guest-desktop-media.js";

export const GUEST_RUNTIME_PATHS = Object.freeze({ root: "/opt/humanish/control", run: "/run/humanish", home: "/home/humanish" });
export const GUEST_RUNTIME_ENV = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/home/humanish", USER: "humanish", LOGNAME: "humanish",
  LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DISPLAY: ":0", XAUTHORITY: "/run/humanish/Xauthority",
  XDG_RUNTIME_DIR: "/run/humanish/xdg", XDG_CACHE_HOME: "/home/humanish/.cache", XDG_CONFIG_HOME: "/home/humanish/.config", TMPDIR: "/tmp" });
const bad = (): CuaExecutorError => new CuaExecutorError("execution_failed", "not_dispatched");
const CONFIG_SHA = "4ae1c52eab748a3624b3948ce792647be258caba70c8c72038b9a43be6459552";
export type GuestRuntimePhase = "layout" | "xauthority" | "display" | "window_manager" | "media" | "browser" | "sandbox" | "focus" | "fixture" | "navigation";

/** Initial document only: do not wait for app data, subresources or network idle. */
export async function navigateGuestInitialPage(page: Pick<Page, "goto" | "waitForFunction">, initialUrl: string, signal: AbortSignal): Promise<void> {
  const url = validateGuestInitialUrl(initialUrl);
  signal.throwIfAborted();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: GUEST_BOOTSTRAP_LIMITS.navigationMs });
  signal.throwIfAborted();
  // A document event precedes compositing. Yield a paint before handing the
  // native full-desktop capture to a participant; this is not app readiness.
  const painted = await page.waitForFunction(`() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  })`, undefined, { timeout: GUEST_BOOTSTRAP_LIMITS.paintMs });
  await painted.dispose();
  signal.throwIfAborted();
}

/** Fixed guest layout with an optional admitted initial loopback app URL. */
export async function createGuestRuntimeDesktop(options: {
  signal: AbortSignal; onTerminal(): void;
  onPhase?(phase: GuestRuntimePhase): void;
  initialUrl?: string;
  media?: GuestMediaConfig;
}): Promise<GuestRuntimeDesktop & { readonly owner: { context: BrowserContext; page: Page; sandboxReport: string; configSha256: string } }> {
  if (options.initialUrl !== undefined) validateGuestInitialUrl(options.initialUrl);
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const children: { child: ChildProcess; closed: Promise<void>; exited: boolean }[] = [];
  let context: BrowserContext | undefined;
  let pendingContext: Promise<BrowserContext> | undefined;
  let content: ReturnType<typeof createGuestChromiumText> | undefined;
  let media: Awaited<ReturnType<typeof startDesktopMedia>> | undefined;
  let closing: Promise<{ complete: boolean }> | undefined;
  let stopping = false;
  let phase: GuestRuntimePhase = "layout";
  const progress = (next: GuestRuntimePhase): void => { phase = next; options.onPhase?.(next); };
  function check(): void { if (signal.aborted || stopping) throw bad(); }
  function child(binary: string, args: string[], input?: string, persistent = false): { done: Promise<void>; child: ChildProcess } {
    check();
    const process = spawn(binary, args, { env: GUEST_RUNTIME_ENV, cwd: GUEST_RUNTIME_PATHS.home, stdio: ["pipe", "ignore", "pipe"] });
    let finish!: () => void;
    const record = { child: process, closed: new Promise<void>(resolve => { finish = resolve; }), exited: false };
    children.push(record);
    const done = new Promise<void>((resolve, reject) => {
      let count = 0, failed = false;
      const fail = (): void => {
        failed = true;
        if (!record.exited) process.kill("SIGKILL");
        if (persistent && !stopping) options.onTerminal();
      };
      const timer = persistent ? undefined : setTimeout(fail, 2000);
      // Fixed helpers communicate success through exit status. In particular,
      // xdpyinfo's normal display inventory is large and is not an error log.
      const consume = (data: Buffer): void => {
        count += data.length;
        if (count > 16_384) fail();
      };
      process.stderr!.on("data", consume);
      process.on("error", fail); process.stdin!.on("error", fail);
      process.once("exit", () => { record.exited = true; if (persistent && !stopping) options.onTerminal(); });
      process.once("close", code => {
        record.exited = true; clearTimeout(timer); signal.removeEventListener("abort", fail); finish();
        if (persistent && !stopping) options.onTerminal();
        if (failed || code !== 0) reject(bad()); else resolve();
      });
      signal.addEventListener("abort", fail, { once: true });
      process.stdin!.end(input); if (signal.aborted) fail();
    });
    void done.catch(() => {});
    return { done, child: process };
  }
  function close(): Promise<{ complete: boolean }> {
    if (closing) return closing;
    stopping = true;
    closing = Promise.resolve().then(async () => {
      let complete = true, timer: NodeJS.Timeout | undefined;
      const work = async (): Promise<void> => {
        try { await content?.close(); } catch { complete = false; }
        try { await media?.close(); } catch { complete = false; }
        try {
          const browser = context ?? await pendingContext?.catch(() => undefined);
          if (browser) await browser.close();
        } catch { complete = false; }
        for (const record of children) if (!record.exited) record.child.kill("SIGKILL");
        await Promise.all(children.map(record => record.closed));
      };
      try {
        await Promise.race([work(), new Promise<void>(resolve => { timer = setTimeout(() => { complete = false; resolve(); }, 4000); })]);
      } finally {
        clearTimeout(timer);
        for (const record of children) if (!record.exited) { complete = false; record.child.kill("SIGKILL"); }
        options.signal.removeEventListener("abort", abort);
      }
      return { complete };
    });
    controller.abort();
    return closing;
  }
  const abort = (): void => { void close(); };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    progress("layout");
    check();
    if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) throw bad();
    for (const path of [GUEST_RUNTIME_PATHS.run, GUEST_RUNTIME_PATHS.home]) {
      const stat = await lstat(path); check();
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 1000 || stat.gid !== 1000 || (stat.mode & 0o777) !== 0o700) throw bad();
    }
    const configuration = await open(`${GUEST_RUNTIME_PATHS.root}/openbox.xml`, constants.O_RDONLY | constants.O_NOFOLLOW);
    let config: Buffer;
    try {
      const stat = await configuration.stat();
      if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o777) !== 0o444) throw bad();
      config = await configuration.readFile();
    } finally { await configuration.close(); }
    if (createHash("sha256").update(config).digest("hex") !== CONFIG_SHA) throw bad();
    for (const path of [`${GUEST_RUNTIME_PATHS.run}/xdg`, `${GUEST_RUNTIME_PATHS.run}/capture`, `${GUEST_RUNTIME_PATHS.home}/.cache`, `${GUEST_RUNTIME_PATHS.home}/.config`]) {
      check(); await mkdir(path, { mode: 0o700 });
    }
    progress("xauthority");
    const auth = await open(GUEST_RUNTIME_ENV.XAUTHORITY, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await auth.close(); check();
    await child("/usr/bin/xauth", ["-f", GUEST_RUNTIME_ENV.XAUTHORITY, "source", "-"], `add :0 . ${randomBytes(16).toString("hex")}\n`).done;
    check(); progress("display"); child("/usr/bin/Xvfb", [":0", "-screen", "0", "960x720x24", "-nolisten", "tcp", "-auth", GUEST_RUNTIME_ENV.XAUTHORITY], undefined, true);
    let displayReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      check();
      try { await child("/usr/bin/xdpyinfo", []).done; displayReady = true; break; }
      catch { await delay(50, undefined, { signal }); }
    }
    if (!displayReady) throw bad();
    progress("window_manager"); child("/usr/bin/openbox", ["--config-file", `${GUEST_RUNTIME_PATHS.root}/openbox.xml`], undefined, true);
    check();
    if (options.media !== undefined) {
      progress("media");
      media = await startDesktopMedia({ media: options.media, env: GUEST_RUNTIME_ENV, signal, onTerminal: options.onTerminal });
      check();
    }
    progress("browser"); pendingContext = chromium.launchPersistentContext(`${GUEST_RUNTIME_PATHS.home}/browser`, { executablePath: "/usr/bin/chromium",
      headless: false, chromiumSandbox: true, viewport: null, env: media?.env ?? GUEST_RUNTIME_ENV, timeout: 25_000,
      args: ["--window-size=960,680", "--window-position=0,20", "--disable-background-networking", "--disable-component-update", "--no-first-run",
        ...(options.media?.permission === "granted" ? ["--use-fake-ui-for-media-stream"] : [])] });
    void pendingContext.then(browser => { if (stopping) void browser.close().catch(() => {}); }, () => {});
    context = await pendingContext; check();
    context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(5000);
    const page = context.pages()[0]; if (!page || context.pages().length !== 1) throw bad();
    progress("sandbox"); const diagnostic = await context.newPage(); check();
    await diagnostic.goto("chrome://sandbox"); check();
    const sandboxReport = await diagnostic.locator("body").innerText();
    if (!["PID namespaces", "Network namespaces", "Seccomp-BPF sandbox"].every(label => new RegExp(label + "\\s+Yes").test(sandboxReport))
      || !sandboxReport.includes("You are adequately sandboxed")) throw bad();
    await diagnostic.close(); check(); await page.bringToFront(); check();
    progress("focus"); const native = createGuestDesktopNativeTools({ display: ":0", temporaryDirectory: `${GUEST_RUNTIME_PATHS.run}/capture`, xauthority: GUEST_RUNTIME_ENV.XAUTHORITY });
    const window = await native.activeWindowId(signal); check();
    content = createGuestChromiumText({ context, page, assertFocusedWindow: async actionSignal => {
      if (await native.activeWindowId(actionSignal) !== window) throw new CuaExecutorError("action_rejected", "not_dispatched");
    } });
    const tools = createGuestBrowserTools(native, content);
    const executor = createGuestDesktopExecutor({ width: 960, height: 720, tools, authoritySignal: signal, onTerminal: options.onTerminal });
    if (options.initialUrl !== undefined) {
      progress("navigation"); await navigateGuestInitialPage(page, options.initialUrl, signal); check();
    } else {
      progress("fixture"); await page.goto(`file://${GUEST_RUNTIME_PATHS.root}/neutral.html`); check();
      await page.locator("#note").waitFor(); check();
    }
    return { executor: media?.wrap(executor) ?? executor, close, owner: { context, page, sandboxReport, configSha256: CONFIG_SHA } };
  } catch {
    await close(); throw Object.assign(bad(), { phase });
  } finally {
    // The fresh private state belongs to the guest owner. No recursive home removal.
    if (stopping && children.every(record => record.exited)) await rm(`${GUEST_RUNTIME_PATHS.run}/capture`, { recursive: true, force: true }).catch(() => {});
  }
}
