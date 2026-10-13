import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  OBSERVER_DATA_SCHEMA,
  buildObserverData,
  observerDataFromSaved,
  type ObserverData,
} from "../../src/observer/data.js";
import type { RunBundle } from "../../src/run/bundle.js";
import type { RunStream } from "../../src/run/streams.js";

// Contract freeze for humanish.observer-data.v3. The Observer rebuild is a
// rendering-layer swap only if the data it renders cannot drift underneath it, so this
// test pins the bundle -> observer-data transform against committed goldens derived from
// the deterministic lab goldens in tests/golden/labs/ (same inputs as lab-golden.test.ts).
// A golden is the data the page renders, with each participant's items; observer-data.json
// holds it without them (tests/observer/participant-items.test.ts).
//
// The committed observer-data goldens double as the dev fixtures the new observer/
// workspace renders, so a shape change here is visible in the same diff that causes it.
//
// Intentional contract changes: rerun with UPDATE_OBSERVER_DATA_GOLDENS=1, review the
// golden diff, and say why in the commit message. Goldens are stored raw (fixed
// generatedAt); normalization happens identically on both sides of the comparison, so
// the committed fixture stays human-diffable (same policy as tests/golden/labs/).

const ROOT = process.cwd();
const GOLDEN_DIR = path.join(ROOT, "tests", "golden", "observer-data");
const FIXED_GENERATED_AT = "2026-01-01T00:00:00.000Z";
// "live" is a pinned real-run snapshot (kept receipt cua-2026-08-17T18-17-25-392Z-9b6aa972,
// sandbox id synthesized): frames with `at` stamps, structured click coords, and reasoning
// items: the player's committed fixture. capture-lab-goldens.mjs regenerates only the
// dry-run goldens; refresh `live` from a new kept live receipt, never from a dry-run.
const GOLDENS = ["first-run", "oss", "live"] as const;

// Same ambient-value masking as tests/lab-golden.test.ts: ISO timestamps and the
// environment-dependent git-state subtree are masked by value, keeping structure asserted.
function normalize(value: unknown, inGitState = false): unknown {
  if (inGitState && (value === null || typeof value !== "object")) {
    return "[git]";
  }
  if (typeof value === "string") {
    return value.replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "[ts]");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry, inGitState));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nowInGitState = inGitState || obj.schema === "humanish.git-state.v1";
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      out[key] = normalize(entry, nowInGitState);
    }
    return out;
  }
  return value;
}

describe("observer-data.v3 contract freeze", () => {
  for (const id of GOLDENS) {
    it(`${id} golden bundle produces the frozen observer-data shape`, async () => {
      const bundle = JSON.parse(
        await readFile(path.join(ROOT, "tests", "golden", "labs", `${id}.json`), "utf8"),
      ) as RunBundle;

      const data = buildObserverData(bundle, FIXED_GENERATED_AT);
      expect(data.schema).toBe(OBSERVER_DATA_SCHEMA);
      expect(data.schemaVersion).toBe(3);

      const goldenPath = path.join(GOLDEN_DIR, `${id}.json`);
      if (process.env.UPDATE_OBSERVER_DATA_GOLDENS) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(goldenPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        return;
      }

      const golden = JSON.parse(await readFile(goldenPath, "utf8")) as unknown;
      expect(normalize(data)).toEqual(normalize(golden));
    });
  }
});

const USAGE_ROW = { input: 3_100, output: 40 };
const RECEIPT = {
  ordinal: 1,
  kind: "interaction" as const,
  dispatched: true,
  usageComplete: true,
  cleanup: "confirmed" as const,
  profileVerified: true,
};

/** The per-request lists the data holds across its participants. */
function heldLists(data: { streams: readonly Partial<RunStream>[] }): number {
  return data.streams
    .flatMap((stream) => [stream.actor, stream.liveActor])
    .reduce(
      (count, trace) =>
        count +
        (trace?.tokenUsage?.turns?.length ?? 0) +
        ((trace as RunStream["actor"])?.conversation?.requests?.length ?? 0) +
        (trace?.providerRequests?.length ?? 0),
      0,
    );
}

describe("the Observer's data leaves the per-request lists out", () => {
  it("of each participant's actor and live actor", async () => {
    const bundle = JSON.parse(
      await readFile(path.join(ROOT, "tests", "golden", "labs", "live.json"), "utf8"),
    ) as RunBundle;
    const [first] = bundle.streams;
    const { actor, ...running } = first!;
    const finished: RunStream = {
      ...first!,
      actor: {
        ...actor!,
        tokenUsage: { input: 6_200, output: 80, turns: [USAGE_ROW, USAGE_ROW] },
        conversation: { mode: "threaded", summarizedTurns: 0, requests: [{ mode: "threaded" }] },
        providerRequests: [RECEIPT],
      },
    };
    const live: RunStream = {
      ...running,
      id: "running",
      liveActor: {
        schema: "humanish.live-actor.v1",
        updatedAt: "2026-10-13T08:00:00.000Z",
        tokenUsage: { input: 3_100, output: 40, turns: [USAGE_ROW] },
        providerRequests: [RECEIPT],
        items: actor!.items,
      },
    };
    const data = buildObserverData({ ...bundle, streams: [finished, live] }, FIXED_GENERATED_AT);
    expect(heldLists(data)).toBe(0);
    expect(data.streams[0]!.actor?.tokenUsage).toEqual({ input: 6_200, output: 80 });
    expect(data.streams[1]!.liveActor?.items).toHaveLength(actor!.items.length);
  });

  it("of a saved projection this version reads, which it reads as v3", async () => {
    const golden = JSON.parse(
      await readFile(path.join(GOLDEN_DIR, "live.json"), "utf8"),
    ) as ObserverData;
    const [first, ...rest] = golden.streams;
    const turns = Array.from({ length: 24 }, () => USAGE_ROW);
    // observer-data.json as 0.123.0 and earlier wrote it: v1, items and lists inline.
    const v1 = {
      ...golden,
      schema: "humanish.observer-data.v1",
      schemaVersion: 1,
      streams: [{ ...first!, actor: { ...first!.actor!, tokenUsage: { turns } } }, ...rest],
    };
    const read = observerDataFromSaved(v1)!;
    expect([read.schema, read.schemaVersion]).toEqual(["humanish.observer-data.v3", 3]);
    expect(heldLists(read)).toBe(0);
    expect(read.streams[0]!.actor?.items).toEqual(first!.actor!.items);
    // A v2 file of a run with no participant trace yet, as 0.124.0 to 0.126.0 wrote it.
    const shell = {
      ...golden,
      schema: "humanish.observer-data.v2",
      schemaVersion: 2,
      streams: golden.streams.map(({ actor: _actor, ...stream }) => stream),
    };
    const fromV2 = observerDataFromSaved(shell)!;
    expect([fromV2.schema, fromV2.schemaVersion]).toEqual(["humanish.observer-data.v3", 3]);
    // One that names an actor left its items out, and the run's traces hold them.
    const named = { ...shell, streams: [{ ...shell.streams[0]!, actor: { reason: "x" } }] };
    expect(observerDataFromSaved(named)).toBeNull();
  });
});
