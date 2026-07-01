import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { CuaAction } from "../src/computer-use.js";
import type { E2BDesktopLike } from "../src/e2b-desktop-executor.js";
import { createE2BDesktopExecutor, perceptualSignature } from "../src/e2b-desktop-executor.js";

// A recorded desktop call: the method name and the arguments it received.
interface Call {
  method: string;
  args: unknown[];
}

// A FakeDesktop that records every call. By default its methods are async
// (return a resolved Promise); pass { sync: true } to make them synchronous (void
// return) to prove the executor awaits correctly in both modes. screenshot
// returns a caller-provided PNG buffer.
function makeFakeDesktop(
  screenshotBytes: Uint8Array | Buffer,
  opts: { sync?: boolean; writeError?: Error; withClipboardFallback?: boolean } = {}
): { desktop: E2BDesktopLike; calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: string, ...args: unknown[]): Promise<void> | void => {
    calls.push({ method, args });
    if (method === "write" && opts.writeError) throw opts.writeError;
    return opts.sync ? undefined : Promise.resolve();
  };
  const screenshotResult = (): Promise<Uint8Array | Buffer> | Uint8Array | Buffer => {
    calls.push({ method: "screenshot", args: [] });
    return opts.sync ? screenshotBytes : Promise.resolve(screenshotBytes);
  };
  const desktop: E2BDesktopLike = {
    screenshot: screenshotResult,
    leftClick: (x, y) => record("leftClick", x, y),
    rightClick: (x, y) => record("rightClick", x, y),
    middleClick: (x, y) => record("middleClick", x, y),
    doubleClick: (x, y) => record("doubleClick", x, y),
    moveMouse: (x, y) => record("moveMouse", x, y),
    scroll: (direction, amount) => record("scroll", direction, amount),
    write: (text) => record("write", text),
    press: (key) => record("press", key),
    drag: (from, to) => record("drag", from, to),
    wait: (ms) => record("wait", ms)
  };
  if (opts.withClipboardFallback) {
    desktop.files = {
      write: async (remotePath, data, options) => {
        calls.push({ method: "files.write", args: [remotePath, data, options] });
      }
    };
    desktop.commands = {
      run: async (command, options) => {
        calls.push({ method: "commands.run", args: [command, options] });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
  }
  return { desktop, calls };
}

// Build a solid-color RGBA PNG of the given size.
function solidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

// Build a left/right two-tone PNG (a clearly different image than a solid one).
function checkerPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const v = on ? 255 : 0;
      png.data[o] = v;
      png.data[o + 1] = v;
      png.data[o + 2] = v;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// Build a horizontal grayscale gradient PNG.
function gradientPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const v = Math.round((x / Math.max(1, width - 1)) * 255);
      png.data[o] = v;
      png.data[o + 1] = v;
      png.data[o + 2] = v;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const SHOT = solidPng(4, 4, 10, 20, 30);

async function run(action: CuaAction, opts?: { sync?: boolean }): Promise<Call[]> {
  const { desktop, calls } = makeFakeDesktop(SHOT, opts);
  const executor = createE2BDesktopExecutor(desktop);
  await executor.execute(action);
  return calls;
}

describe("createE2BDesktopExecutor.execute action mapping", () => {
  it("maps a left click (default button) to leftClick(x, y)", async () => {
    const calls = await run({ kind: "click", x: 11, y: 22 });
    expect(calls).toEqual([{ method: "leftClick", args: [11, 22] }]);
  });

  it("maps an explicit left click to leftClick(x, y)", async () => {
    const calls = await run({ kind: "click", x: 1, y: 2, button: "left" });
    expect(calls).toEqual([{ method: "leftClick", args: [1, 2] }]);
  });

  it("maps a right click to rightClick(x, y)", async () => {
    const calls = await run({ kind: "click", x: 3, y: 4, button: "right" });
    expect(calls).toEqual([{ method: "rightClick", args: [3, 4] }]);
  });

  it("maps a middle click to middleClick(x, y)", async () => {
    const calls = await run({ kind: "click", x: 5, y: 6, button: "middle" });
    expect(calls).toEqual([{ method: "middleClick", args: [5, 6] }]);
  });

  it("maps double_click to doubleClick(x, y)", async () => {
    const calls = await run({ kind: "double_click", x: 7, y: 8 });
    expect(calls).toEqual([{ method: "doubleClick", args: [7, 8] }]);
  });

  it("maps move to moveMouse(x, y)", async () => {
    const calls = await run({ kind: "move", x: 9, y: 10 });
    expect(calls).toEqual([{ method: "moveMouse", args: [9, 10] }]);
  });

  it("maps type to write(text)", async () => {
    const calls = await run({ kind: "type", text: "hello@example.test" });
    expect(calls).toEqual([{ method: "write", args: ["hello@example.test"] }]);
  });

  it("falls back to clipboard paste when desktop.write fails and clipboard surfaces are present", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT, {
      writeError: new Error("exit status 1"),
      withClipboardFallback: true
    });
    const executor = createE2BDesktopExecutor(desktop);

    await executor.execute({ kind: "type", text: "hello — with punctuation" });

    expect(calls.map((call) => call.method)).toEqual([
      "write",
      "files.write",
      "commands.run",
      "press"
    ]);
    expect(calls[1]?.args[1]).toBe("hello — with punctuation");
    expect(String(calls[2]?.args[0])).not.toContain("hello");
    expect(calls[3]).toEqual({ method: "press", args: [["Control", "v"]] });
  });

  it("rethrows desktop.write failures when clipboard fallback surfaces are unavailable", async () => {
    const { desktop } = makeFakeDesktop(SHOT, {
      writeError: new Error("exit status 1")
    });
    const executor = createE2BDesktopExecutor(desktop);

    await expect(executor.execute({ kind: "type", text: "hello" })).rejects.toThrow(
      "exit status 1"
    );
  });

  it("maps keypress to press(keys array)", async () => {
    const calls = await run({ kind: "keypress", keys: ["Control", "a"] });
    expect(calls).toEqual([{ method: "press", args: [["Control", "a"]] }]);
  });

  it("maps wait with ms to wait(ms)", async () => {
    const calls = await run({ kind: "wait", ms: 1234 });
    expect(calls).toEqual([{ method: "wait", args: [1234] }]);
  });

  it("maps wait without ms to wait(defaultWaitMs)", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const executor = createE2BDesktopExecutor(desktop, { defaultWaitMs: 777 });
    await executor.execute({ kind: "wait" });
    expect(calls).toEqual([{ method: "wait", args: [777] }]);
  });

  it("uses a 500ms default wait when no option is given", async () => {
    const calls = await run({ kind: "wait" });
    expect(calls).toEqual([{ method: "wait", args: [500] }]);
  });

  it("treats screenshot as a no-op (the loop captures frames via observe)", async () => {
    const calls = await run({ kind: "screenshot" });
    expect(calls).toEqual([]);
  });
});

describe("createE2BDesktopExecutor scroll mapping", () => {
  it("moves to the scroll point then scrolls down for dy > 0", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const executor = createE2BDesktopExecutor(desktop, { scrollAmountPerTick: 100 });
    await executor.execute({ kind: "scroll", x: 0, y: 0, dx: 0, dy: 250 });
    // round(250 / 100) === 3 (round half up: 2.5 -> 3)
    expect(calls).toEqual([
      { method: "moveMouse", args: [0, 0] },
      { method: "scroll", args: ["down", 3] }
    ]);
  });

  it("scrolls up for dy < 0", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const executor = createE2BDesktopExecutor(desktop, { scrollAmountPerTick: 100 });
    await executor.execute({ kind: "scroll", x: 0, y: 0, dx: 0, dy: -120 });
    // round(120 / 100) === 1
    expect(calls).toEqual([
      { method: "moveMouse", args: [0, 0] },
      { method: "scroll", args: ["up", 1] }
    ]);
  });

  it("floors a small nonzero scroll amount at 1 tick", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const executor = createE2BDesktopExecutor(desktop, { scrollAmountPerTick: 100 });
    await executor.execute({ kind: "scroll", x: 0, y: 0, dx: 0, dy: 5 });
    expect(calls).toEqual([
      { method: "moveMouse", args: [0, 0] },
      { method: "scroll", args: ["down", 1] }
    ]);
  });

  it("scrolls at the action's point and ignores dx (vertical-only SDK)", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const executor = createE2BDesktopExecutor(desktop, { scrollAmountPerTick: 50 });
    await executor.execute({ kind: "scroll", x: 40, y: 60, dx: 999, dy: 100 });
    expect(calls).toEqual([
      { method: "moveMouse", args: [40, 60] },
      { method: "scroll", args: ["down", 2] }
    ]);
  });

  it("is a no-op when dy is 0 (does not even move the cursor)", async () => {
    const calls = await run({ kind: "scroll", x: 5, y: 5, dx: 0, dy: 0 });
    expect(calls).toEqual([]);
  });

  it("uses a default 100px-per-tick when no option is given", async () => {
    const calls = await run({ kind: "scroll", x: 0, y: 0, dx: 0, dy: 300 });
    expect(calls).toEqual([
      { method: "moveMouse", args: [0, 0] },
      { method: "scroll", args: ["down", 3] }
    ]);
  });
});

describe("createE2BDesktopExecutor drag mapping", () => {
  it("drags from the first to the last point of the path", async () => {
    const calls = await run({
      kind: "drag",
      path: [
        { x: 1, y: 2 },
        { x: 5, y: 6 },
        { x: 9, y: 10 }
      ]
    });
    expect(calls).toEqual([{ method: "drag", args: [[1, 2], [9, 10]] }]);
  });

  it("is a safe no-op for an empty path (does not throw)", async () => {
    const calls = await run({ kind: "drag", path: [] });
    expect(calls).toEqual([]);
  });

  it("is a safe no-op for a single-point path", async () => {
    const calls = await run({ kind: "drag", path: [{ x: 3, y: 4 }] });
    expect(calls).toEqual([]);
  });
});

describe("createE2BDesktopExecutor.observe", () => {
  it("returns the screenshot bytes as a Buffer and a stateSignature string", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const executor = createE2BDesktopExecutor(desktop);
    const obs = await executor.observe();
    expect(calls).toEqual([{ method: "screenshot", args: [] }]);
    // The E2B (vision) executor always produces a frame, even though CuaObservation.screenshot
    // is now optional for non-vision executors.
    expect(obs.screenshot).toBeDefined();
    expect(Buffer.isBuffer(obs.screenshot)).toBe(true);
    expect(Buffer.compare(obs.screenshot ?? Buffer.alloc(0), SHOT)).toBe(0);
    expect(typeof obs.stateSignature).toBe("string");
    expect(obs.stateSignature.length).toBeGreaterThan(0);
    expect(obs.stateSignature).toBe(perceptualSignature(SHOT));
  });

  it("probes browser state before capturing the screenshot so stop evidence is less stale", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const executor = createE2BDesktopExecutor(desktop, {
      observeBrowserState: async () => {
        calls.push({ method: "observeBrowserState", args: [] });
        return {
          text: "Dashboard ready",
          title: "Dashboard",
          url: "https://example.test/dashboard",
        };
      },
    });
    const obs = await executor.observe();
    expect(calls).toEqual([
      { method: "observeBrowserState", args: [] },
      { method: "screenshot", args: [] },
    ]);
    expect(obs.text).toBe("Dashboard ready");
    expect(obs.title).toBe("Dashboard");
    expect(obs.url).toBe("https://example.test/dashboard");
  });

  it("coerces a Uint8Array screenshot result to a Buffer", async () => {
    const u8 = new Uint8Array(SHOT);
    const { desktop } = makeFakeDesktop(u8);
    const executor = createE2BDesktopExecutor(desktop);
    const obs = await executor.observe();
    expect(obs.screenshot).toBeDefined();
    expect(Buffer.isBuffer(obs.screenshot)).toBe(true);
    expect(Buffer.compare(obs.screenshot ?? Buffer.alloc(0), SHOT)).toBe(0);
  });
});

describe("await-correctness across sync and async desktops", () => {
  it("awaits an async desktop method before resolving execute", async () => {
    const calls = await run({ kind: "click", x: 1, y: 1 }, { sync: false });
    expect(calls).toEqual([{ method: "leftClick", args: [1, 1] }]);
  });

  it("works with a synchronous desktop (void returns)", async () => {
    const calls = await run({ kind: "click", x: 2, y: 2 }, { sync: true });
    expect(calls).toEqual([{ method: "leftClick", args: [2, 2] }]);
  });

  it("observe works with a synchronous screenshot return", async () => {
    const { desktop } = makeFakeDesktop(SHOT, { sync: true });
    const executor = createE2BDesktopExecutor(desktop);
    const obs = await executor.observe();
    expect(obs.screenshot).toBeDefined();
    expect(Buffer.isBuffer(obs.screenshot)).toBe(true);
    expect(Buffer.compare(obs.screenshot ?? Buffer.alloc(0), SHOT)).toBe(0);
  });

  it("awaits an async write (typed text completes before execute resolves)", async () => {
    let completed = false;
    const calls: Call[] = [];
    const desktop: E2BDesktopLike = {
      screenshot: () => Promise.resolve(SHOT),
      leftClick: () => Promise.resolve(),
      rightClick: () => Promise.resolve(),
      middleClick: () => Promise.resolve(),
      doubleClick: () => Promise.resolve(),
      moveMouse: () => Promise.resolve(),
      scroll: () => Promise.resolve(),
      write: async (text) => {
        await Promise.resolve();
        completed = true;
        calls.push({ method: "write", args: [text] });
      },
      press: () => Promise.resolve(),
      drag: () => Promise.resolve(),
      wait: () => Promise.resolve()
    };
    const executor = createE2BDesktopExecutor(desktop);
    await executor.execute({ kind: "type", text: "abc" });
    expect(completed).toBe(true);
    expect(calls).toEqual([{ method: "write", args: ["abc"] }]);
  });
});

describe("perceptualSignature", () => {
  it("returns the same signature for identical PNGs", () => {
    const a = solidPng(200, 200, 120, 120, 120);
    const b = solidPng(200, 200, 120, 120, 120);
    expect(perceptualSignature(a)).toBe(perceptualSignature(b));
  });

  it("differs for clearly different images (all-black vs all-white)", () => {
    const black = solidPng(100, 100, 0, 0, 0);
    const white = solidPng(100, 100, 255, 255, 255);
    expect(perceptualSignature(black)).not.toBe(perceptualSignature(white));
  });

  it("differs for a checkerboard vs a gradient", () => {
    const checker = checkerPng(128, 128);
    const gradient = gradientPng(128, 128);
    expect(perceptualSignature(checker)).not.toBe(perceptualSignature(gradient));
  });

  it("is robust to a tiny localized change (flip a few corner pixels)", () => {
    // A mid-band gray (96 sits in the center of quantization level 1, 64..127) so
    // a few flipped pixels cannot push a whole averaged grid cell across a level
    // boundary. This is what "robust to small noise" means for this coarse hash.
    const base = solidPng(200, 200, 96, 96, 96);
    const decoded = PNG.sync.read(base);
    // Flip a 3x3 block in the top-left corner to white. Below the 16x16 grid's
    // cell resolution and the 2-bit quantization, so the signature must not move.
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        const o = (y * 200 + x) * 4;
        decoded.data[o] = 255;
        decoded.data[o + 1] = 255;
        decoded.data[o + 2] = 255;
        decoded.data[o + 3] = 255;
      }
    }
    const noisy = PNG.sync.write(decoded);
    expect(perceptualSignature(noisy)).toBe(perceptualSignature(base));
  });

  it("returns a stable fallback for non-PNG bytes (two bad inputs compare equal)", () => {
    const bad1 = Buffer.from("not a png at all");
    const bad2 = Buffer.from([1, 2, 3, 4, 5]);
    expect(perceptualSignature(bad1)).toBe(perceptualSignature(bad2));
    expect(perceptualSignature(bad1)).toBe("unreadable");
  });

  it("returns the fallback for empty input", () => {
    expect(perceptualSignature(Buffer.alloc(0))).toBe("unreadable");
  });

  it("accepts a Uint8Array as well as a Buffer", () => {
    const png = solidPng(64, 64, 50, 60, 70);
    expect(perceptualSignature(new Uint8Array(png))).toBe(perceptualSignature(png));
  });
});
