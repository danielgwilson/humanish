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

import { STUDY_SCHEMA } from "../../../src/study/types.js";
import { libraryConfig } from "../../helpers/library-config.js";
import { runStudyWith } from "../../../src/run-study.js";
import type { AdapterScoringContext } from "../../../src/study/adapter-scorer-loader.js";
import type { StudyEvent } from "../../../src/study/run-study-events.js";
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
    const config = libraryConfig({
      schema: STUDY_SCHEMA,
      id: "local-browser",
      route: "computer-use",
      mode: "live",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
      actor: { type: "local-agent", localAgent: "codex", mission: "Complete a synthetic task." },
      execution: { target: "local", timeoutMs: 120_000 },
    });

    const outcome = await runStudyWith(config, { cwd, dryRun: true, open: false });
    expect((outcome.result as { ok?: boolean }).ok).not.toBe(false);
    expect(calls.prepare).not.toHaveBeenCalled();
    expect(calls.account).not.toHaveBeenCalled();
  });

  it("keeps a caller's scorer through the local study", async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-scored-"));
    const config = libraryConfig({
      schema: STUDY_SCHEMA,
      id: "local-scored",
      route: "computer-use",
      mode: "live",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000" },
      actor: { type: "openai-computer-use", mission: "Complete a synthetic task." },
      execution: { target: "local" },
    });
    const score = vi.fn((ctx: AdapterScoringContext): RunAdapterScore => ({
      schema: "humanish.adapter-score.v1",
      namespace: "example-adapter",
      status: "pass",
      score: 100,
      summary: `Scored ${"participantCount" in ctx ? ctx.participantCount : 0} participant.`,
    }));
    const onEvent = vi.fn((_event: StudyEvent) => {});

    const outcome = await runStudyWith(config, {
      cwd,
      dryRun: true,
      open: false,
      scorer: { score },
      onEvent,
    });

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    expect(outcome.result.ok).toBe(true);
    expect(onEvent.mock.calls.filter(([event]) => event.type === "plan")).toHaveLength(1);
    expect(score).toHaveBeenCalledOnce();
    expect(score.mock.calls[0]![0]).toMatchObject({ route: "computer-use", dryRun: true });
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.adapterScore).toMatchObject({ namespace: "example-adapter", status: "pass" });
    expect(calls.prepare).not.toHaveBeenCalled();
  });
});
