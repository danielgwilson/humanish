import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { copyRunBack, copySettledEvidence, giveUpCopy } from "../../src/remote/copy-back.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { missingLocalEvidenceArtifacts, recordingsLostInCopy } from "../../src/verify/artifacts.js";
import { listRemoteRun, readRemoteFileInRanges, type Runner } from "../../src/remote/runner.js";
import { createRunArtifactPaths } from "../../src/run/paths.js";
import { localRunner } from "../helpers/local-runner.js";

/** A file one range and a little long, so it takes the ranged path at its real size. */
async function largeFile(runDir: string, file = "recordings/p01/desktop.mp4") {
  await mkdir(path.dirname(path.join(runDir, file)), { recursive: true });
  const content = Buffer.alloc(64 * 1024 * 1024 + 3, 7);
  content.write("end", content.length - 3);
  await writeFile(path.join(runDir, file), content);
  return createHash("sha256").update(content).digest("hex");
}

async function runHere() {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-copy-"));
  const created = await createRunArtifactPaths(cwd, "cua-remote");
  if (!created.ok) throw new Error("no run directory");
  return { cwd, paths: created.paths };
}

const fast = { retry: { windowMs: 5, delayMs: 1 } };

const digestOf = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const copiedVideo = (cwd: string, folder = "recordings/p01") =>
  path.join(cwd, ".humanish", "runs", "cua-remote", folder, "desktop.mp4");

/** Fails every `dd` of the range at `index` while `failing()` says so. */
function failingRange(runner: Runner, index: number, failing: () => boolean) {
  const reads: number[] = [];
  const run = runner.shell.run.bind(runner.shell);
  runner.shell.run = ((command: string, options?: { timeoutMs?: number }) => {
    const skip = /skip=([0-9]+)/.exec(command);
    if (skip !== null) {
      reads.push(Number(skip[1]));
      if (Number(skip[1]) === index && failing()) throw new Error("connection dropped");
    }
    return run(command, options);
  }) as Runner["shell"]["run"];
  return reads;
}

describe("copying a large file back from the runner", () => {
  it("copies a file larger than one range to disk, byte for byte, and leaves no partial file", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      const sha256 = await largeFile(runDir);
      const lines: string[] = [];
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), (line) => lines.push(line)),
      ).resolves.toEqual({ files: 1, alreadyHere: 0 });
      expect(await digestOf(copiedVideo(cwd))).toBe(sha256);
      expect(await readdir(path.dirname(copiedVideo(cwd)))).toEqual(["desktop.mp4"]);
      expect(lines).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("copies a large file at the top of the run directory", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      const sha256 = await largeFile(runDir, "events.ndjson");
      await copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined);
      expect(
        await digestOf(path.join(cwd, ".humanish", "runs", "cua-remote", "events.ndjson")),
      ).toBe(sha256);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not copy a large file already here with the same bytes", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      await largeFile(runDir);
      await copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined);
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined),
      ).resolves.toEqual({ files: 1, alreadyHere: 1 });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reads a damaged range again and keeps the copy whole", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      const sha256 = await largeFile(runDir);
      const files = runner.sandbox.files;
      const read = files.read!;
      let reads = 0;
      files.read = async (file, options) => {
        reads += 1;
        if (reads !== 2) return read(file, options);
        return new Blob([new Uint8Array([1, 2, 3])]).stream();
      };
      await copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined);
      expect(await digestOf(copiedVideo(cwd))).toBe(sha256);
      expect(reads).toBe(3);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("gives up on a range that keeps arriving damaged and leaves no partial file", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      await largeFile(runDir);
      runner.sandbox.files.read = async () => new Blob([new Uint8Array([1, 2, 3])]).stream();
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast),
      ).rejects.toThrow("changed or arrived damaged");
      await expect(readdir(path.dirname(copiedVideo(cwd)))).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a large file whose whole digest differs from the one listed", async () => {
    const { home, runner, runDir } = await localRunner();
    try {
      await largeFile(runDir);
      const [file] = await listRemoteRun(runner, "cua-remote");
      await expect(
        readRemoteFileInRanges(
          runner,
          "cua-remote",
          { ...file!, sha256: "0".repeat(64) },
          async () => undefined,
        ),
      ).rejects.toThrow("changed or arrived damaged");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("a copy of a large file that stopped partway", () => {
  it("picks a large copy up where it stopped, and leaves no partial file", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      const sha256 = await largeFile(runDir);
      let broken = true;
      const reads = failingRange(runner, 1, () => broken);
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast),
      ).rejects.toThrow("connection dropped");
      reads.length = 0;
      broken = false;
      await copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast);
      expect(reads).toEqual([1]);
      expect(await digestOf(copiedVideo(cwd))).toBe(sha256);
      expect(await readdir(path.dirname(copiedVideo(cwd)))).toEqual(["desktop.mp4"]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("starts over when what it picked up does not match the listed digest", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      const sha256 = await largeFile(runDir);
      let broken = true;
      failingRange(runner, 1, () => broken);
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast),
      ).rejects.toThrow("connection dropped");
      const folder = path.dirname(copiedVideo(cwd));
      const [partial] = await readdir(folder);
      await writeFile(path.join(folder, partial!), Buffer.alloc(64 * 1024 * 1024, 9));
      broken = false;
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast),
      ).rejects.toThrow("damaged");
      await copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast);
      expect(await digestOf(copiedVideo(cwd))).toBe(sha256);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("removes a partial file an older copy left beside the video", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      await largeFile(runDir);
      await mkdir(path.dirname(copiedVideo(cwd)), { recursive: true });
      await writeFile(path.join(path.dirname(copiedVideo(cwd)), ".copy-old-uuid"), "left over");
      await copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast);
      expect(await readdir(path.dirname(copiedVideo(cwd)))).toEqual(["desktop.mp4"]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rides out a connection that drops for a while", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      const sha256 = await largeFile(runDir);
      let failures = 6;
      failingRange(runner, 0, () => failures-- > 0);
      await copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, {
        retry: { windowMs: 60_000, delayMs: 1 },
      });
      expect(await digestOf(copiedVideo(cwd))).toBe(sha256);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stops at once when the runner is gone", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      await largeFile(runDir);
      const run = runner.shell.run.bind(runner.shell);
      let reads = 0;
      runner.shell.run = ((command: string, options?: { timeoutMs?: number }) => {
        if (command.includes("skip=")) {
          reads += 1;
          throw Object.assign(new Error("sandbox was not found"), {
            name: "SandboxNotFoundError",
          });
        }
        return run(command, options);
      }) as Runner["shell"]["run"];
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, {
          retry: { windowMs: 60_000, delayMs: 1 },
        }),
      ).rejects.toThrow("not found");
      expect(reads).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("the end of a copy of a large file", () => {
  it("refuses to share a partial file with a copy that is still running", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      const sha256 = await largeFile(runDir);
      const folder = path.dirname(copiedVideo(cwd));
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, `.copy-${sha256.slice(0, 32)}.lock`), String(process.pid));
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast),
      ).rejects.toThrow("already copying");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("takes over the lock of a process that has died", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      const sha256 = await largeFile(runDir);
      const folder = path.dirname(copiedVideo(cwd));
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, `.copy-${sha256.slice(0, 32)}.lock`), "2147483646");
      await copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast);
      expect(await digestOf(copiedVideo(cwd))).toBe(sha256);
      expect(await readdir(folder)).toEqual(["desktop.mp4"]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("records a video it can no longer fetch as lost, and stops offering the copy", async () => {
    const { cwd, paths } = await runHere();
    const run = path.join(cwd, ".humanish", "runs", "cua-remote");
    try {
      await writeFile(path.join(run, "remote.json"), JSON.stringify({ copyPending: true }));
      await writeFile(
        path.join(run, "run.json"),
        JSON.stringify({
          streams: [
            { recording: { path: "recordings/gone/desktop.mp4" } },
            { recording: { path: "recordings/here/desktop.mp4" } },
          ],
        }),
      );
      await mkdir(path.join(run, "recordings", "here"), { recursive: true });
      await writeFile(path.join(run, "recordings", "here", "desktop.mp4"), "video");
      await mkdir(path.join(run, "recordings", "gone"), { recursive: true });
      await writeFile(path.join(run, "recordings", "gone", ".copy-partial"), "partial");
      expect(await giveUpCopy(paths)).toEqual(["recordings/gone/desktop.mp4"]);
      expect(await readdir(path.join(run, "recordings", "gone"))).toEqual([]);
      const record = JSON.parse(await readFile(path.join(run, "remote.json"), "utf8"));
      expect(record.copyPending).toBeUndefined();
      expect(record.lostInCopy).toEqual(["recordings/gone/desktop.mp4"]);
      expect([...(await recordingsLostInCopy(paths))]).toEqual(["recordings/gone/desktop.mp4"]);
      const bundle = {
        streams: [
          {
            actor: {},
            recording: { path: "recordings/gone/desktop.mp4", bytes: 5 },
            artifacts: [{ path: "recordings/gone/desktop.mp4", kind: "recording" }],
          },
          {
            actor: {},
            artifacts: [{ path: "recordings/gone/desktop.mp4x", kind: "file" }],
          },
        ],
      } as unknown as RunBundle;
      const lost = new Set(["recordings/gone/desktop.mp4", "recordings/gone/desktop.mp4x"]);
      const missing = await missingLocalEvidenceArtifacts(paths, bundle, new Set(), lost);
      expect(missing.some((entry) => entry === "recordings/gone/desktop.mp4")).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a video the disk here has no room for, after the rest of the run", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      await largeFile(runDir);
      await writeFile(path.join(runDir, "run.json"), "{}");
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, {
          freeBytes: async () => 1024 ** 3 + 1000,
        }),
      ).rejects.toThrow(/free/);
      const run = path.join(cwd, ".humanish", "runs", "cua-remote");
      expect(await readFile(path.join(run, "run.json"), "utf8")).toBe("{}");
      expect(await readdir(path.dirname(copiedVideo(cwd))).catch(() => [])).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("says the copy is finished only once every file is here", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    const record = path.join(cwd, ".humanish", "runs", "cua-remote", "remote.json");
    try {
      await largeFile(runDir);
      await writeFile(record, JSON.stringify({ provider: "e2b", copyPending: true }));
      let broken = true;
      failingRange(runner, 1, () => broken);
      await expect(
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast),
      ).rejects.toThrow("connection dropped");
      expect(JSON.parse(await readFile(record, "utf8")).copyPending).toBe(true);
      broken = false;
      await copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined, fast);
      const finished = JSON.parse(await readFile(record, "utf8"));
      expect(finished.copyPending).toBeUndefined();
      expect(finished.provider).toBe("e2b");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("leaves a large settled recording for the copy at the end of the run", async () => {
    const { home, runner, runDir } = await localRunner();
    const { cwd, paths } = await runHere();
    try {
      await largeFile(runDir);
      await mkdir(path.join(runDir, "recordings", "p02"), { recursive: true });
      await writeFile(path.join(runDir, "recordings", "p02", "desktop.mp4"), "short");
      const old = new Date(Date.now() - 60_000);
      await utimes(path.join(runDir, "recordings", "p01", "desktop.mp4"), old, old);
      await utimes(path.join(runDir, "recordings", "p02", "desktop.mp4"), old, old);
      const copied = new Map<string, number>();
      await copySettledEvidence(runner, paths, "cua-remote", copied, () => undefined);
      expect([...copied.keys()]).toEqual(["recordings/p02/desktop.mp4"]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
