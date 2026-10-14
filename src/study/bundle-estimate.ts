// How large a computer-use run's bundle grows, estimated from its plan before anything runs, and
// whether it would pass a limit a later command holds it to: analysis reads run.json up to
// EVIDENCE_LIMITS.sourceBytes, analysis, verify and the Observer read each participant's trace up to
// RUN_ARTIFACT_MAX_BYTES, verify reads no file larger than RUN_ARTIFACT_MAX_BYTES, and the
// public-safety scan visits at most runEntryLimit(participants) files and folders.
//
// observer/index.html carries every participant's items gzipped, so with busy participants it
// passes verify's 32 MiB long before run.json passes analysis's 16 MiB: at these rates, 20
// participants working 8 hours. From run bundle v4 run.json grows by participant, not by model
// request: each participant's per-request lists are only in its trace. run.json holds each
// participant's text, its mission, its instruction and its task goals, in its stream and again in
// the feedback candidate of a participant that reports friction or stops, and the first
// participant's once more in the scenario goal. A synthetic live run of 3 participants that all
// reported friction held their instructions 3, 2 and 2 times, and the mission and each of 2 task
// goals 7 times. None of the three fields is capped, and the estimate counts the feedback
// candidate's copy for every participant, so it warns at 100 participants with 75,238 bytes of
// text each. On 2026-10-13 the longest mission on the live computer-use runs kept on the
// maintainer's machine was 807 characters. On 2026-10-14 the longest instruction on the 170 live
// runs kept there was 4,061 characters, and none declared task goals.
// observer-data.json leaves the lists out too and was 0.94 to 1.12 of run.json's size on the live
// runs measured, so it passes 32 MiB only after run.json passes 16 MiB, and the estimate does not
// check it.
// A page past 32 MiB grades the run local_only. humanish export then needs --local-only, and a
// bundle export fails even with it, since its copy must verify as share_ready.
// The Observer feed, verify, analysis and the run.json writer each hold one participant's items in
// a string at a time. The page holds all of them gzipped in base64, about 0.18 characters for each
// trace byte, so it reaches V8's longest string, 536,870,888 characters, near 3 GB of traces.
// humanish observe on 25 participants with 30 MiB traces wrote a 138 MiB page at a peak of
// 3.8 GiB, so memory may run out first. Neither limit was measured past that run, and the estimate
// checks neither.

import { EVIDENCE_LIMITS } from "../analysis/analysis-limits.js";
import type { DwellWindow } from "../actors/stop-conditions.js";
import type { ParticipantSchedule } from "./arrivals.js";
import { RUN_ARTIFACT_MAX_BYTES } from "../run/contained-output.js";
import { formatDuration } from "../run/projection.js";
import { plural } from "../run/text.js";
import { runEntryLimit } from "../verify/scan-limit.js";

// Measured on 2026-10-13 on run bundle v3. Live: the 7 finished hosted computer-use runs kept from
// the 0.125.0 smoke test and the 2026-10-12 live checks, 10 participants with 1 to 28 turns and 137
// model requests. Dry: runs of 1, 2, 24 and 100 participants, for the Observer app and the run's
// own files. Pace, session length and screenshots: the live computer-use runs kept on the
// maintainer's machine. The run.json and page data rates were measured again on those runs
// written as v4.
// The trace rates were measured on trace files written indented. The writer now writes them as
// compact JSON, so each trace rate below is the indented figure divided by 1.36, the ratio of
// indented to compact bytes over 236 kept computer-use traces (1.17 to 1.49 each), and the page's
// share of the traces is multiplied by it. A trace's rate a turn on the public
// site/public/runs/lobby-0927 run (8 participants, 20 to 78 turns) was 1,579 bytes plus 91 for the
// page indented, under the live fit. Its participant of 78 turns writes a trace of 149,637 bytes
// indented and 107,897 compact.
const RATES = Object.freeze({
  /** run.json bytes for the run itself: its header, study, review and cost. Live fit: 4,381. */
  runBytes: 4_400,
  /**
   * run.json bytes for each participant: its stream, actor summary and closing report request.
   * Live fit on v3: 16,239. Written as v4, the kept runs of one participant held 20,571 to 23,160
   * bytes and those of two 30,647 to 38,948, beside 20,900 and 37,400 at these rates.
   */
  participantBytes: 16_500,
  /** A trace file's bytes before its turns: the actor summary. Live fit: 5,378 indented. */
  participantTraceBytes: 4_000,
  /**
   * Trace bytes a model turn adds: its items, its screenshot entry and its request's usage, plus 91
   * for the `page` each screenshot item now carries, all indented. Live fit: 1,965 a turn.
   * Participants with 4 or more turns ranged from 1,140 to 4,532; the busiest made 311 items in 15
   * turns, most of them UI actions. Analysis refuses the whole run when one trace passes its limit,
   * so each trace is counted at the busiest participant's rate, 4,700 indented.
   */
  turnTraceBytes: 3_500,
  /**
   * Trace bytes a dwell frame adds: 395 for its item and entry on the kept runs with dwell frames,
   * plus 91 for the page, indented.
   */
  frameTraceBytes: 400,
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
  /**
   * The page's compact copy of observer-data.json, as a share of run.json before the mission: 0.71
   * to 0.84 on the live runs written as v4, where neither carries the per-request lists. The page
   * holds each participant's text at its full size once, and the first participant's once more for
   * the run: dry runs of 1 and 4 participants grew the page by 2 and 5 copies of the mission, as
   * run.json grew, and a 0.128.0 run of 2 participants with 2 feedback candidates held 5 copies in
   * run.json and 3 on the page. The synthetic run of 3 held their instructions 2, 1 and 1 times on
   * the page. An analysis adds each participant's assignment, cut to 8,000 bytes.
   */
  observerPageDataShare: 0.85,
  /**
   * The page's gzipped base64 items, as a share of all the traces' bytes indented: 0.087 to 0.114
   * on the live runs of two participants, 0.097 for the busiest participant alone (about 475 bytes
   * a turn), 0.142 to 0.184 on runs of one participant and 4 to 11 turns, and 0.095 on 0.124.0's
   * synthetic 8-hour run. The estimate counted 0.12 of indented traces.
   */
  observerPageItemsShare: 0.16,
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

/**
 * One participant as the plan has it: its schedule, its dwell window, its mission and instruction,
 * and its task goals.
 */
export interface EstimatedParticipant {
  readonly schedule: ParticipantSchedule;
  readonly limits: { readonly dwell?: DwellWindow };
  readonly assignment: { readonly mission?: string; readonly focus?: string };
  readonly tasks?: readonly { readonly goal: string }[];
}

/**
 * The study fields run.json copies into each participant's stream, and the advice to shorten each.
 * The plan does not keep which form declared the participants, so the advice names both paths.
 */
const COPIED_FIELDS = Object.freeze({
  mission: "shorten the mission (actor.mission)",
  focus:
    "shorten the participants' instructions (participants.instruction or participants[].instruction)",
  tasks: "shorten the task goals (actor.tasks[].goal)",
});
type CopiedField = keyof typeof COPIED_FIELDS;

/** A run's estimated bundle, and the scan's limit for its participants. */
export interface BundleEstimate {
  /** run.json, which analysis reads whole. */
  readonly runFileBytes: number;
  /** The largest participant trace file, which analysis also reads whole. */
  readonly largestTraceBytes: number;
  /** observer/index.html, which verify reads whole. */
  readonly observerPageBytes: number;
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
    /** The copied field with the most bytes over all participants, when one has any. */
    readonly largestField?: CopiedField;
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
  // The bytes of each copied field over all participants, and the longest participant's text.
  const fieldBytes: Record<CopiedField, number> = { mission: 0, focus: 0, tasks: 0 };
  let longestText = 0;
  let longestWindowMs = 0;
  // The longest any participant without an end is counted, for the messages.
  let openMs = Math.min(sessionMs, RATES.openSessionMs);
  let scheduled = 0;
  for (const { schedule, limits, assignment, tasks = [] } of participants) {
    const { end } = schedule;
    const budgetMs = end?.windowMs ?? sessionMs;
    let countedMs: number;
    if (end?.kind === "scheduled_end") {
      scheduled += 1;
      countedMs = end.windowMs;
      longestWindowMs = Math.max(longestWindowMs, countedMs);
    } else {
      countedMs = Math.min(budgetMs, RATES.openSessionMs);
      openMs = Math.max(openMs, countedMs);
    }
    const own = Math.ceil(countedMs / (RATES.secondsPerTurn * 1000));
    const dwell = limits.dwell;
    const ownFrames =
      dwell === undefined ? 0 : Math.floor(Math.min(dwell.ms, budgetMs) / dwell.everyMs) + 1;
    const trace =
      RATES.participantTraceBytes + own * RATES.turnTraceBytes + ownFrames * RATES.frameTraceBytes;
    turns += own;
    frames += ownFrames;
    traces += trace;
    largestTrace = Math.max(largestTrace, trace);
    const mission = storedBytes(assignment.mission);
    const focus = storedBytes(assignment.focus);
    const goals = tasks.reduce((sum, task) => sum + storedBytes(task.goal), 0);
    fieldBytes.mission += mission;
    fieldBytes.focus += focus;
    fieldBytes.tasks += goals;
    longestText = Math.max(longestText, mission + focus + goals);
  }
  const textBytes = fieldBytes.mission + fieldBytes.focus + fieldBytes.tasks;
  // Sorting is stable, so of fields with equal bytes the first declared is named.
  const [largestField] = (Object.keys(fieldBytes) as CopiedField[])
    .filter((field) => fieldBytes[field] > 0)
    .sort((a, b) => fieldBytes[b] - fieldBytes[a]);
  const count = participants.length;
  const dataBytes = RATES.runBytes + count * RATES.participantBytes;
  // run.json holds each participant's text in its stream and in its feedback candidate if it
  // reports friction or stops, counted for every participant, and the first participant's in the
  // run's scenario goal, counted at the longest. The rates were fit on runs with short texts, so a
  // short text is counted twice.
  const runFileBytes = dataBytes + longestText + 2 * textBytes;
  const screenshots = count + turns + frames;
  // The page holds no feedback candidate's copy.
  const observerPageBytes = Math.round(
    RATES.observerAppBytes +
      RATES.observerPageDataShare * dataBytes +
      longestText +
      textBytes +
      RATES.observerPageItemsShare * traces,
  );
  return {
    runFileBytes,
    largestTraceBytes: largestTrace,
    observerPageBytes,
    // observer-data.json is about run.json's size.
    totalBytes: observerPageBytes + screenshots * RATES.screenshotBytes + traces + 2 * runFileBytes,
    entries: RATES.runEntries + count * RATES.participantEntries + turns + frames,
    entryLimit: runEntryLimit(count),
    basis: {
      participants: count,
      scheduled,
      longestWindowMs,
      open: count - scheduled,
      openMs,
      dwell: frames > 0,
      ...(largestField === undefined ? {} : { largestField }),
    },
  };
}

/** A text's bytes as run.json stores it, a JSON string without its quotes. */
function storedBytes(text: string | undefined): number {
  return text === undefined ? 0 : Buffer.byteLength(JSON.stringify(text)) - 2;
}

/**
 * The warning for a run whose estimate passes a limit, or undefined: each limit it passes, what the
 * estimate counted, and what to change.
 */
export function bundleLimitReason(estimate: BundleEstimate): string | undefined {
  const runFile = estimate.runFileBytes > EVIDENCE_LIMITS.sourceBytes;
  const page = estimate.observerPageBytes > RUN_ARTIFACT_MAX_BYTES;
  const entries = estimate.entries > estimate.entryLimit;
  const passed = [
    ...(runFile
      ? [
          `This study's run.json may grow to about ${mib(estimate.runFileBytes)}, past the ${mib(EVIDENCE_LIMITS.sourceBytes)} analysis reads. It holds the mission, the task goals and each participant's instruction in that participant's stream, and again in the feedback candidate of each participant that reports friction or stops. It holds the first participant's mission, instruction and task goals once more for the run, and the estimate counts a feedback candidate for every participant.`,
        ]
      : []),
    ...(estimate.largestTraceBytes > RUN_ARTIFACT_MAX_BYTES
      ? [
          `One participant's trace may grow to about ${mib(estimate.largestTraceBytes)}, past the ${mib(RUN_ARTIFACT_MAX_BYTES)} humanish reads of each trace.`,
        ]
      : []),
    ...(page
      ? [
          `The Observer page, observer/index.html, may grow to about ${mib(estimate.observerPageBytes)}, past the ${mib(RUN_ARTIFACT_MAX_BYTES)} verify reads in one file, so verify would grade the run local_only: humanish export would refuse it without --local-only, and a bundle export would fail.`,
        ]
      : []),
    ...(entries
      ? [
          `The run may hold about ${count(estimate.entries)} files and folders, past the ${count(estimate.entryLimit)} the public-safety scan reads in a run of ${plural(estimate.basis.participants, "participant")}.`,
        ]
      : []),
  ];
  if (passed.length === 0) return undefined;
  const { scheduled, longestWindowMs, open, openMs, dwell, largestField } = estimate.basis;
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
    ...(runFile && largestField !== undefined ? [COPIED_FIELDS[largestField]] : []),
  ];
  // A trace is one participant's, so splitting the study helps only the run's own files.
  if (runFile || page || entries || changes.length === 0)
    changes.push("split the participants across studies");
  const advice =
    changes.length < 2
      ? changes.join("")
      : `${changes.slice(0, -1).join(", ")}, or ${changes.at(-1)}`;
  return [
    ...passed,
    `The estimate counts ${counted.join(" and ")}, at a model turn every ${formatDuration(RATES.secondsPerTurn * 1000)} that adds up to ${(RATES.turnTraceBytes / 1000).toFixed(1)} KB to the participant's trace.`,
    "The run goes ahead.",
    `To stay under ${passed.length === 1 ? "the limit" : "the limits"}, ${advice}.`,
  ].join(" ");
}

/** The estimate beside the limits, for `study check`. */
export function describeBundle(estimate: BundleEstimate): string {
  return `run.json about ${mib(estimate.runFileBytes)} of the ${mib(EVIDENCE_LIMITS.sourceBytes)} analysis reads; largest trace about ${mib(estimate.largestTraceBytes)} of the ${mib(RUN_ARTIFACT_MAX_BYTES)} humanish reads of each; Observer page about ${mib(estimate.observerPageBytes)} of the ${mib(RUN_ARTIFACT_MAX_BYTES)} verify reads; about ${count(estimate.entries)} files and folders of the ${count(estimate.entryLimit)} the public-safety scan reads; about ${mib(estimate.totalBytes, 0)} in all. Participants with a declared end are counted for their whole window and the others for up to ${formatDuration(estimate.basis.openMs)}, at a model turn every ${formatDuration(RATES.secondsPerTurn * 1000)}.`;
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
