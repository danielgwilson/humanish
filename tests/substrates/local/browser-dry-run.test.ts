import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ prepare: vi.fn(), account: vi.fn() }));

vi.mock("../../../src/substrates/local/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/substrates/local/runtime.js")>()),
  prepareLocalRuntime: calls.prepare,
}));
vi.mock("../../../src/analysis/restricted-codex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/analysis/restricted-codex.js")>()),
  checkRestrictedCodexAnalysisReadiness: calls.account,
}));

import type { LabConfig } from "../../../src/lab/types.js";
import { runLab } from "../../../src/lab/engine.js";
import type { BrowserLabScoringContext } from "../../../src/lab/adapter-extension.js";
import type { RunAdapterScore, RunBundle } from "../../../src/run/bundle.js";

describe("local browser dry-run", () => {
  let cwd: string | undefined;
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
    cwd = undefined;
    calls.prepare.mockReset();
    calls.account.mockReset();
  });

  it("uses the local route contract without preparing a runtime or checking account quota", async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-dry-"));
    const config: LabConfig = {
      schema: "humanish.lab.v2",
      id: "local-browser",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
      actors: [{ type: "local-agent", localAgent: "codex", mission: "Complete a synthetic task." }],
      execution: { target: "local", timeoutMs: 120_000 },
      scenario: { mode: "live" },
    };

    const outcome = await runLab(config, { cwd, dryRun: true, open: false });
    expect((outcome.result as { ok?: boolean }).ok).not.toBe(false);
    expect(calls.prepare).not.toHaveBeenCalled();
    expect(calls.account).not.toHaveBeenCalled();
  });

  it("keeps a caller's scorer through the local study", async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-scored-"));
    const config: LabConfig = {
      schema: "humanish.lab.v2",
      id: "local-scored",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
      actors: [{ type: "openai-computer-use", mission: "Complete a synthetic task." }],
      execution: { target: "local" },
      scenario: { mode: "live" },
    };
    const score = vi.fn((ctx: BrowserLabScoringContext): RunAdapterScore => ({
      schema: "humanish.adapter-score.v1",
      namespace: "example-adapter",
      status: "pass",
      score: 100,
      summary: `Scored ${ctx.laneCount} lane.`,
    }));
    const onPreflight = vi.fn();

    const outcome = await runLab(config, {
      cwd,
      dryRun: true,
      open: false,
      cuaHooks: { score, onPreflight },
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    expect(outcome.result.ok).toBe(true);
    expect(onPreflight).toHaveBeenCalledOnce();
    expect(score).toHaveBeenCalledOnce();
    expect(score.mock.calls[0]![0]).toMatchObject({ backend: "cua", dryRun: true });
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.adapterScore).toMatchObject({ namespace: "example-adapter", status: "pass" });
    expect(calls.prepare).not.toHaveBeenCalled();
  });
});
