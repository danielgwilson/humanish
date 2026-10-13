// Where a participant's trace lives: run.json v2 keeps each stream's summary and an index, and the
// trace file holds the items and the screenshot entries. The loader gives readers the stream as a
// v1 bundle held it, and refuses a trace that does not match its index.

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorTrace } from "../../src/actors/contract.js";
import type { RunBundle, StoredRunBundle } from "../../src/run/bundle.js";
import type { RunStream, StoredRunStream } from "../../src/run/streams.js";
import { readRunDetail } from "../../src/run/detail.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { isRunStream } from "../../src/run/stream-shape.js";
import type { PreparedRunArtifactPaths } from "../../src/run/paths.js";
import {
  loadRunTraces,
  loadStreamTrace,
  loadStreamTraces,
  splitStreamTraces,
  StreamTraceRefusedError,
} from "../../src/run/stream-trace.js";

const FIXTURE = path.resolve("tests/fixtures/runs-0107/source-convention-only");
const RUN = "fanout-proof-2026-10-01t00-00-00-000z-v2";

let cwd: string;
let runRoot: string;
let runPaths: PreparedRunArtifactPaths;
let v1: RunBundle;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-stream-trace-"));
  runRoot = path.join(cwd, ".humanish", "runs", RUN);
  await cp(FIXTURE, runRoot, { recursive: true });
  v1 = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
  runPaths = (await resolveRunPath(cwd, RUN))!;
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Writes the bundle as the run writer does: each trace file, then run.json. */
async function writeV2(bundle: RunBundle): Promise<StoredRunBundle> {
  const split = splitStreamTraces(bundle);
  for (const file of split.files) await writeFile(path.join(runRoot, file.path), file.bytes);
  await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify(split.bundle, null, 2)}\n`);
  return split.bundle;
}

describe("writing a run's participant traces", () => {
  it("keeps each stream's summary and index in run.json and its items in the trace file", async () => {
    const stored = await writeV2(v1);
    expect(stored.schema).toBe("humanish.run-bundle.v4");
    const stream = stored.streams[0]!;
    expect(stream.actor).not.toHaveProperty("items");
    expect(stream.actor?.status).toBe(v1.streams[0]!.actor?.status);
    expect(stream.artifacts.map((artifact) => artifact.kind)).toEqual([
      "bundle",
      "review",
      "events",
      "trace",
    ]);
    const bytes = await readFile(path.join(runRoot, "actors/stream-001.json"));
    expect(stream.trace).toEqual({
      path: "actors/stream-001.json",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      items: 4,
      screenshots: 2,
    });
    const file = JSON.parse(bytes.toString("utf8")) as { items: unknown[]; artifacts: unknown[] };
    expect(file.items).toEqual(v1.streams[0]!.actor?.items);
    expect(file.artifacts).toEqual([
      {
        label: "participant mobile-newcomer screenshot 01 (raw)",
        path: "screenshots/mobile-newcomer/turn-00-start.png",
        kind: "screenshot",
      },
      {
        label: "participant mobile-newcomer screenshot 02 (raw)",
        path: "screenshots/mobile-newcomer/turn-01.png",
        kind: "screenshot",
      },
    ]);
  });

  it.each([
    ["a trace artifact named after another participant", ["one", "actors/two.json"], ["two"]],
    ["an id that is not a file name before stream-001", ["bad id"], ["stream-001"]],
    [
      "trace artifacts that differ only in case",
      ["one", "actors/Case.json"],
      ["two", "actors/case.json"],
    ],
  ] as const)("gives each participant its own trace file with %s", async (_name, ...specs) => {
    const base = v1.streams[0]!;
    const streams = specs.map((spec, index) => {
      const [id, tracePath] = spec as readonly [string, string?];
      return {
        ...base,
        id,
        artifacts: [
          ...base.artifacts.filter((artifact) => artifact.kind !== "trace"),
          ...(tracePath === undefined
            ? []
            : [{ label: "trace", path: tracePath, kind: "trace" as const }]),
        ],
        actor: { ...base.actor!, items: base.actor!.items.slice(index, index + 1) },
      };
    });
    const split = splitStreamTraces({ ...v1, streams });
    const paths = split.files.map((file) => file.path);
    // Distinct on a case-insensitive file system too.
    expect(new Set(paths.map((name) => name.toLowerCase())).size).toBe(2);
    await writeV2({ ...v1, streams });
    const loaded = await loadStreamTraces(runPaths, split.bundle);
    expect(loaded.refused).toEqual([]);
    expect(loaded.bundle.streams.map((stream) => stream.actor?.items)).toEqual(
      streams.map((stream) => stream.actor.items),
    );
  });
});

// Three requests, the first past the 272K long-context tier, as a participant's usage rows.
const USAGE_ROWS = [
  { input: 300_000, output: 1_000 },
  { input: 10_000, output: 500 },
  { input: 10_000, output: 500 },
];
const RECEIPT = {
  ordinal: 1,
  kind: "interaction" as const,
  dispatched: true,
  usageComplete: true,
  cleanup: "confirmed" as const,
  profileVerified: true,
  usage: { input: 20, output: 5 },
};

/** The fixture's first stream with three usage rows, three conversation rows and two receipts. */
function withLists(stream: RunStream): RunStream {
  return {
    ...stream,
    actor: {
      ...stream.actor!,
      tokenUsage: { input: 320_000, output: 2_000, total: 322_000, turns: USAGE_ROWS },
      conversation: {
        mode: "threaded",
        summarizedTurns: 0,
        requests: [{ mode: "threaded" }, { mode: "threaded" }, { mode: "threaded" }],
      },
      providerRequests: [RECEIPT, { ...RECEIPT, ordinal: 2 }],
    },
  };
}

describe("run bundle v4's per-request lists", () => {
  it("writes each finished participant's lists only in its trace file", async () => {
    const listed = withLists(v1.streams[0]!);
    const stored = await writeV2({ ...v1, streams: [listed] });
    expect(stored.schema).toBe("humanish.run-bundle.v4");
    const actor = stored.streams[0]!.actor!;
    expect(actor.tokenUsage).toEqual({ input: 320_000, output: 2_000, total: 322_000 });
    expect(actor.conversation).toEqual({ mode: "threaded", summarizedTurns: 0 });
    expect(actor).not.toHaveProperty("providerRequests");
    const file = JSON.parse(await readFile(path.join(runRoot, "actors/stream-001.json"), "utf8"));
    expect(file.tokenUsage.turns).toEqual(USAGE_ROWS);
    expect(file.conversation.requests).toHaveLength(3);
    expect(file.providerRequests).toEqual([RECEIPT, { ...RECEIPT, ordinal: 2 }]);
  });

  it("prices a running participant from its rows, then leaves them out of run.json", () => {
    const { actor: _actor, ...base } = v1.streams[0]!;
    const running: RunStream = {
      ...base,
      status: "running",
      liveActor: {
        schema: "humanish.live-actor.v1",
        updatedAt: "2026-10-13T08:00:00.000Z",
        ids: { model: "gpt-5.6-sol" },
        tokenUsage: { input: 320_000, output: 2_000, turns: USAGE_ROWS },
        providerRequests: [RECEIPT],
        // A producer's own figure is replaced by the one the rows give.
        estimatedCost: {
          schema: "humanish.actor-estimated-cost.v1",
          estimatedCostUsd: 9,
          ratesAsOf: "2026-01-01",
          source: "a producer",
        },
        items: [],
      },
    };
    const live = splitStreamTraces({ ...v1, streams: [running] }).bundle.streams[0]!.liveActor!;
    expect(live.tokenUsage).toEqual({ input: 320_000, output: 2_000 });
    expect(live).not.toHaveProperty("providerRequests");
    // 300,000 x $4/M x 2 + 1,000 x $20/M x 1.5 + 20,000 x $4/M + 1,000 x $20/M. From the totals
    // alone it would be 320,000 x $4/M + 2,000 x $20/M = $1.32.
    expect(live.estimatedCost).toMatchObject({
      schema: "humanish.actor-estimated-cost.v1",
      estimatedCostUsd: 2.53,
      ratesAsOf: "2026-09-03",
    });
    expect(live.estimatedCost?.source).toMatch(/pricing/);
  });

  it("loads the lists back from the trace file, with or without the bundle", async () => {
    const listed = v1.streams.map(withLists);
    const stored = await writeV2({ ...v1, streams: listed });
    const loaded = await loadStreamTraces(runPaths, stored);
    expect(loaded.refused).toEqual([]);
    expect(loaded.bundle.streams).toEqual(listed);
    expect(await loadStreamTrace(runPaths, stored.streams[1]!)).toEqual(listed[1]);
  });

  it("refuses a v4 run.json that holds a list, naming the participant", async () => {
    const stored = await writeV2({ ...v1, streams: v1.streams.map(withLists) });
    const [first, second] = stored.streams;
    const inlineTurns = {
      ...first!,
      actor: { ...first!.actor!, tokenUsage: { ...first!.actor!.tokenUsage, turns: USAGE_ROWS } },
    };
    const { outcome: _outcome, ...running } = stored;
    const liveReceipts = {
      ...second!,
      liveActor: {
        schema: "humanish.live-actor.v2",
        updatedAt: "2026-10-13T08:00:00.000Z",
        providerRequests: [RECEIPT],
        itemsFile: {
          path: "live/2.1.ndjson",
          generation: 1,
          items: 0,
          bytes: 0,
          sha256: createHash("sha256").digest("hex"),
        },
      },
    } as RunStream;
    const loaded = await loadStreamTraces(runPaths, {
      ...running,
      streams: [inlineTurns, liveReceipts],
    });
    expect(loaded.refused.map((error) => error.message)).toEqual([
      expect.stringMatching(/stream-001.*tokenUsage\.turns/),
      expect.stringMatching(/stream-002.*providerRequests/),
    ]);
  });

  it("shows a refused participant without the rows it refused", async () => {
    const stored = await writeV2({ ...v1, streams: [withLists(v1.streams[0]!)] });
    const [first] = stored.streams;
    const { estimatedCost: _estimate, ...actor } = first!.actor!;
    const inline = { ...actor, tokenUsage: { ...actor.tokenUsage, turns: USAGE_ROWS } };
    await writeFile(
      path.join(runRoot, "run.json"),
      JSON.stringify({ ...stored, streams: [{ ...first!, actor: inline }] }),
    );
    const [participant] = (await readRunDetail(cwd, RUN))!.participants;
    expect(participant!.evidenceUnavailable).toMatch(/tokenUsage\.turns/);
    // The totals alone would give $1.32 (320,000 x $4/M + 2,000 x $20/M) and the refused rows
    // $2.53, so run detail shows no figure.
    expect(participant).not.toHaveProperty("estimatedCostUsd");
  });

  it("refuses a trace file whose conversation has no requests list", async () => {
    const listed = withLists(v1.streams[0]!);
    const { requests: _requests, ...conversation } = listed.actor!.conversation!;
    const stored = await writeV2({
      ...v1,
      streams: [{ ...listed, actor: { ...listed.actor!, conversation } as ActorTrace }],
    });
    await expect(loadStreamTrace(runPaths, stored.streams[0]!)).rejects.toThrow(
      /stream-001.*conversation.*requests/,
    );
  });
});

describe("the rules each run bundle version is read under", () => {
  const unfinished = (bundle: StoredRunBundle): StoredRunBundle => {
    const { outcome: _outcome, ...rest } = bundle;
    return rest as StoredRunBundle;
  };
  const finished = (bundle: StoredRunBundle): StoredRunBundle => ({
    ...bundle,
    outcome: { state: "finished", ok: true, execution: { succeeded: true, failures: [] } },
  });
  /** The first stream as a running participant's whose items are in an empty live file. */
  const runningFromFile = async (stream: StoredRunStream): Promise<StoredRunStream> => {
    await mkdir(path.join(runRoot, "live"), { recursive: true });
    await writeFile(path.join(runRoot, "live/1.1.ndjson"), "");
    const { actor: _actor, trace: _trace, ...rest } = stream;
    return {
      ...rest,
      liveActor: {
        schema: "humanish.live-actor.v2",
        updatedAt: "2026-10-13T08:00:00.000Z",
        itemsFile: {
          path: "live/1.1.ndjson",
          generation: 1,
          items: 0,
          bytes: 0,
          sha256: createHash("sha256").digest("hex"),
        },
      },
    } as StoredRunStream;
  };
  // Each rule's run.json, built from the bundle the writer wrote, the versions that refuse it, and
  // the words of its refusal.
  const rules: [string, (stored: StoredRunBundle) => Promise<StoredRunBundle>, string[], RegExp][] =
    [
      [
        "two participants indexing one trace file",
        async (stored) => {
          const [first, second] = stored.streams;
          return { ...stored, streams: [first!, { ...second!, trace: first!.trace! }] };
        },
        ["v1", "v2", "v3", "v4"],
        /indexes .* for participants/,
      ],
      [
        "an actor without a trace index",
        async (stored) => ({ ...stored, streams: [v1.streams[0]!] }),
        ["v2", "v3", "v4"],
        /names no trace file/,
      ],
      [
        "in-progress items in a finished run",
        async (stored) =>
          finished({ ...stored, streams: [await runningFromFile(stored.streams[0]!)] }),
        ["v2", "v3", "v4"],
        /finished run/,
      ],
      [
        "in-progress items inline",
        async (stored) => {
          const { actor: _actor, trace: _trace, ...rest } = stored.streams[0]!;
          const live: StoredRunStream = {
            ...rest,
            liveActor: {
              schema: "humanish.live-actor.v1",
              updatedAt: "2026-10-13T08:00:00.000Z",
              items: [],
            },
          };
          return unfinished({ ...stored, streams: [live] });
        },
        ["v3", "v4"],
        /inline/,
      ],
      [
        "a per-request list in the actor",
        async (stored) => {
          const [first] = stored.streams;
          const usage = { ...first!.actor!.tokenUsage, turns: USAGE_ROWS };
          return {
            ...stored,
            streams: [{ ...first!, actor: { ...first!.actor!, tokenUsage: usage } }],
          };
        },
        ["v4"],
        /tokenUsage\.turns/,
      ],
    ];
  const cases = rules.flatMap(([rule, build, refusing, reason]) =>
    ["v1", "v2", "v3", "v4"].map(
      (version) => [rule, version, refusing.includes(version), build, reason] as const,
    ),
  );

  it.each(cases)(
    "%s in run.json %s: refused %s",
    async (_rule, version, refused, build, reason) => {
      const stored = await writeV2({ ...v1, streams: v1.streams.map(withLists) });
      const bundle = await build({ ...stored, schema: `humanish.run-bundle.${version}` as never });
      const messages = (await loadStreamTraces(runPaths, bundle)).refused.map(
        (error) => error.message,
      );
      expect(messages.length > 0).toBe(refused);
      // Every refusal names this cell's rule.
      expect(messages.filter((message) => !reason.test(message))).toEqual([]);
    },
  );
});

describe("loading a run's participant traces", () => {
  it("loads a v1 stream as it is and a v2 stream back to the same stream", async () => {
    expect(await loadStreamTrace(runPaths, v1.streams[1]!)).toEqual(v1.streams[1]);
    const stored = await writeV2(v1);
    for (const [index, stream] of stored.streams.entries())
      expect(await loadStreamTrace(runPaths, stream)).toEqual(v1.streams[index]);
  });

  it("refuses a trace whose bytes or digest differ from its index", async () => {
    const stored = await writeV2(v1);
    const file = path.join(runRoot, "actors/stream-002.json");
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace('"schema"', '"schemA"'));
    await expect(loadStreamTrace(runPaths, stored.streams[1]!)).rejects.toThrow(
      /stream-002.*sha256/,
    );
    await writeFile(file, `${original}\n`);
    await expect(loadStreamTrace(runPaths, stored.streams[1]!)).rejects.toThrow(
      /stream-002.*bytes/,
    );
  });

  it("refuses a trace the run wrote past the read limit without reading it, and says a copy will not help", async () => {
    const stored = await writeV2(v1);
    const stream = stored.streams[2]!;
    const limit = stream.trace!.bytes - 1;
    const asked: string[] = [];
    const loaded = await loadStreamTraces(
      async (relativePath) => {
        asked.push(relativePath);
        return { refused: `${relativePath} could not be read` };
      },
      { ...stored, streams: [stream] },
      { maxBytes: limit },
    );
    expect(asked).toEqual([]);
    expect(loaded.refused.map((error) => error.message)).toEqual([
      `Participant stream-003's trace was not read: run.json records actors/stream-003.json at ${limit + 1} bytes, more than the ${limit} bytes humanish reads of one file. Restoring a copy does not help; open the file with another tool, such as jq, to read its items.`,
    ]);
    await expect(loadStreamTrace(runPaths, stream, limit)).rejects.toThrow(StreamTraceRefusedError);
  });

  it("tells the reader to restore a trace that grew past the read limit after the run wrote it", async () => {
    const stored = await writeV2(v1);
    const stream = stored.streams[2]!;
    await writeFile(path.join(runRoot, "actors/stream-003.json"), "\n", { flag: "a" });
    await expect(loadStreamTrace(runPaths, stream, stream.trace!.bytes)).rejects.toThrow(
      /actors\/stream-003\.json is larger than \d+ bytes.*restore the run folder from a copy\.$/,
    );
  });

  it("refuses a v2 actor with no index, with or without inline items", async () => {
    const stored = await writeV2(v1);
    const { trace: _index, ...unindexed } = stored.streams[3]!;
    const inline = { ...unindexed, actor: v1.streams[3]!.actor } as RunStream;
    const tampered = { ...stored, streams: [...stored.streams.slice(0, 2), inline, unindexed] };
    const loaded = await loadStreamTraces(runPaths, tampered);
    expect(loaded.refused.map((error) => error.streamId)).toEqual(["stream-004", "stream-004"]);
    await expect(loadRunTraces(runPaths, tampered)).rejects.toThrow(/stream-004/);
    // The same inline streams in a v1 run.json are the v1 shape.
    expect((await loadStreamTraces(runPaths, { ...v1, streams: [inline] })).refused).toEqual([]);
  });

  it("refuses an index that names a file other than a trace file name", async () => {
    const stored = await writeV2(v1);
    const stream = stored.streams[0]!;
    for (const name of ["observer/index.html", "review.json", "traces/desktop.json"]) {
      const moved = { ...stream, trace: { ...stream.trace!, path: name } };
      expect(isRunStream(moved)).toBe(false);
      await expect(loadStreamTrace(runPaths, moved)).rejects.toThrow(/not a trace file name/);
    }
  });

  it("refuses two indexes whose paths differ only in case, on any file system", async () => {
    const stored = await writeV2(v1);
    const first = stored.streams[0]!;
    const bytes = await readFile(path.join(runRoot, first.trace!.path));
    const upper = { ...first, trace: { ...first.trace!, path: "actors/Case.json" } };
    const lower = { ...stored.streams[1]!, trace: { ...first.trace!, path: "actors/case.json" } };
    // A case-insensitive file system: both names open the same file.
    const loaded = await loadStreamTraces(async () => ({ bytes }), {
      ...stored,
      streams: [upper, lower],
    });
    expect(loaded.refused.map((error) => error.streamId)).toEqual([upper.id, lower.id]);
  });

  it("hands each consumed trace's bytes to the caller after they match the index", async () => {
    const stored = await writeV2(v1);
    const seen: { path: string; sha256: string }[] = [];
    await loadStreamTraces(runPaths, stored, {
      onTrace: (file, bytes) =>
        seen.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex") }),
    });
    expect(seen).toEqual(
      stored.streams.map((stream) => ({ path: stream.trace!.path, sha256: stream.trace!.sha256 })),
    );
  });

  it("reads in-progress items only in a v2 run.json whose run has not finished", async () => {
    // 0.123.0 and 0.124.0 wrote these files under run.json v2, with live items inline.
    const stored = { ...(await writeV2(v1)), schema: "humanish.run-bundle.v2" as const };
    const live = {
      ...stored.streams[0]!,
      liveActor: {
        schema: "humanish.live-actor.v1" as const,
        updatedAt: "2026-10-01T00:00:00.000Z",
        items: v1.streams[0]!.actor!.items,
      },
    };
    const { outcome: _outcome, ...unfinished } = { ...stored, streams: [live] };
    expect((await loadStreamTraces(runPaths, unfinished)).refused).toEqual([]);
    const finished = {
      ...unfinished,
      outcome: {
        state: "finished" as const,
        ok: true,
        execution: { succeeded: true, failures: [] },
      },
    };
    const loaded = await loadStreamTraces(runPaths, finished as StoredRunBundle);
    expect(loaded.refused.map((error) => error.message)).toEqual([
      expect.stringMatching(/stream-001.*finished run/),
    ]);
  });

  it("refuses a v2 stream that holds items beside its index", async () => {
    const stored = await writeV2(v1);
    const stream = stored.streams[0]!;
    const doubled = { ...stream, actor: { ...stream.actor!, items: [] } };
    await expect(loadStreamTrace(runPaths, doubled)).rejects.toThrow(/stream-001.*beside/);
  });
});
