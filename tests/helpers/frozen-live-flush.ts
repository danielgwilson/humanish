import type { ActorTokenUsage, ActorTraceItem } from "../../src/actors/contract.js";
import type { CuaLiveMetadata } from "../../src/actors/computer-use/loop.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { startLiveTraceFlush } from "../../src/routes/computer-use/live-flush.js";
import type { DesktopParticipantRun } from "../../src/routes/computer-use/types.js";

/**
 * The production live flush for one participant, with a write that keeps nothing. Pass `onTrace`
 * as a loop's onTrace and every item the loop reports is deep-frozen, as a live run's items are,
 * so a producer that edits a recorded item in place throws inside the loop under test.
 */
export function frozenLiveFlush(): {
  onTrace: (
    items: readonly ActorTraceItem[],
    usage: ActorTokenUsage,
    metadata?: CuaLiveMetadata,
  ) => void;
  stop: () => Promise<void>;
} {
  const flush = startLiveTraceFlush({
    bundle: { streams: [{ id: "frozen-stream" }] } as unknown as RunBundle,
    participantRuns: [
      { planned: { id: "frozen-participant" }, streamId: "frozen-stream" },
    ] as unknown as DesktopParticipantRun[],
    model: "gpt-5.5",
    write: async () => {},
  });
  return {
    onTrace: (items, usage, metadata) => flush.flush("frozen-participant", items, usage, metadata),
    stop: flush.stop,
  };
}
