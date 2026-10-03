import { describe, expect, it, vi } from "vitest";
import { desktopOpener, openTarget, type DesktopOpenerHost } from "../../src/observer/render.js";

const TARGET = "/tmp/observer/index.html";
const linux = (env: NodeJS.ProcessEnv, xdgOpen = true): DesktopOpenerHost => ({
  platform: "linux",
  env,
  onPath: (name) => xdgOpen && name === "xdg-open",
});

describe("desktop opener", () => {
  it("uses the platform opener where a desktop exists", () => {
    expect(desktopOpener(TARGET, { platform: "darwin", env: {}, onPath: () => false })).toEqual({
      command: "open",
      args: [TARGET],
    });
    expect(desktopOpener(TARGET, { platform: "win32", env: {}, onPath: () => false })).toEqual({
      command: "cmd",
      args: ["/c", "start", "", TARGET],
    });
    for (const env of [{ DISPLAY: ":0" }, { WAYLAND_DISPLAY: "wayland-0" }])
      expect(desktopOpener(TARGET, linux(env))).toEqual({ command: "xdg-open", args: [TARGET] });
  });

  it("gives a reason instead of an opener on Linux without a display or xdg-open", () => {
    expect(desktopOpener(TARGET, linux({}))).toEqual({
      reason: "no display is available (`DISPLAY` and `WAYLAND_DISPLAY` are unset)",
    });
    expect(desktopOpener(TARGET, linux({ DISPLAY: ":0" }, false))).toEqual({
      reason: "xdg-open is not installed",
    });
  });

  it("reports not opened, with the reason and the target, and checks nothing else", () => {
    const onPath = vi.fn(() => true);
    const result = openTarget(TARGET, { platform: "linux", env: {}, onPath });
    expect(result).toEqual({
      opened: false,
      warning: `Could not open observer automatically: no display is available (\`DISPLAY\` and \`WAYLAND_DISPLAY\` are unset). Open ${TARGET} in a browser.`,
    });
    expect(onPath).not.toHaveBeenCalled();
  });
});
