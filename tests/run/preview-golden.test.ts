import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDryRun } from "../../src/run/dry-run.js";
import { captureStderr, runDirSnapshot } from "../helpers/run-golden.js";

// Characterization: the complete run directory, latest pointer and returned result of the synthetic
// preview run, pinned so a change to how it writes its bundle shows up as a diff. runDryRun renders
// an Observer only when RunOptions.observer asks for one, so no observer/index.html is expected
// here. Regenerate
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
    const stderr = captureStderr();
    const result = await runDryRun({ cwd, dryRun: true, runId: "preview-golden" }).finally(
      stderr.stop,
    );
    expect(result.ok).toBe(true);
    const snapshot = await runDirSnapshot(path.join(cwd, ".humanish", "runs", "preview-golden"), {
      result,
      stderr: stderr.text(),
      replace: [
        [cwd, "[cwd]"],
        ["preview-golden", "[run]"],
      ],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      "../golden/routes/preview-dry-run.json",
    );
  });

  // The preview goes through the judge like every route: its verdict is a contract, and status.json
  // carries the result's ok and execution outcome.
  it("agrees across bundle, result and status", async () => {
    const cwd = path.join(root, "minimal-app");
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    const result = await runDryRun({ cwd, dryRun: true, runId: "preview-agreement" });
    const runDir = path.join(cwd, ".humanish", "runs", "preview-agreement");
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as {
      review: { verdict: string };
    };
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: { verdict?: string; ok?: boolean; execution?: { succeeded: boolean } };
    };
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(status.outcome?.verdict).toBe(bundle.review.verdict);
    expect(status.outcome?.ok).toBe(result.ok);
    expect(status.outcome?.execution).toEqual({ succeeded: true, failures: [] });
  });
});
