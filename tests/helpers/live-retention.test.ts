import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retainLiveRuns } from "./live-retention.js";

describe("retainLiveRuns", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "humanish-retain-"));
    vi.stubEnv("HUMANISH_LIVE_RETAIN_DIR", path.join(root, "retained"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("copies the project's run bundles to the retained root and removes the project", async () => {
    const cwd = path.join(root, "project");
    const run = path.join(cwd, ".humanish", "runs", "cua-run-1");
    await mkdir(run, { recursive: true });
    await writeFile(path.join(run, "run.json"), '{"ok":true}\n');
    await writeFile(path.join(cwd, "subject.txt"), "temp project file\n");

    const target = await retainLiveRuns(cwd, "cua-lab");

    expect(target?.startsWith(path.join(root, "retained", "cua-lab-"))).toBe(true);
    expect(await readFile(path.join(target!, "cua-run-1", "run.json"), "utf8")).toBe(
      '{"ok":true}\n',
    );
    await expect(stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("only removes a project that wrote no runs", async () => {
    const cwd = path.join(root, "empty-project");
    await mkdir(cwd, { recursive: true });

    expect(await retainLiveRuns(cwd, "terminal")).toBeUndefined();
    await expect(stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(root, "retained"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
