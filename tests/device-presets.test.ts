import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEVICE_PRESET,
  DEVICE_PRESETS,
  DEVICE_PRESET_NAMES,
  isDevicePresetName,
  resolveDevicePreset,
  type DevicePreset
} from "../src/device-presets.js";

describe("device presets", () => {
  // Pin the LITERAL values copied from the in-house ui-sim viewport tables so they cannot
  // silently drift back to a guess.
  it("carries the exact copied preset values", () => {
    expect(DEVICE_PRESETS).toEqual({
      mobile: { width: 414, height: 896, isMobile: true, deviceScaleFactor: 3 },
      "small-mobile": { width: 360, height: 740, isMobile: true, deviceScaleFactor: 3 },
      "narrow-mobile": { width: 320, height: 700, isMobile: true, deviceScaleFactor: 2 },
      tablet: { width: 820, height: 1180, isMobile: false, deviceScaleFactor: 2 },
      desktop: { width: 1440, height: 950, isMobile: false, deviceScaleFactor: 1 },
      wide: { width: 1920, height: 1080, isMobile: false, deviceScaleFactor: 1 }
    });
  });

  it("defaults to the desktop laptop baseline (1440x950), with wide=1920x1080 available", () => {
    expect(DEFAULT_DEVICE_PRESET).toBe("desktop");
    expect(resolveDevicePreset(undefined)).toEqual(DEVICE_PRESETS.desktop);
    expect(DEVICE_PRESETS.wide).toEqual({ width: 1920, height: 1080, isMobile: false, deviceScaleFactor: 1 });
  });

  it("phone presets are mobile with a retina-class DSF; desktop/tablet are not mobile", () => {
    for (const name of ["mobile", "small-mobile", "narrow-mobile"] as const) {
      expect(DEVICE_PRESETS[name].isMobile, name).toBe(true);
      expect(DEVICE_PRESETS[name].deviceScaleFactor, name).toBeGreaterThanOrEqual(2);
    }
    expect(DEVICE_PRESETS.desktop.isMobile).toBe(false);
    expect(DEVICE_PRESETS.tablet.isMobile).toBe(false);
  });

  it("the guessed 1280x800 is gone — no preset matches it", () => {
    const presets: DevicePreset[] = Object.values(DEVICE_PRESETS);
    expect(presets.some((p) => p.width === 1280 && p.height === 800)).toBe(false);
  });

  it("isDevicePresetName + resolveDevicePreset", () => {
    expect(DEVICE_PRESET_NAMES).toContain("mobile");
    expect(isDevicePresetName("mobile")).toBe(true);
    expect(isDevicePresetName("nope")).toBe(false);
    expect(isDevicePresetName(42)).toBe(false);
    expect(resolveDevicePreset("tablet")).toEqual(DEVICE_PRESETS.tablet);
  });
});
