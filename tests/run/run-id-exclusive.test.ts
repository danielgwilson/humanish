import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveLabManifest } from "../../src/lab/discover.js";
import { runLab } from "../../src/lab/engine.js";
import { renderObserver } from "../../src/observer/render.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { bindExistingRunArtifactPaths, createRunArtifactPaths } from "../../src/run/paths.js";
import { reclaimRunSandboxes } from "../../src/run/reclaim.js";
import { SANDBOX_RECEIPTS_ARTIFACT } from "../../src/run/sandbox-receipts.js";
import { verifyRun } from "../../src/run/verify.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-id-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function killRecordingModule(killed: string[]): E2BDesktopModule {
  return {
    Sandbox: {
      async create() {
        throw new Error("reclaim never creates sandboxes");
      },
      async kill(sandboxId: string) {
        killed.push(sandboxId);
        return true;
      },
    },
  } as unknown as E2BDesktopModule;
}

describe("a new run creates its directory exclusively", () => {
  it("lets exactly one of two concurrent starts claim a run id", async () => {
    for (let round = 0; round < 20; round += 1) {
      const runId = `race-${round}`;
      const outcomes = await Promise.all([
        createRunArtifactPaths(cwd, runId),
        createRunArtifactPaths(cwd, runId),
      ]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({
        code: "HUMANISH_RUN_ID_IN_USE",
      });
    }
  });

  it("gives two concurrent runs with one id one bundle and one refusal", async () => {
    const results = await Promise.all([
      runDryRun({ cwd, dryRun: true, runId: "shared" }),
      runDryRun({ cwd, dryRun: true, runId: "shared" }),
    ]);
    expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
    expect(results.find((result) => !result.ok)?.error?.code).toBe("HUMANISH_RUN_ID_IN_USE");
    expect((await verifyRun(cwd, "shared")).ok).toBe(true);
  });

  it("refuses the id of an interrupted run that left only sandbox receipts", async () => {
    const runDir = path.join(cwd, ".humanish", "runs", "interrupted");
    await mkdir(runDir, { recursive: true });
    const receipts = `${JSON.stringify({ at: "2026-09-30T00:00:00.000Z", laneId: "lane-01", sandboxId: "sbx-1", timeoutMs: 1_000 })}\n`;
    await writeFile(path.join(runDir, SANDBOX_RECEIPTS_ARTIFACT), receipts, "utf8");

    const refused = await runDryRun({ cwd, dryRun: true, runId: "interrupted" });

    expect(refused.error?.code).toBe("HUMANISH_RUN_ID_IN_USE");
    expect(await readdir(runDir)).toEqual([SANDBOX_RECEIPTS_ARTIFACT]);
    expect(await readFile(path.join(runDir, SANDBOX_RECEIPTS_ARTIFACT), "utf8")).toBe(receipts);
    const killed: string[] = [];
    await reclaimRunSandboxes(cwd, "interrupted", {
      loadModule: async () => killRecordingModule(killed),
    });
    expect(killed).toEqual(["sbx-1"]);
  });

  it("keeps an existing run readable after a refused reuse of its id", async () => {
    expect((await runDryRun({ cwd, dryRun: true, runId: "kept" })).ok).toBe(true);
    expect((await runDryRun({ cwd, dryRun: true, runId: "kept" })).ok).toBe(false);

    const bound = await bindExistingRunArtifactPaths(cwd, "kept");
    expect(path.basename(bound.physicalRunRoot)).toBe("kept");
    expect((await verifyRun(cwd, "kept")).ok).toBe(true);
    expect((await renderObserver(cwd, "kept", { open: false })).ok).toBe(true);
  });

  it("leaves the id free when the latest pointer is not a regular file", async () => {
    const runsRoot = path.join(cwd, ".humanish", "runs");
    const latest = path.join(runsRoot, "latest.json");
    await mkdir(latest, { recursive: true });

    await expect(runDryRun({ cwd, dryRun: true, runId: "retry" })).rejects.toThrow(
      /single-link regular files/,
    );
    expect(await readdir(runsRoot)).toEqual(["latest.json"]);

    await rm(latest, { recursive: true });
    expect((await runDryRun({ cwd, dryRun: true, runId: "retry" })).ok).toBe(true);
    expect((await verifyRun(cwd, "retry")).ok).toBe(true);
  });
});

describe("every producer refuses a run id that is in use", () => {
  it.each([
    ["preview", "first-run", "synthetic"],
    ["terminal", "terminal-product-demo", "terminal"],
    ["scripted", "scripted-demo", "scripted"],
    ["computer use", "fanout-demo", "cua"],
    ["concurrent shared world", "shared-world-concurrent-demo", "concurrent-shared-world"],
  ] as const)("%s (%s)", async (_route, labId, backend) => {
    // The labs read their personas and scenarios from the project they run in.
    await cp(path.resolve("humanish"), path.join(cwd, "humanish"), { recursive: true });
    const resolved = await resolveLabManifest(cwd, labId);
    if (!resolved.ok) throw new Error(`lab ${labId} did not resolve`);
    const runDir = path.join(cwd, ".humanish", "runs", "in-use");

    const first = await runLab(resolved.config, { cwd, dryRun: true, runId: "in-use" });
    expect(first.backend).toBe(backend);
    expect(first.result.ok).toBe(true);
    const before = {
      run: await readFile(path.join(runDir, "run.json"), "utf8"),
      status: await readFile(path.join(runDir, "status.json"), "utf8"),
    };

    const second = await runLab(resolved.config, { cwd, dryRun: true, runId: "in-use" });
    expect(second.result.ok).toBe(false);
    expect(second.result.error?.code).toBe("HUMANISH_RUN_ID_IN_USE");
    expect({
      run: await readFile(path.join(runDir, "run.json"), "utf8"),
      status: await readFile(path.join(runDir, "status.json"), "utf8"),
    }).toEqual(before);
  });
});
