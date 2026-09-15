// Device/screen presets — a per-persona dimension, with LITERAL values copied from mature
// in-house ui-sim geometry tables rather than guessed. Where two independent reference sims
// agree (mobile/small-mobile/tablet) the value is copied verbatim; where they diverge (desktop
// baseline) both are kept as distinct named presets (laptop vs external monitor).
//
// On the computer-use / E2B-desktop route, presets size the physical X screen by default.
// CSS viewport dimensions are measured independently; browser chrome and the width floor below
// can make them differ. A mobile preset alone does not apply touch, DPR or a mobile user agent.
// With execution.desktop.fidelity.mobileEmulation enabled, hosted Chromium mobile lanes apply
// those overrides through a held CDP session, including later tabs, and record page read-back.
// Neither a preset nor browser emulation establishes physical-device or touch fidelity.
//
// ONE MORE ROUTE CONSTRAINT: Chrome won't render a window narrower than ~500 CSS px, so the RENDERED
// screen width is floored to MIN_DESKTOP_RENDER_WIDTH in resolveLaneDevice — a sub-500 preset (mobile
// 414, small-mobile 360, narrow-mobile 320) is rendered on a 500-wide screen the window fits exactly
// (otherwise the 500-wide window overflowed the narrow screen and clipped the page). These preset
// widths remain the requested device identity (prompt + metadata). Opt-in mobile emulation sets
// the CSS viewport independently of this physical floor; actual read-back remains the evidence.

export interface DevicePreset {
  /** Requested device width; the hosted physical screen may be widened to its minimum. */
  width: number;
  /** Requested device height, used for the hosted physical screen. */
  height: number;
  /** Mobile identity; enables emulation only when the hosted lane explicitly opts in. */
  isMobile: boolean;
  /** Requested DPR; applied on hosted mobile lanes only with opt-in CDP emulation. */
  deviceScaleFactor: number;
}

/**
 * Named presets. Keys are the public vocabulary for `execution.desktop.device` and (later) a
 * per-persona `device`. Values are copied verbatim from the in-house ui-sim screen tables;
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
  // laptop baseline (the in-house desktop screen; ~matches humanish's own run.ts desktop surface)
  desktop: { width: 1440, height: 950, isMobile: false, deviceScaleFactor: 1 },
  // external monitor / most-common desktop resolution
  wide: { width: 1920, height: 1080, isMobile: false, deviceScaleFactor: 1 }
} as const satisfies Record<string, DevicePreset>;

export type DevicePresetName = keyof typeof DEVICE_PRESETS;

/**
 * Default device for a run that does not declare one. `desktop` (1440x950) is the median
 * first-run laptop screen — the in-house desktop default, within 10px of humanish's own
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
