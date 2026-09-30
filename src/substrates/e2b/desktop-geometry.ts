// Screen and browser-window geometry on a hosted E2B desktop, measured in the sandbox rather than
// taken from the request.
import { type DevicePreset } from "../../lab/device-presets.js";
import { failureTail, redactText } from "../../evidence/redaction.js";
import { type RunDesktopGeometry } from "../../run/streams.js";
import {
  chromeCdpProbeCommand,
  parseChromeCdpProbeOutput,
  type ChromeCdpPagePreference,
} from "../../routes/computer-use/cdp-probe.js";
import { toErrorMessage } from "../command-failure.js";
import { shellQuote } from "../shell.js";
import { e2bShell } from "./shell.js";
import {
  findVisibleBrowserWindowId,
  fillDesktopBrowserWindow,
  type DesktopBrowserFamily,
  type DesktopBrowserLaunchIdentity,
} from "./desktop-browser.js";
import type { ChromeCdpEndpoint } from "./desktop-cdp.js";
import type { E2BDesktopSandbox } from "./desktop-launch.js";

/**
 * The DECLARED preset to record alongside the rendered screen, or undefined when the preset
 * rendered faithfully.
 *
 * `desktopGeometry.screen.verified` compares the FLOORED number with itself, so on its own a
 * floored run is indistinguishable from a faithful one: a reader sees requested 500 / verified 500
 * and concludes a 500-wide screen was asked for. Recording the declared preset is what makes
 * "the preset width did not render" legible in the bundle.
 */
export function declaredScreenForRender(
  preset: DevicePreset,
  presetName: string,
  rendered: readonly [number, number],
): { width: number; height: number; preset: string } | undefined {
  if (preset.width === rendered[0] && preset.height === rendered[1]) return undefined;
  return { width: preset.width, height: preset.height, preset: presetName };
}

/**
 * Verify the desktop screen geometry IN-SANDBOX (the per-lane device claim is checked, never
 * assumed). A parseable mismatch fails closed. Unavailable/unparseable evidence is returned as
 * an explicit warning: the lane may still run, but its bundle records only the requested screen
 * and never upgrades that request into a verified measurement.
 */
export async function inspectDesktopScreenGeometry(args: {
  desktop: E2BDesktopSandbox;
  laneId: string;
  requestedScreen: readonly [number, number];
  requestTimeoutMs: number;
}): Promise<{
  verified?: RunDesktopGeometry["screen"]["verified"];
  error?: string;
  warning?: string;
}> {
  let out = "";
  try {
    const result = await e2bShell(args.desktop).run(
      "xdpyinfo 2>/dev/null | grep -i dimensions || true",
      { requestTimeoutMs: args.requestTimeoutMs },
    );
    out = result.stdout.trim();
  } catch {
    return {
      warning: `Desktop screen geometry could not be measured for lane ${args.laneId}; requested geometry remains unverified.`,
    };
  }
  const match = out.match(/(\d+)\s*x\s*(\d+)\s*pixels/i);
  if (!match) {
    return {
      warning: `Desktop screen geometry could not be parsed for lane ${args.laneId}; requested geometry remains unverified.`,
    };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const [expectedWidth, expectedHeight] = args.requestedScreen;
  if (width === expectedWidth && height === expectedHeight) {
    return { verified: { width, height, source: "xdpyinfo" } };
  }
  return {
    verified: { width, height, source: "xdpyinfo" },
    error: `HUMANISH_CUA_LAB_DEVICE_GEOMETRY: lane ${args.laneId} requested a ${expectedWidth}x${expectedHeight} desktop but xdpyinfo reports ${width}x${height} in-sandbox; the per-lane device geometry is unverified (fail-closed).`,
  };
}

/**
 * Read the running browser's actual outer-window bounds and CSS layout viewport through the
 * already-enabled local Chrome DevTools endpoint. The returned values come from `window.*` in
 * the target page; requested E2B resolution is deliberately not an input to this function.
 * Missing channels report their reason via `onUnavailable`, so the geometry warning can name
 * the cause (a dead CDP endpoint, no python3) instead of only the symptom. Returns `undefined`
 * only when neither channel could be measured.
 * Outer bounds and CSS dimensions are independent channels: a background page can report zero
 * outer dimensions while still reporting a CSS viewport. Final captures follow the active tab;
 * launch captures and emulation attribution keep the pinned target.
 */
export function makeChromeDesktopGeometryObserver(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  targetId?: string,
  onUnavailable?: (reason: string) => void,
  prefer: ChromeCdpPagePreference = "pinned",
): () => Promise<
  (Pick<RunDesktopGeometry, "browserWindow" | "viewport"> & { targetId?: string }) | undefined
> {
  const shell = e2bShell(desktop);
  return async () => {
    const result = await shell.run(
      chromeCdpProbeCommand({
        ...endpoint,
        ...(targetId === undefined ? {} : { targetId }),
        prefer,
        mode: "geometry",
      }),
      { requestTimeoutMs, timeoutMs: 5_000 },
    );
    if (result.exitCode !== 0) {
      onUnavailable?.(
        `probe exited ${result.exitCode}: ${failureTail(result.stderr || result.stdout)}`,
      );
      return undefined;
    }
    const parsed = parseChromeCdpProbeOutput(result.stdout);
    if (parsed.unavailable !== undefined) {
      onUnavailable?.(parsed.unavailable);
      return undefined;
    }
    const browserWindow = isMeasuredRect(parsed.browserWindow)
      ? { ...parsed.browserWindow, source: "cdp" as const }
      : undefined;
    const viewport = isMeasuredViewport(parsed.viewport)
      ? { ...parsed.viewport, source: "cdp" as const }
      : undefined;
    if (browserWindow === undefined && viewport === undefined) {
      onUnavailable?.("the page reported no usable window or viewport dimensions");
      return undefined;
    }
    if (browserWindow === undefined)
      onUnavailable?.("the page reported no usable outer-window dimensions");
    if (viewport === undefined)
      onUnavailable?.("the page reported no usable CSS viewport dimensions");
    return {
      ...(browserWindow === undefined ? {} : { browserWindow }),
      ...(viewport === undefined ? {} : { viewport }),
      ...(parsed.targetId === undefined ? {} : { targetId: parsed.targetId }),
    };
  };
}

function isMeasuredRect(
  value: unknown,
): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isFinite(record.x) &&
    Number.isFinite(record.y) &&
    isPositiveMeasurement(record.width) &&
    isPositiveMeasurement(record.height)
  );
}

function isMeasuredViewport(
  value: unknown,
): value is { width: number; height: number; deviceScaleFactor: number } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isPositiveMeasurement(record.width) &&
    isPositiveMeasurement(record.height) &&
    isPositiveMeasurement(record.deviceScaleFactor)
  );
}

function isPositiveMeasurement(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function measureBrowserWindowWithXwininfo(
  desktop: E2BDesktopSandbox,
  windowId: string,
  requestTimeoutMs: number,
): Promise<RunDesktopGeometry["browserWindow"] | undefined> {
  const result = await e2bShell(desktop).run(
    [
      "set -euo pipefail",
      `win=${shellQuote(windowId)}`,
      // Older xdotool builds translate parent-relative offsets twice. With window
      // decorations that falsely reports a visible client as clipped, triggering
      // fullscreen and hiding the participant's address bar. Read root-relative
      // client coordinates directly; never substitute emulated CDP outer bounds.
      'LC_ALL=C xwininfo -id "$win" -stats 2>/dev/null',
    ].join("\n"),
    { requestTimeoutMs, timeoutMs: 5_000 },
  );
  if (result.exitCode !== 0) return undefined;
  return parseXwininfoGeometry(result.stdout);
}

/** Root-relative physical client bounds from xwininfo's C-locale stats. */
export function parseXwininfoGeometry(
  output: string,
): RunDesktopGeometry["browserWindow"] | undefined {
  const read = (label: string) => {
    const matches = [...output.matchAll(new RegExp(`^\\s*${label}:\\s*(-?\\d+)\\s*$`, "gm"))];
    if (matches.length !== 1) return undefined;
    const value = Number(matches[0]![1]);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const x = read("Absolute upper-left X");
  const y = read("Absolute upper-left Y");
  const width = read("Width");
  const height = read("Height");
  const mapStates = [...output.matchAll(/^\s*Map State:\s*(\S+)\s*$/gm)];
  if (mapStates.length !== 1 || mapStates[0]![1] !== "IsViewable") return undefined;
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { x, y, width, height, source: "xwininfo" };
}

/** Physical X client bounds, never the page's emulated window.outerWidth/Height. */
function isBrowserWindowContained(
  bounds: NonNullable<RunDesktopGeometry["browserWindow"]>,
  [width, height]: readonly [number, number],
): boolean {
  return (
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= width &&
    bounds.y + bounds.height <= height
  );
}

/** Bounded repair. Resizing can clear a window-manager maximize state and move the
 * client origin as decorations return, so remeasure before a second adjustment. */
async function fitBrowserWindowWithinDesktop(
  desktop: E2BDesktopSandbox,
  windowId: string,
  resolution: readonly [number, number],
  requestTimeoutMs: number,
): Promise<RunDesktopGeometry["browserWindow"] | undefined> {
  const run = (command: string) =>
    e2bShell(desktop)
      .run(["set -euo pipefail", `win=${shellQuote(windowId)}`, command].join("\n"), {
        requestTimeoutMs,
        timeoutMs: 5_000,
      })
      .catch(() => undefined);
  await run('xdotool windowmove "$win" 0 0');
  await desktop.wait(250).catch(() => undefined);
  const moved = await measureBrowserWindowWithXwininfo(desktop, windowId, requestTimeoutMs).catch(
    () => undefined,
  );
  if (moved === undefined) return moved;
  let resized = moved;
  // Resizing alone cannot fix an offscreen client origin. The window manager
  // can also center a minimum-width client at a negative x on a narrow screen.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isBrowserWindowContained(resized, resolution)) return resized;
    const width = resolution[0] - resized.x;
    const height = resolution[1] - resized.y;
    if (resized.x < 0 || resized.y < 0 || width <= 0 || height <= 0) break;
    await run(`xdotool windowsize "$win" ${width} ${height}`);
    await desktop.wait(250).catch(() => undefined);
    const measured = await measureBrowserWindowWithXwininfo(
      desktop,
      windowId,
      requestTimeoutMs,
    ).catch(() => undefined);
    if (measured === undefined) return measured;
    resized = measured;
  }
  if (resized === undefined || isBrowserWindowContained(resized, resolution)) return resized;
  // Chrome's minimum client width can equal the whole desktop. Window-manager
  // borders then make a decorated window impossible to contain, even after a
  // successful move/resize. Request fullscreen once and prove the physical result.
  // xprop/xdotool ship with the desktop template; wmctrl is not required.
  // Check state first so the fullscreen shortcut cannot toggle an existing state off.
  await run(
    [
      'state=$(xprop -id "$win" _NET_WM_STATE)',
      'case "$state" in',
      "  *_NET_WM_STATE_FULLSCREEN*) ;;",
      '  *) xdotool windowactivate --sync "$win"; xdotool key --clearmodifiers F11 ;;',
      "esac",
    ].join("\n"),
  );
  // The fullscreen animation may report its new origin before its final width.
  // Give the window manager a bounded settling window, keeping missing reads unverified.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await desktop.wait(250).catch(() => undefined);
    const measured = await measureBrowserWindowWithXwininfo(
      desktop,
      windowId,
      requestTimeoutMs,
    ).catch(() => undefined);
    if (measured === undefined || isBrowserWindowContained(measured, resolution)) return measured;
    resized = measured;
  }
  return resized;
}

/** Hosted-browser geometry capture shared by the per-lane and shared-world routes. */
export async function captureDesktopBrowserGeometry(args: {
  desktop: E2BDesktopSandbox;
  browserFamily: DesktopBrowserFamily;
  launchIdentity?: DesktopBrowserLaunchIdentity;
  browserTargetId?: string;
  /** Launch captures stay pinned; final captures follow the participant's current page. */
  pagePreference?: ChromeCdpPagePreference;
  browserWindowId?: string;
  laneId: string;
  /** Runtime-only lane target URL (attributes the CDP page); never persisted by this capture. */
  targetUrl: string;
  requestedScreen: readonly [number, number];
  requestTimeoutMs: number;
  resize?: boolean;
}): Promise<{
  /** Known physical clipping (or unverified repair of it); startup must stop before actions. */
  unusable?: string;
  browserWindowId?: string;
  browserTargetId?: string;
  browserWindow?: RunDesktopGeometry["browserWindow"];
  viewport?: RunDesktopGeometry["viewport"];
  warnings: string[];
}> {
  const warnings: string[] = [];
  let browserWindowId = args.browserWindowId;
  if (browserWindowId === undefined && args.browserFamily !== "unknown") {
    browserWindowId = await findVisibleBrowserWindowId(
      args.desktop,
      args.requestTimeoutMs,
      args.browserFamily,
      args.launchIdentity,
    ).catch((error: unknown) => {
      warnings.push(
        `Browser window lookup failed for lane ${args.laneId}: ${redactText(toErrorMessage(error))}`,
      );
      return undefined;
    });
  }

  let physicalWindow: RunDesktopGeometry["browserWindow"] | undefined;
  if (browserWindowId !== undefined) {
    if (args.resize !== false) {
      await fillDesktopBrowserWindow(
        args.desktop,
        browserWindowId,
        args.requestedScreen,
        args.requestTimeoutMs,
      );
      // Let the window manager apply the resize before querying both X and page layout geometry.
      await args.desktop.wait(250).catch(() => undefined);
    }
    physicalWindow = await measureBrowserWindowWithXwininfo(
      args.desktop,
      browserWindowId,
      args.requestTimeoutMs,
    ).catch(() => undefined);
  } else {
    warnings.push(
      `Browser window bounds could not be measured for lane ${args.laneId}; the live stream will use the full desktop.`,
    );
  }

  let unusable: string | undefined;
  if (
    physicalWindow !== undefined &&
    !isBrowserWindowContained(physicalWindow, args.requestedScreen)
  ) {
    const before = physicalWindow;
    if (args.resize !== false && browserWindowId !== undefined) {
      physicalWindow = await fitBrowserWindowWithinDesktop(
        args.desktop,
        browserWindowId,
        args.requestedScreen,
        args.requestTimeoutMs,
      );
      if (physicalWindow === undefined) {
        // Keep the last measured bad state; a missing observation cannot prove a successful fix.
        physicalWindow = before;
        unusable = `Physical browser containment could not be verified after correction for lane ${args.laneId}; the last measured window was clipped.`;
      } else if (isBrowserWindowContained(physicalWindow, args.requestedScreen)) {
        warnings.push(
          `Browser window clipping corrected for lane ${args.laneId}; physical bounds are ${physicalWindow.width}x${physicalWindow.height} at (${physicalWindow.x}, ${physicalWindow.y}).`,
        );
      }
    }
    if (unusable === undefined && !isBrowserWindowContained(physicalWindow, args.requestedScreen)) {
      unusable = `Browser window is outside the captured ${args.requestedScreen[0]}x${args.requestedScreen[1]} desktop for lane ${args.laneId}: physical bounds ${physicalWindow.width}x${physicalWindow.height} at (${physicalWindow.x}, ${physicalWindow.y}), right=${physicalWindow.x + physicalWindow.width}, bottom=${physicalWindow.y + physicalWindow.height}.`;
    }
    if (unusable !== undefined) warnings.push(unusable);
  }
  if (physicalWindow === undefined) {
    warnings.push(
      `Physical browser containment is unverified for lane ${args.laneId}; X window bounds could not be measured. Page-reported outer dimensions can be emulated and do not prove physical visibility.`,
    );
  }

  let cdpUnavailable: string | undefined;
  const chromeGeometry =
    args.browserFamily === "chromium"
      ? await makeChromeDesktopGeometryObserver(
          args.desktop,
          args.requestTimeoutMs,
          {
            ...(args.launchIdentity?.cdpPort === undefined
              ? {}
              : { cdpPort: args.launchIdentity.cdpPort }),
            ...(args.launchIdentity?.profileDir === undefined
              ? {}
              : { profileDir: args.launchIdentity.profileDir }),
            targetUrl: args.targetUrl,
          },
          args.browserTargetId,
          (reason) => {
            cdpUnavailable = reason;
          },
          args.pagePreference ?? "pinned",
        )().catch((error: unknown) => {
          cdpUnavailable = toErrorMessage(error);
          return undefined;
        })
      : undefined;
  const browserWindow = physicalWindow ?? chromeGeometry?.browserWindow;
  const viewport = chromeGeometry?.viewport;
  // The fill check reads the X window when it was measured: under mobile emulation (#221) the
  // page's window.outerWidth reports the EMULATED screen (414), which is not a fill failure.
  const fillBounds = physicalWindow;
  if (!browserWindow) {
    warnings.push(`Browser outer bounds could not be measured for lane ${args.laneId}.`);
  } else if (
    unusable === undefined &&
    fillBounds !== undefined &&
    (fillBounds.x !== 0 ||
      fillBounds.y !== 0 ||
      fillBounds.width !== args.requestedScreen[0] ||
      fillBounds.height !== args.requestedScreen[1])
  ) {
    warnings.push(
      `Browser window fill did not reach the requested ${args.requestedScreen[0]}x${args.requestedScreen[1]} screen for lane ${args.laneId}; measured physical bounds are ${fillBounds.width}x${fillBounds.height} at (${fillBounds.x}, ${fillBounds.y}).`,
    );
  }
  if (!viewport) {
    // Name the cause, not only the symptom: the same dead DevTools channel that loses the viewport
    // loses every url/text observation, and a reader of the bundle should learn that here (#514).
    const cause =
      cdpUnavailable === undefined ? "" : ` DevTools probe: ${redactText(cdpUnavailable)}.`;
    warnings.push(
      args.browserFamily === "firefox"
        ? `Browser CSS viewport measurement is unavailable for Firefox on lane ${args.laneId}; stream.viewport is omitted instead of reading a different browser's CDP endpoint.`
        : `Browser CSS viewport could not be measured for lane ${args.laneId}; stream.viewport is omitted instead of copying the requested screen resolution.${cause}`,
    );
  }
  return {
    ...(unusable === undefined ? {} : { unusable }),
    ...(browserWindowId === undefined ? {} : { browserWindowId }),
    ...(chromeGeometry?.targetId === undefined ? {} : { browserTargetId: chromeGeometry.targetId }),
    ...(browserWindow === undefined ? {} : { browserWindow }),
    ...(viewport === undefined ? {} : { viewport }),
    warnings,
  };
}
