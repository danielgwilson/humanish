import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeTestTempDir } from "./temp-dir.js";
import setup, { leakedPrefixes } from "./tmp-leak-guard.js";

describe("tmp leak guard", () => {
  it("counts humanish-* entries by their mkdtemp prefix and ignores the rest", async () => {
    const dir = await makeTestTempDir("humanish-leak-count-");
    await mkdir(path.join(dir, "humanish-labs-unsafe-leaf-Ab12Cd"));
    await mkdir(path.join(dir, "humanish-labs-unsafe-leaf-Zz9900"));
    await mkdir(path.join(dir, "humanish-env-file-qwerty"));
    await writeFile(path.join(dir, "humanish-fixed-name.txt"), "");
    await writeFile(path.join(dir, "scripted-outside-sentinel.txt"), "");

    expect(leakedPrefixes(dir)).toEqual([
      ["humanish-labs-unsafe-leaf-", 2],
      ["humanish-env-file-", 1],
      ["humanish-fixed-name.txt", 1],
    ]);
  });

  it("gives the run its own temp dir and fails the teardown on a leftover, naming its prefix", async () => {
    const shared = process.env.TMPDIR;
    const teardown = setup();
    const runDir = tmpdir();
    expect(runDir).not.toBe(shared);
    expect(await readdir(runDir)).toEqual([]);
    await mkdir(path.join(runDir, "humanish-local-tree-Ab12Cd"));

    expect(teardown).toThrow(/1 humanish-\* entries.*humanish-local-tree-\* 1/);
    expect(process.env.TMPDIR).toBe(shared);
    await expect(readdir(runDir)).rejects.toThrow(/ENOENT/);
  });

  it("passes a run that leaves nothing behind", () => {
    const teardown = setup();
    expect(teardown).not.toThrow();
  });
});
