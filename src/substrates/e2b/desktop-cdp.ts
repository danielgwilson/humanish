// Chromium DevTools on a hosted E2B desktop, reached from inside the sandbox: browser state reads,
// mobile emulation and request capture.
import type { ChromeNetworkCaptureRequest } from "./cdp-network-capture.js";
import {
  chromeCdpProbeCommand,
  parseChromeCdpProbeOutput,
  type ChromeCdpProbeResult,
  type ChromeMobileEmulationRequest,
  type ChromePageLoad,
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
 * Mobile emulation on later tabs: the holder attaches to every page target Chrome opens
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
 * node).
 *
 * "active": follow the participant to whatever tab they are driving now; never pin the state
 * observer to the launch tab (a verification link that opened in a new tab left a pinned observer
 * reading the old tab forever).
 *
 * `onUnavailable` fires once, on the first probe that could not read the page, with the reason.
 * The observer still degrades to `{}` for the loop; the callback is how a participant says out loud that
 * url/text criteria are not being measured, instead of letting the funnel report 0/N.
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
    /**
     * Called with undefined when a probe starts, then with the sandbox clock the probe printed
     * (ChromeCdpProbeResult.now), so the caller holds the time of the latest read and never a
     * stale one from a probe that failed.
     */
    onClock?: (now: number | undefined) => void;
  } = {},
): () => Promise<{ url?: string; title?: string; text?: string; scrollY?: number }> {
  const { targetId, onUnavailable, drift, onClock } = options;
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
    onClock?.(undefined);
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
    onClock?.(parsed.now);
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

/**
 * Apply mobile emulation to the participant's launch page and read back what the page reports.
 * Fails closed: a request that cannot be applied throws, because a desktop run labelled mobile is
 * the over-trust this feature exists to prevent. A read-back that cannot be taken is a warning
 * (the emulation was applied; only the proof is missing). With `network`, the same holder also
 * captures requests, and a capture that could not start is reported in `network` without failing
 * the emulation.
 */
export async function applyMobileEmulation(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  request: ChromeMobileEmulationRequest,
  options: {
    targetId?: string | undefined;
    network?: ChromeNetworkCaptureRequest | undefined;
  } = {},
): Promise<{
  fidelity: NonNullable<RunDesktopGeometry["fidelity"]>;
  warnings: string[];
  targetId?: string;
  holderName: string;
  /** The holder's capture status, when `network` was passed and the holder said. */
  network?: ChromeCdpProbeResult["network"];
}> {
  const { targetId, network } = options;
  const command = (mode: "hold" | "fidelity") =>
    chromeCdpProbeCommand({
      ...endpoint,
      ...(targetId === undefined ? {} : { targetId }),
      prefer: "pinned",
      mode,
      emulation: request,
      ...(mode === "hold" && network !== undefined ? { network } : {}),
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
  // replicas and a native-X conversion-toggle control reproduced reset click counts.
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
  const capture = applied.network === undefined ? {} : { network: applied.network };
  if (fidelityRead.fidelity === undefined) {
    warnings.push(
      `Mobile emulation was applied but the page's own report could not be read (${fidelityRead.unavailable ?? "no fidelity read"}); desktopGeometry.fidelity carries the request without a resolved block.`,
    );
    return {
      fidelity: { tier: "mobile-emulated", requested, applied: applied.applied ?? [] },
      warnings,
      holderName,
      ...(emulatedTargetId === undefined ? {} : { targetId: emulatedTargetId }),
      ...capture,
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
    ...capture,
  };
}

/**
 * Wait until the participant's launch page has loaded and painted, read over DevTools in the
 * sandbox, for at most `deadlineMs`. Resolves with what the wait saw, or undefined when it could
 * not run (no python3, a failed command, output that is not the probe's), so the caller can fall
 * back to a fixed wait.
 */
export async function waitForChromePageLoad(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  deadlineMs: number,
): Promise<ChromePageLoad | undefined> {
  const result = await e2bShell(desktop)
    .run(chromeCdpProbeCommand({ ...endpoint, prefer: "pinned", mode: "load", deadlineMs }), {
      requestTimeoutMs,
      // One poll can take 3.5 s past the deadline: a 2 s listing and a 1.5 s evaluate.
      timeoutMs: deadlineMs + 10_000,
    })
    .catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return undefined;
  return parseChromeCdpProbeOutput(result.stdout).load;
}

/** The holder stops writing its events file at 32 MiB, so a read stops there too. */
const NETWORK_EVENTS_MAX_BYTES = 32 * 1024 * 1024;
/**
 * How many times the capture holder's log is read for its announce, and how far apart. The reads
 * start after the page wait, which can end within a second of the holder's start, so they cover
 * the 11 s a holder had when a fixed 8 s settle came before 3 s of reads.
 */
const NETWORK_ANNOUNCE_READS = 22;
const NETWORK_ANNOUNCE_EVERY_MS = 500;

/**
 * Start a holder that records the launch page's requests, and every later tab's, to
 * `network.eventsPath`, for a participant without mobile emulation; applyMobileEmulation passes
 * the request to the holder it starts. Sends no Emulation command and no reload. Returns the
 * holder's process name, which readNetworkCaptureStart reads.
 */
export async function startNetworkCapture(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  network: ChromeNetworkCaptureRequest,
): Promise<string> {
  const holderName = `network-capture-${Date.now().toString(36)}`;
  await startDetachedProcess(e2bShell(desktop), {
    name: holderName,
    command: chromeCdpProbeCommand({ ...endpoint, prefer: "pinned", mode: "hold", network }),
    requestTimeoutMs,
  });
  return holderName;
}

/**
 * What the capture holder announced: when capture started on the launch page, on the sandbox
 * clock, or why it did not. Reads the holder's log up to 22 times, half a second apart by
 * `desktop.wait`, and reports a holder that printed nothing as unavailable.
 */
export async function readNetworkCaptureStart(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  holderName: string,
): Promise<NonNullable<ChromeCdpProbeResult["network"]>> {
  const shell = e2bShell(desktop);
  for (let attempt = 0; attempt < NETWORK_ANNOUNCE_READS; attempt += 1) {
    if (attempt > 0) await desktop.wait(NETWORK_ANNOUNCE_EVERY_MS).catch(() => undefined);
    const log = await readDetachedLog(shell, holderName, requestTimeoutMs).catch(() => "");
    const line = log.split("\n").find((candidate) => candidate.trim().startsWith("{"));
    if (line === undefined) continue;
    const announced = parseChromeCdpProbeOutput(line);
    return (
      announced.network ?? {
        unavailable: announced.unavailable ?? "the holder announced without starting capture",
      }
    );
  }
  return {
    unavailable: `the in-sandbox holder printed nothing within ${(NETWORK_ANNOUNCE_READS * NETWORK_ANNOUNCE_EVERY_MS) / 1000} s of the page wait`,
  };
}

/**
 * The capture holder's events file as text: whole lines only, from at most the first 32 MiB.
 * Throws when the sandbox cannot stream files or the file cannot be read.
 */
export async function readNetworkEvents(
  desktop: E2BDesktopSandbox,
  eventsPath: string,
  requestTimeoutMs: number,
): Promise<string> {
  if (desktop.files.read === undefined)
    throw new Error("this E2B SDK cannot stream a sandbox file to the host");
  const stream = await desktop.files.read(eventsPath, {
    format: "stream",
    requestTimeoutMs,
    streamIdleTimeoutMs: requestTimeoutMs,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < NETWORK_EVENTS_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.subarray(0, NETWORK_EVENTS_MAX_BYTES - total));
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks);
  // A line still being written, or one the cap cut, is dropped.
  return bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1).toString("utf8");
}
