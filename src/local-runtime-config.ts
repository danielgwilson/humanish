import type { LabConfig } from "./lab-config.js";

// The runtime image enforces a 30-minute lifetime; reserve setup/teardown room.
export const LOCAL_BROWSER_LIFETIME_MS = 30 * 60_000;
const MAX_SESSION_MS = 20 * 60_000;

export function isLocalBrowserLab(config: LabConfig): boolean {
  return config.subject.source === "app-url" && config.execution?.target === "local" &&
    ["local-agent", "openai-computer-use"].includes(config.actors[0]?.type ?? "");
}

/** Defaults for the explicitly selected local substrate; hosted configurations are untouched. */
export function localBrowserDefaults(config: LabConfig): LabConfig {
  if (!isLocalBrowserLab(config)) return config;
  return { ...config,
    actors: config.actors.map(actor => ({ ...actor, model: actor.model ?? "gpt-6-astra", reasoningEffort: actor.reasoningEffort ?? "low" })),
    execution: { ...config.execution, timeoutMs: config.execution?.timeoutMs ?? MAX_SESSION_MS, desktop: { ...config.execution?.desktop,
      resolution: config.execution?.desktop?.resolution ?? [960, 720] } },
    ...(config.review?.analysis === undefined && config.actors[0]?.type === "local-agent"
      ? { review: { ...config.review, analysis: { provider: "codex" as const } } } : {}) };
}

export function localBrowserUnsupportedReason(config: LabConfig): string | undefined {
  const actor = config.actors[0];
  const desktop = config.execution?.desktop;
  if ((config.execution?.timeoutMs ?? MAX_SESSION_MS) > MAX_SESSION_MS) {
    return "Local browser sessions currently support at most 20 minutes, within the runtime's 30-minute lifetime.";
  }
  if (config.actors.length !== 1 || !actor ||
    (actor.type === "local-agent" && (actor.localAgent !== undefined && actor.localAgent !== "codex"))) {
    return "Local browser studies currently support Codex local-agent or openai-computer-use participants.";
  }
  if (desktop?.resolution?.[0] !== 960 || desktop.resolution[1] !== 720 || desktop.device !== undefined ||
    (desktop.browser !== undefined && !["default", "chromium"].includes(desktop.browser)) ||
    actor.lanes?.some(lane => lane.device !== undefined) || desktop.template !== undefined || desktop.sandboxTimeoutMs !== undefined) {
    return "The local browser runtime currently uses a 960×720 Chromium desktop. Omit hosted templates, device presets and sandboxTimeoutMs.";
  }
  if (config.comms !== undefined) return "Local browser inboxes are not integrated yet. Remove comms declarations or select a supported hosted route.";
  if (desktop.media?.camera !== undefined && desktop.media.camera.source !== "synthetic") {
    return "Local cameras currently use source: synthetic. Camera files remain supported on hosted desktops.";
  }
  if (actor.type === "local-agent" && (actor.model !== "gpt-6-astra" || actor.reasoningEffort !== "low" ||
    actor.lanes?.some(lane => lane.reasoningEffort !== undefined && lane.reasoningEffort !== "low") ||
    actor.maxOutputTokens !== undefined || config.execution?.caps?.maxUsd !== undefined || config.execution?.caps?.maxTotalUsd !== undefined ||
    config.scenario?.caps?.maxUsd !== undefined || config.scenario?.caps?.maxTotalUsd !== undefined)) {
    return "Local Codex participants currently use gpt-6-astra at low effort. Account dollar/output-token caps are unavailable; use API participants for those controls.";
  }
  for (const target of [config.subject.appUrl, ...(actor.lanes ?? []).map(lane => lane.target)].filter(Boolean)) {
    let url;
    try { url = new URL(target!); } catch { return "Local browser targets must be loopback HTTP(S) URLs."; }
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.username || url.password || Number(url.port) < 1024) return "Local browser targets must use localhost or 127.0.0.1 on a port above 1023.";
  }
  return undefined;
}
