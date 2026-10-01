import { describe, expect, it } from "vitest";

import { inspectDesktopScreenGeometry } from "../../../src/substrates/e2b/desktop-geometry.js";
import type { E2BDesktopSandbox } from "../../../src/substrates/e2b/sdk.js";

// The screen probe's four outcomes. Route goldens use fakes whose xdpyinfo reports the requested
// screen, so the unmeasured and mismatched screens are pinned here.

function desktopAnswering(answer: () => Promise<{ stdout: string }>): E2BDesktopSandbox {
  return {
    commands: { run: async () => ({ exitCode: 0, stderr: "", ...(await answer()) }) },
  } as unknown as E2BDesktopSandbox;
}

const inspect = (desktop: E2BDesktopSandbox) =>
  inspectDesktopScreenGeometry({
    desktop,
    participantId: "lane-01",
    requestedScreen: [1440, 950],
    requestTimeoutMs: 1_000,
  });

describe("inspectDesktopScreenGeometry", () => {
  it("verifies the requested screen that xdpyinfo reports", async () => {
    const desktop = desktopAnswering(async () => ({
      stdout: "  dimensions:    1440x950 pixels (381x251 millimeters)\n",
    }));
    await expect(inspect(desktop)).resolves.toEqual({
      verified: { width: 1440, height: 950, source: "xdpyinfo" },
    });
  });

  it("fails closed on a screen that differs from the request", async () => {
    const desktop = desktopAnswering(async () => ({
      stdout: "  dimensions:    1024x768 pixels\n",
    }));
    await expect(inspect(desktop)).resolves.toEqual({
      verified: { width: 1024, height: 768, source: "xdpyinfo" },
      error:
        "HUMANISH_CUA_LAB_DEVICE_GEOMETRY: participant lane-01 requested a 1440x950 desktop but xdpyinfo reports 1024x768 in-sandbox; the participant's device geometry is unverified (fail-closed).",
    });
  });

  it("leaves the screen unverified when xdpyinfo prints nothing usable", async () => {
    const desktop = desktopAnswering(async () => ({ stdout: "" }));
    await expect(inspect(desktop)).resolves.toEqual({
      warning:
        "Desktop screen geometry could not be parsed for participant lane-01; requested geometry remains unverified.",
    });
  });

  it("leaves the screen unverified when the command fails", async () => {
    const desktop = desktopAnswering(async () => {
      throw new Error("sandbox gone");
    });
    await expect(inspect(desktop)).resolves.toEqual({
      warning:
        "Desktop screen geometry could not be measured for participant lane-01; requested geometry remains unverified.",
    });
  });
});
