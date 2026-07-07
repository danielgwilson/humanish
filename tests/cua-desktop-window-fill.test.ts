import { describe, expect, it } from "vitest";

import { buildFillDesktopWindowCommand } from "../src/cua-actor-lab.js";

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
