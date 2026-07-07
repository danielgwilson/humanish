// Device/viewport presets — a per-persona dimension, with LITERAL values copied from mature
// in-house ui-sim viewport tables rather than guessed. Where two independent reference sims
// agree (mobile/small-mobile/tablet) the value is copied verbatim; where they diverge (desktop
// baseline) both are kept as distinct named presets (laptop vs external monitor).
//
// FIDELITY NOTE (read before trusting "mobile"): on the computer-use / E2B-desktop route, only
// width/height physically render — the desktop X screen is sized to the preset, so a site's
// width-based responsive CSS fires (real mobile LAYOUT), but there is NO touch input, the
// device-scale-factor is not rendered, and the user-agent stays desktop. This is exactly the
// fidelity the bespoke sims' organic (computer-use) lanes have — they compensate by TELLING the
// model its device in the prompt, which this harness also does. True touch/DPR/UA emulation
// needs the deterministic CDP driver (a later actor); `isMobile`/`deviceScaleFactor` are carried
// here as honest metadata + a prompt signal, not a rendered guarantee on this route.

export interface DevicePreset {
  /** CSS-pixel viewport width. */
  width: number;
  /** CSS-pixel viewport height. */
  height: number;
  /** Whether this models a touch/mobile device (metadata + prompt signal on the CUA route). */
  isMobile: boolean;
  /** Device pixel ratio (metadata + prompt signal on the CUA route; rendered only on the CDP route). */
  deviceScaleFactor: number;
}

/**
 * Named presets. Keys are the public vocabulary for `execution.desktop.device` and (later) a
 * per-persona `device`. Values are copied verbatim from the in-house ui-sim viewport tables;
 * the per-line notes record where the two reference sims agree vs. diverge.
 */
export const DEVICE_PRESETS = {
  // phone — both reference sims agree
  mobile: { width: 414, height: 896, isMobile: true, deviceScaleFactor: 3 },
  // small phone — both reference sims agree
  "small-mobile": { width: 360, height: 740, isMobile: true, deviceScaleFactor: 3 },
  // older narrow phone
  "narrow-mobile": { width: 320, height: 700, isMobile: true, deviceScaleFactor: 2 },
  // tablet — both reference sims agree
  tablet: { width: 820, height: 1180, isMobile: false, deviceScaleFactor: 2 },
  // laptop baseline (the in-house desktop viewport; ~matches homun's own run.ts desktop surface)
  desktop: { width: 1440, height: 950, isMobile: false, deviceScaleFactor: 1 },
  // external monitor / most-common desktop resolution
  wide: { width: 1920, height: 1080, isMobile: false, deviceScaleFactor: 1 }
} as const satisfies Record<string, DevicePreset>;

export type DevicePresetName = keyof typeof DEVICE_PRESETS;

/**
 * Default device for a run that does not declare one. `desktop` (1440x950) is the median
 * first-run laptop — the in-house desktop default, within 10px of homun's own
 * pre-existing run.ts desktop surface. `wide` (1920x1080), the most-common external monitor, is
 * one keystroke away (`execution.desktop.device: wide`) but is deliberately not the default,
 * because the median device a first-time user arrives on is a laptop, not a 1080p monitor.
 */
export const DEFAULT_DEVICE_PRESET: DevicePresetName = "desktop";

/** The ordered list of preset names, for validation + help text. */
export const DEVICE_PRESET_NAMES = Object.keys(DEVICE_PRESETS) as DevicePresetName[];

export function isDevicePresetName(value: unknown): value is DevicePresetName {
  return typeof value === "string" && value in DEVICE_PRESETS;
}

/** Resolve a preset name (or undefined) to its preset, falling back to the default. */
export function resolveDevicePreset(name: DevicePresetName | undefined): DevicePreset {
  return DEVICE_PRESETS[name ?? DEFAULT_DEVICE_PRESET];
}
