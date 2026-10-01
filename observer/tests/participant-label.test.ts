import { describe, expect, it } from "vitest";

import fanoutLive from "../../tests/golden/routes/computer-use-fanout-live.json";
import sharedWorldLive from "../../tests/golden/routes/shared-world-concurrent-live.json";
import { inflateProjections } from "../../tests/helpers/run-golden-projections";
import { participantLabels } from "../lib/participant-label";
import type { ObserverData } from "../lib/observer-data";

/**
 * The recorded Observer data. A run-directory golden pins copies of the bundle as markers
 * (tests/helpers/run-golden-projections.ts), so the streams are rebuilt from run.json first.
 */
function observerData(golden: Record<string, unknown>): ObserverData {
  return inflateProjections(golden)["observer/observer-data.json"] as ObserverData;
}

describe("participant labels", () => {
  it("names each recorded fan-out participant by its persona", () => {
    const { streams } = observerData(fanoutLive);
    expect([...participantLabels(streams).values()]).toEqual([
      "First time visitor",
      "Impatient skimmer",
      "Power user",
      "Comparison shopper",
    ]);
  });

  it("names a participant by its persona whatever its recorded label says", () => {
    const { streams } = observerData(fanoutLive);
    const older = streams.map((stream) => ({
      ...stream,
      label: `CUA lane ${stream.laneId} — fanout-proof`,
    }));
    expect([...participantLabels(older).values()]).toEqual([
      ...participantLabels(streams).values(),
    ]);
  });

  it("keeps the recorded label on a stream with no participant id", () => {
    const { streams } = observerData(sharedWorldLive);
    expect(streams.every((stream) => stream.laneId === undefined)).toBe(true);
    expect([...participantLabels(streams).values()]).toEqual(streams.map((stream) => stream.label));
  });
});
