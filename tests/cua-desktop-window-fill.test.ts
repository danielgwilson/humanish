import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";

import { buildFillDesktopWindowCommand, captureDesktopBrowserGeometry, parseXwininfoGeometry } from "../src/cua-actor-lab.js";

const measuredMaximized = readFileSync(new URL("./fixtures/desktop-geometry/xwininfo-maximized.txt", import.meta.url), "utf8");
describe("physical X client measurements", () => {
  it("reads the captured absolute origin without adding the window decoration twice", () => {
    expect(parseXwininfoGeometry(measuredMaximized)).toEqual({ x: 0, y: 51, width: 1440, height: 899, source: "xwininfo" });
  });
  it.each([
    measuredMaximized.replace("Absolute upper-left Y:  51", "Absolute upper-left Y:  51.5"),
    measuredMaximized.replace("Width: 1440", "Width: 0"),
    measuredMaximized.replace("Height: 899", "Height: -1"),
    measuredMaximized.replace("Width: 1440", "Width: 9007199254740992"),
    measuredMaximized.replace(/\s*Absolute upper-left X:.*\n/, "\n"),
    measuredMaximized.replace("IsViewable", "IsUnMapped"),
    measuredMaximized.replace("Synthetic browser", "Synthetic\n  Absolute upper-left X: 0\nbrowser"),
    measuredMaximized.replace("Synthetic browser", "Synthetic\n  Width: 1440\nbrowser"),
    measuredMaximized.replace("IsViewable", "IsUnMapped").replace("Synthetic browser", "Synthetic\n  Map State: IsViewable\nbrowser"),
    ""
  ])("refuses incomplete, invalid or ambiguous output %#", output => {
    expect(parseXwininfoGeometry(output)).toBeUndefined();
  });
  it("preserves negative absolute coordinates so containment still fails closed", () => {
    expect(parseXwininfoGeometry(measuredMaximized.replace("Absolute upper-left X:  0", "Absolute upper-left X:  -5"))?.x).toBe(-5);
  });
});

describe("buildFillDesktopWindowCommand", () => {
  it("moves the window to the origin and sizes it to the exact desktop resolution", () => {
    const cmd = buildFillDesktopWindowCommand("0x2200003", 1440, 900);
    expect(cmd).toContain('xdotool windowmove "$win" 0 0');
    expect(cmd).toContain('xdotool windowsize "$win" 1440 900');
    expect(cmd).toContain("win='0x2200003'");
  });

  it("uses the lane resolution verbatim (no default 1024x768 fallback)", () => {
    const cmd = buildFillDesktopWindowCommand("0x1", 375, 812);
    expect(cmd).toContain('xdotool windowsize "$win" 375 812');
  });

  it("single-quotes the window id so shell metacharacters stay inert", () => {
    const cmd = buildFillDesktopWindowCommand("0x1; rm -rf /tmp", 800, 600);
    expect(cmd).toContain("win='0x1; rm -rf /tmp'");
    expect(cmd).not.toMatch(/win=0x1;\s*rm/);
  });

  it("tolerates its own failure by design (each xdotool call is guarded)", () => {
    const cmd = buildFillDesktopWindowCommand("0x1", 1920, 1080);
    // every xdotool invocation is suffixed with `|| true` so a resize failure
    // never fails the lane (the actor can still run on a smaller window).
    for (const line of cmd.split("\n").filter((l) => l.startsWith("xdotool"))) {
      expect(line).toMatch(/\|\| true$/);
    }
  });
});


type Bounds = { x: number; y: number; width: number; height: number };
const screen = [1280, 720] as const;
const full: Bounds = { x: 0, y: 0, width: 1280, height: 720 };

function geometryDesktop(reads: Array<Bounds | undefined>, pageWindow: Bounds = full) {
  const commands: string[] = [];
  let read = 0;
  const desktop = {
    wait: async () => undefined,
    commands: { run: async (command: string) => {
      commands.push(command);
      if (command.includes("xwininfo -id")) {
        const bounds = reads[Math.min(read++, reads.length - 1)];
        return { stdout: bounds === undefined ? "" : `Absolute upper-left X: ${bounds.x}\nAbsolute upper-left Y: ${bounds.y}\nWidth: ${bounds.width}\nHeight: ${bounds.height}\nMap State: IsViewable\n` };
      }
      if (command.includes("browserWindow: { x: window.screenX")) {
        return { stdout: JSON.stringify({ browserWindow: pageWindow, viewport: { width: 414, height: 896, deviceScaleFactor: 3 } }) };
      }
      return { stdout: "" };
    } }
  } as unknown as E2BDesktopSandbox;
  return { desktop, commands };
}

function capture(desktop: E2BDesktopSandbox, resize = true) {
  return captureDesktopBrowserGeometry({
    desktop, browserFamily: "chromium", browserWindowId: "123", laneId: "synthetic-lane",
    targetUrl: "http://127.0.0.1:8080/", requestedScreen: screen, requestTimeoutMs: 1000, resize
  });
}

describe("physical browser containment", () => {
  it.each([
    { x: 10, y: 85, width: 500, height: 811 },
    { x: -4, y: 27, width: 508, height: 869 }
  ])("removes decorations when the minimum-width client cannot fit: %j", async (clipped) => {
    // Historical reported failure shapes retained as containment regression inputs.
    const contained = { x: 0, y: 0, width: 500, height: 896 };
    const reads = clipped.x < 0 ? [clipped, clipped, contained] : [clipped, clipped, clipped, clipped, contained];
    const { desktop, commands } = geometryDesktop(reads);
    const result = await captureDesktopBrowserGeometry({
      desktop, browserFamily: "chromium", browserWindowId: "123", laneId: "narrow-screen",
      targetUrl: "http://127.0.0.1:8080/", requestedScreen: [500, 896], requestTimeoutMs: 1000
    });
    expect(result.unusable).toBeUndefined();
    expect(result.browserWindow).toEqual({ ...contained, source: "xwininfo" });
    expect(commands.filter((command) => command.includes('key --clearmodifiers F11'))).toHaveLength(1);
  });

  it("keeps known clipping when the fullscreen read-back is missing", async () => {
    const clipped = { ...full, y: 32 };
    const { desktop } = geometryDesktop([clipped, clipped, clipped, undefined]);
    expect((await capture(desktop)).unusable).toContain("could not be verified after correction");
  });

  it("waits for the fullscreen width after its origin has already moved", async () => {
    const clipped = { ...full, y: 32 };
    const { desktop, commands } = geometryDesktop([clipped, clipped, clipped, clipped, { ...full, width: 1288 }, full]);
    expect((await capture(desktop)).unusable).toBeUndefined();
    expect(commands.filter((command) => command.includes('key --clearmodifiers F11'))).toHaveLength(1);
  });

  it.each([
    ["positive y with bottom overflow", { ...full, y: 32 }],
    ["positive x with right overflow", { ...full, x: 16 }],
    ["negative x", { ...full, x: -1 }],
    ["negative y", { ...full, y: -1 }],
    ["excess width", { ...full, width: 1281 }],
    ["excess height", { ...full, height: 721 }]
  ])("names unusable %s even when CSS geometry looks contained", async (_name, bounds) => {
    const { desktop, commands } = geometryDesktop([bounds]);
    const result = await capture(desktop, false);
    expect(result.unusable).toContain("outside the captured 1280x720 desktop");
    expect(result.warnings).toContain(result.unusable);
    expect(result.browserWindow).toEqual({ ...bounds, source: "xwininfo" });
    expect(commands.some((command) => command.includes("windowmove"))).toBe(false);
  });

  it("accepts a fully visible window at a nonzero origin and keeps CSS emulation distinct", async () => {
    const bounds = { x: 8, y: 32, width: 1264, height: 688 };
    const { desktop } = geometryDesktop([bounds], { x: -500, y: -500, width: 414, height: 896 });
    const result = await capture(desktop, false);
    expect(result.unusable).toBeUndefined();
    expect(result.browserWindow).toEqual({ ...bounds, source: "xwininfo" });
    expect(result.viewport).toEqual({ width: 414, height: 896, deviceScaleFactor: 3, source: "cdp" });
  });

  it("fits once to the measured client origin and checks the resulting physical edges", async () => {
    const before = { ...full, y: 32 };
    const after = { ...before, height: 688 };
    const { desktop, commands } = geometryDesktop([before, before, after]);
    const result = await capture(desktop);
    expect(result.unusable).toBeUndefined();
    expect(result.browserWindow).toEqual({ ...after, source: "xwininfo" });
    expect(result.warnings.join(" ")).toContain("corrected");
    expect(commands.filter((command) => command.includes('windowsize "$win" 1280 688'))).toHaveLength(1);
  });

  it("refuses a window manager that ignores the bounded correction", async () => {
    const { desktop, commands } = geometryDesktop([{ ...full, y: 32 }]);
    const result = await capture(desktop);
    expect(result.unusable).toContain("outside the captured 1280x720 desktop");
    expect(commands.filter((command) => command.includes('windowsize "$win" 1280 688'))).toHaveLength(2);
  });

  it("keeps browser chrome when resizing restores a five-pixel window decoration", async () => {
    const initial = { x: 0, y: 56, width: 1440, height: 950 };
    const shifted = { x: 5, y: 56, width: 1440, height: 894 };
    const contained = { ...shifted, width: 1435 };
    const { desktop, commands } = geometryDesktop([initial, initial, shifted, contained]);
    const result = await captureDesktopBrowserGeometry({ desktop, browserFamily: "chromium", browserWindowId: "123",
      laneId: "decorated-desktop", targetUrl: "http://127.0.0.1:8080/", requestedScreen: [1440, 950], requestTimeoutMs: 1000 });
    expect(result.unusable).toBeUndefined();
    expect(result.browserWindow).toEqual({ ...contained, source: "xwininfo" });
    expect(commands.some(command => command.includes('windowsize "$win" 1435 894'))).toBe(true);
    expect(commands.some(command => command.includes("F11"))).toBe(false);
  });

  it("does not resize again when moving alone restores containment", async () => {
    const { desktop, commands } = geometryDesktop([{ ...full, x: -5 }, full]);
    expect((await capture(desktop)).unusable).toBeUndefined();
    expect(commands.filter(command => command.includes("windowsize"))).toHaveLength(1); // initial fill only
    expect(commands.some(command => command.includes("F11"))).toBe(false);
  });

  it("does not clear known clipping when the repair read-back is missing", async () => {
    const before = { ...full, y: 32 };
    const { desktop } = geometryDesktop([before, before, undefined]);
    const result = await capture(desktop);
    expect(result.unusable).toContain("could not be verified after correction");
  });

  it("does not treat an emulated page outer size as measured physical containment", async () => {
    const { desktop } = geometryDesktop([undefined], { x: 0, y: 0, width: 414, height: 896 });
    const result = await capture(desktop);
    expect(result.unusable).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("Physical browser containment is unverified");
    expect(result.warnings.join(" ")).not.toContain("outside the captured");
  });
});
