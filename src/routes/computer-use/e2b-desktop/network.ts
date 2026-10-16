// One E2B desktop participant's browser network log, when its study sets execution.network. The
// in-sandbox DevTools holder (src/substrates/e2b/cdp-probe.ts, mode "hold") appends a line per
// request event of the participant's Chrome to a sandbox file. A participant with mobile emulation
// hands the capture request to the holder it already starts; any other starts a capture-only holder
// once the browser's DevTools answer. Each checkpoint screenshot is paired with the sandbox time of
// the browser-state read before it, and at teardown the file is read and reduced to
// network/<participant id>.ndjson (src/evidence/browser-network.ts). Capture never changes how the
// participant runs: each failure is one warning, and the index says why records are missing.

import {
  networkIndexWithoutEvents,
  reduceBrowserNetwork,
  type BrowserNetworkIndex,
  type TurnMark,
} from "../../../evidence/browser-network.js";
import { redactText, toErrorMessage } from "../../../evidence/redaction.js";
import { traceRedaction } from "../../../evidence/trace-page.js";
import { writeContainedOutputFile } from "../../../run/contained-output.js";
import { readRunSandboxIds } from "../../../run/sandbox-ids.js";
import { networkCaptureOrigins } from "../../../study/study-fields.js";
import type { ChromeNetworkCaptureRequest } from "../../../substrates/e2b/cdp-network-capture.js";
import type { ChromeCdpProbeResult } from "../../../substrates/e2b/cdp-probe.js";
import {
  readNetworkCaptureStart,
  readNetworkEvents,
  startNetworkCapture,
} from "../../../substrates/e2b/desktop-cdp.js";
import type { E2BDesktopSandbox } from "../../../substrates/e2b/sdk.js";
import { e2bShell } from "../../../substrates/e2b/shell.js";
import { detachedProcessExited } from "../../../substrates/detached.js";
import type { E2BDesktopDeps } from "../types.js";
import { cdpEndpoint } from "./fidelity.js";
import type { E2BParticipantContext, E2BParticipantState } from "./state.js";

/** The sandbox file the holder appends to. Each participant has its own sandbox. */
const NETWORK_EVENTS_PATH = "/tmp/humanish-network/events.ndjson";

/** One participant's capture, from the request to the collected log's index. */
export interface ParticipantNetwork {
  readonly request: ChromeNetworkCaptureRequest;
  /** The capture-only holder's process name, when this participant started one. */
  holderName: string | undefined;
  /** Capture answered on the launch page, so the events file is worth reading at teardown. */
  started: boolean;
  /** The sandbox clock of the latest browser-state read, cleared when a read starts. */
  latestRead: number | undefined;
  readonly marks: TurnMark[];
  /** What the stream records: no capture until the file is collected. */
  index: BrowserNetworkIndex;
}

/** The trace redaction a participant's pages go through, which its network log shares. */
function networkRedaction(deps: E2BDesktopDeps): (text: string) => string {
  return traceRedaction(deps.scrubKnownValues, redactText);
}

/**
 * The participant's capture, or undefined when the study did not set execution.network. The
 * holder keeps the participant's target origin and `execution.network.origins`.
 */
export function planParticipantNetwork(
  deps: E2BDesktopDeps,
  targetUrl: string,
): ParticipantNetwork | undefined {
  const extra = networkCaptureOrigins(deps.residual.execution?.network);
  if (extra === undefined) return undefined;
  const target = URL.parse(targetUrl)?.origin;
  const origins = [
    ...new Set([...(target === undefined || target === "null" ? [] : [target]), ...extra]),
  ];
  return {
    request: { eventsPath: NETWORK_EVENTS_PATH, origins },
    holderName: undefined,
    started: false,
    latestRead: undefined,
    marks: [],
    index: networkIndexWithoutEvents({ origins, redact: networkRedaction(deps) }, "no-capture"),
  };
}

function warnNotRecorded(ctx: E2BParticipantContext, reason: string): void {
  ctx.warnings.push(
    `Participant ${ctx.spec.planned.id}'s network log was not recorded: ${redactText(ctx.deps.scrubKnownValues(reason))}. The participant ran without request capture.`,
  );
}

/**
 * Start the capture-only holder for a participant without mobile emulation, right after the
 * browser launched. A browser other than Chrome or Chromium has no DevTools port to record from,
 * which is one warning.
 */
export async function startParticipantNetwork(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const network = state.network;
  if (network === undefined) return;
  if (state.launchedBrowserFamily !== "chromium") {
    warnNotRecorded(
      ctx,
      `the launched browser family is ${state.launchedBrowserFamily}, and requests are recorded only from Chrome or Chromium. Set execution.desktop.browser: chrome`,
    );
    return;
  }
  try {
    network.holderName = await startNetworkCapture(
      desktop,
      ctx.deps.requestTimeoutMs,
      cdpEndpoint(state.browserLaunchIdentity, ctx.targetUrl),
      network.request,
    );
  } catch (error) {
    warnNotRecorded(ctx, `the capture holder could not start (${toErrorMessage(error)})`);
  }
}

/** Read the capture-only holder's announce, after the desktop settled. */
export async function readParticipantNetworkStart(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const network = state.network;
  if (network?.holderName === undefined) return;
  noteNetworkStart(
    ctx,
    network,
    await readNetworkCaptureStart(desktop, ctx.deps.requestTimeoutMs, network.holderName),
  );
}

/**
 * Record what a holder said about capture: started, or one warning with why not. A mobile holder
 * that said nothing about it did not start it.
 */
export function noteNetworkStart(
  ctx: E2BParticipantContext,
  network: ParticipantNetwork,
  status: ChromeCdpProbeResult["network"],
): void {
  if (status !== undefined && "startedAt" in status) {
    network.started = true;
    return;
  }
  warnNotRecorded(ctx, status?.unavailable ?? "the emulation holder did not report capture");
}

/**
 * The callbacks a participant whose capture started runs with, or undefined when capture did not
 * start: the browser-state observer reports each read's sandbox clock, and each checkpoint
 * screenshot is paired with the read before it. A read that failed leaves no mark.
 */
export function networkHooks(network: ParticipantNetwork | undefined):
  | {
      onClock: (now: number | undefined) => void;
      onCheckpoint: (turnNumber: number) => void;
    }
  | undefined {
  if (network?.started !== true) return undefined;
  return {
    onClock: (now) => {
      network.latestRead = now;
    },
    onCheckpoint: (turnNumber) => {
      if (network.latestRead !== undefined)
        network.marks.push({ wallTime: network.latestRead, turn: turnNumber });
    },
  };
}

/**
 * Read the holder's events at teardown, reduce them and write the participant's network log. Runs
 * before any other teardown evidence and never throws: a file that cannot be read or written is
 * one warning, and the index says it was not collected.
 */
export async function collectParticipantNetwork(
  ctx: E2BParticipantContext,
  state: E2BParticipantState,
  desktop: E2BDesktopSandbox,
): Promise<void> {
  const network = state.network;
  if (network === undefined || !network.started) return;
  const { spec, deps } = ctx;
  // Another participant's id the run journaled is swept from every run file at finish, so a log
  // that named one would no longer match its index. An unreadable journal leaves the own id.
  const journaled = await readRunSandboxIds(deps.artifactRoot).catch((): string[] => []);
  const capture = {
    participantId: spec.planned.id,
    origins: network.request.origins,
    marks: network.marks,
    redact: networkRedaction(deps),
    sandboxIds: [desktop.sandboxId, ...journaled],
  };
  const notCollected = (error: unknown): void => {
    ctx.warnings.push(
      `Participant ${spec.planned.id}'s network log could not be collected: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}. Its index records it as not collected.`,
    );
    network.index = networkIndexWithoutEvents(capture, "not-collected");
  };
  // Asked before the read, so an exited holder's file is already whole. A failed check leaves the
  // log as complete as its own lines say.
  const holderName = network.holderName ?? state.fidelity.holderName;
  const holderExited =
    holderName !== undefined &&
    (await detachedProcessExited(e2bShell(desktop), holderName, deps.requestTimeoutMs).catch(
      () => false,
    ));
  let events: string;
  try {
    events = await readNetworkEvents(desktop, NETWORK_EVENTS_PATH, deps.requestTimeoutMs);
  } catch (error) {
    notCollected(error);
    return;
  }
  const log = await reduceBrowserNetwork({ ...capture, events, holderExited });
  try {
    if (log.text !== undefined && log.index.path !== undefined)
      await writeContainedOutputFile(deps.artifactRoot, log.index.path, log.text, "utf8");
  } catch (error) {
    notCollected(error);
    return;
  }
  network.index = log.index;
  ctx.warnings.push(...log.warnings);
}
