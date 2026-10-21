import {
  ADEQUATE,
  fake,
  flushUntil,
  FULL,
  h,
  HOME,
  media,
  type Options,
  persistent,
  PINNED_CONFIG,
  RECORDING_PATH,
  recorder,
  spawned,
  start,
} from "./runtime-desktop-harness.js";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseExecutorError } from "../../src/actors/computer-use/executor-error.js";
import {
  createGuestRuntimeDesktop,
  type GuestRuntimePhase,
} from "../../src/guest/runtime-desktop.js";

// Characterizes the guest desktop's setup and teardown at its module boundaries; the harness
// fakes them.

describe("guest runtime desktop setup", () => {
  it("runs the fixture phases, spawns the fixed helpers and returns the owned desktop", async () => {
    const { pending, phases } = start();
    const desktop = await pending;
    expect(phases).toEqual([
      "layout",
      "xauthority",
      "display",
      "window_manager",
      "browser",
      "sandbox",
      "focus",
      "fixture",
    ]);
    expect(spawned()).toEqual(["xauth", "Xvfb", "xdpyinfo", "openbox"]);
    const [xauth, xvfb, , openbox] = h.children;
    expect(xauth!.args).toEqual(["-f", "/run/humanish/Xauthority", "source", "-"]);
    expect(xauth!.input).toMatch(/^add :0 \. [0-9a-f]{32}\n$/);
    expect(xauth!.options).toMatchObject({
      cwd: HOME,
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect((xauth!.options as { env: Record<string, string> }).env).toMatchObject({
      HOME: HOME,
      DISPLAY: ":0",
    });
    expect(xvfb!.args).toEqual([
      ":0",
      "-screen",
      "0",
      "960x720x24",
      "-nolisten",
      "tcp",
      "-auth",
      "/run/humanish/Xauthority",
    ]);
    expect(openbox!.args).toEqual(["--config-file", "/opt/humanish/control/openbox.xml"]);
    expect(h.mkdir.map(([path, options]) => [path, options])).toEqual(
      ["/run/humanish/xdg", "/run/humanish/capture", `${HOME}/.cache`, `${HOME}/.config`].map(
        (path) => [path, { mode: 0o700 }],
      ),
    );
    expect(h.opened[1]).toEqual(["/run/humanish/Xauthority", expect.any(Number), 0o600]);
    expect(h.launchOptions).toMatchObject({
      path: `${HOME}/browser`,
      executablePath: "/usr/bin/chromium",
      headless: false,
      chromiumSandbox: true,
      viewport: null,
      timeout: 25_000,
      args: [
        "--window-size=960,680",
        "--window-position=0,20",
        "--disable-background-networking",
        "--disable-component-update",
        "--no-first-run",
      ],
    });
    expect((h.launchOptions!.env as Record<string, string>).HOME).toBe(HOME);
    expect(fake.context.setDefaultTimeout).toHaveBeenCalledWith(5000);
    expect(fake.context.setDefaultNavigationTimeout).toHaveBeenCalledWith(5000);
    expect(fake.diagnostic.goto).toHaveBeenCalledWith("chrome://sandbox");
    expect(fake.diagnostic.close).toHaveBeenCalled();
    expect(fake.page.goto).toHaveBeenCalledWith("file:///opt/humanish/control/neutral.html");
    expect(h.executorOptions).toMatchObject({ width: 960, height: 720, tools: { tools: true } });
    expect(desktop.executor).toEqual({ executor: "base" });
    expect(desktop.finishRecording).toBeUndefined();
    expect(desktop.owner).toEqual({
      context: fake.context,
      page: fake.page,
      sandboxReport: ADEQUATE,
      configSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(h.rm).toEqual([]);
    expect(await desktop.close()).toEqual({ complete: true });
  });

  it("runs media, recording and navigation with their env precedence and wrapped executor", async () => {
    const { pending, phases, onTerminal } = start(FULL);
    const desktop = await pending;
    expect(phases).toEqual([
      "layout",
      "xauthority",
      "display",
      "window_manager",
      "media",
      "recording",
      "browser",
      "sandbox",
      "focus",
      "navigation",
    ]);
    expect(h.mediaOptions).toMatchObject({
      media: { microphone: { source: "speech" } },
      onTerminal,
    });
    expect(Object.keys(h.mediaOptions!.media as object)).toEqual(["microphone"]);
    expect(h.recorderOptions).toMatchObject({
      display: ":0",
      width: 960,
      height: 720,
      outputPath: RECORDING_PATH,
      env: { MEDIA: "1" },
      audioSources: ["microphone-input", "speaker-output"],
      pulseReady: true,
    });
    expect(h.launchOptions!.env).toEqual({ RECORDER: "1" });
    expect(h.launchOptions!.args).toContain("--use-fake-ui-for-media-stream");
    expect(fake.page.goto).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(desktop.executor).toEqual({ wrapped: { executor: "base" } });
    const recording = await desktop.finishRecording!();
    expect(recording).toEqual({ metadata: { bytes: 1234 }, stream: "recording-stream" });
  });

  it("chooses media env without a recorder and base env without either, and silent recordings", async () => {
    h.recorder = undefined;
    await start({ media: { camera: { source: "synthetic" }, permission: "prompt" } }).pending;
    expect(h.launchOptions!.env).toEqual({ MEDIA: "1" });
    expect(h.launchOptions!.args).not.toContain("--use-fake-ui-for-media-stream");
    expect(Object.keys(h.mediaOptions!.media as object)).toEqual(["camera"]);
    h.recorder = recorder();
    await start({ recording: { audio: false } }).pending;
    expect(h.recorderOptions).toMatchObject({ audioSources: [], pulseReady: false });
    expect((h.recorderOptions!.env as Record<string, string>).HOME).toBe(HOME);
    await start({ recording: { audio: true } }).pending;
    expect(h.recorderOptions).toMatchObject({ pulseReady: false });
  });

  it("polls the display until xdpyinfo succeeds and gives up after 100 attempts", async () => {
    h.xdpyinfoFailures = 3;
    await start().pending;
    expect(spawned().filter((name) => name === "xdpyinfo")).toHaveLength(4);
    h.children = [];
    h.xdpyinfoFailures = 1000;
    const { pending } = start();
    await expect(pending).rejects.toMatchObject({ phase: "display" });
    expect(spawned().filter((name) => name === "xdpyinfo")).toHaveLength(100);
  });
});

describe("guest runtime desktop failures", () => {
  const failures: [GuestRuntimePhase, Options, () => void][] = [
    ["layout", {}, () => void (h.uid = 0)],
    ["xauthority", {}, () => void (h.xauthCode = 1)],
    ["window_manager", {}, () => void (h.spawnThrows = "/usr/bin/openbox")],
    ["media", FULL, () => void (h.media = new Error("media failed"))],
    ["browser", {}, () => void (h.launch = Promise.reject(new Error("launch failed")))],
    ["browser", {}, () => void (h.pages = 2)],
    [
      "sandbox",
      {},
      () =>
        void (h.sandboxReport = ADEQUATE.replace(
          "Seccomp-BPF sandbox\tYes",
          "Seccomp-BPF sandbox\tNo",
        )),
    ],
    [
      "sandbox",
      {},
      () => void (h.sandboxReport = ADEQUATE.replace("adequately", "not adequately")),
    ],
    ["focus", {}, () => void (h.focusFails = true)],
    ["fixture", {}, () => void (h.gotoFails = true)],
    ["navigation", FULL, () => void (h.gotoFails = true)],
  ];
  it.each(failures)(
    "reports phase %s, closes what started and removes the capture dir",
    async (phase, options, arrange) => {
      arrange();
      const { pending, onTerminal } = start(options);
      const error = await pending.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ComputerUseExecutorError);
      expect(error).toMatchObject({
        code: "execution_failed",
        disposition: "not_dispatched",
        phase,
      });
      for (const child of persistent()) expect(child.kills).toEqual(["SIGKILL"]);
      if (["sandbox", "focus", "fixture", "navigation"].includes(phase))
        expect(fake.context.close).toHaveBeenCalled();
      expect(h.rm).toEqual(["/run/humanish/capture"]);
      expect(onTerminal).not.toHaveBeenCalled();
    },
  );

  it("fails a recording phase abort but tolerates a recorder that failed to start", async () => {
    h.recorder = () => {
      throw new Error("no ffmpeg");
    };
    const desktop = await start({ recording: { audio: false } }).pending;
    expect(h.launchOptions!.env).not.toHaveProperty("RECORDER");
    await expect(desktop.finishRecording!()).rejects.toThrow("Desktop recording failed.");
    const owner = new AbortController();
    h.recorder = () => {
      owner.abort();
      return recorder();
    };
    await expect(
      createGuestRuntimeDesktop({
        signal: owner.signal,
        onTerminal: vi.fn(),
        recording: { audio: false },
      }),
    ).rejects.toMatchObject({ phase: "recording" });
  });

  it("rejects each unsafe layout before spawning anything", async () => {
    const unsafe: (() => void)[] = [
      () => void (h.gid = 0),
      () => void (h.dirStat = { ...h.dirStat, isDirectory: () => false }),
      () => void (h.dirStat = { ...h.dirStat, isSymbolicLink: () => true }),
      () => void (h.dirStat = { ...h.dirStat, uid: 0 }),
      () => void (h.dirStat = { ...h.dirStat, gid: 0 }),
      () => void (h.dirStat = { ...h.dirStat, mode: 0o40750 }),
      () => void (h.configStat = { ...h.configStat, isFile: () => false }),
      () => void (h.configStat = { ...h.configStat, uid: 1000 }),
      () => void (h.configStat = { ...h.configStat, gid: 1000 }),
      () => void (h.configStat = { ...h.configStat, nlink: 2 }),
      () => void (h.configStat = { ...h.configStat, size: 4097 }),
      () => void (h.configStat = { ...h.configStat, mode: 0o100644 }),
      () => void (h.configBytes = Buffer.concat([PINNED_CONFIG, Buffer.from(" ")])),
    ];
    for (const [index, arrange] of unsafe.entries()) {
      const saved = {
        gid: h.gid,
        dirStat: h.dirStat,
        configStat: h.configStat,
        configBytes: h.configBytes,
      };
      arrange();
      await expect(start().pending, `case ${index}`).rejects.toMatchObject({ phase: "layout" });
      expect(h.children, `case ${index}`).toEqual([]);
      Object.assign(h, saved);
    }
  });
});

describe("guest runtime desktop processes", () => {
  it("kills a helper that writes more than 16 KiB of stderr", async () => {
    h.xauthCode = null;
    const { pending } = start();
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.stderr.emit("data", Buffer.alloc(16_384));
    expect(h.children[0]!.kills).toEqual([]);
    h.children[0]!.stderr.emit("data", Buffer.alloc(1));
    expect(h.children[0]!.kills).toEqual(["SIGKILL"]);
    await expect(pending).rejects.toMatchObject({ phase: "xauthority" });
  });

  it("rejects a helper that overflows stderr between exit and a status-0 close", async () => {
    h.xauthCode = null;
    const { pending } = start();
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    const xauth = h.children[0]!;
    xauth.exited = true;
    xauth.emit("exit", 0);
    xauth.stderr.emit("data", Buffer.alloc(16_385));
    expect(xauth.kills).toEqual([]);
    xauth.emit("close", 0);
    await expect(pending).rejects.toMatchObject({ phase: "xauthority" });
  });

  it("kills a helper that runs past 2 s", async () => {
    vi.useFakeTimers();
    h.xauthCode = null;
    const { pending } = start();
    const settled = pending.catch((error: unknown) => error);
    await flushUntil(() => h.children.length === 1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.children[0]!.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({ phase: "xauthority" });
  });

  it("reports a persistent exit as terminal only while not stopping", async () => {
    const { pending, onTerminal } = start();
    const desktop = await pending;
    persistent()[0]!.exit(1);
    await vi.waitFor(() => expect(onTerminal).toHaveBeenCalled());
    onTerminal.mockClear();
    await desktop.close();
    expect(persistent()[1]!.kills).toEqual(["SIGKILL"]);
    expect(onTerminal).not.toHaveBeenCalled();
  });
});

describe("guest runtime desktop close", () => {
  it("closes once in order and reports complete", async () => {
    const desktop = await start(FULL).pending;
    const first = desktop.close();
    expect(desktop.close()).toBe(first);
    expect(await first).toEqual({ complete: true });
    expect(h.order).toEqual(["content.close", "recorder.finish", "media.close", "browser.close"]);
    for (const child of persistent()) expect(child.kills).toEqual(["SIGKILL"]);
  });

  it.each([
    ["content", () => void (h.contentClose = async () => Promise.reject(new Error("x")))],
    ["media", () => void (h.mediaCloseFails = true)],
    ["browser", () => void (h.browserCloseFails = true)],
  ])("reports incomplete when %s close fails", async (_name, arrange) => {
    const desktop = await start(FULL).pending;
    arrange();
    expect(await desktop.close()).toEqual({ complete: false });
  });

  it("ignores a failed recorder finish", async () => {
    const desktop = await start(FULL).pending;
    (h.recorder as { finish(): Promise<unknown> }).finish = async () =>
      Promise.reject(new Error("x"));
    expect(await desktop.close()).toEqual({ complete: true });
  });

  it("kills children at once on close and bounds a hung teardown at 4 s", async () => {
    const desktop = await start().pending;
    vi.useFakeTimers();
    h.contentClose = () => new Promise(() => {});
    let result: unknown;
    void desktop.close().then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(0);
    for (const child of persistent()) expect(child.kills).toEqual(["SIGKILL"]);
    await vi.advanceTimersByTimeAsync(3999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ complete: false });
  });

  it("keeps the capture dir while a child survives SIGKILL past the 4 s bound", async () => {
    vi.useFakeTimers();
    h.stubborn = "/usr/bin/Xvfb";
    h.spawnThrows = "/usr/bin/openbox";
    const settled = start().pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await settled).toMatchObject({ phase: "window_manager" });
    // The owner's abort, teardown and the final sweep each send one.
    expect(persistent()[0]!.kills).toEqual(["SIGKILL", "SIGKILL", "SIGKILL"]);
    expect(h.rm).toEqual([]);
  });

  it("closes a browser that launches after a stalled teardown passed its bound", async () => {
    vi.useFakeTimers();
    h.media = { ...media(), close: () => new Promise<void>(() => {}) };
    let launched!: (context: unknown) => void;
    h.launch = new Promise((resolve) => (launched = resolve));
    const { pending, owner } = start({
      media: { microphone: { source: "speech" }, permission: "prompt" },
    });
    const settled = pending.catch((error: unknown) => error);
    await flushUntil(() => h.launchOptions !== undefined);
    owner.abort();
    await vi.advanceTimersByTimeAsync(4000);
    expect(fake.context.close).not.toHaveBeenCalled();
    launched(fake.context);
    expect(await settled).toMatchObject({ phase: "browser" });
    await flushUntil(() => fake.context.close.mock.calls.length > 0);
  });

  it("closes on owner abort, including a browser that launches after the stop", async () => {
    let launched!: (context: unknown) => void;
    h.launch = new Promise((resolve) => (launched = resolve));
    const { pending, owner } = start();
    await vi.waitFor(() => expect(h.launchOptions).toBeDefined());
    owner.abort();
    launched(fake.context);
    await expect(pending).rejects.toMatchObject({ phase: "browser" });
    expect(fake.context.close).toHaveBeenCalled();
    for (const child of persistent()) expect(child.kills).toEqual(["SIGKILL"]);
  });
});

describe("guest runtime desktop actions and recording", () => {
  it("rejects an action when focus moved to another window", async () => {
    h.windows = ["0x1", "0x1", "0x2"];
    await start().pending;
    const signal = new AbortController().signal;
    await expect(h.textOptions!.assertFocusedWindow(signal)).resolves.toBeUndefined();
    await expect(h.textOptions!.assertFocusedWindow(signal)).rejects.toMatchObject({
      code: "action_rejected",
      disposition: "not_dispatched",
    });
  });

  it("rejects a recording whose file size differs from its metadata and closes the file", async () => {
    h.recordingSize = 99;
    const desktop = await start(FULL).pending;
    await expect(desktop.finishRecording!()).rejects.toThrow("Desktop recording failed.");
    expect(h.order).toContain("recording.file.close");
  });
});
