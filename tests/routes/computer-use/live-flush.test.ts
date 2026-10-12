// The live flush is the one producer of a running participant's live items. It freezes each item it
// is handed, so an edit after the item was recorded throws where it happens: an appended line in
// the live file can never go stale behind the participant's list.

import { describe, expect, it } from "vitest";

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
});
