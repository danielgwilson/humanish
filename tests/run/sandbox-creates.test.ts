// The per-run-directory create registry the signal handler reads: a stop refuses later creates
// and reports every id a create in flight returns, however many other directories come and go.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  prepareSelectedOutputDirectory,
  type PreparedOutputRoot,
} from "../../src/run/contained-output.js";
import {
  beginSandboxCreate,
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
    const ticket = beginSandboxCreate(active, "p1");
    for (let index = 0; index < 100; index += 1) {
      const other = beginSandboxCreate(root(`other-${index}`, 1_000 + index), "p1");
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
    expect(() => beginSandboxCreate(active, "p2")).toThrow("The run is stopping");
  });

  it("names a directory by its basename and keys it by inode and creation time", () => {
    const tags = sandboxOwnerTags(root("smoke", 42));
    expect(tags).toMatchObject({ tool: "humanish", runId: "smoke" });
    expect(tags.runKey).toMatch(/^[0-9a-f]{16}$/);
    expect(sandboxOwnerTags(root("smoke", 43)).runKey).not.toBe(tags.runKey);
    // A renamed directory keeps its inode, so it keeps its key.
    expect(sandboxOwnerTags(root("renamed", 42)).runKey).toBe(tags.runKey);
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
      recordSandboxOwnerOnce(directory, write),
      recordSandboxOwnerOnce(directory, write),
    ]);
    expect(writes).toBe(1);
    // It failed, so the next create writes again; once it lands, no create writes it again.
    await recordSandboxOwnerOnce(directory, write);
    await recordSandboxOwnerOnce(directory, write);
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
      expect(await appendSandboxOwner(prepared, owner)).toBe(true);
      expect(parseSandboxOwners(await readFile(journal, "utf8"), owner.runId)).toEqual([owner]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
