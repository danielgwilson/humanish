// verify on run.json v2's trace index. An indexed trace is source evidence: it may live only at a
// trace file name the writer produces, and verify scans the bytes the loader consumed. A finished
// v2 run indexes every actor, so inline items or a missing index fail closed, and in-progress
// items (liveActor) keep a run from grading share_ready.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorExecutionProfile } from "../../src/actors/contract.js";
import type { StoredRunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { verifyRun } from "../../src/verify/verify.js";
import { syntheticActor as actor, writeTwoParticipantRun } from "../helpers/run-traces.js";

const RUN = "synthetic-trace-index";
// A secret-shaped value the text scan finds only after gunzipping base64.
const PAYLOAD = gzipSync("sk-" + "syntheticvalue1234567890abcdef").toString("base64");

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const PROFILE: ActorExecutionProfile = {
  schema: "humanish.actor-execution-profile.v1",
  transport: "codex-app-server",
  authentication: "chatgpt-account",
  billing: "account-unknown",
  requestedModel: "gpt-5.6-sol",
  reasoningEffort: "low",
  cliVersion: "0.160.0",
  toolPolicy: "codex-ui-tools-v1",
  participantSchema: "humanish.codex-ui-tool.v1",
  memoryPolicy: "continuing-thread-v1",
};
const RECEIPT = {
  ordinal: 1,
  kind: "interaction" as const,
  dispatched: true,
  usageComplete: true,
  cleanup: "confirmed" as const,
  profileVerified: true,
  usage: { input: 20, output: 5 },
};

describe("verify on an indexed trace", () => {
  let cwd: string;
  let runDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-trace-index-"));
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** The dry run with two participants' actors, written as the run writer writes v2. */
  const writeTwoParticipants = (texts: [string, string]): Promise<StoredRunBundle> =>
    writeTwoParticipantRun(runDir, [actor(texts[0]), actor(texts[1])]);

  const writeStored = (bundle: StoredRunBundle) =>
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

  it("reports only the refusal for an account participant whose trace file is missing, in v4 as in v3", async () => {
    const account = {
      ...actor("Saved the record."),
      executionProfile: PROFILE,
      historyTurnsOmitted: 0,
      providerRequests: [RECEIPT],
    };
    const stored = await writeTwoParticipantRun(runDir, [account, actor("Opened the list.")]);
    const [first, second] = stored.streams;
    await unlink(path.join(runDir, first!.trace!.path));
    const checks = async () =>
      new Map((await verifyRun(cwd, RUN)).checks.map((check) => [check.name, check]));
    const v4 = await checks();
    expect(v4.get("local evidence artifacts exist")?.message).toMatch(
      /stream-one's trace was not read: .* is missing/,
    );
    expect(v4.get("cost estimate labeling")).toMatchObject({ ok: true });
    // A v3 run.json held the receipts in the participant's summary too.
    const summary = { ...first!.actor!, providerRequests: [RECEIPT] };
    await writeStored({
      ...stored,
      schema: "humanish.run-bundle.v3",
      streams: [{ ...first!, actor: summary }, second!],
    });
    const v3 = await checks();
    expect(v3.get("local evidence artifacts exist")?.message).toMatch(/stream-one's trace/);
    expect(v3.get("cost estimate labeling")).toMatchObject({ ok: true });
  });

  it("blocks an inline v1 run relabelled as v2", async () => {
    const stored = await writeTwoParticipants(["Saved the record.", "Opened the list."]);
    const inline: StoredRunBundle = {
      ...stored,
      streams: stored.streams.map(({ trace: _index, ...stream }) => ({
        ...stream,
        actor: actor("Saved the record."),
      })),
    };
    await writeStored({ ...inline, schema: "humanish.run-bundle.v1" });
    expect((await verifyRun(cwd, RUN)).shareSafety.status).toBe("share_ready");
    await writeStored({ ...inline, schema: "humanish.run-bundle.v2" });
    const relabelled = await verifyRun(cwd, RUN);
    expect(relabelled.ok).toBe(false);
    expect(relabelled.shareSafety.status).toBe("blocked");
  });

  it("keeps a v2 run with in-progress items from share_ready, and blocks them in a finished run", async () => {
    const stored = await writeTwoParticipants(["Saved the record.", "Opened the list."]);
    const { outcome: _outcome, ...unfinished } = stored;
    // 0.123.0 and 0.124.0 wrote a running participant's items inline in run.json v2.
    const live = {
      ...unfinished,
      schema: "humanish.run-bundle.v2" as const,
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
    } as StoredRunBundle);
    const finished = await verifyRun(cwd, RUN);
    expect(finished.ok).toBe(false);
    expect(finished.shareSafety.status).toBe("blocked");
  });
});
