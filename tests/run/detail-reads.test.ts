import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRunDetail } from "../../src/run/detail.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { estimateActorCost } from "../../src/run/pricing.js";

// Lets a test act right after readRunDetail resolved its run, or hand it another project's run.
const afterResolve: { run?: () => Promise<void>; from?: string } = {};
vi.mock("../../src/run/locate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/locate.js")>();
  return {
    ...actual,
    resolveRunPath: vi.fn(async (cwd: string, run: string) => {
      const resolved = await actual.resolveRunPath(afterResolve.from ?? cwd, run);
      await afterResolve.run?.();
      return resolved;
    }),
  };
});

describe("run detail reads", () => {
  let base: string;
  let project: string;
  let runJson: string;
  const runId = "detail-reads";

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "humanish-detail-reads-"));
    project = path.join(base, "proj");
    await mkdir(project);
    await runDryRun({ cwd: project, dryRun: true, runId });
    runJson = path.join(project, ".humanish", "runs", runId, "run.json");
    delete afterResolve.run;
    delete afterResolve.from;
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function outsideBundle(): Promise<string> {
    const outside = path.join(base, "outside.json");
    await writeFile(outside, JSON.stringify({ runId: "planted", streams: [] }));
    return outside;
  }

  it("reads the run's own bundle", async () => {
    const detail = await readRunDetail(project, runId);
    expect(detail?.runId).toBe(runId);
    expect(detail?.observerPath).toBe(
      path.join(".humanish", "runs", runId, "observer", "index.html"),
    );
  });

  it("refuses a run.json swapped for a symlink after the run resolved", async () => {
    const outside = await outsideBundle();
    afterResolve.run = async () => {
      await unlink(runJson);
      await symlink(outside, runJson);
    };
    await expect(readRunDetail(project, runId)).rejects.toThrow(
      "run.json is not a single-link regular file.",
    );
  });

  it("refuses a run.json swapped for a hardlink after the run resolved", async () => {
    const outside = await outsideBundle();
    afterResolve.run = async () => {
      await unlink(runJson);
      await link(outside, runJson);
    };
    await expect(readRunDetail(project, runId)).rejects.toThrow(
      "run.json is not a single-link regular file.",
    );
  });

  it("shows an observer outside the cwd as an absolute path, even with a shared name prefix", async () => {
    // proj2 starts with the characters of proj, so a string-prefix check calls it inside proj.
    const sibling = path.join(base, "proj2");
    await mkdir(sibling);
    await runDryRun({ cwd: sibling, dryRun: true, runId });
    afterResolve.from = sibling;
    const detail = await readRunDetail(project, runId);
    expect(detail?.observerPath).toBe(
      path.join(sibling, ".humanish", "runs", runId, "observer", "index.html"),
    );
  });
});

describe("rate source labels", () => {
  it("names gpt-6-astra's own rate sheet", () => {
    const astra = estimateActorCost({ input: 1000, output: 200 }, "gpt-6-astra");
    expect(astra.source).toContain("gpt-6-astra");
    expect(astra.source).not.toContain("gpt-5.6");
    const sol = estimateActorCost({ input: 1000, output: 200 }, "gpt-5.6-sol");
    expect(sol.source).toContain("gpt-5.6 family");
  });
});
