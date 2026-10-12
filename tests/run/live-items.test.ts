// A running participant's items so far: run.json v3 indexes the live file that holds them, one item
// per line, and the trace loader joins them so every reader sees `liveActor.items` as before.

import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorTraceItem } from "../../src/actors/contract.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { resolveRunPath } from "../../src/run/locate.js";
import type { PreparedRunArtifactPaths } from "../../src/run/paths.js";
import { loadStreamTraces, splitStreamTraces } from "../../src/run/stream-trace.js";
import type { RunStream } from "../../src/run/streams.js";

const FIXTURE = path.resolve("tests/fixtures/runs-0107/source-convention-only");
const RUN = "fanout-proof-2026-10-01t00-00-00-000z-v2";

const FIRST: ActorTraceItem = {
  id: "reasoning-001",
  kind: "reasoning",
  lifecycle: "completed",
  title: "reasoning turn 1",
  text: "The lobby list is empty.",
  at: "2026-10-12T08:00:01.000Z",
};
const SECOND: ActorTraceItem = {
  id: "ui_action-002",
  kind: "ui_action",
  lifecycle: "completed",
  title: "click",
  coord: { x: 10, y: 20 },
  at: "2026-10-12T08:00:02.000Z",
};
/** The two items as the writer lays them out: one JSON line each. */
const TWO_LINES = `${JSON.stringify(FIRST)}\n${JSON.stringify(SECOND)}\n`;

let cwd: string;
let runRoot: string;
let runPaths: PreparedRunArtifactPaths;
let stored: RunBundle;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-live-items-"));
  runRoot = path.join(cwd, ".humanish", "runs", RUN);
  await cp(FIXTURE, runRoot, { recursive: true });
  const v1 = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
  const split = splitStreamTraces(v1);
  for (const file of split.files) await writeFile(path.join(runRoot, file.path), file.bytes);
  stored = split.bundle;
  await mkdir(path.join(runRoot, "live"));
  runPaths = (await resolveRunPath(cwd, RUN))!;
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The first stream with a live actor that indexes `file` as holding `text`. */
function liveStream(
  file: string,
  text: string,
  overrides: Record<string, unknown> = {},
): RunStream {
  const generation = Number(/\.(\d+)\.ndjson$/.exec(file)![1]);
  return {
    ...stored.streams[0]!,
    liveActor: {
      schema: "humanish.live-actor.v2",
      updatedAt: "2026-10-12T08:00:02.000Z",
      itemsFile: {
        path: file,
        generation,
        items: text.split("\n").length - 1,
        bytes: Buffer.byteLength(text),
        sha256: sha256(text),
      },
      ...overrides,
    } as unknown as NonNullable<RunStream["liveActor"]>,
  };
}

/** The bundle with its first stream replaced, as an in-progress run.json holds it. */
function inProgress(stream: RunStream): RunBundle {
  const { outcome: _outcome, ...rest } = stored;
  return { ...rest, streams: [stream, ...stored.streams.slice(1)] };
}

describe("loading a running participant's live items", () => {
  it("joins the indexed lines and ignores bytes appended past the index", async () => {
    await writeFile(path.join(runRoot, "live/1.1.ndjson"), `${TWO_LINES}{"id":"half`);
    const loaded = await loadStreamTraces(
      runPaths,
      inProgress(liveStream("live/1.1.ndjson", TWO_LINES)),
    );
    expect(loaded.refused).toEqual([]);
    const live = loaded.bundle.streams[0]!.liveActor!;
    expect(live.items).toEqual([FIRST, SECOND]);
    expect(live).not.toHaveProperty("itemsFile");
    expect(live.updatedAt).toBe("2026-10-12T08:00:02.000Z");
  });

  it("refuses indexed bytes that do not match the recorded sha256", async () => {
    await writeFile(path.join(runRoot, "live/1.1.ndjson"), TWO_LINES.replace("empty", "full!"));
    const loaded = await loadStreamTraces(
      runPaths,
      inProgress(liveStream("live/1.1.ndjson", TWO_LINES)),
    );
    expect(loaded.refused.map((error) => error.message)).toEqual([
      expect.stringMatching(/stream-001.*live\/1\.1\.ndjson does not match the sha256/),
    ]);
  });

  it("refuses an index whose item count differs from the lines it covers", async () => {
    await writeFile(path.join(runRoot, "live/1.1.ndjson"), TWO_LINES);
    const stream = liveStream("live/1.1.ndjson", TWO_LINES);
    const miscounted = {
      ...stream,
      liveActor: { ...stream.liveActor!, itemsFile: { ...stream.liveActor!.itemsFile!, items: 3 } },
    };
    const loaded = await loadStreamTraces(runPaths, inProgress(miscounted));
    expect(loaded.refused.map((error) => error.message)).toEqual([
      expect.stringMatching(/live\/1\.1\.ndjson holds 2 items and run\.json records 3/),
    ]);
  });

  it("refuses a file shorter than its index", async () => {
    await writeFile(path.join(runRoot, "live/1.1.ndjson"), `${JSON.stringify(FIRST)}\n`);
    const loaded = await loadStreamTraces(
      runPaths,
      inProgress(liveStream("live/1.1.ndjson", TWO_LINES)),
    );
    expect(loaded.refused).toHaveLength(1);
    expect(loaded.bundle.streams[0]!.liveActor!).not.toHaveProperty("items");
  });

  it("refuses a live-actor schema it does not know, and inline items in a v3 run.json", async () => {
    const unknown = liveStream("live/1.1.ndjson", TWO_LINES, { schema: "humanish.live-actor.v9" });
    const inline = {
      ...stored.streams[1]!,
      liveActor: {
        schema: "humanish.live-actor.v1" as const,
        updatedAt: "2026-10-12T08:00:02.000Z",
        items: [FIRST],
      },
    };
    await writeFile(path.join(runRoot, "live/1.1.ndjson"), TWO_LINES);
    const loaded = await loadStreamTraces(runPaths, {
      ...inProgress(unknown),
      streams: [unknown, inline],
    });
    expect(loaded.refused.map((error) => error.message)).toEqual([
      expect.stringMatching(/stream-001.*humanish\.live-actor\.v9/),
      expect.stringMatching(/stream-002.*inline/),
    ]);
  });

  it("refuses an index that names a file outside live/", async () => {
    for (const name of ["actor.json", "live/../run.json", "live/1.ndjson", "live/1.2.ndjson"]) {
      const stream = liveStream("live/1.1.ndjson", TWO_LINES);
      const moved = {
        ...stream,
        liveActor: {
          ...stream.liveActor!,
          itemsFile: { ...stream.liveActor!.itemsFile!, path: name },
        },
      };
      const loaded = await loadStreamTraces(runPaths, inProgress(moved));
      expect(loaded.refused.map((error) => error.message)).toEqual([
        expect.stringMatching(/malformed live items index/),
      ]);
    }
  });

  it("re-reads run.json once when the generation it indexes is gone", async () => {
    // The writer started generation 2 and removed generation 1 after this reader read run.json.
    const later = `${TWO_LINES}${JSON.stringify({ ...SECOND, id: "ui_action-003" })}\n`;
    await writeFile(path.join(runRoot, "live/1.2.ndjson"), later);
    const current = inProgress(liveStream("live/1.2.ndjson", later));
    await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify(current, null, 2)}\n`);
    const loaded = await loadStreamTraces(
      runPaths,
      inProgress(liveStream("live/1.1.ndjson", TWO_LINES)),
    );
    expect(loaded.refused).toEqual([]);
    expect(loaded.bundle.streams[0]!.liveActor!.items.map((item) => item.id)).toEqual([
      "reasoning-001",
      "ui_action-002",
      "ui_action-003",
    ]);
  });

  it("re-reads run.json once when the generation a cursor names is gone, and reads the next whole", async () => {
    // The caller holds the first item of generation 1; the writer moved to generation 2 and
    // removed generation 1 after this reader read run.json.
    const later = `${TWO_LINES}${JSON.stringify({ ...SECOND, id: "ui_action-003" })}\n`;
    await writeFile(path.join(runRoot, "live/1.2.ndjson"), later);
    const current = inProgress(liveStream("live/1.2.ndjson", later));
    await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify(current, null, 2)}\n`);
    const held = { items: 1, bytes: Buffer.byteLength(`${JSON.stringify(FIRST)}\n`) };
    const loaded = await loadStreamTraces(
      runPaths,
      inProgress(liveStream("live/1.1.ndjson", TWO_LINES)),
      { liveAfter: (index) => (index.path === "live/1.1.ndjson" ? held : undefined) },
    );
    expect(loaded.refused).toEqual([]);
    expect(loaded.bundle.streams[0]!.liveActor!.items.map((item) => item.id)).toEqual([
      "reasoning-001",
      "ui_action-002",
      "ui_action-003",
    ]);
    expect(loaded.live).toEqual([
      { streamId: "stream-001", index: current.streams[0]!.liveActor!.itemsFile },
    ]);
  });

  it("re-reads run.json once when the run finished and removed its live files", async () => {
    await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify(stored, null, 2)}\n`);
    const loaded = await loadStreamTraces(
      runPaths,
      inProgress(liveStream("live/1.1.ndjson", TWO_LINES)),
    );
    expect(loaded.refused).toEqual([]);
    expect(loaded.bundle.streams[0]!.liveActor).toBeUndefined();
    expect(loaded.bundle.streams[0]!.actor!.items.length).toBeGreaterThan(0);
  });

  it("refuses the stream when run.json, read again, still names the missing file", async () => {
    const indexed = inProgress(liveStream("live/1.1.ndjson", TWO_LINES));
    await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify(indexed, null, 2)}\n`);
    const loaded = await loadStreamTraces(runPaths, indexed);
    expect(loaded.refused.map((error) => error.message)).toEqual([
      expect.stringMatching(/stream-001.*live\/1\.1\.ndjson is missing/),
    ]);
  });

  it("hands the joined live bytes to the caller", async () => {
    await writeFile(path.join(runRoot, "live/1.1.ndjson"), TWO_LINES);
    await appendFile(path.join(runRoot, "live/1.1.ndjson"), "{}\n");
    const seen: { path: string; text: string }[] = [];
    await loadStreamTraces(runPaths, inProgress(liveStream("live/1.1.ndjson", TWO_LINES)), {
      onTrace: (file, bytes) => seen.push({ path: file, text: bytes.toString("utf8") }),
    });
    expect(seen.filter((entry) => entry.path.startsWith("live/"))).toEqual([
      { path: "live/1.1.ndjson", text: TWO_LINES },
    ]);
  });
});
