// verify through one prepared run twice, as a finished study does when it renders the Observer and
// then analyzes. The second verify must grade a frame by the bytes on disk at that moment: each
// case changes the frame between the two calls, and the second result must equal a fresh verifyRun.
// The clock runs 10 s ahead, so the frame the first verify reads is old enough for verify to keep
// what it learned from it.
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTOR_TRACE_SCHEMA } from "../../src/actors/contract.js";
import { screenshotEvidenceError } from "../../src/evidence/image.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import type { PreparedRunArtifactPaths } from "../../src/run/paths.js";
import { verifyRun, verifyRunPrepared, type VerifyResult } from "../../src/verify/verify.js";
import { writeRunBundle } from "../helpers/run-traces.js";

// The PNG check is the cost the memo saves, so the spy counts it; it still runs the real check.
vi.mock("../../src/evidence/image.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/evidence/image.js")>();
  return { ...actual, screenshotEvidenceError: vi.fn(actual.screenshotEvidenceError) };
});

// The redactor's output shape: share_ready under a blurred claim (screenshot-claims.test.ts).
const PNG_4X4 = PNG.sync.write(new PNG({ width: 4, height: 4 }));
// Wider than any redacted thumbnail: RAW_SCREENSHOTS under the same claim.
const PNG_1280X720 = PNG.sync.write(new PNG({ width: 1280, height: 720 }));
const FRAME = "screenshots/frame.png";
// A whole second, so utimes can set it back exactly after an in-place write.
const FRAME_MTIME = Math.floor(Date.now() / 1000) - 60;
const runId = "screenshot-reads";

/**
 * The run's first stream registers one frame under each reference, claimed blurred. Each reference
 * names a file of PNG_4X4 at its own path (`\\` read as `/`).
 */
async function registerFrames(runDir: string, references: readonly string[]): Promise<void> {
  await mkdir(path.join(runDir, "screenshots"), { recursive: true });
  for (const reference of references) {
    const file = path.join(runDir, reference.replace(/\\/g, "/"));
    await writeFile(file, PNG_4X4);
    await utimes(file, FRAME_MTIME, FRAME_MTIME);
  }
  const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
  Object.assign(bundle.streams[0]!, {
    actor: {
      schema: ACTOR_TRACE_SCHEMA,
      items: references.map((reference, index) => ({
        id: `item-${index + 1}`,
        kind: "screenshot",
        lifecycle: "completed",
        title: "frame",
        screenshotRef: { path: reference, redaction: "blurred" },
      })),
      redaction: { status: "passed", screenshots: "blurred", notes: "Synthetic." },
    },
  });
  await writeRunBundle(runDir, bundle);
}

const grade = (result: VerifyResult) => ({
  status: result.shareSafety.status,
  codes: result.shareSafety.reasons.map((reason) => reason.code),
});
const evidenceCheck = (result: VerifyResult) =>
  result.checks.find((check) => check.name === "local evidence artifacts exist")?.message;

describe("a second verify through the same prepared run", () => {
  let cwd: string;
  let runDir: string;
  let prepared: PreparedRunArtifactPaths;

  async function setUp(...references: string[]): Promise<void> {
    await runDryRun({ cwd, dryRun: true, runId });
    runDir = path.join(cwd, ".humanish", "runs", runId);
    await registerFrames(runDir, references);
    prepared = (await resolveRunPath(cwd, runId))!;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10_000 });
  }
  const verifyAgain = () => verifyRunPrepared(cwd, runId, prepared);

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-screenshot-reads-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.mocked(screenshotEvidenceError).mockClear();
    await rm(cwd, { recursive: true, force: true });
  });

  it("grades an unchanged frame share_ready both times", async () => {
    await setUp(FRAME);
    expect(grade(await verifyAgain())).toEqual({ status: "share_ready", codes: [] });
    const second = await verifyAgain();
    expect(grade(second)).toEqual({ status: "share_ready", codes: [] });
    expect(second).toEqual(await verifyRun(cwd, runId));
  });

  it("refuses a frame corrupted in place at the same size with its mtime put back", async () => {
    await setUp(FRAME);
    expect(grade(await verifyAgain())).toEqual({ status: "share_ready", codes: [] });
    const file = path.join(runDir, FRAME);
    const before = await stat(file, { bigint: true });
    // A byte inside the IDAT data: the chunk's CRC no longer matches.
    const handle = await open(file, "r+");
    await handle.write(Buffer.from([PNG_4X4[43]! ^ 0xff]), 0, 1, 43);
    await handle.close();
    await utimes(file, FRAME_MTIME, FRAME_MTIME);
    const after = await stat(file, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs]).toEqual([
      before.ino,
      before.size,
      before.mtimeNs,
    ]);

    const second = await verifyAgain();
    expect(grade(second)).toEqual({ status: "blocked", codes: ["VERIFY_FAILED"] });
    expect(evidenceCheck(second)).toContain(`${FRAME} (could not decode PNG evidence)`);
    expect(second).toEqual(await verifyRun(cwd, runId));
  });

  it("grades a frame replaced by rename with a full-size frame as raw", async () => {
    await setUp(FRAME);
    expect(grade(await verifyAgain())).toEqual({ status: "share_ready", codes: [] });
    await writeFile(path.join(runDir, "frame-next.png"), PNG_1280X720);
    await rename(path.join(runDir, "frame-next.png"), path.join(runDir, FRAME));

    const second = await verifyAgain();
    expect(grade(second)).toEqual({ status: "local_only", codes: ["RAW_SCREENSHOTS"] });
    expect(second).toEqual(await verifyRun(cwd, runId));
  });

  it("reports a deleted frame missing", async () => {
    await setUp(FRAME);
    expect(grade(await verifyAgain())).toEqual({ status: "share_ready", codes: [] });
    await rm(path.join(runDir, FRAME));

    const second = await verifyAgain();
    expect(grade(second)).toEqual({
      status: "blocked",
      codes: ["VERIFY_FAILED", "RAW_SCREENSHOTS"],
    });
    expect(evidenceCheck(second)).toBe(`missing local evidence artifacts: ${FRAME}`);
    expect(second).toEqual(await verifyRun(cwd, runId));
  });

  it("checks each frame once, with more frames than verify reads at a time", async () => {
    // Nine frames: verify reads eight at once, so first reads of one run overlap.
    const frames = Array.from({ length: 9 }, (_, index) => `screenshots/frame-${index}.png`);
    await setUp(...frames);
    expect(grade(await verifyAgain())).toEqual({ status: "share_ready", codes: [] });
    expect(vi.mocked(screenshotEvidenceError)).toHaveBeenCalledTimes(9);
    expect(grade(await verifyAgain())).toEqual({ status: "share_ready", codes: [] });
    expect(vi.mocked(screenshotEvidenceError)).toHaveBeenCalledTimes(9);
  });

  it("reads a frame the trace names with a backslash", async () => {
    await setUp("screenshots\\frame.png");
    expect(grade(await verifyAgain())).toEqual({ status: "share_ready", codes: [] });
    const second = await verifyAgain();
    expect(grade(second)).toEqual({ status: "share_ready", codes: [] });
    expect(second).toEqual(await verifyRun(cwd, runId));
  });
});
