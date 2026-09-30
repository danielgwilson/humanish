import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDryRun } from "../../src/run/dry-run.js";
import { runDirSnapshot } from "../helpers/run-golden.js";

// Characterization: the complete run directory, latest pointer and returned result of the synthetic
// preview run, pinned so a change to how it writes its bundle shows up as a diff. The Observer is
// rendered by the callers of runDryRun, so no observer/index.html is expected here. Regenerate
// with `pnpm vitest run tests/run/preview-golden.test.ts -u` and review the diff.
describe("preview run directory golden", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "humanish-preview-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("dry run of the minimal app", async () => {
    const cwd = path.join(root, "minimal-app");
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    const result = await runDryRun({ cwd, dryRun: true, runId: "preview-golden" });
    expect(result.ok).toBe(true);
    const snapshot = await runDirSnapshot(path.join(cwd, ".humanish", "runs", "preview-golden"), {
      result,
      replace: [
        [cwd, "[cwd]"],
        ["preview-golden", "[run]"],
      ],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/routes/preview-dry-run.json",
    );
  });
});
