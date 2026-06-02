import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  buildArtifactLayout,
  buildRunId,
  captureGitState,
  createHistoryEntry,
  createLatestPointer,
  createLifecycleEvent,
  summarizePorcelainStatus,
  summarizeTiming
} from "../src/core/index.js";

const execFileAsync = promisify(execFile);

describe("core run primitives", () => {
  it("builds deterministic public-safe run ids and artifact paths", () => {
    const runId = buildRunId({
      prefix: "Contract Fixture",
      createdAt: "2026-06-02T10:00:00.123Z",
      entropy: "Issue #6"
    });
    const layout = buildArtifactLayout(runId);

    expect(runId).toBe("contract-fixture-2026-06-02t10-00-00-123z-issue-6");
    expect(layout).toEqual({
      artifactRoot: ".mimetic/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6",
      run: ".mimetic/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/run.json",
      reviewJson: ".mimetic/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/review.json",
      reviewMarkdown: ".mimetic/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/review.md",
      observerData: ".mimetic/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/observer/observer-data.json",
      events: ".mimetic/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/events.ndjson",
      latestPointer: ".mimetic/runs/latest.json"
    });
  });

  it("builds latest, history, lifecycle, and timing records from explicit inputs", () => {
    const runId = "contract-fixture-2026-06-02t10-00-00-123z-issue-6";
    const artifactRoot = ".mimetic/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6";

    expect(createLatestPointer({
      runId,
      artifactRoot,
      updatedAt: "2026-06-02T10:01:00.000Z"
    })).toEqual({
      schema: "mimetic.latest-run.v1",
      runId,
      path: artifactRoot,
      updatedAt: "2026-06-02T10:01:00.000Z"
    });
    expect(createHistoryEntry({
      runId,
      createdAt: "2026-06-02T10:00:00.123Z",
      mode: "dry-run",
      artifactRoot
    })).toEqual({
      schema: "mimetic.run-history-entry.v1",
      runId,
      createdAt: "2026-06-02T10:00:00.123Z",
      mode: "dry-run",
      path: artifactRoot
    });
    expect(createLifecycleEvent({
      at: "2026-06-02T10:00:00.123Z",
      event: "run.created",
      message: "Created contract fixture."
    })).toEqual({
      at: "2026-06-02T10:00:00.123Z",
      event: "run.created",
      message: "Created contract fixture."
    });
    expect(summarizeTiming({
      startedAt: "2026-06-02T10:00:00.000Z",
      endedAt: "2026-06-02T10:00:02.500Z"
    })).toEqual({
      startedAt: "2026-06-02T10:00:00.000Z",
      endedAt: "2026-06-02T10:00:02.500Z",
      durationMs: 2500,
      status: "complete"
    });
  });

  it("rejects absolute and traversal artifact paths", () => {
    expect(() => buildArtifactLayout("valid-run", "/tmp/mimetic")).toThrow(/relative/);
    expect(() => buildArtifactLayout("valid-run", ".mimetic/../runs")).toThrow(/unsafe/);
  });

  it("keeps source code free of environment-specific nouns", async () => {
    const sourceRoot = path.resolve("src/core");
    const files = [
      "index.ts",
      "run-primitives.ts",
      "git-state.ts"
    ];
    const joined = await Promise.all(files.map(async (file) => {
      const text = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(sourceRoot, file), "utf8"));
      return text;
    }));

    expect(joined.join("\n")).not.toMatch(/\b(persona|scenario|browser|tui|codex|e2b|openai|github|image|private-web-adapter)\b/i);
  });
});

describe("core git state", () => {
  it("summarizes porcelain status without file names", () => {
    expect(summarizePorcelainStatus([
      "M  src/private-name.ts",
      " M docs/private-note.md",
      "?? scratch/private-file.txt"
    ].join("\n"))).toEqual({
      staged: 1,
      unstaged: 1,
      untracked: 1,
      total: 3
    });
  });

  it("captures clean and dirty git state without paths, remotes, branch names, or file names", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-core-git-"));

    try {
      await runGit(["init"], tempRoot);
      await writeFile(path.join(tempRoot, "tracked-private-name.txt"), "initial\n", "utf8");
      await runGit(["add", "tracked-private-name.txt"], tempRoot);
      await runGit([
        "-c",
        "user.name=Mimetic Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "initial"
      ], tempRoot);

      const clean = await captureGitState(tempRoot, {
        capturedAt: "2026-06-02T10:00:00.000Z"
      });
      expect(clean.status).toBe("clean");
      expect(clean.changes).toEqual({
        staged: 0,
        unstaged: 0,
        untracked: 0,
        total: 0
      });
      expect(clean.head.shortSha).toMatch(/^[a-f0-9]{7,12}$/);
      expect(clean.head.refState).toBe("attached");

      await writeFile(path.join(tempRoot, "tracked-private-name.txt"), "changed\n", "utf8");
      await writeFile(path.join(tempRoot, "untracked-private-name.txt"), "new\n", "utf8");

      const dirty = await captureGitState(tempRoot, {
        capturedAt: "2026-06-02T10:01:00.000Z"
      });
      const publicJson = JSON.stringify(dirty);

      expect(dirty.status).toBe("dirty");
      expect(dirty.changes).toEqual({
        staged: 0,
        unstaged: 1,
        untracked: 1,
        total: 2
      });
      expect(publicJson).not.toContain(tempRoot);
      expect(publicJson).not.toContain("tracked-private-name.txt");
      expect(publicJson).not.toContain("untracked-private-name.txt");
      expect(publicJson).not.toContain("origin");
      expect(publicJson).not.toContain("master");
      expect(publicJson).not.toContain("main");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("reports missing git work trees without leaking the cwd", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-core-no-git-"));

    try {
      await mkdir(path.join(tempRoot, "nested"), { recursive: true });
      const state = await captureGitState(path.join(tempRoot, "nested"), {
        capturedAt: "2026-06-02T10:00:00.000Z"
      });

      expect(state).toEqual({
        schema: "mimetic.git-state.v1",
        status: "missing",
        capturedAt: "2026-06-02T10:00:00.000Z",
        head: {
          shortSha: null,
          refState: "unknown"
        },
        changes: {
          staged: 0,
          unstaged: 0,
          untracked: 0,
          total: 0
        },
        note: "No git work tree was detected."
      });
      expect(JSON.stringify(state)).not.toContain(tempRoot);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
