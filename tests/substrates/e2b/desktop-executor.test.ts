import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { CuaAction } from "../../../src/actors/computer-use/loop.js";
import type { E2BDesktopLike } from "../../../src/substrates/e2b/desktop-executor.js";
import { perceptualSignature } from "../../../src/evidence/frame-signature.js";
import { createE2BDesktopExecutor } from "../../../src/substrates/e2b/desktop-executor.js";

// The hosted transport's own behavior: observation, waits, the scroll option, held keys around a
// cancelled action and the shell guard. What each action sends is in
// tests/substrates/x11/desktop-contract.test.ts.

/**
 * A fake hosted desktop that records each call as one line. Commands answer exit 0; `failOn`
 * makes the named command throw. `sync` makes screenshot and wait return synchronously.
 */
function makeFakeDesktop(
  screenshotBytes: Uint8Array | Buffer,
  opts: { sync?: boolean; failOn?: string; pointer?: () => void } = {},
): { desktop: E2BDesktopLike; calls: string[] } {
  const calls: string[] = [];
  const desktop: E2BDesktopLike = {
    commands: {
      run: async (command) => {
        calls.push(command);
        if (command === opts.failOn) throw new Error(`synthetic ${command} failure`);
        if (command === "xdotool getmouselocation") {
          opts.pointer?.();
          return { exitCode: 0, stdout: "x:0 y:0 screen:0 window:1\n" };
        }
        return { exitCode: 0, stdout: command.includes("mktemp") ? "/tmp/humanish-type-T1" : "" };
      },
    },
    files: {
      write: async (path) => {
        calls.push(`files.write ${path}`);
      },
    },
    screenshot: () => {
      calls.push("screenshot");
      return opts.sync ? screenshotBytes : Promise.resolve(screenshotBytes);
    },
    wait: (ms) => {
      calls.push(`wait ${ms}`);
      return opts.sync ? undefined : Promise.resolve();
    },
  };
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

async function run(action: CuaAction, scrollAmountPerTick?: number): Promise<string[]> {
  const { desktop, calls } = makeFakeDesktop(SHOT);
  const executor = createE2BDesktopExecutor(
    desktop,
    scrollAmountPerTick === undefined ? {} : { scrollAmountPerTick },
  );
  await executor.execute(action);
  return calls;
}

describe("createE2BDesktopExecutor.execute", () => {
  it("waits on the sandbox for the action's length", async () => {
    expect(await run({ kind: "wait", ms: 1234 })).toEqual(["wait 1234"]);
  });

  it("waits half a second for a wait that names no duration", async () => {
    expect(await run({ kind: "wait" })).toEqual(["wait 500"]);
  });

  it("works with a synchronous wait", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT, { sync: true });
    await createE2BDesktopExecutor(desktop).execute({ kind: "wait", ms: 5 });
    expect(calls).toEqual(["wait 5"]);
  });

  it.each([
    [undefined, "2"],
    [50, "4"],
  ])("scrolls %j pixels per wheel step", async (perTick, steps) => {
    const calls = await run({ kind: "scroll", x: 5, y: 6, dx: 0, dy: 200 }, perTick);
    expect(calls).toEqual(["xdotool mousemove --sync 5 6", `xdotool click --repeat ${steps} 5`]);
  });

  it("never puts typed text into a command", async () => {
    const calls = await run({ kind: "type", text: "hello with punctuation" });
    expect(calls).toContain("files.write /tmp/humanish-type-T1/text");
    expect(calls.join("\n")).not.toContain("hello");
  });

  it("refuses a coordinate that is not a shell-safe number before running anything", async () => {
    const x = "1; reboot" as unknown as number;
    const { desktop, calls } = makeFakeDesktop(SHOT);
    await expect(
      createE2BDesktopExecutor(desktop).execute({ kind: "move", x, y: 2 }),
    ).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
    expect(calls).toEqual([]);
  });
});

describe("createE2BDesktopExecutor.observe", () => {
  it("returns the screenshot bytes as a Buffer and a stateSignature string", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const obs = await createE2BDesktopExecutor(desktop).observe();
    expect(calls).toEqual(["screenshot"]);
    expect(Buffer.isBuffer(obs.screenshot)).toBe(true);
    expect(Buffer.compare(obs.screenshot ?? Buffer.alloc(0), SHOT)).toBe(0);
    expect(obs.stateSignature).toBe(perceptualSignature(SHOT));
  });

  it("probes browser state before capturing the screenshot so stop evidence is less stale", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const executor = createE2BDesktopExecutor(desktop, {
      observeBrowserState: async () => {
        calls.push("observeBrowserState");
        return {
          text: "Dashboard ready",
          title: "Dashboard",
          url: "https://example.test/dashboard",
        };
      },
    });
    const obs = await executor.observe();
    expect(calls).toEqual(["observeBrowserState", "screenshot"]);
    expect(obs.text).toBe("Dashboard ready");
    expect(obs.title).toBe("Dashboard");
    expect(obs.url).toBe("https://example.test/dashboard");
  });

  it("carries the links the desktop handed to another app, and observes on when the read fails", async () => {
    const { desktop } = makeFakeDesktop(SHOT);
    const reads = [
      async () => [{ scheme: "mailto", recipients: ["help@example.test"] }],
      async () => [],
      async () => {
        throw new Error("sandbox did not answer");
      },
    ];
    const executor = createE2BDesktopExecutor(desktop, {
      readExternalHandoffs: () => reads.shift()!(),
    });
    expect((await executor.observe()).externalHandoffs).toEqual([
      { scheme: "mailto", recipients: ["help@example.test"] },
    ]);
    expect((await executor.observe()).externalHandoffs).toBeUndefined();
    const afterFailure = await executor.observe();
    expect(afterFailure.externalHandoffs).toBeUndefined();
    expect(afterFailure.screenshot).toBeDefined();
  });

  it.each([
    ["an async Uint8Array", false],
    ["a synchronous Uint8Array", true],
  ])("coerces %s screenshot result to a Buffer", async (_label, sync) => {
    const { desktop } = makeFakeDesktop(new Uint8Array(SHOT), { sync });
    const obs = await createE2BDesktopExecutor(desktop).observe();
    expect(Buffer.isBuffer(obs.screenshot)).toBe(true);
    expect(Buffer.compare(obs.screenshot ?? Buffer.alloc(0), SHOT)).toBe(0);
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

describe("createE2BDesktopExecutor held modifiers", () => {
  it("releases the modifiers when the action is cancelled mid-way", async () => {
    const controller = new AbortController();
    const { desktop, calls } = makeFakeDesktop(SHOT, { pointer: () => controller.abort() });
    await expect(
      createE2BDesktopExecutor(desktop).execute(
        { kind: "click", x: 5, y: 6, heldKeys: ["SHIFT"] },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual([
      "xdotool keydown shift",
      "xdotool getmouselocation",
      "xdotool keyup shift",
    ]);
  });

  it.each<[string, string[]]>([
    ["an ordinary key", ["a"]],
    ["an unknown name", ["HYPER"]],
    ["command syntax", ["shift; reboot"]],
    ["a repeated modifier", ["CTRL", "CONTROL"]],
  ])("refuses %s before dispatch", async (_label, heldKeys) => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    await expect(
      createE2BDesktopExecutor(desktop).execute({ kind: "click", x: 5, y: 6, heldKeys }),
    ).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
    expect(calls).toEqual([]);
  });

  it("presses nothing for a pointer action that sends no input", async () => {
    const { desktop, calls } = makeFakeDesktop(SHOT);
    const executor = createE2BDesktopExecutor(desktop);
    await executor.execute({ kind: "scroll", x: 5, y: 6, dx: 0, dy: 0, heldKeys: ["SHIFT"] });
    await executor.execute({ kind: "drag", path: [{ x: 1, y: 1 }], heldKeys: ["SHIFT"] });
    expect(calls).toEqual([]);
  });
});
