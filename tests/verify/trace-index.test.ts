// verify on run.json v2's trace index. An indexed trace is source evidence: it may live only at a
// trace file name the writer produces, and verify scans the bytes the loader consumed. A finished
// v2 run indexes every actor, so inline items or a missing index fail closed, and in-progress
// items (liveActor) keep a run from grading share_ready.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTOR_TRACE_SCHEMA,
  CODEX_APP_SERVER_CAPABILITIES,
  type ActorTrace,
} from "../../src/actors/contract.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { splitStreamTraces } from "../../src/run/stream-trace.js";
import { verifyRun } from "../../src/verify/verify.js";

const RUN = "synthetic-trace-index";
// A secret-shaped value the text scan finds only after gunzipping base64.
const PAYLOAD = gzipSync("sk-" + "syntheticvalue1234567890abcdef").toString("base64");

function actor(text: string): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "synthetic-fixture",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: { id: "synthetic-new-user", traitsApplied: [], promptDigest: "0123456789abcdef" },
    redaction: { status: "passed", screenshots: "blurred", notes: "Synthetic fixture." },
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:00:01.000Z",
    durationMs: 1000,
    status: "passed",
    completionReason: "goal_satisfied",
    reason: "Synthetic fixture completed.",
    ids: {},
    modelSettings: { reasoningEffort: "low", maxOutputTokens: 4096 },
    counts: { messages: 1, actions: 0 },
    items: [{ id: "i1", kind: "message", lifecycle: "completed", title: "message", text }],
    capabilities: {
      ...CODEX_APP_SERVER_CAPABILITIES,
      lanes: ["computer-use"],
      producesScreenshots: true,
    },
  };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("verify on an indexed trace", () => {
  let cwd: string;
  let runDir: string;
  let dryRun: RunBundle;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-trace-index-"));
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
    dryRun = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** The dry run with two participants' actors, written as the run writer writes v2. */
  async function writeTwoParticipants(texts: [string, string]): Promise<RunBundle> {
    const second = { ...dryRun.streams[0]!, id: "stream-two", simId: dryRun.simulations[0]!.id };
    const bundle: RunBundle = {
      ...dryRun,
      streams: [
        { ...dryRun.streams[0]!, actor: actor(texts[0]) },
        { ...second, actor: actor(texts[1]) },
      ],
      simulations: [
        { ...dryRun.simulations[0]!, streamIds: [dryRun.streams[0]!.id, "stream-two"] },
      ],
    };
    const split = splitStreamTraces(bundle);
    await mkdir(path.join(runDir, "actors"), { recursive: true });
    for (const file of split.files) await writeFile(path.join(runDir, file.path), file.bytes);
    await writeStored(split.bundle);
    return split.bundle;
  }

  const writeStored = (bundle: RunBundle) =>
    writeFile(path.join(runDir, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`);

  it("grades the plain two-participant v2 run share_ready", async () => {
    await writeTwoParticipants(["Saved the record.", "Opened the list."]);
    const verified = await verifyRun(cwd, RUN);
    expect(verified.ok).toBe(true);
    expect(verified.shareSafety.status).toBe("share_ready");
  });

  it("refuses a trace indexed at the Observer page, which the scan reads as a projection", async () => {
    const stored = await writeTwoParticipants([PAYLOAD, "Opened the list."]);
    const own = stored.streams[0]!.trace!;
    // At its own name the payload is opaque to the scan: valid local evidence, not share-ready.
    const atOwnPath = await verifyRun(cwd, RUN);
    expect(atOwnPath.shareSafety.status).toBe("local_only");
    expect(atOwnPath.shareSafety.reasons.map((reason) => reason.code)).toContain(
      "UNSCANNED_ARTIFACT",
    );

    const bytes = await readFile(path.join(runDir, own.path));
    await writeFile(path.join(runDir, "observer", "index.html"), bytes);
    await unlink(path.join(runDir, own.path));
    stored.streams[0]!.trace = { ...own, path: "observer/index.html", sha256: sha256(bytes) };
    await writeStored(stored);
    const atObserver = await verifyRun(cwd, RUN);
    expect(atObserver.ok).toBe(false);
    expect(atObserver.shareSafety.status).toBe("blocked");
  });

  it("blocks a finished v2 run whose participant lost its index and trace file", async () => {
    const stored = await writeTwoParticipants(["Saved the record.", "Opened the list."]);
    const first = stored.streams[0]!;
    await unlink(path.join(runDir, first.trace!.path));
    const { trace: _index, ...unindexed } = first;
    stored.streams[0] = { ...unindexed, actor: { ...first.actor!, items: [] } };
    await writeStored(stored);
    const verified = await verifyRun(cwd, RUN);
    expect(verified.ok).toBe(false);
    expect(verified.shareSafety.status).toBe("blocked");
  });

  it("blocks an inline v1 run relabelled as v2", async () => {
    const stored = await writeTwoParticipants(["Saved the record.", "Opened the list."]);
    const inline: RunBundle = {
      ...stored,
      streams: stored.streams.map(({ trace: _index, ...stream }) => ({
        ...stream,
        actor: actor("Saved the record."),
      })),
    };
    await writeStored({ ...inline, schema: "humanish.run-bundle.v1" });
    expect((await verifyRun(cwd, RUN)).shareSafety.status).toBe("share_ready");
    await writeStored(inline);
    const relabelled = await verifyRun(cwd, RUN);
    expect(relabelled.ok).toBe(false);
    expect(relabelled.shareSafety.status).toBe("blocked");
  });

  it("keeps a v2 run with in-progress items from share_ready, and blocks them in a finished run", async () => {
    const stored = await writeTwoParticipants(["Saved the record.", "Opened the list."]);
    const { outcome: _outcome, ...unfinished } = stored;
    const live = {
      ...unfinished,
      streams: [
        stored.streams[0]!,
        {
          ...stored.streams[1]!,
          liveActor: {
            schema: "humanish.live-actor.v1" as const,
            updatedAt: "2026-09-01T00:00:01.000Z",
            items: actor("Still working.").items,
          },
        },
      ],
    };
    await writeStored(live);
    const inProgress = await verifyRun(cwd, RUN);
    expect(inProgress.shareSafety.status).toBe("local_only");
    expect(inProgress.shareSafety.reasons.map((reason) => reason.code)).toContain(
      "RUN_NOT_FINISHED",
    );

    await writeStored({
      ...live,
      outcome: { state: "finished", ok: true, execution: { succeeded: true, failures: [] } },
    } as RunBundle);
    const finished = await verifyRun(cwd, RUN);
    expect(finished.ok).toBe(false);
    expect(finished.shareSafety.status).toBe("blocked");
  });
});
