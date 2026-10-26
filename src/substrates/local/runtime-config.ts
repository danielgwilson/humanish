import { isApiParticipantActor } from "../../actors/computer-use/models.js";
import type { StudyConfig } from "../../study/types.js";
import { participantList } from "../../study/study-fields.js";
import {
  DEVICE_PRESET_NAMES,
  resolveParticipantDevice,
  type DevicePreset,
} from "../../study/device-presets.js";
import { participantMobileEmulation } from "../../study/mobile-emulation.js";
import {
  DEFAULT_GUEST_SCREEN,
  GUEST_SCREEN_LIMITS,
  type GuestDisplayConfig,
} from "../../guest/display-config.js";

// The runtime image enforces a 30-minute lifetime; reserve setup/teardown room.
export const LOCAL_BROWSER_LIFETIME_MS = 30 * 60_000;
const MAX_SESSION_MS = 20 * 60_000;

export function isLocalBrowserStudy(config: StudyConfig): boolean {
  return (
    config.subject.source === "app-url" &&
    config.execution?.target === "local" &&
    (config.actor?.type === "local-agent" || isApiParticipantActor(config.actor?.type))
  );
}

/** Defaults for the explicitly selected local substrate; hosted configurations are untouched. */
export function localBrowserDefaults(config: StudyConfig): StudyConfig {
  const actor = config.actor;
  if (!isLocalBrowserStudy(config) || actor === undefined) return config;
  return {
    ...config,
    actor: {
      ...actor,
      // A study that names its vendor runs that vendor's default model.
      ...(actor.provider === undefined ? { model: actor.model ?? "gpt-6-astra" } : {}),
      reasoningEffort: actor.reasoningEffort ?? "low",
    },
    execution: {
      ...config.execution,
      timeoutMs: config.execution?.timeoutMs ?? MAX_SESSION_MS,
      desktop: {
        ...config.execution?.desktop,
        // A named device governs the screen when the study sets one; resolution would override it.
        ...(config.execution?.desktop?.device !== undefined ||
        participantList(config)?.some((entry) => entry.device !== undefined)
          ? {}
          : {
              resolution: config.execution?.desktop?.resolution ?? [
                DEFAULT_GUEST_SCREEN.width,
                DEFAULT_GUEST_SCREEN.height,
              ],
            }),
      },
    },
  };
}

export function localBrowserUnsupportedReason(config: StudyConfig): string | undefined {
  const actor = config.actor;
  const desktop = config.execution?.desktop;
  if ((config.execution?.timeoutMs ?? MAX_SESSION_MS) > MAX_SESSION_MS) {
    return "Local browser sessions currently support at most 20 minutes, within the runtime's 30-minute lifetime.";
  }
  if (
    !actor ||
    (actor.type === "local-agent" && actor.localAgent !== undefined && actor.localAgent !== "codex")
  ) {
    return "Local browser studies support only Codex local-agent or API computer-use participants (computer-use or openai-computer-use).";
  }
  if (
    (desktop?.browser !== undefined && !["default", "chromium"].includes(desktop.browser)) ||
    desktop?.template !== undefined ||
    desktop?.sandboxTimeoutMs !== undefined
  ) {
    return "The local browser runtime runs Chromium and has no hosted templates or sandboxTimeoutMs. Remove execution.desktop.browser, template and sandboxTimeoutMs, or use a hosted desktop.";
  }
  const screenReason = localScreenReason(config);
  if (screenReason) return screenReason;
  if (
    config.comms !== undefined &&
    (config.comms.email?.kind !== "fake" || !config.comms.email.external)
  ) {
    return "Local browser inboxes require captured email with comms.email.external.catchBaseUrl. Run humanish comms catch and point your app's email sends at it. Real receiving requires a supported hosted route.";
  }
  if (desktop?.media?.camera !== undefined && desktop.media.camera.source !== "synthetic") {
    return "Local cameras currently use source: synthetic. Camera files remain supported on hosted desktops.";
  }
  if (
    actor.type === "local-agent" &&
    (actor.model !== "gpt-6-astra" ||
      actor.reasoningEffort !== "low" ||
      participantList(config)?.some(
        (entry) => entry.reasoningEffort !== undefined && entry.reasoningEffort !== "low",
      ) ||
      actor.maxOutputTokens !== undefined ||
      config.caps?.maxUsd !== undefined ||
      config.caps?.maxTotalUsd !== undefined)
  ) {
    return "Local Codex participants currently use gpt-6-astra at low effort. Account dollar/output-token caps are unavailable; use API participants for those controls.";
  }
  for (const target of [
    config.subject.appUrl,
    ...(participantList(config) ?? []).map((entry) => entry.target),
  ].filter(Boolean)) {
    let url;
    try {
      url = new URL(target!);
    } catch {
      return "Local browser targets must be loopback HTTP(S) URLs.";
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.username ||
      url.password ||
      Number(url.port) < 1024
    )
      return "Local browser targets must use localhost or 127.0.0.1 on a port above 1023.";
  }
  return undefined;
}

/** Why a participant's screen does not fit the local guest, or undefined. */
function localScreenReason(config: StudyConfig): string | undefined {
  const limits = GUEST_SCREEN_LIMITS;
  for (const entry of participantList(config) ?? [{}]) {
    const [width, height] = resolveParticipantDevice(config, entry.device).resolution;
    if (
      width < limits.minWidth ||
      width > limits.maxWidth ||
      height < limits.minHeight ||
      height > limits.maxHeight
    )
      return `Local browser desktops support screens up to ${limits.maxWidth}×${limits.maxHeight} and at least ${limits.minHeight} pixels high; this study asks for ${width}×${height}. Use a device preset (${DEVICE_PRESET_NAMES.join(", ")}), a resolution within those bounds, or a hosted desktop.`;
  }
  const userAgent = config.execution?.desktop?.fidelity?.userAgent;
  if (userAgent !== undefined && !/^[\x20-\x7e]{1,512}$/.test(userAgent))
    return "Local browser desktops take an execution.desktop.fidelity.userAgent of at most 512 printable ASCII characters. Shorten it or remove non-ASCII characters.";
  return undefined;
}

/**
 * The screen a local participant's guest starts, with mobile emulation where hosted desktops apply
 * it. Undefined is the guest's 960×720 default, which every installed runtime supports.
 */
export function localGuestDisplay(
  config: StudyConfig,
  device: { preset: DevicePreset; resolution: readonly [number, number] },
): GuestDisplayConfig | undefined {
  const mobileEmulation = participantMobileEmulation(
    config.execution?.desktop?.fidelity,
    device.preset,
  );
  const [width, height] = device.resolution;
  if (
    mobileEmulation === undefined &&
    width === DEFAULT_GUEST_SCREEN.width &&
    height === DEFAULT_GUEST_SCREEN.height
  )
    return undefined;
  return { width, height, ...(mobileEmulation === undefined ? {} : { mobileEmulation }) };
}

/** Whether any participant of a local study needs a screen other than the guest's default. */
export function localStudySetsScreens(config: StudyConfig): boolean {
  const study = localBrowserDefaults(config);
  return (participantList(study) ?? [{}]).some(
    (entry) =>
      localGuestDisplay(study, resolveParticipantDevice(study, entry.device)) !== undefined,
  );
}
