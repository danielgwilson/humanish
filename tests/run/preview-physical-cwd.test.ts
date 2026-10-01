import { symlinkSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDryRun } from "../../src/run/dry-run.js";
import { loadDryRunInputs } from "../../src/run/dry-run-inputs.js";

// The preview takes no hooks, so the alias is retargeted from inside the selection read, the last
// step before the run starts.
vi.mock("../../src/run/dry-run-inputs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/dry-run-inputs.js")>();
  return { ...actual, loadDryRunInputs: vi.fn(actual.loadDryRunInputs) };
});

describe("preview project binding", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "humanish-preview-cwd-"));
  });
  afterEach(async () => {
    vi.mocked(loadDryRunInputs).mockReset();
    await rm(root, { recursive: true, force: true });
  });

  it("pins a symlink cwd before the alias can be retargeted", async () => {
    const actual = await vi.importActual<typeof import("../../src/run/dry-run-inputs.js")>(
      "../../src/run/dry-run-inputs.js",
    );
    const physicalA = path.join(root, "project-a");
    const physicalB = path.join(root, "project-b");
    const cwdAlias = path.join(root, "project-alias");
    const decoyRuns = path.join(physicalB, ".humanish", "runs");
    const decoyLatest = path.join(decoyRuns, "latest.json");
    const sentinel = "outside sentinel must stay unchanged\n";
    await mkdir(physicalA);
    await mkdir(decoyRuns, { recursive: true });
    await writeFile(decoyLatest, sentinel, "utf8");
    symlinkSync(physicalA, cwdAlias, "dir");
    const pinnedA = await realpath(physicalA);
    vi.mocked(loadDryRunInputs).mockImplementation(async (...args) => {
      unlinkSync(cwdAlias);
      symlinkSync(physicalB, cwdAlias, "dir");
      return actual.loadDryRunInputs(...args);
    });

    const result = await runDryRun({ cwd: cwdAlias, dryRun: true, runId: "pinned" });

    expect(result.ok).toBe(true);
    expect(result.cwd).toBe(pinnedA);
    const bundle = JSON.parse(
      await readFile(path.join(physicalA, ".humanish", "runs", "pinned", "run.json"), "utf8"),
    );
    expect(bundle.runId).toBe("pinned");
    expect(await readFile(decoyLatest, "utf8")).toBe(sentinel);
    expect(await readdir(decoyRuns)).toEqual(["latest.json"]);
  });
});
