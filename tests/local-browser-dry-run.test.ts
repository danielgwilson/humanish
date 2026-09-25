import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ prepare: vi.fn(), account: vi.fn() }));

vi.mock("../src/local-runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/local-runtime.js")>(),
  prepareLocalRuntime: calls.prepare
}));
vi.mock("../src/restricted-codex-analysis.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/restricted-codex-analysis.js")>(),
  checkRestrictedCodexAnalysisReadiness: calls.account
}));

import type { LabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";

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
      scenario: { mode: "live" }
    };

    const outcome = await runLab(config, { cwd, dryRun: true, open: false });
    expect((outcome.result as { ok?: boolean }).ok).not.toBe(false);
    expect(calls.prepare).not.toHaveBeenCalled();
    expect(calls.account).not.toHaveBeenCalled();
  });
});
