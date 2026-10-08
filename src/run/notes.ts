// Reviewer notes: free text a person adds at a moment of a recorded run. Each note is its own file
// in the run directory (note-files.ts). A note's time counts from the run clock's start, the
// first timed capture or desktop video of any participant, which is the Observer's study clock.

import type { ActorTraceItem } from "../actors/contract.js";
import { cli } from "../cli/invocation.js";
import { redactText } from "../evidence/redaction.js";
import type { RunBundle } from "./bundle.js";
import { createContainedOutputFile } from "./contained-output.js";
import { loadRunBundlePrepared } from "./locate.js";
import { countRunNotes, encodeRunNote, newRunNoteId, runNoteFile } from "./note-files.js";
import { MAX_NOTE_TEXT, MAX_RUN_NOTES, type RunNote } from "./note-shape.js";
import { runParticipantCaptions, streamParticipantIdOf } from "./participant-records.js";
import { physicalCwdOf, runIdOf, type PreparedRunArtifactPaths } from "./paths.js";
import type { RunStream } from "./streams.js";
import { transientCommsKnownValueScrub } from "./transient-comms-secrets.js";
import { isNodeError } from "./type-guards.js";

const DEFAULT_AUTHOR = "you";
/** New ids a note tries when the one before was taken. */
const PUBLISH_ATTEMPTS = 5;

export interface RunNoteInput {
  atMs: number;
  participant: string | null;
  text: string;
}

export type RunNoteErrorCode =
  | "HUMANISH_INVALID_RUN_BUNDLE"
  | "HUMANISH_NOTE_INVALID"
  | "HUMANISH_NOTE_NO_CLOCK"
  | "HUMANISH_NOTE_UNKNOWN_PARTICIPANT"
  | "HUMANISH_NOTE_OUTSIDE_RUN"
  | "HUMANISH_NOTES_UNREADABLE"
  | "HUMANISH_NOTES_FULL"
  | "HUMANISH_NOTE_ID_TAKEN";

export type AddRunNoteResult =
  /** `scrubbed`: redaction replaced part of the text before it was written. */
  | { ok: true; note: RunNote; scrubbed: boolean }
  | { ok: false; error: { code: RunNoteErrorCode; message: string } };

const refuse = (code: RunNoteErrorCode, message: string): AddRunNoteResult => ({
  ok: false,
  error: { code, message },
});

/**
 * The stream id a note's participant names: a stream id, or the participant's own id from the study
 * (`charge-nurse`). Both kinds of id are matched, so a name that is one stream's id and another
 * stream's study id is refused, naming both, as is a study id that two streams record. Otherwise
 * the refusal names the run's participants by caption, with the id to type for each.
 */
function participantStreamId(bundle: RunBundle, named: string): string | AddRunNoteResult {
  const captions = runParticipantCaptions(bundle);
  const matching = bundle.streams.filter(
    (stream) => stream.id === named || streamParticipantIdOf(stream) === named,
  );
  if (matching.length === 1) return matching[0]!.id;
  const described = (stream: RunStream): string => {
    const participantId = streamParticipantIdOf(stream);
    return `${captions.get(stream.id)} (stream id ${stream.id}${participantId === undefined ? "" : `, study id ${participantId}`})`;
  };
  if (matching.length > 1)
    return refuse(
      "HUMANISH_NOTE_UNKNOWN_PARTICIPANT",
      `${named} names ${matching.length} participants in run ${bundle.runId}: ${matching.map(described).join(" and ")}. Name the one you mean by an id only it has.`,
    );
  const known = bundle.streams.map(
    (stream) => `${captions.get(stream.id)} (${streamParticipantIdOf(stream) ?? stream.id})`,
  );
  return refuse(
    "HUMANISH_NOTE_UNKNOWN_PARTICIPANT",
    `Run ${bundle.runId} has no participant ${named}. Its participants are ${known.join(", ")}; leave the participant out for a note on the whole run.`,
  );
}

/** A run clock time as the Observer shows it: whole minutes and seconds, `02:31`. */
export function formatRunTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The run clock: the first and last timed capture or desktop video moment, in epoch ms. */
export function runClock(bundle: RunBundle): { startMs: number; endMs: number } | null {
  const moments = bundle.streams.flatMap((stream) => [
    ...(captureTimes(stream) ?? []),
    ...recordingMoments(stream),
  ]);
  if (moments.length === 0) return null;
  // A loop, since spreading a long recording's capture times into Math.min can overflow the stack.
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const moment of moments) {
    startMs = Math.min(startMs, moment);
    endMs = Math.max(endMs, moment);
  }
  return { startMs, endMs };
}

function traceItems(stream: RunStream): ActorTraceItem[] {
  return stream.actor?.items ?? stream.liveActor?.items ?? [];
}

const stamp = (item: ActorTraceItem): number =>
  item.at === undefined ? Number.NaN : Date.parse(item.at);

/**
 * A participant's capture times, as the Observer's study clock reads them: only when every capture
 * is stamped and the stamps never go back. Otherwise the participant adds nothing to the clock.
 */
function captureTimes(stream: RunStream): number[] | null {
  const times = traceItems(stream)
    .filter(
      (item) => (item.kind === "screenshot" || item.kind === "ui_action") && item.screenshotRef,
    )
    .map(stamp);
  const ordered = times.every(
    (time, index) => Number.isFinite(time) && (index === 0 || time >= times[index - 1]!),
  );
  return ordered ? times : null;
}

function recordingMoments(stream: RunStream): number[] {
  const recording = stream.recording;
  if (!recording) return [];
  const startMs = Date.parse(recording.startedAt);
  const endMs = startMs + recording.durationMs;
  return Number.isFinite(startMs) && Number.isFinite(endMs) && recording.durationMs > 0
    ? [startMs, endMs]
    : [];
}

/** The latest stamped trace item at or before `moment`, among the given participants. */
function nearestItem(streams: readonly RunStream[], moment: number): RunNote["nearest"] {
  let best: { participant: string; itemId: string; time: number } | null = null;
  for (const stream of streams)
    for (const item of traceItems(stream)) {
      const time = stamp(item);
      if (Number.isFinite(time) && time <= moment && (best === null || time >= best.time))
        best = { participant: stream.id, itemId: item.id, time };
    }
  return best === null ? null : { participant: best.participant, itemId: best.itemId };
}

/**
 * The text as it is written: line breaks as `\n`, the run's known values and every secret-shaped
 * value or local path replaced, as other run text is before it is written.
 */
function scrubNoteText(text: string): string {
  let known: string;
  try {
    known = transientCommsKnownValueScrub()(text);
  } catch {
    // A closed run scope refuses to scrub and has dropped its values. The note then gets the
    // pattern redaction that a separate `humanish notes` process gives it.
    known = text;
  }
  return redactText(known.replace(/\r\n?/g, "\n").trim());
}

/** Why the text cannot be a note, or null when it can. */
function noteTextProblem(text: string): string | null {
  if (text.length === 0) return "A note needs some text.";
  if (text.length > MAX_NOTE_TEXT)
    return `A note holds at most ${MAX_NOTE_TEXT} characters; this one has ${text.length}. Shorten it and add it again.`;
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))
    return "A note holds plain text and line breaks; this one has a control character. Remove it and add the note again.";
  return null;
}

/**
 * Adds a note as a new file, notes/<id>.json, created under a name nothing holds. It reads no other
 * note and replaces nothing, so notes added at the same time, from any process, are all kept.
 */
export async function addRunNote(
  prepared: PreparedRunArtifactPaths,
  input: RunNoteInput,
): Promise<AddRunNoteResult> {
  const text = scrubNoteText(input.text);
  const problem = noteTextProblem(text);
  if (problem) return refuse("HUMANISH_NOTE_INVALID", problem);
  let loaded;
  try {
    loaded = await loadRunBundlePrepared(physicalCwdOf(prepared), prepared);
  } catch (error) {
    // The storage check throws on a link or a special file anywhere in the run directory, or on a
    // run directory that moved.
    return refuse(
      "HUMANISH_INVALID_RUN_BUNDLE",
      `No note was added to run ${runIdOf(prepared)}: its directory failed humanish's storage check. ${error instanceof Error ? error.message : String(error)} Fix that in the run directory and add the note again.`,
    );
  }
  if (!loaded)
    return refuse(
      "HUMANISH_INVALID_RUN_BUNDLE",
      `Run ${runIdOf(prepared)} has no run.json humanish can read safely, so no note was added. \`${cli(`verify --run ${runIdOf(prepared)}`)}\` says what is wrong with it.`,
    );
  const { bundle } = loaded;
  const clock = runClock(bundle);
  if (!clock)
    return refuse(
      "HUMANISH_NOTE_NO_CLOCK",
      `Run ${bundle.runId} has no captures with recorded times, so a note cannot point at a moment of it.`,
    );
  const participant =
    input.participant === null ? null : participantStreamId(bundle, input.participant);
  if (participant !== null && typeof participant !== "string") return participant;
  // The Observer shows whole seconds, so a moment in the second the clock ends is its end.
  const durationMs = clock.endMs - clock.startMs;
  if (
    !Number.isFinite(input.atMs) ||
    input.atMs < 0 ||
    Math.floor(input.atMs / 1000) > Math.floor(durationMs / 1000)
  )
    return refuse(
      "HUMANISH_NOTE_OUTSIDE_RUN",
      `A note on run ${bundle.runId} needs a moment from 00:00 to ${formatRunTime(durationMs)}, the time its captures cover.`,
    );
  const atMs = Math.min(Math.round(input.atMs), durationMs);
  const streams = bundle.streams.filter(
    (stream) => participant === null || stream.id === participant,
  );
  const now = new Date();
  const fields: Omit<RunNote, "id"> = {
    atMs,
    participant,
    nearest: nearestItem(streams, clock.startMs + atMs),
    text,
    author: DEFAULT_AUTHOR,
    createdAt: now.toISOString(),
    editedAt: null,
  };
  try {
    // A count of the files notes/ lists; no note is read.
    if ((await countRunNotes(prepared)) >= MAX_RUN_NOTES)
      return refuse(
        "HUMANISH_NOTES_FULL",
        `Run ${bundle.runId} already has ${MAX_RUN_NOTES} notes, the most one run keeps.`,
      );
    // The note appears only under a name nothing holds; a taken name gets a new id.
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
      const note: RunNote = { id: newRunNoteId(now), ...fields };
      try {
        await createContainedOutputFile(
          prepared,
          runNoteFile(note.id),
          encodeRunNote(note, bundle.runId),
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") continue;
        throw error;
      }
      return { ok: true, note, scrubbed: text !== input.text.replace(/\r\n?/g, "\n").trim() };
    }
  } catch {
    return refuse(
      "HUMANISH_NOTES_UNREADABLE",
      `The notes folder in run ${bundle.runId} is not a plain folder inside the run, so no note was added. Move it out of the run directory and add the note again.`,
    );
  }
  return refuse(
    "HUMANISH_NOTE_ID_TAKEN",
    `Each new id humanish chose for the note was already taken in run ${bundle.runId}'s notes folder, so no note was added. Something else is writing files there; add the note again.`,
  );
}
