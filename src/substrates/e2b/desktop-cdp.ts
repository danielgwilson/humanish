// Chromium DevTools on a hosted E2B desktop, reached from inside the sandbox: browser state reads
// and mobile emulation.
import {
  chromeCdpProbeCommand,
  parseChromeCdpProbeOutput,
  type ChromeMobileEmulationRequest,
} from "./cdp-probe.js";
import { failureTail, toErrorMessage } from "../../evidence/redaction.js";
import type { RunDesktopGeometry } from "../../run/streams.js";
import { readDetachedLog, startDetachedProcess } from "../detached.js";
import type { ShellResult } from "../shell.js";
import type { E2BDesktopSandbox } from "./sdk.js";
import { e2bShell } from "./shell.js";

/**
 * Runtime-only CDP endpoint attribution for the exact chromium this participant launched. Port
 * resolution at observe time: the cached launch-time `cdpPort` wins; absent that, the observer
 * probe re-reads `profileDir`'s DevToolsActivePort marker (a slow cold start can publish it
 * after the launch-time poll gave up); absent both it uses 9222, the port every participant launches
 * Chrome with, where a dead endpoint degrades into a warning that names the cause.
 */
export interface ChromeCdpEndpoint {
  cdpPort?: number;
  /** The launched profile dir; lets observers re-read DevToolsActivePort at observe time. */
  profileDir?: string;
  /** The URL this participant opened; attributes the CDP page when no target id is pinned yet. */
  targetUrl: string;
}

/**
 * Mobile emulation on later tabs (#623): the holder attaches to every page target Chrome opens
 * after the launch page, so a tab the participant opens later should lay out at the phone width
 * too. The first observation on each new target reads that page's own report; a target that
 * reports the requested width is recorded through `onCovered`, and one that does not (or cannot be
 * read) fires `onDrift` once, so a phone-labelled participant that spent part of its session at desktop
 * layout says so with the number the page gave.
 */
export interface ChromeEmulationDrift {
  emulatedTargetId: string;
  expectedWidth: number;
  expectTouch?: boolean;
  onDrift: (reason: string) => void;
  onCovered?: (
    targetId: string,
    read: { innerWidth: number; devicePixelRatio: number; maxTouchPoints: number },
  ) => void;
}

/**
 * The URL / title / page-text / scroll observer behind stopWhen and task criteria. One probe per
 * observation, run on the sandbox's python3 (see src/substrates/e2b/cdp-probe.ts for why not
 * node: #514).
 *
 * "active": follow the participant to whatever tab they are driving now — never pin the state
 * observer to the launch tab (a verification link that opened in a new tab left a pinned observer
 * reading the old tab forever).
 *
 * `onUnavailable` fires once, on the first probe that could not read the page, with the reason.
 * The observer still degrades to `{}` for the loop; the callback is how a participant says out loud that
 * url/text criteria are not being measured, instead of letting the funnel report 0/N (#514).
 */
export function makeChromeBrowserStateObserver(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  options: {
    /** The page target to prefer before the participant switches tabs. */
    targetId?: string | undefined;
    /** Called once, with the reason, on the first probe that could not read the page. */
    onUnavailable?: (reason: string) => void;
    drift?: ChromeEmulationDrift | undefined;
  } = {},
): () => Promise<{ url?: string; title?: string; text?: string; scrollY?: number }> {
  const { targetId, onUnavailable, drift } = options;
  let reported = false;
  let drifted = false;
  const checkedTargets = new Set<string>(drift === undefined ? [] : [drift.emulatedTargetId]);
  const unavailable = (reason: string): Record<string, never> => {
    if (!reported) {
      reported = true;
      onUnavailable?.(reason);
    }
    return {};
  };
  const shell = e2bShell(desktop);
  const checkLaterTarget = async (newTargetId: string): Promise<void> => {
    if (drift === undefined || checkedTargets.has(newTargetId)) return;
    checkedTargets.add(newTargetId);
    // A read that fails or cannot be taken leaves the target's width unknown, which is drift.
    const read = await shell
      .run(
        chromeCdpProbeCommand({
          ...endpoint,
          targetId: newTargetId,
          prefer: "pinned",
          mode: "fidelity",
        }),
        { requestTimeoutMs, timeoutMs: 5_000 },
      )
      .catch(() => undefined);
    const fidelity =
      read === undefined || read.exitCode !== 0
        ? undefined
        : parseChromeCdpProbeOutput(read.stdout).fidelity;
    if (fidelity !== undefined && fidelity.innerWidth === drift.expectedWidth) {
      drift.onCovered?.(newTargetId, {
        innerWidth: fidelity.innerWidth,
        devicePixelRatio: fidelity.devicePixelRatio,
        maxTouchPoints: fidelity.maxTouchPoints,
      });
      if (drift.expectTouch === true && fidelity.maxTouchPoints === 0 && !drifted) {
        // The viewport followed; touch did not (yet): the holder reloads a later tab once after its
        // first navigation commits, and this observation may have landed before that reload.
        drifted = true;
        drift.onDrift(
          `a later page target reports the ${fidelity.innerWidth} px viewport but navigator.maxTouchPoints 0 on its first observation; touch reaches a document only when it loads under the override`,
        );
      }
      return;
    }
    if (drifted) return;
    drifted = true;
    drift.onDrift(
      fidelity === undefined
        ? "the participant drove a page target other than the emulated launch tab and that page's own read-back could not be taken; whether it laid out at the phone width is not known"
        : `the participant drove a page target other than the emulated launch tab and that page reports a ${fidelity.innerWidth} px viewport where ${drift.expectedWidth} px was requested (DPR ${fidelity.devicePixelRatio}); the mobile user agent and touch events are browser-wide, the viewport override was not re-applied to it`,
    );
  };
  return async () => {
    let result: ShellResult;
    try {
      result = await shell.run(
        chromeCdpProbeCommand({
          ...endpoint,
          ...(targetId === undefined ? {} : { targetId }),
          prefer: "active",
          mode: "state",
        }),
        { requestTimeoutMs, timeoutMs: 5_000 },
      );
    } catch (error) {
      // The executor discards a rejected probe, so a timeout is reported here or nowhere.
      return unavailable(`probe failed: ${failureTail(toErrorMessage(error))}`);
    }
    if (result.exitCode !== 0) {
      return unavailable(
        `probe exited ${result.exitCode}: ${failureTail(result.stderr || result.stdout)}`,
      );
    }
    const parsed = parseChromeCdpProbeOutput(result.stdout);
    if (parsed.unavailable !== undefined) return unavailable(parsed.unavailable);
    if (parsed.targetId !== undefined) await checkLaterTarget(parsed.targetId);
    return {
      ...(parsed.url === undefined ? {} : { url: parsed.url }),
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.text === undefined ? {} : { text: parsed.text }),
      ...(parsed.scrollY === undefined ? {} : { scrollY: parsed.scrollY }),
    };
  };
}

/** The user agent a mobile-emulated participant presents unless the lab sets its own. */
export const DEFAULT_MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * Apply mobile emulation (#221) to the participant's launch page and read back what the page reports.
 * Fails closed: a request that cannot be applied throws, because a desktop run labelled mobile is
 * the over-trust this feature exists to prevent. A read-back that cannot be taken is a warning
 * (the emulation was applied; only the proof is missing).
 */
export async function applyMobileEmulation(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  request: ChromeMobileEmulationRequest,
  options: { targetId?: string | undefined } = {},
): Promise<{
  fidelity: NonNullable<RunDesktopGeometry["fidelity"]>;
  warnings: string[];
  targetId?: string;
  holderName: string;
}> {
  const { targetId } = options;
  const command = (mode: "hold" | "fidelity") =>
    chromeCdpProbeCommand({
      ...endpoint,
      ...(targetId === undefined ? {} : { targetId }),
      prefer: "pinned",
      mode,
      emulation: request,
    });
  const shell = e2bShell(desktop);
  const read = async () => {
    const result = await shell.run(command("fidelity"), {
      requestTimeoutMs,
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) {
      return {
        unavailable: `probe exited ${result.exitCode}: ${failureTail(result.stderr || result.stdout)}`,
      };
    }
    return parseChromeCdpProbeOutput(result.stdout);
  };
  // The UA / touch / DPR overrides are bound to the DevTools session that set them and lapse the
  // moment its socket closes (measured: only the viewport width survived a one-shot apply). So the
  // applier stays attached for the participant's whole life as a detached process; the sandbox teardown
  // ends it. Its first stdout line says what was applied.
  const holderName = `mobile-emulation-${Date.now().toString(36)}`;
  await startDetachedProcess(shell, {
    name: holderName,
    command: command("hold"),
    requestTimeoutMs,
  });
  let announced: ReturnType<typeof parseChromeCdpProbeOutput> | undefined;
  for (let attempt = 0; attempt < 30 && announced === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const log = await readDetachedLog(shell, holderName, requestTimeoutMs).catch(() => "");
    const line = log.split("\n").find((candidate) => candidate.trim().startsWith("{"));
    if (line !== undefined) announced = parseChromeCdpProbeOutput(line);
  }
  if (announced === undefined) {
    throw new Error(
      "mobile emulation could not be applied: the in-sandbox applier printed nothing within 15 s",
    );
  }
  if (announced.unavailable !== undefined) {
    throw new Error(
      `mobile emulation could not be applied (${announced.unavailable}); applied before failing: ${(announced.applied ?? []).join(", ") || "nothing"}`,
    );
  }
  const applied = announced;
  // Viewport/touch read-back proves context settings, not gesture equivalence. Two hosted
  // replicas and a native-X conversion-toggle control reproduced reset click counts (#676).
  const warnings: string[] = request.touch
    ? [
        "Mobile emulation uses desktop pointer-to-touch conversion, which can differ for repeated taps. Confirm gesture failures with direct or native touch input before attributing them to the app.",
      ]
    : [];
  // The reload inside the applier takes a moment; the read-back is retried until the page reports
  // the requested viewport and user agent, so a slow page does not read as "no proof".
  let readBack = await read();
  for (
    let attempt = 0;
    attempt < 20 &&
    (readBack.fidelity === undefined ||
      readBack.fidelity.innerWidth !== request.width ||
      !readBack.fidelity.userAgent.includes(request.userAgent.slice(0, 24)));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    readBack = await read();
  }
  const fidelityRead = readBack;
  const requested = {
    width: request.width,
    height: request.height,
    deviceScaleFactor: request.deviceScaleFactor,
    touch: request.touch,
    userAgent: request.userAgent,
  };
  const emulatedTargetId = applied.targetId ?? fidelityRead.targetId;
  if (fidelityRead.fidelity === undefined) {
    warnings.push(
      `Mobile emulation was applied but the page's own report could not be read (${fidelityRead.unavailable ?? "no fidelity read"}); desktopGeometry.fidelity carries the request without a resolved block.`,
    );
    return {
      fidelity: { tier: "mobile-emulated", requested, applied: applied.applied ?? [] },
      warnings,
      holderName,
      ...(emulatedTargetId === undefined ? {} : { targetId: emulatedTargetId }),
    };
  }
  const resolved = { ...fidelityRead.fidelity, source: "cdp" as const };
  if (resolved.innerWidth !== request.width) {
    warnings.push(
      `Mobile emulation requested a ${request.width} px viewport; the page reports ${resolved.innerWidth} px.`,
    );
  }
  if (resolved.devicePixelRatio !== request.deviceScaleFactor) {
    warnings.push(
      `Mobile emulation requested devicePixelRatio ${request.deviceScaleFactor}; the page reports ${resolved.devicePixelRatio}.`,
    );
  }
  if (request.touch && resolved.maxTouchPoints === 0) {
    warnings.push("Mobile emulation requested touch; the page reports navigator.maxTouchPoints 0.");
  }
  if (
    !resolved.userAgent.includes("Mobile") &&
    !resolved.userAgent.includes("Android") &&
    !resolved.userAgent.includes("iPhone")
  ) {
    warnings.push(
      "Mobile emulation requested a mobile user agent; the page reports a desktop one.",
    );
  }
  return {
    fidelity: { tier: "mobile-emulated", requested, applied: applied.applied ?? [], resolved },
    warnings,
    holderName,
    ...(emulatedTargetId === undefined ? {} : { targetId: emulatedTargetId }),
  };
}
