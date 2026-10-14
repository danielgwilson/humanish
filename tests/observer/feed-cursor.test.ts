// The Observer feed sends a running participant's live items only past the cursor the page sends
// back. A cursor names the live file and the prefix the page holds; the server answers with the
// items after it, or with the full list when it cannot use the cursor. Every case runs the real
// run writer and polls the real library server.

import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ActorTraceItem } from "../../src/actors/contract.js";
import { buildObserverData } from "../../src/observer/data.js";
import type { PackedObserverItems } from "../../src/observer/participant-items.js";
import { serveObserverLibrary } from "../../src/observer/serve.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { RUN_ARTIFACT_MAX_BYTES } from "../../src/run/contained-output.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { runScope, type RunScope } from "../../src/run/run.js";
import type { RunStream } from "../../src/run/streams.js";
import { PASSING_OUTCOME } from "../helpers/finished-run.js";
import { unpackItems } from "../helpers/observer-page.js";

const RUN = "synthetic-feed-cursor";
const item = (n: number): ActorTraceItem => ({
  id: `reasoning-${String(n).padStart(3, "0")}`,
  kind: "reasoning",
  lifecycle: "completed",
  title: `reasoning turn ${n}`,
  text: `Step ${n} on the list.`,
  at: `2026-10-12T08:00:0${n}.000Z`,
});
/** The bytes the items take in a live file, one JSON line each (docs/contracts/run-bundle.md). */
const bytes = (...items: ActorTraceItem[]) =>
  items.reduce((sum, entry) => sum + Buffer.byteLength(`${JSON.stringify(entry)}\n`), 0);

let template: RunBundle;
let templateRoot: string;
let cwd: string;

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(tmpdir(), "humanish-feed-cursor-template-"));
  expect((await runDryRun({ cwd: templateRoot, dryRun: true, runId: "template" })).ok).toBe(true);
  template = JSON.parse(
    await readFile(path.join(templateRoot, ".humanish", "runs", "template", "run.json"), "utf8"),
  ) as RunBundle;
});
afterAll(async () => {
  await rm(templateRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-feed-cursor-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const runFile = (file: string) => path.join(cwd, ".humanish", "runs", RUN, file);

/** The template's stream as a running participant's, with its items so far. */
function running(stream: RunStream, items: readonly ActorTraceItem[]): RunStream {
  const { actor: _actor, trace: _trace, ...rest } = stream;
  return {
    ...rest,
    status: "running",
    liveActor: {
      schema: "humanish.live-actor.v1",
      updatedAt: "2026-10-12T08:00:09.000Z",
      items: items as ActorTraceItem[],
    },
  };
}

/** The bundle with one running stream per list: the template's stream, then copies of it. */
function inProgress(...lists: (readonly ActorTraceItem[])[]): RunBundle {
  const { outcome: _outcome, ...rest } = template;
  const [first] = template.streams;
  return {
    ...rest,
    runId: RUN,
    artifactRoot: path.join(".humanish", "runs", RUN),
    streams: lists.map((items, index) =>
      running(index === 0 ? first! : { ...first!, id: `stream-extra-${index}` }, items),
    ),
  };
}

type Run = Awaited<ReturnType<RunScope["startRun"]>> & { ok: true };

async function withRun(body: (run: Run["run"]) => Promise<void>): Promise<void> {
  await runScope(async (scope) => {
    const started = await scope.startRun({
      cwd,
      runId: RUN,
      mintRunId: () => RUN,
      mode: "dry-run",
      renderReview: (bundle) => `# Review ${bundle.runId}\n`,
    });
    if (!started.ok) throw new Error(started.message);
    await body(started.run);
  });
}

interface FeedEntry {
  liveActor?: ActorTraceItem[];
  actor?: ActorTraceItem[];
  live?: string;
  liveAfter?: string;
}
interface FeedBody {
  data: {
    run: { runId: string };
    streams: {
      id: string;
      traceUnavailable?: string;
      timeline: { type: string; level: string; message: string }[];
    }[];
  };
  items: { schema: string; runId: string; streams: Record<string, FeedEntry> };
}
/** A body as the server sends it: each participant's entry is gzip-compressed JSON in base64. */
type PackedFeedBody = Omit<FeedBody, "items"> & { items: PackedObserverItems };

let server: { url: string; close(): Promise<void> } | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** One poll of the run's feed, sending `after` when given, with each participant's entry decoded. */
async function poll(after?: string): Promise<FeedBody> {
  const body = await pollPacked(after);
  return { ...body, items: unpackItems(body.items) };
}

/** One poll of the run's feed, as the server sends it. */
async function pollPacked(after?: string): Promise<PackedFeedBody> {
  if (server === undefined) {
    const started = await serveObserverLibrary(cwd, {
      port: 0,
      safe: false,
      expose: false,
      edgeAuthed: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    server = started.server;
  }
  const url = new URL(`/_humanish/runs/${RUN}/observer/observer-feed.json`, server.url);
  if (after !== undefined) url.searchParams.set("after", after);
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return (await response.json()) as PackedFeedBody;
}

/** The items entry of stream `position` (from 0). */
const entry = (body: FeedBody, position: number): FeedEntry | undefined =>
  body.items.streams[body.data.streams[position]!.id];
const ids = (items: ActorTraceItem[] | undefined) => items?.map((value) => value.id);
/** A body without the times each response stamps. */
const withoutClock = (body: FeedBody) =>
  JSON.parse(JSON.stringify(body).replace(/"(generatedAt|observedAt)":"[^"]*"/g, '"$1":""'));
/** The cursors a body gives, as the page sends them back. */
const cursorsOf = (body: FeedBody) =>
  Object.values(body.items.streams)
    .flatMap((value) => (value.live === undefined ? [] : [value.live]))
    .join(",");

describe("the Observer feed's items", () => {
  it("packs each participant's entry on its own, as the page packs them", async () => {
    const [a, b, c] = [item(1), item(2), item(3)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b], [c]));
      const body = await pollPacked();
      expect(body.items.schema).toBe("humanish.observer-items.v2");
      expect(body.items.streams.map(([id]) => id)).toEqual(
        body.data.streams.map((stream) => stream.id),
      );
      const decoded = body.items.streams.map(
        ([, packed]) =>
          JSON.parse(gunzipSync(Buffer.from(packed, "base64")).toString("utf8")) as FeedEntry,
      );
      expect(decoded.map((value) => ids(value.liveActor))).toEqual([
        ["reasoning-001", "reasoning-002"],
        ["reasoning-003"],
      ]);
      expect(decoded.map((value) => value.live)).toEqual([
        `1.1.2.${bytes(a, b)}`,
        `2.1.1.${bytes(c)}`,
      ]);
    });
  });
});

describe("the Observer feed's live cursors", () => {
  it("gives each running participant's cursor: its live file, items and bytes", async () => {
    const [a, b, c] = [item(1), item(2), item(3)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b], [c]));
      const first = await poll();
      expect(ids(entry(first, 0)?.liveActor)).toEqual(["reasoning-001", "reasoning-002"]);
      expect(entry(first, 0)?.live).toBe(`1.1.2.${bytes(a, b)}`);
      expect(entry(first, 0)?.liveAfter).toBeUndefined();
      expect(entry(first, 1)?.live).toBe(`2.1.1.${bytes(c)}`);
    });
  });

  it("sends only the items past each cursor the page sends back, and says which cursor they follow", async () => {
    const [a, b, c, d] = [item(1), item(2), item(3), item(4)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b], [c]));
      const first = await poll();
      await run.writeSnapshot(inProgress([a, b, d], [c]));
      const next = await poll(cursorsOf(first));
      expect(ids(entry(next, 0)?.liveActor)).toEqual(["reasoning-004"]);
      expect(entry(next, 0)?.liveAfter).toBe(`1.1.2.${bytes(a, b)}`);
      expect(entry(next, 0)?.live).toBe(`1.1.3.${bytes(a, b, d)}`);
      expect(entry(next, 1)?.liveActor).toEqual([]);
      expect(entry(next, 1)?.liveAfter).toBe(`2.1.1.${bytes(c)}`);
      expect(entry(next, 1)?.live).toBe(`2.1.1.${bytes(c)}`);
    });
  });

  it("gives a participant whose writer started a new generation its full list", async () => {
    const [a, b, c, d] = [item(1), item(2), item(3), item(4)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b], [c]));
      const first = await poll();
      // A replaced item (a new object for item 1) makes the writer start live/1.2.ndjson.
      const replaced = { ...a };
      await run.writeSnapshot(inProgress([replaced, b, d], [c]));
      const next = await poll(cursorsOf(first));
      expect(ids(entry(next, 0)?.liveActor)).toEqual([
        "reasoning-001",
        "reasoning-002",
        "reasoning-004",
      ]);
      expect(entry(next, 0)?.liveAfter).toBeUndefined();
      expect(entry(next, 0)?.live).toBe(`1.2.3.${bytes(a, b, d)}`);
      expect(entry(next, 1)?.liveAfter).toBe(`2.1.1.${bytes(c)}`);
    });
  });

  it("reads only the bytes past a cursor, so a change before it shows on the next whole read", async () => {
    const [a, b, c] = [item(1), item(2), item(3)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
      const first = await poll();
      // One byte of item 1's line changes in place; the file keeps its length.
      const file = await open(runFile("live/1.1.ndjson"), "r+");
      await file.write("X", 2);
      await file.close();
      await run.writeSnapshot(inProgress([a, b, c]));
      expect(ids(entry(await poll(cursorsOf(first)), 0)?.liveActor)).toEqual(["reasoning-003"]);
      const whole = await poll();
      expect(whole.data.streams[0]!.traceUnavailable).toMatch(/live\/1\.1\.ndjson does not match/);
      expect(entry(whole, 0)?.live).toBeUndefined();
    });
  });

  it("gives the full list for a cursor past the index, off a line end or miscounted", async () => {
    const [a, b, c] = [item(1), item(2), item(3)];
    const cases = [
      `1.1.3.${bytes(a, b, c)}`,
      `1.1.1.${bytes(a) + 1}`,
      `1.1.2.${bytes(a)}`,
      `1.1.1.${bytes(a, b)}`,
      `1.2.1.${bytes(a)}`,
    ];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
      for (const cursor of cases) {
        const body = await poll(cursor);
        expect(ids(entry(body, 0)?.liveActor), cursor).toEqual(["reasoning-001", "reasoning-002"]);
        expect(entry(body, 0)?.liveAfter, cursor).toBeUndefined();
        expect(entry(body, 0)?.live, cursor).toBe(`1.1.2.${bytes(a, b)}`);
      }
    });
  });

  it("ignores a malformed after parameter whole, so every list comes in full", async () => {
    const [a, b, c] = [item(1), item(2), item(3)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b], [c]));
      const good = `1.1.1.${bytes(a)}`;
      for (const after of [`${good},01.1.1.5`, `${good},${good}`, `${good},2.1.x.1`, `${good},`]) {
        const body = await poll(after);
        expect(ids(entry(body, 0)?.liveActor), after).toEqual(["reasoning-001", "reasoning-002"]);
        expect(entry(body, 0)?.liveAfter, after).toBeUndefined();
      }
      // The well-formed cursor alone is used.
      expect(ids(entry(await poll(good), 0)?.liveActor)).toEqual(["reasoning-002"]);
    });
  });

  it("gives a finished run's full projection with no cursors", async () => {
    const [a, b] = [item(1), item(2)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
      const first = await poll();
      await run.finish(
        { ...template, runId: RUN, artifactRoot: path.join(".humanish", "runs", RUN) },
        PASSING_OUTCOME,
      );
      expect(cursorsOf(first)).not.toBe("");
      const body = await poll(cursorsOf(first));
      for (const value of Object.values(body.items.streams)) {
        expect(value.live).toBeUndefined();
        expect(value.liveAfter).toBeUndefined();
        expect(value.liveActor).toBeUndefined();
      }
      // The answer to the page's cursors is the answer to a page that sent none.
      expect(withoutClock(body)).toEqual(withoutClock(await poll()));
    });
  });
});

describe("the Observer feed of a run with no live files", () => {
  it("gives a v2 run.json's inline live items in full, with no cursor", async () => {
    const [a, b] = [item(1), item(2)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
    });
    // A run.json 0.124.0 wrote mid-run: v2, with the live items inline.
    const stored = JSON.parse(await readFile(runFile("run.json"), "utf8")) as RunBundle;
    const v2 = {
      ...stored,
      schema: "humanish.run-bundle.v2",
      streams: stored.streams.map((stream) => running(stream, [a, b])),
    };
    await writeFile(runFile("run.json"), `${JSON.stringify(v2, null, 2)}\n`);
    await rm(runFile("live"), { recursive: true, force: true });
    const body = await poll(`1.1.1.${bytes(a)}`);
    expect(ids(entry(body, 0)?.liveActor)).toEqual(["reasoning-001", "reasoning-002"]);
    expect(entry(body, 0)?.live).toBeUndefined();
    expect(entry(body, 0)?.liveAfter).toBeUndefined();
  });

  it("gives the saved observer-data.json of a run with no run.json, with no cursor", async () => {
    const [a, b] = [item(1), item(2)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
    });
    // An observer-data.json written before v2 holds each participant's items.
    const stored = JSON.parse(await readFile(runFile("run.json"), "utf8")) as RunBundle;
    const saved = {
      ...buildObserverData({
        ...stored,
        streams: stored.streams.map((stream) => running(stream, [a, b])),
      }),
      schema: "humanish.observer-data.v1",
    };
    await writeFile(runFile("observer/observer-data.json"), JSON.stringify(saved));
    await rm(runFile("run.json"));
    await rm(runFile("live"), { recursive: true, force: true });
    const body = await poll(`1.1.1.${bytes(a)}`);
    expect(ids(entry(body, 0)?.liveActor)).toEqual(["reasoning-001", "reasoning-002"]);
    expect(entry(body, 0)?.live).toBeUndefined();
    expect(entry(body, 0)?.liveAfter).toBeUndefined();
  });
});

// The bodies a page meets over one run, kept for the page's tests (observer/tests/feed-cursor.test.tsx):
// each entry is the `after` a poll sent and the body the server answered, with each participant's
// packed entry decoded so the diff reads. Rerun with UPDATE_OBSERVER_FEED_GOLDENS=1 after an
// intended change to the feed and review the diff.
const SEQUENCE_GOLDEN = path.resolve("tests/golden/observer-feed/sequence.json");

/** A body with every timestamp masked, so two runs of the writer compare equal. */
const masked = (value: unknown) =>
  JSON.parse(JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "[ts]"));

describe("the bodies a page polls over one run", () => {
  it("are the committed sequence: full, tails, a new generation, finished", async () => {
    const [a, b, c, d, e, f] = [item(1), item(2), item(3), item(4), item(5), item(6)];
    const sequence: { after: string | null; body: FeedBody }[] = [];
    const record = async (after: string | null) => {
      const body = await poll(after ?? undefined);
      sequence.push({ after, body });
      return body;
    };
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b], [c]));
      const first = await record(null);
      await run.writeSnapshot(inProgress([a, b, d], [c]));
      const second = await record(cursorsOf(first));
      await run.writeSnapshot(inProgress([{ ...a }, b, d, e], [c, f]));
      const third = await record(cursorsOf(second));
      await run.finish(
        { ...template, runId: RUN, artifactRoot: path.join(".humanish", "runs", RUN) },
        PASSING_OUTCOME,
      );
      await record(cursorsOf(third));
    });
    if (process.env.UPDATE_OBSERVER_FEED_GOLDENS) {
      await mkdir(path.dirname(SEQUENCE_GOLDEN), { recursive: true });
      await writeFile(SEQUENCE_GOLDEN, `${JSON.stringify(sequence, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(await readFile(SEQUENCE_GOLDEN, "utf8")) as unknown;
    expect(masked(sequence)).toEqual(masked(golden));
  });
});

// The bodies a page meets when a participant's live file passes the read limit, kept for the page's
// tests (observer/tests/feed-cursor.test.tsx). Rerun with UPDATE_OBSERVER_FEED_GOLDENS=1 as above.
const PAST_LIMIT_GOLDEN = path.resolve("tests/golden/observer-feed/past-limit.json");

describe("the Observer feed of a participant whose live file passes the read limit", () => {
  it("keeps the page's items at its cursor and warns that later items are not read", async () => {
    const [a, b] = [item(1), item(2)];
    // One item whose text alone takes the live file past RUN_ARTIFACT_MAX_BYTES (32 MiB).
    const large = { ...item(3), text: "x".repeat(RUN_ARTIFACT_MAX_BYTES) };
    const sequence: { after: string | null; body: FeedBody }[] = [];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
      const first = await poll();
      sequence.push({ after: null, body: first });
      await run.writeSnapshot(inProgress([a, b, large]));
      const held = cursorsOf(first);
      const next = await poll(held);
      sequence.push({ after: held, body: next });
      expect(entry(next, 0)?.liveActor).toEqual([]);
      expect(entry(next, 0)?.liveAfter).toBe(held);
      expect(entry(next, 0)?.live).toBe(held);
      expect(next.data.streams[0]!.traceUnavailable).toBeUndefined();
      const warnings = next.data.streams[0]!.timeline.filter(
        (event) => event.type === "live-items.not-read",
      );
      expect(warnings.map((event) => event.level)).toEqual(["warn"]);
      expect(warnings[0]!.message).toMatch(
        new RegExp(
          `items past 2 were not read: run.json records live/1\\.1\\.ndjson at \\d+ bytes, more than the ${RUN_ARTIFACT_MAX_BYTES} bytes`,
        ),
      );
      // The page sends the same cursor again and gets the same answer.
      expect(withoutClock(await poll(held))).toEqual(withoutClock(next));
      // A page that holds none of the items gets the trace unavailable, with the file's size.
      const fresh = await poll();
      expect(fresh.data.streams[0]!.traceUnavailable).toMatch(
        new RegExp(
          `live/1\\.1\\.ndjson at \\d+ bytes, more than the ${RUN_ARTIFACT_MAX_BYTES} bytes`,
        ),
      );
      expect(entry(fresh, 0)?.live).toBeUndefined();
      // The finished participant's trace file is past the limit too: every page gets it unavailable.
      const { trace: _trace, ...finished } = template.streams[0]!;
      await run.finish(
        {
          ...template,
          runId: RUN,
          artifactRoot: path.join(".humanish", "runs", RUN),
          streams: [{ ...finished, actor: { ...finished.actor!, items: [a, b, large] } }],
        },
        PASSING_OUTCOME,
      );
      const done = await poll(held);
      expect(done.data.streams[0]!.traceUnavailable).toMatch(
        new RegExp(
          `run\\.json records actors/\\S+ at \\d+ bytes, more than the ${RUN_ARTIFACT_MAX_BYTES} bytes`,
        ),
      );
      expect(entry(done, 0)?.actor).toEqual([]);
      expect(entry(done, 0)?.live).toBeUndefined();
    });
    if (process.env.UPDATE_OBSERVER_FEED_GOLDENS) {
      await mkdir(path.dirname(PAST_LIMIT_GOLDEN), { recursive: true });
      await writeFile(PAST_LIMIT_GOLDEN, `${JSON.stringify(sequence, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(await readFile(PAST_LIMIT_GOLDEN, "utf8")) as unknown;
    expect(masked(sequence)).toEqual(masked(golden));
  });
});
