// What a reader of run.json or of the Observer's data can read of a participant's per-request lists
// (tokenUsage.turns, conversation.requests, providerRequests). From run bundle v4 only the trace
// file holds them, so the types refuse each read before the loader joins them. Each
// `@ts-expect-error` fails typecheck if the line below it compiles, so `pnpm typecheck` is the
// assertion; the runtime test checks that each refused read finds nothing in the bytes.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ActorTrace } from "../../src/actors/contract.js";
import { buildObserverData, type ObserverData } from "../../src/observer/data.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { isRunBundle } from "../../src/run/bundle-shape.js";
import {
  loadStreamTraces,
  splitStreamTraces,
  type TraceFileReader,
  withoutRequestLists,
} from "../../src/run/stream-trace.js";

const FIXTURE = path.resolve("tests/fixtures/runs-0107/source-convention-only/run.json");

/** The lists of run.json as parsed: none compiles. */
function runJsonReads(value: unknown): unknown[] {
  if (!isRunBundle(value)) throw new Error("not a run bundle");
  return value.streams.flatMap((stream) => [
    // @ts-expect-error run.json's actor has no conversation.requests
    stream.actor?.conversation?.requests,
    // @ts-expect-error run.json's actor has no tokenUsage.turns
    stream.actor?.tokenUsage?.turns,
    // @ts-expect-error run.json's actor has no providerRequests
    stream.actor?.providerRequests,
    // @ts-expect-error run.json's live actor has no tokenUsage.turns
    stream.liveActor?.tokenUsage?.turns,
    // @ts-expect-error run.json's live actor has no providerRequests
    stream.liveActor?.providerRequests,
  ]);
}

/** The lists of the Observer's data: none compiles. */
function observerReads(data: ObserverData): unknown[] {
  return data.streams.flatMap((stream) => [
    // @ts-expect-error the Observer's actor has no conversation.requests
    stream.actor?.conversation?.requests,
    // @ts-expect-error the Observer's actor has no tokenUsage.turns
    stream.actor?.tokenUsage?.turns,
    // @ts-expect-error the Observer's actor has no providerRequests
    stream.actor?.providerRequests,
    // @ts-expect-error the Observer's live actor has no tokenUsage.turns
    stream.liveActor?.tokenUsage?.turns,
  ]);
}

/** The lists of an actor without them: none compiles. */
function summaryReads(actor: ActorTrace): unknown[] {
  const summary = withoutRequestLists(actor);
  return [
    // @ts-expect-error the summary has no conversation.requests
    summary.conversation?.requests,
    // @ts-expect-error the summary has no tokenUsage.turns
    summary.tokenUsage?.turns,
    // @ts-expect-error the summary has no providerRequests
    summary.providerRequests,
  ];
}

/** The lists of the loader's bundle: each compiles. */
function loadedReads(bundle: RunBundle): unknown[] {
  return bundle.streams.flatMap(({ actor }) => [
    actor?.conversation?.requests,
    actor?.tokenUsage?.turns,
    actor?.providerRequests,
  ]);
}

/** The fixture's first participant with one entry in each per-request list. */
async function bundleWithLists(): Promise<RunBundle> {
  const bundle = JSON.parse(await readFile(FIXTURE, "utf8")) as RunBundle;
  const [first, ...rest] = bundle.streams;
  const actor = first!.actor!;
  const withLists: ActorTrace = {
    ...actor,
    tokenUsage: { ...actor.tokenUsage, input: 10, turns: [{ input: 10 }] },
    conversation: { mode: "threaded", summarizedTurns: 0, requests: [{ mode: "threaded" }] },
    providerRequests: [],
  };
  return { ...bundle, streams: [{ ...first!, actor: withLists }, ...rest] };
}

describe("run.json's per-request lists", () => {
  it("are absent where the types refuse them and joined where the loader's bundle has them", async () => {
    const written = await bundleWithLists();
    const split = splitStreamTraces(written);
    const runJson: unknown = JSON.parse(JSON.stringify(split.bundle));
    expect(runJsonReads(runJson).filter((list) => list !== undefined)).toEqual([]);

    const files = new Map(split.files.map((file) => [file.path, file.bytes]));
    const read: TraceFileReader = async (relativePath) => {
      const bytes = files.get(relativePath);
      return bytes === undefined ? { refused: `${relativePath} is missing` } : { bytes };
    };
    if (!isRunBundle(runJson)) throw new Error("not a run bundle");
    const { bundle, refused } = await loadStreamTraces(read, runJson);
    expect(refused).toEqual([]);
    expect(loadedReads(bundle).filter((list) => list !== undefined)).toEqual([
      [{ mode: "threaded" }],
      [{ input: 10 }],
      [],
    ]);

    const data = buildObserverData(bundle, "2026-10-13T00:00:00.000Z");
    expect(observerReads(data).filter((list) => list !== undefined)).toEqual([]);
    expect(summaryReads(written.streams[0]!.actor!)).toEqual([undefined, undefined, undefined]);
  });
});
