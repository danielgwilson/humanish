// How large a computer-use run's bundle grows, estimated from its plan before anything runs, and
// whether it would pass a limit a later command holds it to: analysis reads a run.json of at most
// EVIDENCE_LIMITS.sourceBytes, verify reads no file larger than RUN_ARTIFACT_MAX_BYTES, and the
// public-safety scan visits at most runEntryLimit(participants) files and folders.

import { EVIDENCE_LIMITS } from "../analysis/analysis-limits.js";
import type { DwellWindow } from "../actors/stop-conditions.js";
import { RUN_ARTIFACT_MAX_BYTES } from "../run/contained-output.js";
import { formatDuration } from "../run/projection.js";
import { plural } from "../run/text.js";
import { runEntryLimit } from "../verify/scan-limit.js";

// Measured on 2026-10-12. Live: the hosted computer-use bundles kept on the maintainer's machine,
// 219 runs since 2026-10-01 for run.json's size (a least-squares fit gave 372 bytes a run, 14,368
// a participant and 2,423 a turn), and for the pace the 42 participant sessions of 5 minutes or
// more among every kept run since August. Synthetic: runStudyWith on fake desktops, with the live median
// of about 270 characters of reasoning and message a turn, from 10 to 2,000 turns and from 1 to
// 16 participants. An adopter's 39-minute run grew run.json about 7 KB a minute for a participant
// working the whole window; these rates give 12.6 KB, so the estimate errs high.
const RATES = Object.freeze({
  /** run.json bytes for the run itself: its header, study and scenario. */
  runBytes: 400,
  /** run.json bytes for each participant before its turns: its records, events and cost lines. */
  participantBytes: 14_400,
  /** run.json bytes a model turn adds. Synthetic: 2,094 to 2,125 a turn over 10 to 2,000 turns. */
  turnBytes: 2_100,
  /** run.json bytes a dwell frame adds. Synthetic: 6,247 for 10 frames and the frame after. */
  frameBytes: 570,
  /** Seconds between model turns: the median of the 42 long live sessions was 10.3. */
  secondsPerTurn: 10,
  /**
   * How long a participant with no declared end is counted, at most its session budget. It ends
   * when it finishes its mission: 90 % of 974 live sessions ended within 184 s.
   */
  openSessionMs: 3 * 60_000,
  /** observer-data.json bytes beyond run.json's for each participant: 0.9 to 2.6 KB live. */
  observerDataParticipantBytes: 2_600,
  /** observer/index.html: the page, and a share of run.json it embeds (synthetic, 10 to 2,000 turns). */
  observerPageBytes: 1_190_000,
  observerPageShare: 0.62,
  /** A desktop screenshot: the median of 249 live PNG frames was 108,565 bytes. */
  screenshotBytes: 110_000,
  /** Run files and folders besides the participants': run.json, status, review, events, receipts, the Observer, analysis. */
  runEntries: 20,
  /** A participant's entries besides its turn screenshots: its trace file, its screenshot folder, its first frame. */
  participantEntries: 3,
});

const MIB = 1024 * 1024;

/** One participant as the plan has it: when it starts and ends, and its dwell window. */
export interface EstimatedParticipant {
  readonly startAfterMs?: number;
  readonly endAfterMs?: number;
  readonly limits: { readonly dwell?: DwellWindow };
}

/** A run's estimated bundle, and the scan's limit for its participants. */
export interface BundleEstimate {
  /** run.json, which analysis reads whole. */
  readonly runFileBytes: number;
  /** The largest file: observer/observer-data.json, or the Observer page for a small run. */
  readonly largestFileBytes: number;
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
 * declares an end. A participant with an end works its whole window; one without is counted for
 * the measured open session above, or its budget when that is shorter. Each takes a model turn at
 * the measured pace, and a dwell window adds a frame every `everyMs` for its length, cut to the
 * session, and the frame after it.
 */
export function estimateBundle(
  participants: readonly EstimatedParticipant[],
  sessionMs: number,
): BundleEstimate {
  let turns = 0;
  let frames = 0;
  let longestWindowMs = 0;
  const openMs = Math.min(sessionMs, RATES.openSessionMs);
  for (const participant of participants) {
    const windowMs =
      participant.endAfterMs === undefined
        ? undefined
        : participant.endAfterMs - (participant.startAfterMs ?? 0);
    if (windowMs !== undefined) longestWindowMs = Math.max(longestWindowMs, windowMs);
    turns += Math.ceil((windowMs ?? openMs) / (RATES.secondsPerTurn * 1000));
    const dwell = participant.limits.dwell;
    if (dwell !== undefined)
      frames += Math.floor(Math.min(dwell.ms, windowMs ?? sessionMs) / dwell.everyMs) + 1;
  }
  const count = participants.length;
  const runFileBytes =
    RATES.runBytes +
    count * RATES.participantBytes +
    turns * RATES.turnBytes +
    frames * RATES.frameBytes;
  const observerDataBytes = runFileBytes + count * RATES.observerDataParticipantBytes;
  const pageBytes = RATES.observerPageBytes + Math.round(RATES.observerPageShare * runFileBytes);
  const screenshots = count + turns + frames;
  const scheduled = participants.filter((participant) => participant.endAfterMs !== undefined);
  return {
    runFileBytes,
    largestFileBytes: Math.max(observerDataBytes, pageBytes),
    // Each participant's trace file holds about what its stream holds in run.json.
    totalBytes:
      2 * runFileBytes + observerDataBytes + pageBytes + screenshots * RATES.screenshotBytes,
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
 * Why a run of this estimate would pass a limit, or undefined: each limit it passes, what the
 * estimate counted, and what to change.
 */
export function bundleLimitReason(estimate: BundleEstimate): string | undefined {
  const passed = [
    ...(estimate.runFileBytes > EVIDENCE_LIMITS.sourceBytes
      ? [
          `This study's run.json would grow to about ${mib(estimate.runFileBytes)}, past the ${mib(EVIDENCE_LIMITS.sourceBytes)} analysis reads.`,
        ]
      : []),
    ...(estimate.largestFileBytes > RUN_ARTIFACT_MAX_BYTES
      ? [
          `Its largest file, observer/observer-data.json, would grow to about ${mib(estimate.largestFileBytes)}, past the ${mib(RUN_ARTIFACT_MAX_BYTES)} verify reads in one file.`,
        ]
      : []),
    ...(estimate.entries > estimate.entryLimit
      ? [
          `It would hold about ${count(estimate.entries)} files and folders, past the ${count(estimate.entryLimit)} the public-safety scan reads in a run of ${plural(estimate.basis.participants, "participant")}.`,
        ]
      : []),
  ];
  if (passed.length === 0) return undefined;
  const { scheduled, longestWindowMs, open, openMs, dwell } = estimate.basis;
  const counted = [
    ...(scheduled > 0
      ? [
          `${plural(scheduled, "participant")} working their declared windows of up to ${formatDuration(longestWindowMs)}`,
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
  const split = "split the participants across studies";
  const advice = changes.length === 0 ? split : `${changes.join(", ")}, or ${split}`;
  return [
    ...passed,
    `The estimate counts ${counted.join(" and ")}, at a model turn every ${formatDuration(RATES.secondsPerTurn * 1000)} that adds about ${(RATES.turnBytes / 1000).toFixed(1)} KB.`,
    `${advice[0]!.toUpperCase()}${advice.slice(1)}.`,
  ].join(" ");
}

/** The estimate beside the limits, for `study check`. */
export function describeBundle(estimate: BundleEstimate): string {
  return `run.json about ${mib(estimate.runFileBytes)} of the ${mib(EVIDENCE_LIMITS.sourceBytes)} analysis reads; largest file about ${mib(estimate.largestFileBytes)} of the ${mib(RUN_ARTIFACT_MAX_BYTES)} verify reads; about ${count(estimate.entries)} files and folders of the ${count(estimate.entryLimit)} the public-safety scan reads; about ${mib(estimate.totalBytes, 0)} in all. Participants with a declared end are counted for their whole window and the others for up to ${formatDuration(estimate.basis.openMs)}, at a model turn every ${formatDuration(RATES.secondsPerTurn * 1000)}.`;
}

function mib(bytes: number, digits = 1): string {
  const value = bytes / MIB;
  return `${Number.isInteger(value) ? value : value.toFixed(digits)} MiB`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}
