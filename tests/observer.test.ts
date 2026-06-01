import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";
import { renderObserver } from "../src/observer.js";
import { runDryRun } from "../src/run.js";

async function withRunBundle<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-observer-fixture-"));
  const tempApp = path.join(tempRoot, "minimal-app");

  try {
    await cp(path.resolve("fixtures/minimal-app"), tempApp, { recursive: true });
    await runDryRun({
      cwd: tempApp,
      dryRun: true,
      runId: "observer-proof"
    });
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

describe("observer rendering", () => {
  it("renders a static observer from a verified bundle", async () => {
    await withRunBundle(async (cwd) => {
      const result = await renderObserver(cwd, "latest");

      expect(result.ok).toBe(true);
      expect(result.observerPath).toBe(".mimetic/runs/observer-proof/observer/index.html");
      const observerPath = result.observerPath;
      if (!observerPath) {
        throw new Error("observerPath missing");
      }
      await expect(stat(path.join(cwd, observerPath))).resolves.toBeTruthy();

      const html = await readFile(path.join(cwd, observerPath), "utf8");
      expect(html).toContain("Mimetic Observer");
      expect(html).toContain("contract_proof_only");
      expect(html).toContain("Evidence Gaps");
      expect(html).toContain("No feedback candidates");
    });
  });

  it("exposes watch --no-open through the Commander CLI", async () => {
    await withRunBundle(async (cwd) => {
      const result = await runCli(["watch", "--run", "latest", "--cwd", cwd, "--no-open", "--json"]);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        observerPath: string;
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.observerPath).toBe(".mimetic/runs/observer-proof/observer/index.html");
    });
  });
});
