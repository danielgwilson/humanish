import { afterEach, describe, expect, it, vi } from "vitest";

import { streamEvent } from "../../src/study/run-study-homes.js";
import { allowDeprecationsInThisTest } from "../helpers/deprecations.js";

const CODE = "HUMANISH_STREAM_EVENT_FIELD_DEPRECATED";

const ready = () =>
  streamEvent({
    type: "ready",
    participantId: "lane-01",
    sandboxId: "sbx",
    recordId: "sim-001",
    streamId: "stream-001",
    url: "https://stream.invalid/key",
  });

const ended = () =>
  streamEvent({
    type: "ended",
    participantId: "lane-02",
    recordId: "sim-002",
    streamId: "stream-002",
  });

const deprecationCodes = (spy: { mock: { calls: unknown[][] } }): unknown[] =>
  spy.mock.calls
    .map(([, options]) => (options as { code?: unknown } | undefined)?.code)
    .filter((code) => code === CODE);

describe("StreamEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives a caller recordId without a warning", () => {
    const spy = vi.spyOn(process, "emitWarning");

    expect([ready().recordId, ended().recordId]).toEqual(["sim-001", "sim-002"]);
    expect(deprecationCodes(spy)).toEqual([]);
  });

  it("copies and serializes without reading simId", () => {
    const spy = vi.spyOn(process, "emitWarning");
    const event = ready();

    for (const copy of [
      { ...event },
      Object.assign({}, event),
      JSON.parse(JSON.stringify(event)) as Record<string, unknown>,
      structuredClone(event),
    ]) {
      expect(copy).toMatchObject({ type: "ready", recordId: "sim-001", streamId: "stream-001" });
      expect(copy).not.toHaveProperty("simId");
    }
    expect(Object.keys(event)).not.toContain("simId");
    expect("simId" in event).toBe(true);
    expect(deprecationCodes(spy)).toEqual([]);
  });

  it("still fills simId with recordId, and warns once", () => {
    allowDeprecationsInThisTest(CODE, "reads the deprecated field on purpose");
    const spy = vi.spyOn(process, "emitWarning");

    expect([ready().simId, ended().simId, ready().simId]).toEqual([
      "sim-001",
      "sim-002",
      "sim-001",
    ]);
    expect(deprecationCodes(spy)).toEqual([CODE]);
    expect(spy.mock.calls.map(([message]) => message)).toEqual([
      "StreamEvent.simId is deprecated and is removed in the next minor. Use recordId.",
    ]);
  });
});
