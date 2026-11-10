import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { createRunArtifactPaths } from "../../src/run/paths.js";
import { parseRunAge, pruneRuns } from "../../src/run/prune.js";
import { pointLatestRunAt } from "../../src/run/run.js";
import { listRuns } from "../../src/run/stored-runs.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const DAY = 86_400_000;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "humanish-prune-"));
  roots.push(root);
  return root;
}

interface Fixture {
  ageDays: number;
  bytes?: number;
  status?: Record<string, unknown>;
  files?: Record<string, string>;
  noBundle?: boolean;
}

async function addRun(cwd: string, runId: string, fixture: Fixture): Promise<string> {
  const created = await createRunArtifactPaths(cwd, runId);
  if (!created.ok) throw new Error("run exists");
  const root = created.paths.physicalRunRoot;
  const createdAt = new Date(NOW - fixture.ageDays * DAY).toISOString();
  if (fixture.noBundle !== true)
    await writeFile(path.join(root, "run.json"), JSON.stringify({ runId, createdAt }));
  await mkdir(path.join(root, "recordings", "first"), { recursive: true });
  await writeFile(
    path.join(root, "recordings", "first", "desktop.mp4"),
    Buffer.alloc(fixture.bytes ?? 1000),
  );
  if (fixture.status)
    await writeFile(path.join(root, "status.json"), JSON.stringify({ runId, ...fixture.status }));
  for (const [name, text] of Object.entries(fixture.files ?? {}))
    await writeFile(path.join(root, name), text);
  return root;
}

const runsIn = (cwd: string) => readdir(path.join(cwd, ".humanish", "runs"));

describe("pruning old runs", () => {
  it("only reports what it would remove until it is told to apply", async () => {
    const cwd = await project();
    await addRun(cwd, "old", { ageDays: 40, bytes: 5000 });
    await addRun(cwd, "new", { ageDays: 1 });
    const preview = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: false, nowMs: NOW });
    expect(preview.applied).toBe(false);
    expect(preview.removable.map((run) => run.runId)).toEqual(["old"]);
    expect(preview.freedBytes).toBeGreaterThanOrEqual(5000);
    expect(await runsIn(cwd)).toEqual(expect.arrayContaining(["old", "new"]));
  });

  it("removes the old runs and nothing else when applied", async () => {
    const cwd = await project();
    await addRun(cwd, "old", { ageDays: 40 });
    await addRun(cwd, "new", { ageDays: 1 });
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: true, nowMs: NOW });
    expect(result.applied).toBe(true);
    const left = await runsIn(cwd);
    expect(left).toContain("new");
    expect(left).not.toContain("old");
  });

  it("keeps the latest run however old it is", async () => {
    const cwd = await project();
    await addRun(cwd, "only", { ageDays: 90 });
    const created = await createRunArtifactPaths(cwd, "pointer");
    if (!created.ok) throw new Error("run exists");
    await pointLatestRunAt(created.paths, "only");
    await rm(created.paths.physicalRunRoot, { recursive: true });
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: true, nowMs: NOW });
    expect(result.removable).toEqual([]);
    expect(result.kept).toEqual([{ runId: "only", reason: "latest" }]);
    expect(await runsIn(cwd)).toContain("only");
  });

  it("keeps a run that is still going, whatever its age", async () => {
    const cwd = await project();
    await addRun(cwd, "live", {
      ageDays: 40,
      status: { state: "running", updatedAt: new Date(NOW - 1000).toISOString() },
    });
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: true, nowMs: NOW });
    expect(result.kept).toEqual([{ runId: "live", reason: "running" }]);
    expect(await runsIn(cwd)).toContain("live");
  });

  it("keeps a finished run whose analysis is still writing", async () => {
    const cwd = await project();
    await addRun(cwd, "analyzing", {
      ageDays: 40,
      status: { state: "finished", updatedAt: new Date(NOW - 1000).toISOString() },
    });
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: true, nowMs: NOW });
    expect(result.kept).toEqual([{ runId: "analyzing", reason: "running" }]);
  });

  it("keeps a paused run whose process is alive", async () => {
    const cwd = await project();
    await addRun(cwd, "paused", {
      ageDays: 40,
      status: {
        state: "running",
        pid: process.pid,
        updatedAt: new Date(NOW - 39 * DAY).toISOString(),
      },
    });
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: true, nowMs: NOW });
    expect(result.kept).toEqual([{ runId: "paused", reason: "running" }]);
  });

  it("keeps a run whose copy back has not finished, though its run.json is here", async () => {
    const cwd = await project();
    await addRun(cwd, "partway", {
      ageDays: 40,
      files: { "remote.json": JSON.stringify({ copyPending: true }) },
    });
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: true, nowMs: NOW });
    expect(result.kept).toEqual([{ runId: "partway", reason: "not-copied-back" }]);
  });

  it("removes a finished recent run only once its sandboxes are confirmed gone", async () => {
    const cwd = await project();
    await addRun(cwd, "failed-teardown", {
      ageDays: 3,
      status: { state: "finished", updatedAt: new Date(NOW - 3 * DAY).toISOString() },
      files: {
        "sandbox-receipts.ndjson": '{"sandboxId":"fake-sb-a"}\n',
        "reclaim-receipt.json": JSON.stringify({ state: "unknown" }),
      },
    });
    await addRun(cwd, "clean", {
      ageDays: 3,
      status: { state: "finished", updatedAt: new Date(NOW - 3 * DAY).toISOString() },
      files: {
        "sandbox-receipts.ndjson": '{"sandboxId":"fake-sb-b"}\n',
        "reclaim-receipt.json": JSON.stringify({ state: "clean" }),
      },
    });
    const result = await pruneRuns(cwd, { olderThanMs: DAY, apply: true, nowMs: NOW });
    expect(result.kept).toEqual([{ runId: "failed-teardown", reason: "sandboxes-unconfirmed" }]);
    expect(result.removable.map((run) => run.runId)).toEqual(["clean"]);
  });

  it("keeps a recent run whose sandboxes were never confirmed stopped", async () => {
    const cwd = await project();
    await addRun(cwd, "crashed", {
      ageDays: 3,
      status: { state: "running", updatedAt: new Date(NOW - 2 * DAY).toISOString() },
      files: { "sandbox-receipts.ndjson": '{"sandboxId":"fake-sb-crashed"}\n' },
    });
    const result = await pruneRuns(cwd, { olderThanMs: DAY, apply: true, nowMs: NOW });
    expect(result.kept).toEqual([{ runId: "crashed", reason: "sandboxes-unconfirmed" }]);
  });

  it("removes a crashed run too old for any sandbox of it to still exist", async () => {
    const cwd = await project();
    await addRun(cwd, "crashed", {
      ageDays: 40,
      status: { state: "running", updatedAt: new Date(NOW - 39 * DAY).toISOString() },
      files: { "sandbox-receipts.ndjson": '{"sandboxId":"fake-sb-crashed"}\n' },
    });
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: true, nowMs: NOW });
    expect(result.removable.map((run) => run.runId)).toEqual(["crashed"]);
  });

  it("removes a crashed run with no sandbox left to stop", async () => {
    const cwd = await project();
    await addRun(cwd, "crashed", {
      ageDays: 40,
      status: { state: "running", updatedAt: new Date(NOW - 39 * DAY).toISOString() },
    });
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: true, nowMs: NOW });
    expect(result.removable.map((run) => run.runId)).toEqual(["crashed"]);
  });

  it("keeps a remote run that has not been copied back", async () => {
    const cwd = await project();
    const root = await addRun(cwd, "remote", {
      ageDays: 40,
      noBundle: true,
      files: { "remote.json": "{}" },
    });
    const old = new Date(NOW - 40 * DAY);
    await utimes(root, old, old);
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: true, nowMs: NOW });
    expect(result.kept).toEqual([{ runId: "remote", reason: "not-copied-back" }]);
  });

  it("ages a run with no readable bundle by its folder", async () => {
    const cwd = await project();
    const root = await addRun(cwd, "torn", { ageDays: 0, noBundle: true });
    const old = new Date(NOW - 40 * DAY);
    await utimes(root, old, old);
    const result = await pruneRuns(cwd, { olderThanMs: 30 * DAY, apply: false, nowMs: NOW });
    expect(result.removable.map((run) => run.runId)).toEqual(["torn"]);
  });
});

describe("listing runs without sizes", () => {
  it("does not measure them, since the Observer lists runs on every poll", async () => {
    const cwd = await project();
    await addRun(cwd, "a", { ageDays: 2 });
    const listed = await listRuns(cwd);
    expect(listed.runs[0]).not.toHaveProperty("bytes");
    expect(listed).not.toHaveProperty("totalBytes");
  });
});

describe("the age a prune takes", () => {
  it("reads days and hours", () => {
    expect(parseRunAge("30d")).toBe(30 * DAY);
    expect(parseRunAge("12h")).toBe(12 * 3_600_000);
  });

  it("refuses an age short enough to catch a run in progress", () => {
    expect(parseRunAge("30m")).toBeNull();
    expect(parseRunAge("0d")).toBeNull();
    expect(parseRunAge("soon")).toBeNull();
  });
});

describe("the run listing", () => {
  it("says how much disk each run and the project use", async () => {
    const cwd = await project();
    await addRun(cwd, "a", { ageDays: 2, bytes: 4096 });
    await addRun(cwd, "b", { ageDays: 1, bytes: 1024 });
    const listed = await listRuns(cwd, { sizes: true });
    const sizes = Object.fromEntries(listed.runs.map((run) => [run.runId, run.bytes]));
    expect(sizes.a).toBeGreaterThanOrEqual(4096);
    expect(sizes.b).toBeGreaterThanOrEqual(1024);
    expect(listed.totalBytes).toBe(sizes.a! + sizes.b!);
  });
});

describe("humanish runs prune", () => {
  async function prune(args: string[], cwd: string) {
    const out: string[] = [];
    let exit = 0;
    const program = createProgram({
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      setExitCode: (code) => {
        exit = code;
      },
    });
    const before = process.cwd();
    process.chdir(cwd);
    try {
      await program.parseAsync(["node", "humanish", "runs", "prune", ...args], { from: "node" });
    } finally {
      process.chdir(before);
    }
    return { out: out.join(""), exit };
  }

  it("acts on the project --cwd names, wherever it is run from", async () => {
    const elsewhere = await project();
    const target = await project();
    const created = await createRunArtifactPaths(target, "old");
    if (!created.ok) throw new Error("run exists");
    await writeFile(
      path.join(created.paths.physicalRunRoot, "run.json"),
      JSON.stringify({ runId: "old", createdAt: "2020-01-01T00:00:00.000Z" }),
    );
    const { out } = await prune(
      ["--older-than", "30d", "--cwd", target, "--yes", "--json"],
      elsewhere,
    );
    expect(JSON.parse(out).removable.map((run: { runId: string }) => run.runId)).toEqual(["old"]);
    expect(await runsIn(target)).not.toContain("old");
  });
});
