import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ContainedOutput from "../../src/run/contained-output.js";
import { activeRuns } from "../../src/run/active-runs.js";
import { runScope } from "../../src/run/run.js";
import { RUN_STATUS_FILE } from "../../src/run/status.js";

// The first status write can be held open, so a test can look at the registry while status.json
// is still settling, which is when a signal used to find no run to interrupt.
const statusGate = vi.hoisted(() => ({
  hold: undefined as Promise<void> | undefined,
  reached: undefined as (() => void) | undefined,
}));
vi.mock("../../src/run/contained-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ContainedOutput>();
  return {
    ...actual,
    writeContainedOutputFile: async (
      ...args: Parameters<typeof actual.writeContainedOutputFile>
    ) => {
      if (args[1] === RUN_STATUS_FILE && statusGate.hold !== undefined) {
        statusGate.reached?.();
        await statusGate.hold;
      }
      return actual.writeContainedOutputFile(...args);
    },
  };
});

describe("the active-run registry", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-active-runs-"));
  });
  afterEach(async () => {
    statusGate.hold = undefined;
    statusGate.reached = undefined;
    await rm(cwd, { recursive: true, force: true });
  });

  it("holds a run before its first status write has settled", async () => {
    let release!: () => void;
    statusGate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      statusGate.reached = resolve;
    });
    await runScope(async (scope) => {
      const starting = scope.startRun({
        cwd,
        runId: "run-settling",
        mintRunId: () => "run-settling",
        mode: "live",
        renderReview: () => "# Review\n",
      });
      await reached;
      const registered = activeRuns().map((run) => run.runId);
      statusGate.hold = undefined;
      release();
      expect((await starting).ok).toBe(true);
      expect(registered).toContain("run-settling");
    });
    expect(activeRuns().map((run) => run.runId)).not.toContain("run-settling");
  });
});
