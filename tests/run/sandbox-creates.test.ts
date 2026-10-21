// The per-run-directory create registry the signal handler reads: a stop refuses later creates
// and reports every id a create in flight returns, however many other directories come and go.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  prepareSelectedOutputDirectory,
  type PreparedOutputRoot,
} from "../../src/run/contained-output.js";
import { createRunArtifactPaths } from "../../src/run/paths.js";
import {
  beginSandboxCreate,
  pinRunOwnerKey,
  recordSandboxOwnerOnce,
  sandboxOwnerTags,
  stopSandboxCreates,
  type CreatedSandbox,
} from "../../src/run/sandbox-creates.js";
import {
  appendSandboxOwner,
  parseSandboxOwners,
  SANDBOX_RECEIPTS_ARTIFACT,
} from "../../src/run/sandbox-receipts.js";

/** A directory identity only; the registry never touches the filesystem. */
function root(name: string, ino: number): PreparedOutputRoot {
  return {
    physicalPath: `/synthetic/${name}`,
    requestedPath: `/synthetic/${name}`,
    identity: { dev: 1n, ino: BigInt(ino), birthtimeNs: 7n },
  };
}

describe("the sandbox create registry", () => {
  it("keeps a directory with a create in flight while a hundred others come and go", () => {
    const active = root("active-run", 1);
    const ticket = beginSandboxCreate(active, "p1", "e2b");
    for (let index = 0; index < 100; index += 1) {
      const other = beginSandboxCreate(root(`other-${index}`, 1_000 + index), "p1", "e2b");
      other.created(`fake-sb-other-${index}`);
      other.released(`fake-sb-other-${index}`);
      other.settled();
    }
    const stopped = stopSandboxCreates(active);
    const seen: CreatedSandbox[] = [];
    stopped.watch((sandbox) => seen.push(sandbox));
    // The original ticket sees the stop, and the id it reports reaches the stopped entry.
    expect(ticket.stopping()).toBe(true);
    ticket.created("fake-sb-active");
    expect(seen.map((sandbox) => sandbox.sandboxId)).toEqual(["fake-sb-active"]);
    expect(stopped.inFlight()).toBe(1);
    ticket.settled();
    expect(stopped.inFlight()).toBe(0);
    expect(() => beginSandboxCreate(active, "p2", "e2b")).toThrow("The run is stopping");
  });

  it("names a directory by its basename and keys it by inode and creation time", () => {
    const tags = sandboxOwnerTags(root("smoke", 42));
    expect(tags).toMatchObject({ tool: "humanish", runId: "smoke" });
    expect(tags.runKey).toMatch(/^[0-9a-f]{16}$/);
    expect(sandboxOwnerTags(root("smoke", 43)).runKey).not.toBe(tags.runKey);
    // A renamed directory keeps its inode, so it keeps its key.
    expect(sandboxOwnerTags(root("renamed", 42)).runKey).toBe(tags.runKey);
  });

  it("names a run directory by the key its launcher pinned, on any machine", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-owner-key-"));
    try {
      const made = await Promise.all(
        ["launcher", "remote"].map(async (side) => {
          await mkdir(path.join(cwd, side));
          const created = await createRunArtifactPaths(path.join(cwd, side), "cua-remote-run");
          if (!created.ok) throw new Error("run directory not created");
          return created.paths;
        }),
      );
      const [launcher, remote] = made as [PreparedOutputRoot, PreparedOutputRoot];
      expect(sandboxOwnerTags(launcher)).not.toEqual(sandboxOwnerTags(remote));
      for (const paths of made) await pinRunOwnerKey(paths, "1111222233334444");
      expect(sandboxOwnerTags(launcher)).toEqual({
        tool: "humanish",
        runId: "cua-remote-run",
        runKey: "1111222233334444",
      });
      expect(sandboxOwnerTags(remote)).toEqual(sandboxOwnerTags(launcher));
      // Pinned once: a second key is refused, and the first stays.
      await expect(pinRunOwnerKey(launcher, "5555666677778888")).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(sandboxOwnerTags(launcher).runKey).toBe("1111222233334444");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a malformed key and ignores a pinned key that is a link", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "humanish-owner-key-"));
    try {
      const created = await createRunArtifactPaths(cwd, "cua-linked");
      if (!created.ok) throw new Error("run directory not created");
      const derived = sandboxOwnerTags(created.paths).runKey;
      await expect(pinRunOwnerKey(created.paths, "NOT-A-KEY")).rejects.toThrow("16 lowercase");
      const outside = path.join(cwd, "elsewhere");
      await writeFile(outside, "1111222233334444\n");
      await symlink(outside, path.join(created.paths.physicalRunRoot, "owner-key"));
      expect(sandboxOwnerTags(created.paths).runKey).toBe(derived);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes the owner line once per directory, and again after a failed write", async () => {
    const directory = root("owner-line", 77);
    const results = [false, true];
    let writes = 0;
    const write = async () => {
      writes += 1;
      return results.shift() ?? true;
    };
    // Two creates that start together share one write.
    await Promise.all([
      recordSandboxOwnerOnce(directory, "e2b", write),
      recordSandboxOwnerOnce(directory, "e2b", write),
    ]);
    expect(writes).toBe(1);
    // It failed, so the next create writes again; once it lands, no create writes it again.
    await recordSandboxOwnerOnce(directory, "e2b", write);
    await recordSandboxOwnerOnce(directory, "e2b", write);
    expect(writes).toBe(2);
  });

  it("records a valid owner line after an earlier append left a torn one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "humanish-owner-line-"));
    try {
      const prepared = await prepareSelectedOutputDirectory(dir, "run");
      const journal = path.join(dir, "run", SANDBOX_RECEIPTS_ARTIFACT);
      // A write that failed partway through, with no newline after it.
      await writeFile(journal, '{"at":"2026-10-04T00:00:00.000Z","provider":"e2b","owner":{"too');
      const owner = sandboxOwnerTags(prepared);
      expect(await appendSandboxOwner(prepared, owner, "e2b")).toBe(true);
      expect(parseSandboxOwners(await readFile(journal, "utf8"), owner.runId)).toEqual([
        { provider: "e2b", tags: owner },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
