import type { DevicePreset } from "./device-presets.js";
import type { StudyDesktopFidelity } from "./types.js";

/** The user agent a mobile-emulated participant presents unless the study sets its own. */
const DEFAULT_MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** The CDP Emulation overrides one participant's Chromium pages get. */
export interface MobileEmulationRequest {
  width: number;
  height: number;
  deviceScaleFactor: number;
  touch: boolean;
  userAgent: string;
}

/**
 * The emulation a participant gets, or undefined. Only a participant on a mobile preset is
 * emulated: a run-wide `mobileEmulation` must not hand a desktop or tablet participant beside a
 * phone participant an iPhone user agent. Hosted and local desktops both read this.
 */
export function participantMobileEmulation(
  fidelity: StudyDesktopFidelity | undefined,
  preset: DevicePreset,
): MobileEmulationRequest | undefined {
  if (!fidelity?.mobileEmulation || !preset.isMobile) return undefined;
  return {
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: fidelity.deviceScaleFactor ?? preset.deviceScaleFactor,
    touch: fidelity.touch ?? true,
    userAgent: fidelity.userAgent ?? DEFAULT_MOBILE_USER_AGENT,
  };
}

/** Chromium flags that carry the user agent and touch support to every page and worker. */
export function mobileEmulationLaunchFlags(request: MobileEmulationRequest | undefined): string[] {
  if (request === undefined) return [];
  return [
    `--user-agent=${request.userAgent}`,
    ...(request.touch ? ["--touch-events=enabled"] : []),
  ];
}

/**
 * The CDP commands that apply a request to one page, in order. The local guest sends these over
 * its own page session; the hosted desktop's in-sandbox probe sends the same Emulation domain.
 * Touch adds mouse-to-touch conversion, since participants drive a desktop pointer.
 */
export function mobileEmulationCommands(
  request: MobileEmulationRequest,
): { method: string; params: Record<string, unknown> }[] {
  return [
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: request.width,
        height: request.height,
        deviceScaleFactor: request.deviceScaleFactor,
        mobile: true,
        screenWidth: request.width,
        screenHeight: request.height,
      },
    },
    ...(request.touch
      ? [
          {
            method: "Emulation.setTouchEmulationEnabled",
            params: { enabled: true, maxTouchPoints: 5 },
          },
          {
            method: "Emulation.setEmitTouchEventsForMouse",
            params: { enabled: true, configuration: "mobile" },
          },
        ]
      : []),
    { method: "Emulation.setUserAgentOverride", params: { userAgent: request.userAgent } },
  ];
}
