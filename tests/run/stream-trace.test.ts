// Where a participant's trace lives: run.json v2 keeps each stream's summary and an index, and the
// trace file holds the items and the screenshot entries. The loader gives readers the stream as a
// v1 bundle held it, and refuses a trace that does not match its index.

import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunBundle } from "../../src/run/bundle.js";
import type { RunStream } from "../../src/run/streams.js";
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
async function writeV2(bundle: RunBundle): Promise<RunBundle> {
  const split = splitStreamTraces(bundle);
  for (const file of split.files) await writeFile(path.join(runRoot, file.path), file.bytes);
  await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify(split.bundle, null, 2)}\n`);
  return split.bundle;
}

describe("writing a run's participant traces", () => {
  it("keeps each stream's summary and index in run.json and its items in the trace file", async () => {
    const stored = await writeV2(v1);
    expect(stored.schema).toBe("humanish.run-bundle.v2");
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

  it("refuses a trace over the read limit without reading it", async () => {
    const stored = await writeV2(v1);
    const stream = stored.streams[2]!;
    await expect(loadStreamTrace(runPaths, stream, stream.trace!.bytes - 1)).rejects.toThrow(
      StreamTraceRefusedError,
    );
    await expect(loadStreamTrace(runPaths, stream, stream.trace!.bytes - 1)).rejects.toThrow(
      /larger than/,
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
    const stored = await writeV2(v1);
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
    const loaded = await loadStreamTraces(runPaths, finished as RunBundle);
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
