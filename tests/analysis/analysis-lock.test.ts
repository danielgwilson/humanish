// The run's analysis lock is held by another process: one that is still running keeps it, and one
// that was killed while holding it leaves it to the next analysis, which says it took it over. The
// holder is a real child process that takes the lock through withAnalysisLock and waits.
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalysisFetch } from "../../src/analysis/provider.js";
import { analyzeRun } from "../../src/analysis/service.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import type { AnalysisConfig } from "../../src/analysis/types.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { syntheticResult } from "./fixtures.js";

const RUN = "analysis-lock";
const config: AnalysisConfig = {
  model: "gpt-5.6-sol",
  question: null,
  maxCostUsd: 5,
  timeoutMs: 1000,
  maxOutputTokens: 8192,
};
// Real captured wire envelope; only the synthetic analysis answer is replaced.
// Provenance: fixtures/openai-closing-report/README.md.
const wirePath = new URL(
  "../fixtures/openai-closing-report/typed-closing-report.json",
  import.meta.url,
);

let cwd: string;
let runRoot: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-analysis-lock-"));
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runDryRun({ cwd, dryRun: true, runId: RUN });
  runRoot = path.join(cwd, ".humanish/runs", RUN);
  const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
  bundle.mode = "live";
  bundle.streams[0]!.status = "complete";
  await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle, null, 2) + "\n");
  await rm(path.join(runRoot, "status.json"), { force: true });
});

afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(cwd, { recursive: true, force: true });
});

async function transport() {
  const original = await readFile(path.join(runRoot, "run.json"));
  const input = await captureEvidence((await resolveRunPath(cwd, RUN))!, original);
  const wire = JSON.parse(await readFile(wirePath, "utf8"));
  wire.output[0].content[0].text = JSON.stringify(syntheticResult(input));
  return vi.fn<AnalysisFetch>(async () => new Response(JSON.stringify(wire)));
}

/** A child process that takes the run's analysis lock and holds it until it is killed. */
async function holdLock(): Promise<ChildProcess> {
  const module = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
  const script = `
    import { withAnalysisLock } from ${module("../../src/analysis/analysis-lock.ts")};
    import { resolveRunPath } from ${module("../../src/run/locate.ts")};
    const prepared = await resolveRunPath(${JSON.stringify(cwd)}, ${JSON.stringify(RUN)});
    await withAnalysisLock(prepared, async () => {
      process.stdout.write("LOCKED\\n");
      // A pending timer keeps the process alive; a bare pending promise would let it exit.
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the child never took the lock")), 15_000);
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("LOCKED")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("the child exited before it took the lock"));
    });
  });
  return child;
}

describe("the analysis lock of a run", () => {
  it("stays with an owner that is still running", async () => {
    await holdLock();
    const fetch = await transport();
    const result = await analyzeRun(cwd, RUN, { config }, { apiKey: "synthetic-key", fetch });
    expect(result.error?.code).toBe("ANALYSIS_BUSY");
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(runRoot)).toContain(".analysis-lock");
  });

  it("passes from an owner that was killed to the next analysis, which says so", async () => {
    const child = await holdLock();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect(await readdir(runRoot)).toContain(".analysis-lock");

    const fetch = await transport();
    const result = await analyzeRun(cwd, RUN, { config }, { apiKey: "synthetic-key", fetch });
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.warnings.some((warning) => warning.includes(String(child.pid)))).toBe(true);
    expect((await readdir(runRoot)).filter((entry) => entry.includes("analysis-lock"))).toEqual([]);
  });

  it("keeps a lock that names no owner, as earlier versions left one", async () => {
    await mkdir(path.join(runRoot, ".analysis-lock"));
    const fetch = await transport();
    const result = await analyzeRun(cwd, RUN, { config }, { apiKey: "synthetic-key", fetch });
    expect(result.error?.code).toBe("ANALYSIS_BUSY");
    expect(await readdir(runRoot)).toContain(".analysis-lock");
  });
});
