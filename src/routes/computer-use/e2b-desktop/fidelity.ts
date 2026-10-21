// Device fidelity for one E2B desktop participant: mobile emulation beyond viewport size, the
// browser-state observer that watches it for drift, and the final browser geometry.

import { redactText, toErrorMessage } from "../../../evidence/redaction.js";
import type { ResidualConfig } from "../../../study/plan-types.js";
import type { RunDesktopGeometry } from "../../../run/streams.js";
import { readDetachedLog } from "../../../substrates/detached.js";
import type {
  DesktopBrowserFamily,
  DesktopBrowserLaunchIdentity,
} from "../../../substrates/e2b/desktop-browser.js";
import {
  applyMobileEmulation,
  makeChromeBrowserStateObserver,
  type ChromeCdpEndpoint,
} from "../../../substrates/e2b/desktop-cdp.js";
import {
  mobileEmulationLaunchFlags,
  participantMobileEmulation,
} from "../../../study/mobile-emulation.js";
import type { ChromeNetworkCaptureRequest } from "../../../substrates/e2b/cdp-network-capture.js";
import type { ChromeCdpProbeResult } from "../../../substrates/e2b/cdp-probe.js";
import { captureDesktopBrowserGeometry } from "../../../substrates/e2b/desktop-geometry.js";
import type { E2BDesktopSandbox } from "../../../substrates/e2b/sdk.js";
import { e2bShell } from "../../../substrates/e2b/shell.js";
import type { E2BDesktopDeps, DesktopParticipantRun } from "../types.js";

type BrowserGeometry = Awaited<ReturnType<typeof captureDesktopBrowserGeometry>>;

/** The mobile emulation a participant applied, updated as later tabs are covered and at teardown. */
export interface ParticipantFidelity {
  applied: RunDesktopGeometry["fidelity"] | undefined;
  emulatedTargetId: string | undefined;
  holderName: string | undefined;
}

/** The participant's emulation request; see participantMobileEmulation for who gets one. */
function emulationFor(
  residual: Readonly<ResidualConfig>,
  spec: DesktopParticipantRun,
): ReturnType<typeof participantMobileEmulation> {
  return participantMobileEmulation(
    residual.execution?.desktop?.fidelity,
    spec.planned.device.preset,
  );
}

/** Only participants on a mobile preset are emulated; the flags go on the browser command line. */
export function mobileLaunchFlags(
  residual: Readonly<ResidualConfig>,
  spec: DesktopParticipantRun,
): string[] {
  return mobileEmulationLaunchFlags(emulationFor(residual, spec));
}

/** The launched browser's DevTools address, as far as the launch recorded it. */
export function cdpEndpoint(
  identity: DesktopBrowserLaunchIdentity | undefined,
  targetUrl: string,
): ChromeCdpEndpoint {
  return {
    ...(identity?.cdpPort === undefined ? {} : { cdpPort: identity.cdpPort }),
    ...(identity?.profileDir === undefined ? {} : { profileDir: identity.profileDir }),
    targetUrl,
  };
}

/**
 * Apply mobile fidelity to the launch page before the geometry capture and the participant's first
 * observation. A request that cannot be applied fails the participant closed with the reason. Only
 * participants on a mobile preset are emulated: a run-wide flag must not hand a desktop or tablet
 * participant an iPhone user agent (the first live proof did exactly that to the desktop newcomer
 * beside the phone participant). Those participants carry no fidelity block, since nothing was
 * emulated.
 */
export async function applyParticipantMobileFidelity(args: {
  desktop: E2BDesktopSandbox;
  spec: DesktopParticipantRun;
  deps: E2BDesktopDeps;
  targetUrl: string;
  browserFamily: DesktopBrowserFamily;
  launchIdentity: DesktopBrowserLaunchIdentity | undefined;
  targetId: string | undefined;
  warnings: string[];
  /** Request capture for the holder to start beside emulation, and where its status goes. */
  network?: {
    request: ChromeNetworkCaptureRequest;
    onStart: (status: ChromeCdpProbeResult["network"]) => void;
  };
}): Promise<ParticipantFidelity> {
  const { spec, deps } = args;
  const request = emulationFor(deps.residual, spec);
  const none: ParticipantFidelity = {
    applied: undefined,
    emulatedTargetId: undefined,
    holderName: undefined,
  };
  if (request === undefined) return none;
  if (args.browserFamily !== "chromium") {
    throw new Error(
      `execution.desktop.fidelity.mobileEmulation needs Chrome or Chromium for participant ${spec.planned.id}; the launched browser family is ${args.browserFamily}. Set execution.desktop.browser: chrome.`,
    );
  }
  const applied = await applyMobileEmulation(
    args.desktop,
    deps.requestTimeoutMs,
    cdpEndpoint(args.launchIdentity, args.targetUrl),
    request,
    {
      targetId: args.targetId,
      ...(args.network === undefined ? {} : { network: args.network.request }),
    },
  );
  args.warnings.push(...applied.warnings);
  args.network?.onStart(applied.network);
  return {
    applied: applied.fidelity,
    emulatedTargetId: applied.targetId,
    holderName: applied.holderName,
  };
}

/** The Chrome observer behind URL/text stop conditions and task criteria, watching for emulation drift. */
export function participantBrowserStateObserver(args: {
  desktop: E2BDesktopSandbox;
  spec: DesktopParticipantRun;
  deps: E2BDesktopDeps;
  targetUrl: string;
  launchIdentity: DesktopBrowserLaunchIdentity | undefined;
  targetId: string | undefined;
  fidelity: ParticipantFidelity;
  warnings: string[];
  /** Receives the sandbox clock of each read; see makeChromeBrowserStateObserver's onClock. */
  onClock?: (now: number | undefined) => void;
}): ReturnType<typeof makeChromeBrowserStateObserver> {
  const { spec, deps, fidelity, warnings } = args;
  return makeChromeBrowserStateObserver(
    args.desktop,
    deps.requestTimeoutMs,
    cdpEndpoint(args.launchIdentity, args.targetUrl),
    {
      targetId: args.targetId,
      ...(args.onClock === undefined ? {} : { onClock: args.onClock }),
      // Once per participant: a dark observation channel is a gap in the instrument, and the
      // funnel's "never measured" count needs this line to explain itself.
      onUnavailable: (reason) => {
        warnings.push(
          `Browser-state observer unavailable for participant ${spec.planned.id} (${redactText(deps.scrubKnownValues(reason))}); ` +
            "urlIncludes, urlPathEquals and textIncludes stop conditions and task criteria are not measured in this session.",
        );
      },
      drift:
        fidelity.emulatedTargetId === undefined
          ? undefined
          : {
              emulatedTargetId: fidelity.emulatedTargetId,
              expectedWidth: spec.planned.device.preset.width,
              expectTouch: fidelity.applied?.requested.touch === true,
              onDrift: (reason) => {
                warnings.push(
                  `Mobile emulation drift for participant ${spec.planned.id}: ${reason}.`,
                );
              },
              onCovered: (coveredTargetId, read) => {
                // A later tab the page itself reported at the phone width: evidence that
                // the emulation followed the participant, kept on the bundle.
                if (fidelity.applied === undefined) return;
                fidelity.applied = {
                  ...fidelity.applied,
                  laterTargets: [
                    ...(fidelity.applied.laterTargets ?? []),
                    { targetId: coveredTargetId, ...read },
                  ],
                };
              },
            },
    },
  );
}

/**
 * The participant's final browser geometry, measured while the sandbox is alive. A final capture that
 * measured either field wins whole, so a partial final capture omits fields the launch-time capture
 * had; only a final capture that measured nothing falls back to the launch-time
 * capture. Also reads the emulation holder's log into the fidelity block.
 */
export async function finalParticipantGeometry(args: {
  desktop: E2BDesktopSandbox;
  spec: DesktopParticipantRun;
  deps: E2BDesktopDeps;
  targetUrl: string;
  browserFamily: DesktopBrowserFamily;
  launchIdentity: DesktopBrowserLaunchIdentity | undefined;
  windowId: string | undefined;
  targetId: string | undefined;
  initial: BrowserGeometry | undefined;
  geometry: RunDesktopGeometry;
  fidelity: ParticipantFidelity;
  warnings: string[];
}): Promise<RunDesktopGeometry> {
  const { desktop, spec, deps, fidelity, warnings } = args;
  const finalGeometry: BrowserGeometry = await captureDesktopBrowserGeometry({
    desktop,
    browserFamily: args.browserFamily,
    ...(args.launchIdentity === undefined ? {} : { launchIdentity: args.launchIdentity }),
    ...(args.windowId === undefined ? {} : { browserWindowId: args.windowId }),
    ...(args.targetId === undefined ? {} : { browserTargetId: args.targetId }),
    participantId: spec.planned.id,
    targetUrl: args.targetUrl,
    requestedScreen: spec.planned.device.resolution,
    requestTimeoutMs: deps.requestTimeoutMs,
    pagePreference: "active",
    resize: false,
  }).catch((error: unknown) => ({
    warnings: [
      `Final browser geometry measurement failed for participant ${spec.planned.id}: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`,
    ],
  }));
  const chosenGeometry =
    finalGeometry.browserWindow !== undefined || finalGeometry.viewport !== undefined
      ? finalGeometry
      : (args.initial ?? finalGeometry);
  const geometryWarnings = [
    ...new Set(
      [...(args.initial?.warnings ?? []), ...chosenGeometry.warnings].map((warning) =>
        deps.scrubKnownValues(warning),
      ),
    ),
  ];
  warnings.push(...geometryWarnings);
  // The emulation holder's own log, after its announce line: which later targets it
  // attached to, what it sent, and any reply that came back as an error. Read while
  // the sandbox is alive; the first live proof had no way to say what the holder did.
  if (fidelity.applied !== undefined && fidelity.holderName !== undefined) {
    const holderLog = await readDetachedLog(
      e2bShell(desktop),
      fidelity.holderName,
      deps.requestTimeoutMs,
    ).catch(() => "");
    const lines = holderLog
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .slice(1, 51);
    if (lines.length > 0)
      fidelity.applied = {
        ...fidelity.applied,
        holderLog: lines.map((line) => deps.scrubKnownValues(line)),
      };
  }
  const geometry = args.geometry;
  return {
    screen: geometry.screen,
    ...(chosenGeometry.browserWindow === undefined
      ? {}
      : { browserWindow: chosenGeometry.browserWindow }),
    ...(chosenGeometry.viewport === undefined ? {} : { viewport: chosenGeometry.viewport }),
    ...(fidelity.applied === undefined ? {} : { fidelity: fidelity.applied }),
    ...((geometry.warnings?.length ?? 0) + geometryWarnings.length === 0
      ? {}
      : { warnings: [...(geometry.warnings ?? []), ...geometryWarnings] }),
  };
}
