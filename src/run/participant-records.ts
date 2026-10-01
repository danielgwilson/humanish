// The run bundle's participant records, written and read. A route describes each participant (its
// record and stream fields, its events) and these functions give them the bundle's saved shape and
// field names; readers ask them for the ids a saved record carries. This module and run/bundle.ts
// (its types and bundleHead) and run/streams.ts are where those contract spellings live.

import type { RunEvent, RunSimulation } from "./bundle.js";
import type { RunStream } from "./streams.js";

/** The ids a participant's saved records carry: its record id and its stream id. */
export interface ParticipantIds {
  readonly simId: string;
  readonly streamId: string;
}

/** Ids a route chose itself, for routes whose ids are not the `sim-NNN` default. */
export function participantIdsOf(recordId: string, streamId: string): ParticipantIds {
  return { simId: recordId, streamId };
}

/** The default ids of the participant at a 0-based position: `sim-001` and `stream-001` first. */
export function participantIds(position: number): ParticipantIds {
  const ordinal = String(position + 1).padStart(3, "0");
  return participantIdsOf(`sim-${ordinal}`, `stream-${ordinal}`);
}

/** A participant's record, at its 1-based place in the bundle, with its one stream. */
export function participantRecord(
  ids: ParticipantIds,
  place: number,
  fields: Omit<RunSimulation, "id" | "index" | "streamIds">,
): RunSimulation {
  return {
    id: ids.simId,
    index: place,
    personaId: fields.personaId,
    scenarioId: fields.scenarioId,
    status: fields.status,
    streamKind: fields.streamKind,
    mode: fields.mode,
    progress: fields.progress,
    currentStep: fields.currentStep,
    summary: fields.summary,
    streamIds: [ids.streamId],
    startedAt: fields.startedAt,
    updatedAt: fields.updatedAt,
  };
}

/** A participant's stream. */
export function participantStream(
  ids: ParticipantIds,
  fields: Omit<RunStream, "id" | "simId">,
): RunStream {
  return { id: ids.streamId, simId: ids.simId, ...fields };
}

/** An event about one participant. */
export function participantEvent(
  ids: ParticipantIds,
  event: Omit<RunEvent, "simId" | "streamId">,
): RunEvent {
  return { ...event, simId: ids.simId, streamId: ids.streamId };
}

/** The record id a saved stream belongs to. */
export function recordIdOf(stream: RunStream): string {
  return stream.simId;
}

/** The record id a saved event names, when it names one. */
export function eventRecordIdOf(event: RunEvent): string | undefined {
  return event.simId;
}

/** The participant id an adapter recorded on a saved stream (a fan-out lane id), when it has one. */
export function streamParticipantIdOf(stream: RunStream): string | undefined {
  return stream.laneId;
}
