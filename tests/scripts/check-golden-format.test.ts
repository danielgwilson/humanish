import { describe, expect, it } from "vitest";

import { expandRepeatedFiles, referenceRepeatedFiles } from "../helpers/analysis-golden-files.js";
import { loopGoldenText } from "../helpers/loop-golden-log.js";
import { dedupeProjections, inflateProjections } from "../helpers/run-golden-projections.js";

// The run-directory golden format (scripts/check-golden-format.ts checks a change of it against
// the old goldens): a copy of the bundle that equals its source becomes a marker, and any copy
// that differs is pinned in full.

const event = (id: string, streamId: string, message: string) => ({
  id,
  at: "[ts]",
  level: "info",
  type: "cua-lab.session.running",
  message,
  simId: `sim-${streamId}`,
  streamId,
});

function snapshot() {
  const events = [
    event("e1", "s1", "Participant lane-01 is running."),
    event("e2", "s2", "Participant lane-02 is running."),
  ];
  const streams = [
    { id: "s1", simId: "sim-s1", label: "CUA participant lane-01: lab", status: "passed" },
    { id: "s2", simId: "sim-s2", label: "CUA participant lane-02: lab", status: "passed" },
  ];
  const simulations = [
    { id: "sim-s1", personaId: "first-time-visitor" },
    { id: "sim-s2", personaId: "power-user" },
  ];
  const cost = { estimatedUsd: 0.12 };
  return {
    "run.json": { events, streams, simulations, cost },
    "events.ndjson": structuredClone(events),
    "observer/observer-data.json": {
      run: { runId: "run" },
      events: structuredClone(events),
      cost: structuredClone(cost),
      streams: streams.map((stream, index) => ({
        ...structuredClone(stream),
        sim: structuredClone(simulations[index]),
        kindLabel: "browser",
        timeline: [structuredClone(events[index])],
      })),
    },
  };
}

describe("run-directory golden projections", () => {
  it("pins each copy equal to its source as a marker and inflates it back", () => {
    const full = snapshot();
    const pinned = dedupeProjections(full);
    expect(pinned["events.ndjson"]).toBe("[same as run.json events]");
    expect(pinned["observer/observer-data.json"]).toEqual({
      run: { runId: "run" },
      events: "[same as run.json events]",
      cost: "[same as run.json cost]",
      streams: [
        {
          "[same as the run.json stream]": "simId label status",
          id: "s1",
          sim: "[same as run.json simulation sim-s1]",
          kindLabel: "browser",
          timeline: "[same as run.json events for this stream]",
        },
        {
          "[same as the run.json stream]": "simId label status",
          id: "s2",
          sim: "[same as run.json simulation sim-s2]",
          kindLabel: "browser",
          timeline: "[same as run.json events for this stream]",
        },
      ],
    });
    expect(inflateProjections(pinned)).toEqual(full);
  });

  it("pins a copy that differs from its source in full", () => {
    const full = snapshot();
    const data = full["observer/observer-data.json"];
    full["events.ndjson"][1]!.message = "Participant lane-02 stopped.";
    data.streams[0]!.label = "First time visitor";
    data.streams[0]!.timeline.push(event("e9", "s1", "Harness email receiving"));
    data.streams[1]!.sim!.personaId = "someone-else";
    data.cost.estimatedUsd = 0.5;

    const pinned = dedupeProjections(full);
    expect(pinned["events.ndjson"]).toEqual(full["events.ndjson"]);
    const projected = pinned["observer/observer-data.json"] as typeof data;
    expect(projected.cost).toEqual({ estimatedUsd: 0.5 });
    expect(projected.streams[0]).toMatchObject({
      "[same as the run.json stream]": "simId status",
      label: "First time visitor",
      timeline: full["observer/observer-data.json"].streams[0]!.timeline,
    });
    expect(projected.streams[1]!.sim).toEqual({ id: "sim-s2", personaId: "someone-else" });
    expect(inflateProjections(pinned)).toEqual(full);
  });

  it("leaves a snapshot without a run.json bundle unchanged", () => {
    const loop = { result: { status: "passed" }, log: [["executor.observe", 0]] };
    expect(dedupeProjections(loop)).toBe(loop);
  });
});

describe("loop golden layout", () => {
  const outcome = {
    result: { status: "passed", reason: "Booked the appointment." },
    log: [
      ["executor.observe", 0],
      ["onTrace", 1, { input: 0, output: 0 }, {}],
      ["profile", undefined],
    ],
  };

  it("writes each logged call on one line, inside a single outcome or named outcomes", () => {
    expect(loopGoldenText(outcome)).toContain(
      '"log": [\n    ["executor.observe",0],\n    ["onTrace",1,{"input":0,"output":0},{}],\n    ["profile",null]\n  ]',
    );
    expect(loopGoldenText({ first: outcome })).toContain('      ["executor.observe",0],\n');
  });

  it("keeps the value the old layout pinned", () => {
    for (const value of [outcome, { first: outcome, second: outcome }])
      expect(JSON.parse(loopGoldenText(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });
});

describe("analysis golden repeated files", () => {
  const receipt = { status: "completed", usage: { estimatedCostUsd: 0.25 } };
  const scenarios = () => ({
    completed: { result: { ok: true }, files: { "receipt.json": structuredClone(receipt) } },
    reused: { result: { ok: true }, files: { "receipt.json": structuredClone(receipt) } },
    rerun: {
      result: { ok: true },
      files: { "receipt.json": { ...structuredClone(receipt), status: "failed" } },
    },
    failedAgain: {
      result: { ok: false },
      files: { "receipt.json": { ...structuredClone(receipt), status: "failed" } },
    },
    refused: { result: { ok: false } },
  });

  it("references the first scenario that wrote an equal file and expands back", () => {
    const pinned = referenceRepeatedFiles(scenarios());
    expect(pinned).toMatchObject({
      completed: { files: { "receipt.json": receipt } },
      reused: { files: { "receipt.json": '[same as scenario "completed"]' } },
      failedAgain: { files: { "receipt.json": '[same as scenario "rerun"]' } },
      refused: { result: { ok: false } },
    });
    expect(expandRepeatedFiles(pinned)).toEqual(scenarios());
  });

  it("pins a file that differs from every earlier one in full", () => {
    const pinned = referenceRepeatedFiles(scenarios());
    expect(pinned).toMatchObject({
      rerun: { files: { "receipt.json": { ...receipt, status: "failed" } } },
    });
  });
});
