import { describe, expect, it } from "vitest";
import {
  participantEvent,
  participantIds,
  participantIdsOf,
  participantRecord,
  participantStream,
  eventRecordIdOf,
  recordIdOf,
  streamParticipantIdOf,
} from "../../src/run/participant-records.js";
import type { RunStream } from "../../src/run/streams.js";

describe("participant records (bundle write)", () => {
  const ids = participantIds(0);
  const fields = {
    personaId: "persona-1",
    scenarioId: "scenario-1",
    status: "passed" as const,
    streamKind: "terminal" as const,
    mode: "cli-sim" as const,
    progress: 100,
    currentStep: "done",
    summary: "summary",
    startedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:01:00.000Z",
  };

  it("numbers the default ids from a 0-based position, and keeps a route's own ids", () => {
    expect(participantIds(0)).toEqual({ simId: "sim-001", streamId: "stream-001" });
    expect(participantIds(11)).toEqual({ simId: "sim-012", streamId: "stream-012" });
    expect(participantIdsOf("scripted-desktop", "scripted-desktop-stream")).toEqual({
      simId: "scripted-desktop",
      streamId: "scripted-desktop-stream",
    });
  });

  it("writes a record in the bundle's key order, with its one stream", () => {
    const record = participantRecord(ids, 1, fields);
    expect(Object.keys(record)).toEqual([
      "id",
      "index",
      "personaId",
      "scenarioId",
      "status",
      "streamKind",
      "mode",
      "progress",
      "currentStep",
      "summary",
      "streamIds",
      "startedAt",
      "updatedAt",
    ]);
    expect(record).toMatchObject({ id: "sim-001", index: 1, streamIds: ["stream-001"] });
  });

  it("puts a stream's ids first and an event's ids last, as the saved bundles do", () => {
    const streamFields: Omit<RunStream, "id" | "simId" | "laneId"> = {
      kind: "terminal",
      label: "Terminal",
      status: "passed",
      transport: "snapshot",
      updatedAt: fields.updatedAt,
      artifacts: [],
    };
    const stream = participantStream(ids, streamFields);
    expect(Object.keys(stream).slice(0, 3)).toEqual(["id", "simId", "kind"]);
    expect(recordIdOf(stream)).toBe("sim-001");
    const named = participantStream(ids, streamFields, "reviewer");
    expect(Object.keys(named).slice(0, 4)).toEqual(["id", "simId", "laneId", "kind"]);
    expect(named).toMatchObject({ id: "stream-001", laneId: "reviewer" });
    const event = participantEvent(ids, {
      id: "event-001",
      at: fields.startedAt,
      level: "info",
      type: "synthetic",
      message: "synthetic",
    });
    expect(Object.keys(event)).toEqual([
      "id",
      "at",
      "level",
      "type",
      "message",
      "simId",
      "streamId",
    ]);
    expect(eventRecordIdOf(event)).toBe("sim-001");
    expect(streamParticipantIdOf(stream)).toBeUndefined();
    expect(streamParticipantIdOf({ ...stream, laneId: "reviewer" })).toBe("reviewer");
  });
});
