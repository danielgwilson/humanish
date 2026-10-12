// Where a participant's trace lives: run.json v2 keeps each stream's summary and an index, and the
// trace file holds the items and the screenshot entries. The loader gives readers the stream as a
// v1 bundle held it, and refuses a trace that does not match its index.

import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunBundle } from "../../src/run/bundle.js";
import { resolveRunPath } from "../../src/run/locate.js";
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

describe("a run's participant traces", () => {
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

  it("refuses a v2 stream whose actor has neither its items nor an index", async () => {
    const stored = await writeV2(v1);
    const { trace: _index, ...unindexed } = stored.streams[3]!;
    const tampered = { ...stored, streams: [...stored.streams.slice(0, 3), unindexed] };
    const loaded = await loadStreamTraces(runPaths, tampered);
    expect(loaded.refused.map((error) => error.streamId)).toEqual(["stream-004"]);
    await expect(loadRunTraces(runPaths, tampered)).rejects.toThrow(/stream-004/);
  });

  it("refuses a v2 stream that holds items beside its index", async () => {
    const stored = await writeV2(v1);
    const stream = stored.streams[0]!;
    const doubled = { ...stream, actor: { ...stream.actor!, items: [] } };
    await expect(loadStreamTrace(runPaths, doubled)).rejects.toThrow(/stream-001.*beside/);
  });
});
