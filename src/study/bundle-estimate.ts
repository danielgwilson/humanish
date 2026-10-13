// How large a computer-use run's bundle grows, estimated from its plan before anything runs, and
// whether it would pass a limit a later command holds it to: analysis reads run.json and each
// participant's trace up to EVIDENCE_LIMITS.sourceBytes each, and the public-safety scan visits at
// most runEntryLimit(participants) files and folders.
//
// verify reads no file larger than RUN_ARTIFACT_MAX_BYTES (32 MiB), and the estimate does not check
// it. run.json and the traces pass analysis's 16 MiB first. observer-data.json carries the same
// per-request lists as run.json and was within 7 % of its size on every live run measured.
// observer/index.html is the app, a compact copy of observer-data.json (0.7 of its size) and the
// items gzipped: 0.087 to 0.114 of the traces' bytes on the live runs of two participants, 0.095 on
// 0.124.0's synthetic 8-hour run. At 0.114 the page is about 29 MiB when run.json reaches 16 MiB;
// it would pass 32 MiB first only above 0.13.

import { EVIDENCE_LIMITS } from "../analysis/analysis-limits.js";
import type { DwellWindow } from "../actors/stop-conditions.js";
import { formatDuration } from "../run/projection.js";
import { plural } from "../run/text.js";
import { runEntryLimit } from "../verify/scan-limit.js";

// Measured on 2026-10-13 on run bundle v3. Live: the 7 finished hosted computer-use runs kept from
// the 0.125.0 smoke test and the 2026-10-12 live checks, 10 participants with 1 to 28 turns and 137
// model requests. Dry: runs of 1, 2, 24 and 100 participants, for the Observer app and the run's
// own files. Pace, session length and screenshots: the live computer-use runs kept on the
// maintainer's machine. A trace's rate a turn, cross-checked on the public
// site/public/runs/lobby-0927 run (8 participants, 20 to 78 turns), was 1,579 bytes plus 91 for the
// page, so the estimate runs about a quarter high there.
const RATES = Object.freeze({
  /** run.json bytes for the run itself: its header, study, review and cost. Live fit: 4,381. */
  runBytes: 4_400,
  /**
   * run.json bytes for each participant before its turns: its stream, actor summary and closing
   * report request. Live fit: 16,239, plus one request.
   */
  participantBytes: 16_500,
  /**
   * run.json bytes a model turn adds: the request's entries in `tokenUsage.turns` and
   * `conversation.requests`. Live: 30,623 bytes over 137 requests, 223.5 each.
   */
  turnRunBytes: 225,
  /** A trace file's bytes before its turns: the actor summary. Live fit: 5,378. */
  participantTraceBytes: 5_400,
  /**
   * Trace bytes a model turn adds: its items, its screenshot entry and its request's usage. Live
   * fit: 1,965 a turn, plus 91 for the `page` each screenshot item now carries.
   */
  turnTraceBytes: 2_100,
  /**
   * Trace bytes a dwell frame adds: 395 for its item and entry on the kept runs with dwell frames,
   * plus 91 for the page.
   */
  frameTraceBytes: 500,
  /**
   * Seconds between model turns: the median of the 27 of 185 kept live participants that worked 5
   * minutes or more was 10.4.
   */
  secondsPerTurn: 10,
  /**
   * How long a participant with no declared end is counted, at most its session budget. It ends
   * when it finishes its mission: 90 % of 974 kept sessions ended within 184 s on 2026-10-12; of
   * the 197 kept on 2026-10-13, 64 % ended within 180 s and 90 % within 325 s. Counting 325 s would
   * add under 0.4 MiB to the run.json of 100 participants.
   */
  openSessionMs: 3 * 60_000,
  /** observer/index.html's app before any run data: 1,199,831 bytes on the dry runs. */
  observerAppBytes: 1_200_000,
  /** A desktop screenshot: the median of 3,990 kept live PNG frames was 107,895 bytes. */
  screenshotBytes: 110_000,
  /**
   * Run files and folders besides the participants': 10 on a dry run, and live the sandbox
   * receipts, `actors/` and an analysis's 9.
   */
  runEntries: 20,
  /** A participant's entries besides its turn screenshots: its trace file, its screenshot folder, its first frame. */
  participantEntries: 3,
});

const MIB = 1024 * 1024;

/** One participant as the plan has it: when it starts and ends, its cap, and its dwell window. */
export interface EstimatedParticipant {
  readonly startAfterMs?: number;
  readonly endAfterMs?: number;
  readonly maxSessionMs?: number;
  readonly limits: { readonly dwell?: DwellWindow };
}

/** A run's estimated bundle, and the scan's limit for its participants. */
export interface BundleEstimate {
  /** run.json, which analysis reads whole. */
  readonly runFileBytes: number;
  /** The largest participant trace file, which analysis also reads whole. */
  readonly largestTraceBytes: number;
  /** Every file, screenshots included. */
  readonly totalBytes: number;
  /** Files and folders in the run folder, as the public-safety scan counts them. */
  readonly entries: number;
  /** The most entries the scan reads in a run of these participants (runEntryLimit). */
  readonly entryLimit: number;
  /** What the estimate assumed, for its messages. */
  readonly basis: {
    readonly participants: number;
    /** Participants with a declared end, counted for their whole window, and the longest window. */
    readonly scheduled: number;
    readonly longestWindowMs: number;
    /** Participants without one, and how long each is counted at most. */
    readonly open: number;
    readonly openMs: number;
    readonly dwell: boolean;
  };
}

/**
 * The bundle a live run of `participants` leaves, each in its session of `sessionMs` unless it
 * declares an end or a cap. A participant with an end works its whole window; one without ends
 * itself, so it is counted for the measured open session above, or its budget (its cap, else
 * `sessionMs`) when that is shorter. Each takes a model turn at the measured pace, and a dwell
 * window adds a frame every `everyMs` for its length, cut to the session, and the frame after it.
 */
export function estimateBundle(
  participants: readonly EstimatedParticipant[],
  sessionMs: number,
): BundleEstimate {
  let turns = 0;
  let frames = 0;
  let traces = 0;
  let largestTrace = 0;
  let longestWindowMs = 0;
  // The longest any participant without an end is counted, for the messages.
  let openMs = Math.min(sessionMs, RATES.openSessionMs);
  for (const participant of participants) {
    const windowMs =
      participant.endAfterMs === undefined
        ? undefined
        : participant.endAfterMs - (participant.startAfterMs ?? 0);
    const budgetMs = windowMs ?? participant.maxSessionMs ?? sessionMs;
    const countedMs = windowMs ?? Math.min(budgetMs, RATES.openSessionMs);
    if (windowMs !== undefined) longestWindowMs = Math.max(longestWindowMs, windowMs);
    else openMs = Math.max(openMs, countedMs);
    const own = Math.ceil(countedMs / (RATES.secondsPerTurn * 1000));
    const dwell = participant.limits.dwell;
    const ownFrames =
      dwell === undefined ? 0 : Math.floor(Math.min(dwell.ms, budgetMs) / dwell.everyMs) + 1;
    const trace =
      RATES.participantTraceBytes + own * RATES.turnTraceBytes + ownFrames * RATES.frameTraceBytes;
    turns += own;
    frames += ownFrames;
    traces += trace;
    largestTrace = Math.max(largestTrace, trace);
  }
  const count = participants.length;
  const runFileBytes = RATES.runBytes + count * RATES.participantBytes + turns * RATES.turnRunBytes;
  const screenshots = count + turns + frames;
  const scheduled = participants.filter((participant) => participant.endAfterMs !== undefined);
  return {
    runFileBytes,
    largestTraceBytes: largestTrace,
    // observer-data.json is about run.json's size; the page's copies of both add under 1 %.
    totalBytes:
      RATES.observerAppBytes + screenshots * RATES.screenshotBytes + traces + 2 * runFileBytes,
    entries: RATES.runEntries + count * RATES.participantEntries + turns + frames,
    entryLimit: runEntryLimit(count),
    basis: {
      participants: count,
      scheduled: scheduled.length,
      longestWindowMs,
      open: count - scheduled.length,
      openMs,
      dwell: frames > 0,
    },
  };
}

/**
 * The warning for a run whose estimate passes a limit, or undefined: each limit it passes, what the
 * estimate counted, and what to change.
 */
export function bundleLimitReason(estimate: BundleEstimate): string | undefined {
  const runFile = estimate.runFileBytes > EVIDENCE_LIMITS.sourceBytes;
  const entries = estimate.entries > estimate.entryLimit;
  const passed = [
    ...(runFile
      ? [
          `This study's run.json may grow to about ${mib(estimate.runFileBytes)}, past the ${mib(EVIDENCE_LIMITS.sourceBytes)} analysis reads.`,
        ]
      : []),
    ...(estimate.largestTraceBytes > EVIDENCE_LIMITS.sourceBytes
      ? [
          `One participant's trace may grow to about ${mib(estimate.largestTraceBytes)}, past the ${mib(EVIDENCE_LIMITS.sourceBytes)} analysis reads of each trace.`,
        ]
      : []),
    ...(entries
      ? [
          `The run may hold about ${count(estimate.entries)} files and folders, past the ${count(estimate.entryLimit)} the public-safety scan reads in a run of ${plural(estimate.basis.participants, "participant")}.`,
        ]
      : []),
  ];
  if (passed.length === 0) return undefined;
  const { scheduled, longestWindowMs, open, openMs, dwell } = estimate.basis;
  const counted = [
    ...(scheduled > 0
      ? [
          `${plural(scheduled, "participant")} working ${scheduled === 1 ? "a declared window" : "declared windows"} of up to ${formatDuration(longestWindowMs)}`,
        ]
      : []),
    ...(open > 0
      ? [
          `${scheduled > 0 ? open : plural(open, "participant")} for up to ${formatDuration(openMs)} each`,
        ]
      : []),
  ];
  const changes = [
    ...(scheduled > 0 ? ["shorten the longest windows (participants[].endAfterMs)"] : []),
    ...(dwell ? ["shorten the dwell window (dwell.ms) or capture less often (dwell.everyMs)"] : []),
  ];
  // A trace is one participant's, so splitting the study helps only run.json and the file count.
  if (runFile || entries || changes.length === 0)
    changes.push("split the participants across studies");
  const advice =
    changes.length < 2
      ? changes.join("")
      : `${changes.slice(0, -1).join(", ")}, or ${changes.at(-1)}`;
  return [
    ...passed,
    `The estimate counts ${counted.join(" and ")}, at a model turn every ${formatDuration(RATES.secondsPerTurn * 1000)} that adds about ${RATES.turnRunBytes} bytes to run.json and ${(RATES.turnTraceBytes / 1000).toFixed(1)} KB to the participant's trace.`,
    "The run goes ahead.",
    `To stay under ${passed.length === 1 ? "the limit" : "the limits"}, ${advice}.`,
  ].join(" ");
}

/** The estimate beside the limits, for `study check`. */
export function describeBundle(estimate: BundleEstimate): string {
  return `run.json about ${mib(estimate.runFileBytes)} of the ${mib(EVIDENCE_LIMITS.sourceBytes)} analysis reads; largest trace about ${mib(estimate.largestTraceBytes)} of the ${mib(EVIDENCE_LIMITS.sourceBytes)} analysis reads of each; about ${count(estimate.entries)} files and folders of the ${count(estimate.entryLimit)} the public-safety scan reads; about ${mib(estimate.totalBytes, 0)} in all. Participants with a declared end are counted for their whole window and the others for up to ${formatDuration(estimate.basis.openMs)}, at a model turn every ${formatDuration(RATES.secondsPerTurn * 1000)}.`;
}

/** Bytes in MiB to `digits` places, or two under 0.1 MiB, so a short study's trace does not read 0.0. */
function mib(bytes: number, digits = 1): string {
  const value = bytes / MIB;
  if (Number.isInteger(value)) return `${value} MiB`;
  return `${value.toFixed(value < 0.1 ? 2 : digits)} MiB`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}
