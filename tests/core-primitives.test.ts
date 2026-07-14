import { execFile } from "node:child_process";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
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
      artifactRoot: ".humanish/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6",
      run: ".humanish/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/run.json",
      reviewJson: ".humanish/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/review.json",
      reviewMarkdown: ".humanish/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/review.md",
      observerData: ".humanish/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/observer/observer-data.json",
      events: ".humanish/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6/events.ndjson",
      latestPointer: ".humanish/runs/latest.json"
    });
  });

  it("builds latest, history, lifecycle, and timing records from explicit inputs", () => {
    const runId = "contract-fixture-2026-06-02t10-00-00-123z-issue-6";
    const artifactRoot = ".humanish/runs/contract-fixture-2026-06-02t10-00-00-123z-issue-6";

    expect(createLatestPointer({
      runId,
      artifactRoot,
      updatedAt: "2026-06-02T10:01:00.000Z"
    })).toEqual({
      schema: "humanish.latest-run.v1",
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
      schema: "humanish.run-history-entry.v1",
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
    expect(() => buildArtifactLayout("valid-run", "/tmp/humanish")).toThrow(/relative/);
    expect(() => buildArtifactLayout("valid-run", ".humanish/../runs")).toThrow(/unsafe/);
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
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-core-git-"));

    try {
      await runGit(["init"], tempRoot);
      await writeFile(path.join(tempRoot, "tracked-private-name.txt"), "initial\n", "utf8");
      await runGit(["add", "tracked-private-name.txt"], tempRoot);
      await runGit([
        "-c",
        "user.name=Humanish Test",
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
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-core-no-git-"));

    try {
      await mkdir(path.join(tempRoot, "nested"), { recursive: true });
      const state = await captureGitState(path.join(tempRoot, "nested"), {
        capturedAt: "2026-06-02T10:00:00.000Z"
      });

      expect(state).toEqual({
        schema: "humanish.git-state.v1",
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

  it("rejects a forged gitdir file without reading or refreshing the outside repository", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-core-git-forged-"));
    const outside = path.join(tempRoot, "outside");
    const target = path.join(tempRoot, "target");

    try {
      await mkdir(outside);
      await mkdir(target);
      await initializeCommittedRepo(outside, "outside-only\n");
      await writeFile(path.join(target, ".git"), `gitdir: ${path.join(outside, ".git")}\n`, "utf8");
      const outsideIndexPath = path.join(outside, ".git", "index");
      const outsideIndexBefore = await readFile(outsideIndexPath);
      let runnerCalls = 0;

      const injected = await captureGitState(target, {
        capturedAt: "2026-06-02T10:00:00.000Z",
        runner: async () => {
          runnerCalls += 1;
          return { exitCode: 0, stderr: "", stdout: "true\n" };
        }
      });
      const actual = await captureGitState(target, {
        capturedAt: "2026-06-02T10:00:00.000Z"
      });

      expect(runnerCalls).toBe(0);
      expect(injected.status).toBe("unavailable");
      expect(actual.status).toBe("unavailable");
      expect(actual.note).toBe("Git metadata failed containment validation.");
      expect(await readFile(outsideIndexPath)).toEqual(outsideIndexBefore);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("captures an exact linked worktree through the verified admin/common/backpointer chain", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-core-git-worktree-"));
    const canonical = path.join(tempRoot, "canonical");
    const linked = path.join(tempRoot, "linked");

    try {
      await mkdir(canonical);
      await initializeCommittedRepo(canonical, "canonical\n");
      const expectedSha = await runGitOutput(["rev-parse", "--short=12", "HEAD"], canonical);
      await runGit(["worktree", "add", "--detach", linked, "HEAD"], canonical);

      const state = await captureGitState(linked, {
        capturedAt: "2026-06-02T10:00:00.000Z"
      });

      expect(state.status).toBe("clean");
      expect(state.head.shortSha).toBe(expectedSha);
      expect(state.head.refState).toBe("detached");
      expect(state.changes.total).toBe(0);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects an unsafe linked-worktree admin config.worktree leaf", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-core-git-worktree-config-"));
    const canonical = path.join(tempRoot, "canonical");
    const linked = path.join(tempRoot, "linked");
    const outsideConfig = path.join(tempRoot, "outside-config");

    try {
      await mkdir(canonical);
      await initializeCommittedRepo(canonical, "canonical\n");
      await runGit(["worktree", "add", "--detach", linked, "HEAD"], canonical);
      const gitFile = await readFile(path.join(linked, ".git"), "utf8");
      const declaredGitDir = gitFile.match(/^gitdir:\s*(.+)\s*$/)?.[1];
      expect(declaredGitDir).toBeTruthy();
      const adminGitDir = await realpath(path.resolve(linked, declaredGitDir!));
      await writeFile(outsideConfig, "[core]\n\tfsmonitor = false\n", "utf8");
      await symlink(outsideConfig, path.join(adminGitDir, "config.worktree"));
      let runnerCalls = 0;

      const state = await captureGitState(linked, {
        capturedAt: "2026-06-02T10:00:00.000Z",
        runner: async () => {
          runnerCalls += 1;
          return { exitCode: 0, stderr: "", stdout: "true\n" };
        }
      });

      expect(runnerCalls).toBe(0);
      expect(state.status).toBe("unavailable");
      expect(state.note).toBe("Git metadata failed containment validation.");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("keeps an ordinary unborn git init repository available", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-core-git-unborn-"));

    try {
      await runGit(["init"], tempRoot);
      const state = await captureGitState(tempRoot, {
        capturedAt: "2026-06-02T10:00:00.000Z"
      });

      expect(state.status).toBe("clean");
      expect(state.head.shortSha).toBeNull();
      expect(state.changes.total).toBe(0);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("binds the default Git runner against inherited and config-derived outside authority", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-core-git-authority-"));
    const outside = path.join(tempRoot, "outside");
    const target = path.join(tempRoot, "target");
    const marker = path.join(tempRoot, "fsmonitor-ran");
    const hook = path.join(tempRoot, "fsmonitor.sh");
    const gitEnvironment = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(outside, ".git", "objects"),
      GIT_ATTR_NOSYSTEM: "0",
      GIT_COMMON_DIR: path.join(outside, ".git"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_GLOBAL: path.join(outside, ".git", "config"),
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_SYSTEM: path.join(outside, ".git", "config"),
      GIT_CONFIG_VALUE_0: hook,
      GIT_DIR: path.join(outside, ".git"),
      GIT_EXEC_PATH: path.join(tempRoot, "missing-git-exec-path"),
      GIT_INDEX_FILE: path.join(outside, ".git", "index"),
      GIT_NO_LAZY_FETCH: "0",
      GIT_NO_REPLACE_OBJECTS: "0",
      GIT_OBJECT_DIRECTORY: path.join(outside, ".git", "objects"),
      GIT_OPTIONAL_LOCKS: "1",
      GIT_WORK_TREE: outside
    } satisfies Record<string, string>;
    const previous = new Map<string, string | undefined>();

    try {
      await mkdir(outside);
      await mkdir(target);
      await initializeCommittedRepo(outside, "outside\n");
      await initializeCommittedRepo(target, "target\n");
      await writeFile(hook, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`, "utf8");
      await chmod(hook, 0o755);
      await writeFile(path.join(target, ".gitattributes"), "tracked.txt filter=evil\n", "utf8");
      await runGit(["config", "filter.evil.clean", hook], target);
      await runGit(["config", "filter.evil.required", "true"], target);
      await runGit(["add", ".gitattributes"], target);
      await runGit([
        "-c",
        "user.name=Humanish Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "attributes"
      ], target);
      await runGit(["config", "core.worktree", outside], target);
      await runGit(["config", "core.fsmonitor", hook], target);
      await runGit(["config", "core.alternateRefsCommand", hook], target);
      const outsideSha = await runGitOutput(["rev-parse", "--short=12", "HEAD"], outside);
      const targetSha = await runGitOutput(["rev-parse", "--short=12", "HEAD"], target);
      expect(targetSha).not.toBe(outsideSha);
      await rm(marker, { force: true });

      const targetIndexPath = path.join(target, ".git", "index");
      const outsideIndexPath = path.join(outside, ".git", "index");
      const targetIndexBefore = await readFile(targetIndexPath);
      const outsideIndexBefore = await readFile(outsideIndexPath);
      // A same-content mtime change normally invites Git to refresh index stat
      // data. GIT_OPTIONAL_LOCKS=0 must keep the captured index byte-identical.
      await utimes(path.join(target, "tracked.txt"), new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-01T00:00:00.000Z"));
      await writeFile(path.join(outside, "tracked.txt"), "outside-dirty\n", "utf8");

      for (const [name, value] of Object.entries(gitEnvironment)) {
        previous.set(name, process.env[name]);
        process.env[name] = value;
      }

      const state = await captureGitState(target, {
        capturedAt: "2026-06-02T10:00:00.000Z"
      });

      expect(state.status).toBe("clean");
      expect(state.head.shortSha).toBe(targetSha);
      expect(state.head.shortSha).not.toBe(outsideSha);
      expect(state.changes.total).toBe(0);
      await expect(access(marker)).rejects.toThrow();
      expect(await readFile(targetIndexPath)).toEqual(targetIndexBefore);
      expect(await readFile(outsideIndexPath)).toEqual(outsideIndexBefore);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["HEAD", "symlink"],
    ["HEAD", "hardlink"],
    ["HEAD", "fifo"],
    ["index", "symlink"],
    ["index", "hardlink"],
    ["index", "fifo"],
    ["config", "symlink"],
    ["config", "hardlink"],
    ["config", "fifo"]
  ] as const)("rejects unsafe Git metadata leaf %s (%s) before invoking a runner", async (leafName, kind) => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), `humanish-core-git-${leafName}-${kind}-`));
    const target = path.join(tempRoot, "target");
    const outside = path.join(tempRoot, `outside-${leafName}`);

    try {
      await mkdir(target);
      await initializeCommittedRepo(target, "target\n");
      const leaf = path.join(target, ".git", leafName);
      const original = await readFile(leaf);
      await unlink(leaf);
      if (kind === "fifo") {
        await execFileAsync("mkfifo", [leaf]);
      } else {
        await writeFile(outside, original);
        if (kind === "symlink") await symlink(outside, leaf);
        else await link(outside, leaf);
      }
      let runnerCalls = 0;

      const state = await captureGitState(target, {
        capturedAt: "2026-06-02T10:00:00.000Z",
        runner: async () => {
          runnerCalls += 1;
          return { exitCode: 0, stderr: "", stdout: "true\n" };
        }
      });

      expect(runnerCalls).toBe(0);
      expect(state.status).toBe("unavailable");
      expect(state.note).toBe("Git metadata failed containment validation.");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("returns unavailable when a git command exceeds its deadline", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-core-git-timeout-"));

    try {
      await mkdir(path.join(tempRoot, ".git"));
      const startedAt = Date.now();
      const state = await captureGitState(tempRoot, {
        capturedAt: "2026-06-02T10:00:00.000Z",
        commandTimeoutMs: 25,
        runner: async () => await new Promise(() => {})
      });

      expect(state.status).toBe("unavailable");
      expect(state.note).toBe("Git work-tree detection timed out.");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function runGitOutput(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function initializeCommittedRepo(cwd: string, contents: string): Promise<void> {
  await runGit(["init"], cwd);
  await writeFile(path.join(cwd, "tracked.txt"), contents, "utf8");
  await runGit(["add", "tracked.txt"], cwd);
  await runGit([
    "-c",
    "user.name=Humanish Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "initial"
  ], cwd);
}
