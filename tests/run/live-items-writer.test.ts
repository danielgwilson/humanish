// The run writer keeps each running participant's items so far in an append-only live file: a
// snapshot appends what is new, a new generation starts when appending cannot keep the file equal
// to the participant's list, and the final publication removes the live files. Every reader of
// the run loads the items back through the trace loader.

import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ActorTraceItem } from "../../src/actors/contract.js";
import { serveObserverLibrary } from "../../src/observer/serve.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { readRunDetail } from "../../src/run/detail.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { runScope, type RunScope } from "../../src/run/run.js";
import { appendSandboxReceipt } from "../../src/run/sandbox-receipts.js";
import type { RunStream } from "../../src/run/streams.js";
import { verifyRun } from "../../src/verify/verify.js";
import { PASSING_OUTCOME } from "../helpers/finished-run.js";
import { readRunWithTraces } from "../helpers/run-traces.js";

const RUN = "synthetic-live-items";
const item = (n: number, text = `Step ${n} on the list.`): ActorTraceItem => ({
  id: `reasoning-${String(n).padStart(3, "0")}`,
  kind: "reasoning",
  lifecycle: "completed",
  title: `reasoning turn ${n}`,
  text,
  at: `2026-10-12T08:00:0${n}.000Z`,
});
const line = (value: ActorTraceItem) => `${JSON.stringify(value)}\n`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let template: RunBundle;
let templateRoot: string;
let cwd: string;

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(tmpdir(), "humanish-live-template-"));
  expect((await runDryRun({ cwd: templateRoot, dryRun: true, runId: "template" })).ok).toBe(true);
  template = JSON.parse(
    await readFile(path.join(templateRoot, ".humanish", "runs", "template", "run.json"), "utf8"),
  ) as RunBundle;
});
afterAll(async () => {
  await rm(templateRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-live-items-writer-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const runDir = () => path.join(cwd, ".humanish", "runs", RUN);
const readText = (file: string) => readFile(path.join(runDir(), file), "utf8");
const liveFiles = async () => (await readdir(path.join(runDir(), "live")).catch(() => [])).sort();
const storedLive = async (position = 0) =>
  (JSON.parse(await readText("run.json")) as RunBundle).streams[position]!.liveActor;

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

/**
 * The bundle with one running stream per list, each with those items: the template's stream, then
 * copies of it under other ids.
 */
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

/** Runs `body` with a started run of the test project. */
async function withRun(
  body: (run: Awaited<ReturnType<typeof startRun>>) => Promise<void>,
): Promise<void> {
  await runScope(async (scope) => body(await startRun(scope)));
}
async function startRun(scope: RunScope) {
  const started = await scope.startRun({
    cwd,
    runId: RUN,
    mintRunId: () => RUN,
    mode: "dry-run",
    renderReview: (bundle) => `# Review ${bundle.runId}\n`,
  });
  if (!started.ok) throw new Error(started.message);
  return started.run;
}

describe("the run writer's live items", () => {
  it("writes a running participant's items one per line and indexes them in run.json", async () => {
    const [a, b] = [item(1), item(2)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
    });
    expect(await readText("live/1.1.ndjson")).toBe(line(a) + line(b));
    const live = await storedLive();
    expect(live).toEqual({
      schema: "humanish.live-actor.v2",
      updatedAt: "2026-10-12T08:00:09.000Z",
      itemsFile: {
        path: "live/1.1.ndjson",
        generation: 1,
        items: 2,
        bytes: Buffer.byteLength(line(a) + line(b)),
        sha256: sha256(line(a) + line(b)),
      },
    });
    expect(JSON.parse(await readText("run.json")).schema).toBe("humanish.run-bundle.v3");
  });

  it("appends only the items recorded since the last write, to the same file", async () => {
    const [a, b, c] = [item(1), item(2), item(3)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
      const before = await stat(path.join(runDir(), "live/1.1.ndjson"));
      await run.writeSnapshot(inProgress([a, b, c]));
      expect((await stat(path.join(runDir(), "live/1.1.ndjson"))).ino).toBe(before.ino);
    });
    expect(await readText("live/1.1.ndjson")).toBe(line(a) + line(b) + line(c));
    expect((await storedLive())?.itemsFile).toMatchObject({ generation: 1, items: 3 });
  });

  it("names each participant's file by its stream position", async () => {
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([item(1)], [item(2), item(3)]));
    });
    expect(await liveFiles()).toEqual(["1.1.ndjson", "2.1.ndjson"]);
    expect((await storedLive(1))?.itemsFile).toMatchObject({ path: "live/2.1.ndjson", items: 2 });
  });

  it("starts the next generation with the full list when an earlier item is replaced", async () => {
    const [a, b, c] = [item(1), item(2), item(3)];
    const replaced = item(2, "Step 2, said again.");
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
      await run.writeSnapshot(inProgress([a, replaced, c]));
    });
    expect(await liveFiles()).toEqual(["1.2.ndjson"]);
    expect(await readText("live/1.2.ndjson")).toBe(line(a) + line(replaced) + line(c));
    expect((await storedLive())?.itemsFile).toMatchObject({
      path: "live/1.2.ndjson",
      generation: 2,
    });
  });

  it("starts the next generation when the list shrinks", async () => {
    const [a, b, c] = [item(1), item(2), item(3)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b, c]));
      await run.writeSnapshot(inProgress([a, b]));
    });
    expect(await liveFiles()).toEqual(["1.2.ndjson"]);
    expect(await readText("live/1.2.ndjson")).toBe(line(a) + line(b));
  });

  it("starts the next generation when an append fails", async () => {
    const [a, b, c] = [item(1), item(2), item(3)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
      // Bytes the writer did not write: its next append refuses the file.
      await appendFile(path.join(runDir(), "live/1.1.ndjson"), "{}\n");
      await run.writeSnapshot(inProgress([a, b, c]));
    });
    expect(await liveFiles()).toEqual(["1.2.ndjson"]);
    expect(await readText("live/1.2.ndjson")).toBe(line(a) + line(b) + line(c));
  });

  it("scrubs a known sandbox id from new items, and rewrites a generation that holds one learned later", async () => {
    const early = item(1, "The page names synthetic-sandbox-one in its footer.");
    const later = item(2, "synthetic-sandbox-one again.");
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([early]));
      expect(await readText("live/1.1.ndjson")).toContain("synthetic-sandbox-one");
      await appendSandboxReceipt(run.paths, {
        at: "2026-10-12T08:00:05.000Z",
        laneId: "participant-1",
        sandboxId: "synthetic-sandbox-one",
      });
      await run.writeSnapshot(inProgress([early, later]));
    });
    expect(await liveFiles()).toEqual(["1.2.ndjson"]);
    const text = await readText("live/1.2.ndjson");
    expect(text).not.toContain("synthetic-sandbox-one");
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(text).toContain("[redacted-sandbox-id ");
  });

  it("keeps the live files of a run that ends without its final write, readable by the loader", async () => {
    const [a, b] = [item(1), item(2)];
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([a, b]));
    });
    expect(await liveFiles()).toEqual(["1.1.ndjson"]);
    const loaded = await readRunWithTraces(runDir());
    expect(loaded.streams[0]!.liveActor?.items).toEqual([a, b]);
  });

  it("removes the live files and their folder after the final run.json", async () => {
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([item(1), item(2)]));
      await run.writeSnapshot(inProgress([item(3)]));
      await run.finish(
        { ...template, runId: RUN, artifactRoot: path.join(".humanish", "runs", RUN) },
        PASSING_OUTCOME,
      );
    });
    await expect(stat(path.join(runDir(), "live"))).rejects.toThrow(/ENOENT/);
    expect(JSON.parse(await readText("run.json")).streams[0].liveActor).toBeUndefined();
  });
});

describe("readers of a run in progress", () => {
  const thought = item(2, "The second patient is waiting.");

  beforeEach(async () => {
    await withRun(async (run) => {
      await run.writeSnapshot(inProgress([item(1), thought]));
    });
  });

  it("verify grades the run local_only because it has not finished", async () => {
    const verified = await verifyRun(cwd, RUN);
    expect(verified.shareSafety.status).toBe("local_only");
    expect(verified.shareSafety.reasons.map((reason) => reason.code)).toContain("RUN_NOT_FINISHED");
  });

  it("run detail quotes the participant's latest thought from the live file", async () => {
    const detail = await readRunDetail(cwd, RUN);
    expect(detail?.participants[0]?.thought?.text).toBe("The second patient is waiting.");
  });

  it("the Observer server's feed carries the participant's items", async () => {
    const started = await serveObserverLibrary(cwd, {
      port: 0,
      safe: false,
      expose: false,
      edgeAuthed: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    try {
      const response = await fetch(
        new URL(`/_humanish/runs/${RUN}/observer/observer-feed.json`, started.server.url),
      );
      expect(response.status).toBe(200);
      const feed = (await response.json()) as {
        items: { streams: Record<string, { liveActor?: { id: string }[] }> };
      };
      const streamId = template.streams[0]!.id;
      expect(feed.items.streams[streamId]?.liveActor?.map((entry) => entry.id)).toEqual([
        "reasoning-001",
        "reasoning-002",
      ]);
    } finally {
      await started.server.close();
    }
  });
});
