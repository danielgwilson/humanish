import { randomBytes, createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createGuestDesktopNativeTools, type GuestDesktopNativeTools } from "./desktop-native.js";
import { createGuestChromiumText, type GuestChromiumText } from "./chromium-text.js";
import { createGuestBrowserTools } from "./browser-tools.js";
import { createGuestDesktopExecutor } from "./desktop-executor.js";
import { ComputerUseExecutorError } from "../actors/computer-use/executor-error.js";
import type { CuaExecutor } from "../actors/computer-use/loop.js";
import type { GuestRuntimeDesktop } from "./runtime.js";
import { GUEST_BOOTSTRAP_LIMITS, validateGuestInitialUrl } from "./bootstrap.js";
import type { GuestMediaConfig } from "./media-config.js";
import {
  startDesktopMedia,
  type GuestDesktopMedia,
  type GuestDesktopMediaOptions,
} from "./desktop-media.js";
import type {
  DesktopRecordingAudioSource,
  DesktopRecordingConfig,
  DesktopRecordingMetadata,
} from "../evidence/desktop-recording-types.js";
import { startDesktopRecorder, type DesktopRecorderHandle } from "../evidence/desktop-recorder.js";
import { createGuestProcesses, setupFailed, type GuestProcesses } from "./runtime-processes.js";

/** The guest image's fixed layout. Tests derive guest paths from it rather than spelling them. */
export const GUEST_RUNTIME_PATHS = Object.freeze({
  root: "/opt/humanish/control",
  run: "/run/humanish",
  home: "/home/humanish",
});
const GUEST_RUNTIME_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/home/humanish",
  USER: "humanish",
  LOGNAME: "humanish",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  DISPLAY: ":0",
  XAUTHORITY: "/run/humanish/Xauthority",
  XDG_RUNTIME_DIR: "/run/humanish/xdg",
  XDG_CACHE_HOME: "/home/humanish/.cache",
  XDG_CONFIG_HOME: "/home/humanish/.config",
  TMPDIR: "/tmp",
});
const CONFIG_SHA = "4ae1c52eab748a3624b3948ce792647be258caba70c8c72038b9a43be6459552";
const XVFB_ARGS = Object.freeze([
  ":0",
  "-screen",
  "0",
  "960x720x24",
  "-nolisten",
  "tcp",
  "-auth",
  GUEST_RUNTIME_ENV.XAUTHORITY,
]);
const SANDBOX_FEATURES = ["PID namespaces", "Network namespaces", "Seccomp-BPF sandbox"];
const RECORDING_PATH = `${GUEST_RUNTIME_PATHS.home}/desktop-recording.mp4`;
export type GuestRuntimePhase =
  | "layout"
  | "xauthority"
  | "display"
  | "window_manager"
  | "media"
  | "recording"
  | "browser"
  | "sandbox"
  | "focus"
  | "fixture"
  | "navigation";

/** Initial document only: do not wait for app data, subresources or network idle. */
export async function navigateGuestInitialPage(
  page: Pick<Page, "goto" | "waitForFunction">,
  initialUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const url = validateGuestInitialUrl(initialUrl);
  signal.throwIfAborted();
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: GUEST_BOOTSTRAP_LIMITS.navigationMs,
  });
  signal.throwIfAborted();
  // A document event precedes compositing. Yield a paint before handing the
  // native full-desktop capture to a participant; this is not app readiness.
  // Playwright evaluates a string predicate as an expression and never calls it,
  // so the string is the promise itself; a function source would resolve at once.
  const painted = await page.waitForFunction(
    `new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  })`,
    undefined,
    { timeout: GUEST_BOOTSTRAP_LIMITS.paintMs },
  );
  await painted.dispose();
  signal.throwIfAborted();
}

/** /run/humanish and /home/humanish: real directories private to the guest user. */
export function isPrivateGuestDirectory(
  stat: Pick<Stats, "isDirectory" | "isSymbolicLink" | "uid" | "gid" | "mode">,
): boolean {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.uid === 1000 &&
    stat.gid === 1000 &&
    (stat.mode & 0o777) === 0o700
  );
}

/** The window manager config: a small, read-only, single-link file owned by root. */
export function isPinnedOpenboxConfig(
  stat: Pick<Stats, "isFile" | "uid" | "gid" | "nlink" | "size" | "mode">,
): boolean {
  return (
    stat.isFile() &&
    stat.uid === 0 &&
    stat.gid === 0 &&
    stat.nlink === 1 &&
    stat.size <= 4096 &&
    (stat.mode & 0o777) === 0o444
  );
}

/** chrome://sandbox must report every namespace and seccomp feature and the overall verdict. */
export function isAdequatelySandboxed(report: string): boolean {
  return (
    SANDBOX_FEATURES.every((label) => new RegExp(label + "\\s+Yes").test(report)) &&
    report.includes("You are adequately sandboxed")
  );
}

export function chromiumLaunchArgs(media: GuestMediaConfig | undefined): string[] {
  return [
    "--window-size=960,680",
    "--window-position=0,20",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    ...(media?.permission === "granted" ? ["--use-fake-ui-for-media-stream"] : []),
  ];
}

/** The devices to start; the permission policy only changes Chromium's flags. */
export function desktopMediaRequest(media: GuestMediaConfig): GuestDesktopMediaOptions["media"] {
  return {
    ...(media.camera === undefined ? {} : { camera: media.camera }),
    ...(media.microphone === undefined ? {} : { microphone: media.microphone }),
  };
}

/** Audio needs Pulse, which only the microphone path starts. */
export function recorderAudio(
  recording: DesktopRecordingConfig,
  media: GuestMediaConfig | undefined,
): { audioSources: DesktopRecordingAudioSource[]; pulseReady: boolean } {
  return {
    audioSources: recording.audio ? ["microphone-input", "speaker-output"] : [],
    pulseReady: recording.audio && media?.microphone !== undefined,
  };
}

/** What setup has acquired so far. Teardown reads whichever fields are set. */
interface GuestDesktopState {
  context?: BrowserContext;
  pendingContext?: Promise<BrowserContext>;
  content?: GuestChromiumText;
  media?: GuestDesktopMedia;
  recorder?: DesktopRecorderHandle | undefined;
  stopping: boolean;
  closing?: Promise<{ complete: boolean }>;
}

async function verifyGuestLayout(check: () => void): Promise<void> {
  if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) throw setupFailed();
  for (const path of [GUEST_RUNTIME_PATHS.run, GUEST_RUNTIME_PATHS.home]) {
    const stat = await lstat(path);
    check();
    if (!isPrivateGuestDirectory(stat)) throw setupFailed();
  }
  const configuration = await open(
    `${GUEST_RUNTIME_PATHS.root}/openbox.xml`,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let config: Buffer;
  try {
    if (!isPinnedOpenboxConfig(await configuration.stat())) throw setupFailed();
    config = await configuration.readFile();
  } finally {
    await configuration.close();
  }
  if (createHash("sha256").update(config).digest("hex") !== CONFIG_SHA) throw setupFailed();
  for (const path of [
    `${GUEST_RUNTIME_PATHS.run}/xdg`,
    `${GUEST_RUNTIME_PATHS.run}/capture`,
    `${GUEST_RUNTIME_PATHS.home}/.cache`,
    `${GUEST_RUNTIME_PATHS.home}/.config`,
  ]) {
    check();
    await mkdir(path, { mode: 0o700 });
  }
}

async function authorizeDisplay(processes: GuestProcesses, check: () => void): Promise<void> {
  const auth = await open(
    GUEST_RUNTIME_ENV.XAUTHORITY,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  await auth.close();
  check();
  await processes.spawn(
    "/usr/bin/xauth",
    ["-f", GUEST_RUNTIME_ENV.XAUTHORITY, "source", "-"],
    `add :0 . ${randomBytes(16).toString("hex")}\n`,
  ).done;
  check();
}

async function waitForDisplay(
  processes: GuestProcesses,
  signal: AbortSignal,
  check: () => void,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    check();
    try {
      await processes.spawn("/usr/bin/xdpyinfo", []).done;
      return;
    } catch {
      await delay(50, undefined, { signal });
    }
  }
  throw setupFailed();
}

/** A recorder that fails to start leaves the desktop usable; finishRecording reports it. */
async function startGuestRecorder(
  recording: DesktopRecordingConfig,
  media: GuestMediaConfig | undefined,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<DesktopRecorderHandle | undefined> {
  try {
    return await startDesktopRecorder({
      display: ":0",
      width: 960,
      height: 720,
      outputPath: RECORDING_PATH,
      env,
      signal,
      ...recorderAudio(recording, media),
    });
  } catch {
    return undefined;
  }
}

async function launchGuestBrowser(
  state: GuestDesktopState,
  media: GuestMediaConfig | undefined,
  check: () => void,
): Promise<{ context: BrowserContext; page: Page }> {
  state.pendingContext = chromium.launchPersistentContext(`${GUEST_RUNTIME_PATHS.home}/browser`, {
    executablePath: "/usr/bin/chromium",
    headless: false,
    chromiumSandbox: true,
    viewport: null,
    env: state.recorder?.env ?? state.media?.env ?? GUEST_RUNTIME_ENV,
    timeout: 25_000,
    args: chromiumLaunchArgs(media),
  });
  // A browser that finishes launching after the stop is closed here; teardown may not see it.
  void state.pendingContext.then(
    (browser) => {
      if (state.stopping) void browser.close().catch(() => {});
    },
    () => {},
  );
  const context = (state.context = await state.pendingContext);
  check();
  context.setDefaultTimeout(5000);
  context.setDefaultNavigationTimeout(5000);
  const page = context.pages()[0];
  if (!page || context.pages().length !== 1) throw setupFailed();
  return { context, page };
}

async function verifyBrowserSandbox(
  context: BrowserContext,
  page: Page,
  check: () => void,
): Promise<string> {
  const diagnostic = await context.newPage();
  check();
  await diagnostic.goto("chrome://sandbox");
  check();
  const report = await diagnostic.locator("body").innerText();
  if (!isAdequatelySandboxed(report)) throw setupFailed();
  await diagnostic.close();
  check();
  await page.bringToFront();
  check();
  return report;
}

/** Text actions run only while the browser window that setup saw still has focus. */
function focusGuard(
  native: GuestDesktopNativeTools,
  window: string,
): (actionSignal: AbortSignal) => Promise<void> {
  return async (actionSignal) => {
    if ((await native.activeWindowId(actionSignal)) !== window)
      throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
  };
}

async function createGuestExecutorFor(
  state: GuestDesktopState,
  browser: { context: BrowserContext; page: Page },
  signal: AbortSignal,
  onTerminal: () => void,
  check: () => void,
): Promise<CuaExecutor> {
  const native = createGuestDesktopNativeTools({
    display: ":0",
    temporaryDirectory: `${GUEST_RUNTIME_PATHS.run}/capture`,
    xauthority: GUEST_RUNTIME_ENV.XAUTHORITY,
  });
  const window = await native.activeWindowId(signal);
  check();
  state.content = createGuestChromiumText({
    ...browser,
    assertFocusedWindow: focusGuard(native, window),
  });
  return createGuestDesktopExecutor({
    width: 960,
    height: 720,
    tools: createGuestBrowserTools(native, state.content),
    authoritySignal: signal,
    onTerminal,
  });
}

async function openGuestFixture(page: Page, check: () => void): Promise<void> {
  await page.goto(`file://${GUEST_RUNTIME_PATHS.root}/neutral.html`);
  check();
  await page.locator("#note").waitFor();
  check();
}

async function finishGuestRecording(
  recorder: DesktopRecorderHandle | undefined,
): Promise<{ metadata: DesktopRecordingMetadata; stream: Readable }> {
  try {
    if (!recorder) throw new Error();
    const result = await recorder.finish();
    const file = await open(result.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fileStat = await file.stat();
      if (!fileStat.isFile() || fileStat.size !== result.metadata.bytes) throw new Error();
      return { metadata: result.metadata, stream: file.createReadStream({ autoClose: true }) };
    } catch (error) {
      await file.close().catch(() => {});
      throw error;
    }
  } catch {
    throw new Error("Desktop recording failed.");
  }
}

/** Closes in a fixed order within 4 s; a failed step other than the recording marks it incomplete. */
function closeGuestRuntimeDesktop(
  state: GuestDesktopState,
  processes: GuestProcesses,
  controller: AbortController,
  detach: () => void,
): Promise<{ complete: boolean }> {
  if (state.closing) return state.closing;
  state.stopping = true;
  state.closing = Promise.resolve().then(async () => {
    let complete = true,
      timer: NodeJS.Timeout | undefined;
    const work = async (): Promise<void> => {
      try {
        await state.content?.close();
      } catch {
        complete = false;
      }
      try {
        await state.recorder?.finish();
      } catch {
        /* Recording evidence is optional to desktop teardown. */
      }
      try {
        await state.media?.close();
      } catch {
        complete = false;
      }
      try {
        const browser = state.context ?? (await state.pendingContext?.catch(() => undefined));
        if (browser) await browser.close();
      } catch {
        complete = false;
      }
      processes.killRunning();
      await processes.closed();
    };
    try {
      await Promise.race([
        work(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            complete = false;
            resolve();
          }, 4000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (processes.killRunning()) complete = false;
      detach();
    }
    return { complete };
  });
  controller.abort();
  return state.closing;
}

/** Fixed guest layout with an optional admitted initial loopback app URL. */
export async function createGuestRuntimeDesktop(options: {
  signal: AbortSignal;
  onTerminal(): void;
  onPhase?(phase: GuestRuntimePhase): void;
  initialUrl?: string;
  media?: GuestMediaConfig;
  recording?: DesktopRecordingConfig;
}): Promise<
  GuestRuntimeDesktop & {
    readonly owner: {
      context: BrowserContext;
      page: Page;
      sandboxReport: string;
      configSha256: string;
    };
  }
> {
  if (options.initialUrl !== undefined) validateGuestInitialUrl(options.initialUrl);
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const state: GuestDesktopState = { stopping: false };
  let phase: GuestRuntimePhase = "layout";
  const progress = (next: GuestRuntimePhase): void => {
    phase = next;
    options.onPhase?.(next);
  };
  const check = (): void => {
    if (signal.aborted || state.stopping) throw setupFailed();
  };
  const processes = createGuestProcesses({
    env: GUEST_RUNTIME_ENV,
    cwd: GUEST_RUNTIME_PATHS.home,
    signal,
    check,
    isStopping: () => state.stopping,
    onTerminal: options.onTerminal,
  });
  const abort = (): void => void close();
  const close = (): Promise<{ complete: boolean }> =>
    closeGuestRuntimeDesktop(state, processes, controller, () =>
      options.signal.removeEventListener("abort", abort),
    );
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    progress("layout");
    check();
    await verifyGuestLayout(check);
    progress("xauthority");
    await authorizeDisplay(processes, check);
    progress("display");
    processes.spawn("/usr/bin/Xvfb", XVFB_ARGS, undefined, true);
    await waitForDisplay(processes, signal, check);
    progress("window_manager");
    processes.spawn(
      "/usr/bin/openbox",
      ["--config-file", `${GUEST_RUNTIME_PATHS.root}/openbox.xml`],
      undefined,
      true,
    );
    check();
    if (options.media !== undefined) {
      progress("media");
      state.media = await startDesktopMedia({
        media: desktopMediaRequest(options.media),
        env: GUEST_RUNTIME_ENV,
        signal,
        onTerminal: options.onTerminal,
      });
      check();
    }
    if (options.recording !== undefined) {
      progress("recording");
      const env = state.media?.env ?? GUEST_RUNTIME_ENV;
      state.recorder = await startGuestRecorder(options.recording, options.media, env, signal);
      check();
    }
    progress("browser");
    const browser = await launchGuestBrowser(state, options.media, check);
    progress("sandbox");
    const sandboxReport = await verifyBrowserSandbox(browser.context, browser.page, check);
    progress("focus");
    const executor = await createGuestExecutorFor(
      state,
      browser,
      signal,
      options.onTerminal,
      check,
    );
    if (options.initialUrl !== undefined) {
      progress("navigation");
      await navigateGuestInitialPage(browser.page, options.initialUrl, signal);
      check();
    } else {
      progress("fixture");
      await openGuestFixture(browser.page, check);
    }
    return {
      executor: state.media?.wrap(executor) ?? executor,
      close,
      ...(options.recording === undefined
        ? {}
        : { finishRecording: () => finishGuestRecording(state.recorder) }),
      owner: { ...browser, sandboxReport, configSha256: CONFIG_SHA },
    };
  } catch {
    await close();
    throw Object.assign(setupFailed(), { phase });
  } finally {
    // The fresh private state belongs to the guest owner. No recursive home removal.
    if (state.stopping && processes.allExited())
      await rm(`${GUEST_RUNTIME_PATHS.run}/capture`, { recursive: true, force: true }).catch(
        () => {},
      );
  }
}
