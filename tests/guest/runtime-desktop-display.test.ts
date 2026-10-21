import { fake, flushUntil, FULL, h, start } from "./runtime-desktop-harness.js";
import { describe, expect, it } from "vitest";

// One participant's screen and phone emulation, observed at the guest desktop's faked boundaries.

describe("guest runtime desktop at a participant's screen", () => {
  it("sizes the screen, window, recording and frames to a tablet participant without emulation", async () => {
    const { pending } = start({ ...FULL, display: { width: 820, height: 1180 } });
    await pending;
    expect(h.children.find((child) => child.binary === "/usr/bin/Xvfb")!.args).toContain(
      "820x1180x24",
    );
    expect(h.launchOptions!.args).toEqual(
      expect.arrayContaining(["--window-size=820,1140", "--window-position=0,20"]),
    );
    expect((h.launchOptions!.args as string[]).some((arg) => arg.startsWith("--user-agent"))).toBe(
      false,
    );
    expect(h.recorderOptions).toMatchObject({ width: 820, height: 1180 });
    expect(h.executorOptions).toMatchObject({ width: 820, height: 1180 });
    expect(fake.context.newCDPSession).not.toHaveBeenCalled();
  });

  it("emulates a phone on the launch page before it navigates", async () => {
    const userAgent = "Mozilla/5.0 (Synthetic Phone) Mobile";
    const { pending } = start({
      ...FULL,
      display: {
        width: 500,
        height: 896,
        mobileEmulation: { width: 414, height: 896, deviceScaleFactor: 3, touch: true, userAgent },
      },
    });
    await pending;
    expect(h.children.find((child) => child.binary === "/usr/bin/Xvfb")!.args).toContain(
      "500x896x24",
    );
    expect(h.launchOptions!.args).toEqual(
      expect.arrayContaining([
        "--window-size=500,856",
        `--user-agent=${userAgent}`,
        "--touch-events=enabled",
      ]),
    );
    expect(h.executorOptions).toMatchObject({ width: 500, height: 896 });
    expect(h.cdp).toEqual([
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          width: 414,
          height: 896,
          deviceScaleFactor: 3,
          mobile: true,
          screenWidth: 414,
          screenHeight: 896,
        },
      },
      {
        method: "Emulation.setTouchEmulationEnabled",
        params: { enabled: true, maxTouchPoints: 5 },
      },
      {
        method: "Emulation.setEmitTouchEventsForMouse",
        params: { enabled: true, configuration: "mobile" },
      },
      { method: "Emulation.setUserAgentOverride", params: { userAgent } },
    ]);
    const firstNavigation = h.steps.indexOf("page.goto");
    expect(
      h.steps.slice(0, firstNavigation).filter((step) => step.startsWith("cdp page")),
    ).toHaveLength(4);
    // A tab the participant opens later gets the same overrides.
    const [event, listener] = fake.context.on.mock.calls[0] as [string, (page: unknown) => void];
    expect(event).toBe("page");
    listener({ later: true });
    await flushUntil(() => h.cdp.length === 8);
    expect(h.steps.filter((step) => step.startsWith("cdp other"))).toHaveLength(4);
  });
});
