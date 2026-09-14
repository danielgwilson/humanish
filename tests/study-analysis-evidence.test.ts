import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../src/run-paths.js";
import { isStudyEvidencePath, readBoundedStudyFile } from "../src/study-analysis-evidence.js";

describe("bounded study evidence reads", () => {
  let cwd: string;
  let root: PreparedRunArtifactPaths;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-study-input-"));
    root = await prepareRunArtifactPaths(cwd, "synthetic-study");
    await mkdir(path.join(root.physicalRunRoot, "evidence"));
    await writeFile(path.join(root.physicalRunRoot, "evidence", "sample.txt"), "synthetic evidence");
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("reads a contained single-link file within its exact byte budget", async () => {
    expect((await readBoundedStudyFile(root, "evidence/sample.txt", 18))?.toString()).toBe("synthetic evidence");
    expect(await readBoundedStudyFile(root, "evidence/sample.txt", 17)).toBeNull();
    expect(await readBoundedStudyFile(root, "missing.txt", 100)).toBeNull();
  });

  it.each(["../outside.txt", "/outside.txt", "C:\\outside.txt", "evidence\\sample.txt",
    "https://example.test/evidence.txt", "data:text/plain,example", "file:evidence.txt",
    "evidence/../sample.txt", "evidence//sample.txt", "evidence/./sample.txt", "bad\0name", "bad\nname"])(
    "rejects path-shaped or nonlocal evidence %j", async (input) => {
      expect(isStudyEvidencePath(input)).toBe(false);
      expect(await readBoundedStudyFile(root, input, 100)).toBeNull();
    }
  );

  it.each(["symlink", "hardlink"] as const)("rejects %s leaves without exposing outside content", async (kind) => {
    const outside = path.join(cwd, "outside.txt");
    await writeFile(outside, "OUTSIDE-SENTINEL");
    const target = path.join(root.physicalRunRoot, "evidence", "linked.txt");
    if (kind === "symlink") await symlink(outside, target);
    else await link(outside, target);
    expect(await readBoundedStudyFile(root, "evidence/linked.txt", 100)).toBeNull();
    expect(await readFile(outside, "utf8")).toBe("OUTSIDE-SENTINEL");
  });

  it("rejects a symlinked parent and a replaced prepared run root", async () => {
    const outside = path.join(cwd, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "sample.txt"), "OUTSIDE-SENTINEL");
    await symlink(outside, path.join(root.physicalRunRoot, "alias"));
    expect(await readBoundedStudyFile(root, "alias/sample.txt", 100)).toBeNull();
    await rename(root.physicalRunRoot, `${root.physicalRunRoot}-retained`);
    await mkdir(root.physicalRunRoot);
    await writeFile(path.join(root.physicalRunRoot, "sample.txt"), "replacement");
    expect(await readBoundedStudyFile(root, "sample.txt", 100)).toBeNull();
  });

  it("rejects invalid budgets without reading", async () => {
    for (const limit of [0, -1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await readBoundedStudyFile(root, "evidence/sample.txt", limit)).toBeNull();
    }
  });
});
