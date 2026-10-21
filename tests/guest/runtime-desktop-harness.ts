import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, vi, type Mock } from "vitest";
import {
  createGuestRuntimeDesktop,
  GUEST_RUNTIME_PATHS,
  type GuestRuntimePhase,
} from "../../src/guest/runtime-desktop.js";

// The guest desktop's module boundaries, faked for the tests that characterize its setup and
// teardown: process spawns, the filesystem, Playwright and the sibling guest modules. Nothing here
// depends on how createGuestRuntimeDesktop is split internally. Import it before the module under
// test so its mocks are in place.

export const PINNED_CONFIG = readFileSync(
  "runtime/browser-guest/control/root/opt/humanish/control/openbox.xml",
);
export const HOME = GUEST_RUNTIME_PATHS.home;
export const RECORDING_PATH = `${HOME}/desktop-recording.mp4`;
export const ADEQUATE =
  "PID namespaces\tYes\nNetwork namespaces\tYes\nSeccomp-BPF sandbox\tYes\nYou are adequately sandboxed.";

class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdin = Object.assign(new EventEmitter(), {
    end: (input?: string) => {
      this.input = input;
      this.onEnd(this);
    },
  });
  input: string | undefined;
  exited = false;
  readonly kills: string[] = [];
  constructor(
    readonly binary: string,
    readonly args: string[],
    readonly options: unknown,
    private readonly onEnd: (child: FakeChild) => void,
  ) {
    super();
  }
  kill(signal: string): boolean {
    this.kills.push(signal);
    if (h.stubborn !== this.binary) this.exit(null);
    return true;
  }
  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    queueMicrotask(() => {
      this.emit("exit", code);
      this.emit("close", code);
    });
  }
}

const h = vi.hoisted(() => ({
  children: [] as FakeChild[],
  order: [] as string[],
  uid: 1000,
  gid: 1000,
  dirStat: {} as Record<string, unknown>,
  configStat: {} as Record<string, unknown>,
  configBytes: Buffer.alloc(0),
  xauthCode: 0 as number | null,
  xdpyinfoFailures: 0,
  spawnThrows: undefined as string | undefined,
  stubborn: undefined as string | undefined,
  rm: [] as string[],
  mkdir: [] as unknown[][],
  opened: [] as unknown[][],
  launch: undefined as unknown,
  launchOptions: undefined as Record<string, unknown> | undefined,
  sandboxReport: "",
  pages: 1,
  windows: ["0x1"] as string[],
  focusFails: false,
  gotoFails: false,
  contentClose: undefined as (() => Promise<void>) | undefined,
  browserCloseFails: false,
  media: undefined as unknown,
  mediaOptions: undefined as Record<string, unknown> | undefined,
  mediaCloseFails: false,
  recorder: undefined as unknown,
  recorderOptions: undefined as Record<string, unknown> | undefined,
  recordingSize: 1234,
  executorOptions: undefined as Record<string, unknown> | undefined,
  textOptions: undefined as { assertFocusedWindow(signal: AbortSignal): Promise<void> } | undefined,
  cdp: [] as { method: string; params: unknown }[],
  steps: [] as string[],
}));

vi.mock("node:child_process", () => ({
  spawn: (binary: string, args: string[], options: unknown) => {
    if (h.spawnThrows === binary) throw new Error("spawn failed");
    const child = new FakeChild(binary, args, options, (self) => {
      if (binary === "/usr/bin/xauth" && h.xauthCode !== null) self.exit(h.xauthCode);
      if (binary === "/usr/bin/xdpyinfo") self.exit(h.xdpyinfoFailures-- > 0 ? 1 : 0);
    });
    h.children.push(child);
    return child;
  },
}));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));
vi.mock("node:fs/promises", () => ({
  lstat: async () => h.dirStat,
  mkdir: async (...args: unknown[]) => void h.mkdir.push(args),
  rm: async (path: string) => void h.rm.push(path),
  open: async (...args: unknown[]) => {
    h.opened.push(args);
    const close = async () => {};
    if (args[0] === "/opt/humanish/control/openbox.xml")
      return { stat: async () => h.configStat, readFile: async () => h.configBytes, close };
    if (args[0] === RECORDING_PATH)
      return {
        stat: async () => ({ isFile: () => true, size: h.recordingSize }),
        createReadStream: () => "recording-stream",
        close: async () => void h.order.push("recording.file.close"),
      };
    return { close };
  },
}));
vi.mock("playwright-core", () => ({
  chromium: {
    launchPersistentContext: (path: string, options: Record<string, unknown>) => {
      h.launchOptions = { path, ...options };
      return h.launch;
    },
  },
}));
vi.mock("../../src/guest/desktop-native.js", () => ({
  createGuestDesktopNativeTools: () => ({
    activeWindowId: async () => {
      if (h.focusFails) throw new Error("no window");
      return h.windows.shift() ?? "0x1";
    },
  }),
}));
vi.mock("../../src/guest/chromium-text.js", () => ({
  createGuestChromiumText: (options: {
    assertFocusedWindow(signal: AbortSignal): Promise<void>;
  }) => {
    h.textOptions = options;
    return {
      close: async () => {
        h.order.push("content.close");
        await h.contentClose?.();
      },
    };
  },
}));
vi.mock("../../src/guest/browser-tools.js", () => ({
  createGuestBrowserTools: () => ({ tools: true }),
}));
vi.mock("../../src/guest/desktop-executor.js", () => ({
  createGuestDesktopExecutor: (options: Record<string, unknown>) => {
    h.executorOptions = options;
    return { executor: "base" };
  },
}));
// tests/guest/external-links.test.ts covers the stand-ins' log and the profile; this setup keeps
// its executor and file system fakes.
vi.mock("../../src/guest/external-links.js", () => ({
  GUEST_EXTERNAL_LINK_BIN: "/opt/humanish/control/bin",
  prepareGuestBrowserProfile: async () => {},
  withExternalHandoffs: (executor: unknown) => executor,
}));
vi.mock("../../src/guest/desktop-media.js", () => ({
  startDesktopMedia: async (options: Record<string, unknown>) => {
    h.mediaOptions = options;
    if (h.media instanceof Error) throw h.media;
    return h.media;
  },
}));
vi.mock("../../src/evidence/desktop-recorder.js", () => ({
  startDesktopRecorder: async (options: Record<string, unknown>) => {
    h.recorderOptions = options;
    if (typeof h.recorder === "function") return (h.recorder as () => unknown)();
    return h.recorder;
  },
}));

/** The fake Playwright page, diagnostic tab and persistent context one setup acquires. */
interface FakeBrowser {
  page: Record<"bringToFront" | "goto" | "locator" | "waitForFunction", Mock>;
  diagnostic: { goto: Mock; locator: () => { innerText(): Promise<string> }; close: Mock };
  context: {
    pages(): unknown[];
    newPage(): Promise<unknown>;
  } & Record<
    "on" | "newCDPSession" | "setDefaultTimeout" | "setDefaultNavigationTimeout" | "close",
    Mock
  >;
}

function browser(): FakeBrowser {
  const page = {
    bringToFront: vi.fn(async () => {}),
    goto: vi.fn(async () => {
      h.steps.push("page.goto");
      if (h.gotoFails) throw new Error("navigation failed");
    }),
    locator: vi.fn(() => ({ waitFor: async () => {} })),
    waitForFunction: vi.fn(async () => ({ dispose: async () => {} })),
  };
  const diagnostic = {
    goto: vi.fn(async () => {}),
    locator: () => ({ innerText: async () => h.sandboxReport }),
    close: vi.fn(async () => {}),
  };
  const context = {
    pages: () => (h.pages === 1 ? [page] : [page, diagnostic]),
    newPage: async () => diagnostic,
    on: vi.fn(),
    newCDPSession: vi.fn(async (target: unknown) => ({
      send: vi.fn(async (method: string, params: unknown) => {
        h.steps.push(`cdp ${target === page ? "page" : "other"} ${method}`);
        h.cdp.push({ method, params });
      }),
      detach: vi.fn(async () => {}),
    })),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    close: vi.fn(async () => {
      h.order.push("browser.close");
      if (h.browserCloseFails) throw new Error("close failed");
    }),
  };
  return { page, diagnostic, context };
}

export function media() {
  return {
    env: { MEDIA: "1" },
    wrap: (executor: unknown) => ({ wrapped: executor }),
    close: async () => {
      h.order.push("media.close");
      if (h.mediaCloseFails) throw new Error("media close failed");
    },
  };
}

export function recorder() {
  return {
    env: { RECORDER: "1" },
    outputPath: RECORDING_PATH,
    finish: async () => {
      h.order.push("recorder.finish");
      return { outputPath: RECORDING_PATH, metadata: { bytes: 1234 } };
    },
  };
}

export let fake: FakeBrowser;
beforeEach(() => {
  Object.assign(h, {
    children: [],
    order: [],
    uid: 1000,
    gid: 1000,
    dirStat: {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 1000,
      gid: 1000,
      mode: 0o40700,
    },
    configStat: {
      isFile: () => true,
      uid: 0,
      gid: 0,
      nlink: 1,
      size: PINNED_CONFIG.length,
      mode: 0o100444,
    },
    configBytes: PINNED_CONFIG,
    xauthCode: 0,
    xdpyinfoFailures: 0,
    spawnThrows: undefined,
    stubborn: undefined,
    rm: [],
    mkdir: [],
    opened: [],
    sandboxReport: ADEQUATE,
    pages: 1,
    windows: ["0x1"],
    focusFails: false,
    gotoFails: false,
    contentClose: undefined,
    browserCloseFails: false,
    media: media(),
    mediaCloseFails: false,
    recorder: recorder(),
    recordingSize: 1234,
    launchOptions: undefined,
    mediaOptions: undefined,
    recorderOptions: undefined,
    executorOptions: undefined,
    textOptions: undefined,
    cdp: [],
    steps: [],
  });
  fake = browser();
  h.launch = Promise.resolve(fake.context);
  vi.spyOn(process, "getuid").mockImplementation(() => h.uid);
  vi.spyOn(process, "getgid").mockImplementation(() => h.gid);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

export type Options = Partial<Parameters<typeof createGuestRuntimeDesktop>[0]>;
export function start(options: Options = {}): {
  pending: ReturnType<typeof createGuestRuntimeDesktop>;
  owner: AbortController;
  phases: GuestRuntimePhase[];
  onTerminal: Mock<() => void>;
} {
  const owner = new AbortController();
  const phases: GuestRuntimePhase[] = [];
  const onTerminal = vi.fn<() => void>();
  const pending = createGuestRuntimeDesktop({
    signal: owner.signal,
    onTerminal,
    onPhase: (phase) => phases.push(phase),
    ...options,
  });
  return { pending, owner, phases, onTerminal };
}
// Fake timers do not replace queueMicrotask, so this drains setup without moving the clock.
export async function flushUntil(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !done(); turn++) await new Promise<void>(queueMicrotask);
  expect(done()).toBe(true);
}
export const spawned = () => h.children.map((child) => child.binary.replace("/usr/bin/", ""));
export const persistent = () => h.children.filter((child) => /Xvfb|openbox/.test(child.binary));
export const FULL: Options = {
  initialUrl: "http://127.0.0.1:3000/",
  media: { microphone: { source: "speech" }, permission: "granted" },
  recording: { audio: true },
};

export { h };
