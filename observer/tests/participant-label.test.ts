import { describe, expect, it } from "vitest";

import terminalDry from "../../tests/golden/routes/terminal-dry-run.json";
import scriptedDry from "../../tests/golden/routes/scripted-dry-run.json";
import terminalLive from "../../tests/golden/routes/terminal-live.json";
import scriptedLive from "../../tests/golden/routes/scripted-live.json";
import fanoutLive from "../../tests/golden/routes/computer-use-fanout-live.json";
import sharedWorldLive from "../../tests/golden/routes/shared-world-concurrent-live.json";
import { inflateProjections } from "../../tests/helpers/run-golden-projections";
import { buildObserverData } from "../../src/observer/data";
import type { RunBundle } from "../../src/run/bundle";
import { runParticipantCaptions } from "../../src/run/participant-records";
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
  it("names each fan-out participant by the caption its run recorded", () => {
    const { streams } = observerData(fanoutLive);
    expect([...participantLabels(streams).values()]).toEqual([
      "Mobile newcomer, phone",
      "Small skimmer, phone",
      "Desktop power",
      "Wide researcher",
    ]);
  });

  it("names a computer-use participant from its ids when an older release recorded the label", () => {
    const { streams } = observerData(fanoutLive);
    for (const older of [
      (laneId: string) => `${laneId} · browser`,
      (laneId: string) => `CUA lane ${laneId} — fanout-proof`,
    ]) {
      const recorded = streams.map((stream) => ({ ...stream, label: older(stream.laneId!) }));
      expect([...participantLabels(recorded).values()]).toEqual([
        "Mobile newcomer",
        "Small skimmer",
        "Desktop power",
        "Wide researcher",
      ]);
    }
  });

  it.each([
    [terminalLive, "Terminal agent · terminal-proof", "Autonomous creative agent"],
    [scriptedLive, "Desktop browser surface · scripted-proof", "Synthetic new user"],
  ] as const)("re-captions a participant from an older bundle", (golden, label, caption) => {
    const { streams } = observerData(golden);
    const recorded = streams.map((stream) => ({ ...stream, label }));
    expect([...participantLabels(recorded).values()]).toEqual([caption]);
    expect(recorded[0]?.label).toBe(label);
  });

  it.each([
    [terminalDry, ["Terminal agent · terminal-proof"], ["Autonomous creative agent"]],
    [
      scriptedDry,
      ["Desktop browser surface · scripted-proof", "Mobile browser surface · scripted-proof"],
      ["Synthetic new user", "Synthetic new user, phone"],
    ],
  ] as const)("re-captions an older dry run without an actor trace", (golden, labels, captions) => {
    const { streams } = observerData(golden);
    const recorded = streams.map((stream, index) => ({ ...stream, label: labels[index]! }));
    expect([...participantLabels(recorded).values()]).toEqual(captions);
  });

  it("names a shared-world participant by its id, not the taxonomy an older label carried", () => {
    const { streams } = observerData(sharedWorldLive);
    const recorded = streams.map((stream, index) => ({
      ...stream,
      label: `Concurrent persona persona-0${index + 1} (type:initiator / surface:intake / case:case-001) · concurrent-shared-world-proof`,
    }));
    expect([...participantLabels(recorded).values()]).toEqual([
      "Persona 01",
      "Persona 02",
      "Persona 03",
    ]);
  });
});

describe("participants whose captions read the same", () => {
  it("adds the participant id, then the stream id, where two captions would read the same", () => {
    const { streams } = observerData(fanoutLive);
    const recorded = streams.map((stream, index) => ({
      ...stream,
      label: "Same reader",
      laneId: index < 2 ? "shared-lane" : stream.laneId!,
    }));

    expect([...participantLabels(recorded).entries()]).toEqual([
      ["stream-001", "Same reader · shared-lane · stream-001"],
      ["stream-002", "Same reader · shared-lane · stream-002"],
      ["stream-003", "Same reader · desktop-power"],
      ["stream-004", "Same reader · wide-researcher"],
    ]);
  });

  it.each([
    ["computer-use fan-out", fanoutLive],
    ["shared world", sharedWorldLive],
    ["terminal", terminalLive],
    ["scripted", scriptedDry],
  ] as const)(
    "names each %s participant in notes and drafts as the Observer does",
    (_route, golden) => {
      const bundle = inflateProjections(golden)["run.json"] as RunBundle;
      const repeated = {
        ...bundle,
        streams: bundle.streams.map((stream) => ({ ...stream, label: "Same reader" })),
      };

      for (const run of [bundle, repeated])
        expect(runParticipantCaptions(run)).toEqual(
          participantLabels(buildObserverData(run).streams),
        );
    },
  );
});
