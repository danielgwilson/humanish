// The live flush is the one producer of a running participant's live items. It freezes each item it
// is handed, so an edit after the item was recorded throws where it happens: an appended line in
// the live file can never go stale behind the participant's list.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorTraceItem } from "../../../src/actors/contract.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { startLiveTraceFlush } from "../../../src/routes/computer-use/live-flush.js";
import type { DesktopParticipantRun } from "../../../src/routes/computer-use/types.js";

const screenshot = (): ActorTraceItem => ({
  id: "screenshot-001",
  kind: "screenshot",
  lifecycle: "completed",
  title: "turn-01",
  screenshotRef: { path: "screenshots/participant-one/turn-01.png", redaction: "blurred" },
  at: "2026-10-12T08:00:01.000Z",
});

function flushFor(writes: RunBundle[]) {
  return startLiveTraceFlush({
    bundle: { streams: [{ id: "stream-one" }] } as unknown as RunBundle,
    participantRuns: [
      { planned: { id: "participant-one" }, streamId: "stream-one" },
    ] as unknown as DesktopParticipantRun[],
    model: "gpt-5.5",
    write: async (bundle) => {
      writes.push(bundle);
    },
  });
}

describe("the live flush", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("freezes each item it is handed, nested fields included", async () => {
    const item = screenshot();
    const flush = flushFor([]);
    flush.flush("participant-one", [item]);
    await flush.stop();
    expect(() => {
      item.title = "turn-02";
    }).toThrow(TypeError);
    expect(() => {
      item.screenshotRef!.redaction = "none";
    }).toThrow(TypeError);
    expect(item.title).toBe("turn-01");
  });

  it("writes the participant's items as its live actor", async () => {
    const writes: RunBundle[] = [];
    const item = screenshot();
    const flush = flushFor(writes);
    flush.flush("participant-one", [item]);
    await flush.stop();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.streams[0]!.liveActor?.items).toEqual([screenshot()]);
  });

  it("writes a participant's first items at once and holds the next write for 2 seconds", async () => {
    vi.useFakeTimers();
    const writes: RunBundle[] = [];
    const flush = flushFor(writes);
    flush.flush("participant-one", [screenshot()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);

    flush.flush("participant-one", [screenshot(), { ...screenshot(), id: "screenshot-002" }]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.streams[0]!.liveActor?.items).toHaveLength(2);
    await flush.stop();
  });
});
