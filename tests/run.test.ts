import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";
import {
  RUN_BUNDLE_SCHEMA,
  listRuns,
  readReview,
  runDryRun,
  verifyRun
} from "../src/run.js";

async function withFixtureCopy<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-run-fixture-"));
  const tempApp = path.join(tempRoot, "minimal-app");

  try {
    await cp(path.resolve("fixtures/minimal-app"), tempApp, { recursive: true });
    return await callback(tempApp);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    }
  });

  await program.parseAsync(["node", "mimetic", ...args], { from: "node" });

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join("")
  };
}

describe("dry-run bundles", () => {
  it("writes and verifies a synthetic run bundle", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runDryRun({
        cwd,
        dryRun: true,
        runId: "dryrun-test"
      });

      expect(run.ok).toBe(true);
      expect(run.runId).toBe("dryrun-test");
      expect(run.bundlePath).toBe(".mimetic/runs/dryrun-test/run.json");

      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".mimetic/runs/dryrun-test/run.json"), "utf8")
      ) as { schema: string; review: { verdict: string }; simCount: number; simulations: unknown[] };
      expect(bundle.schema).toBe(RUN_BUNDLE_SCHEMA);
      expect(bundle.simCount).toBe(1);
      expect(bundle.simulations).toHaveLength(1);
      expect(bundle.review.verdict).toBe("contract_proof_only");

      await expect(stat(path.join(cwd, ".mimetic/runs/latest.json"))).resolves.toBeTruthy();

      const verify = await verifyRun(cwd, "latest");
      expect(verify.ok).toBe(true);
      expect(verify.checks.every((check) => check.ok)).toBe(true);

      const review = await readReview(cwd, "latest");
      expect("verdict" in review ? review.verdict : null).toBe("contract_proof_only");

      const runs = await listRuns(cwd);
      expect(runs.latest).toBe("dryrun-test");
      expect(runs.runs).toHaveLength(1);
    });
  });

  it("keeps live runs fail-closed", async () => {
    await withFixtureCopy(async (cwd) => {
      const result = await runDryRun({ cwd });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MIMETIC_LIVE_RUN_UNIMPLEMENTED");
      await expect(stat(path.join(cwd, ".mimetic"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("exposes run and verify through the Commander CLI", async () => {
    await withFixtureCopy(async (cwd) => {
      const run = await runCli([
        "run",
        "--dry-run",
        "--run-id",
        "dryrun-cli",
        "--cwd",
        cwd,
        "--json"
      ]);
      expect(run.exitCode).toBe(0);
      const runResult = JSON.parse(run.stdout) as { ok: boolean; runId: string };
      expect(runResult.ok).toBe(true);
      expect(runResult.runId).toBe("dryrun-cli");

      const verify = await runCli(["verify", "--run", "latest", "--cwd", cwd, "--json"]);
      expect(verify.exitCode).toBe(0);
      const verifyResult = JSON.parse(verify.stdout) as { ok: boolean };
      expect(verifyResult.ok).toBe(true);
    });
  });
});
