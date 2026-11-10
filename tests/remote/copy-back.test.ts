import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { copyRunBack, copySettledEvidence } from "../../src/remote/copy-back.js";
import { listRemoteRun, readRemoteFileInRanges } from "../../src/remote/runner.js";
import { createRunArtifactPaths } from "../../src/run/paths.js";
import { localRunner } from "../helpers/local-runner.js";

describe("copying a large file back from the runner", () => {
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

  const digestOf = async (file: string) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  const copiedVideo = (cwd: string, folder = "recordings/p01") =>
    path.join(cwd, ".humanish", "runs", "cua-remote", folder, "desktop.mp4");

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
        copyRunBack(runner, paths, "cua-remote", new Map(), () => undefined),
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
