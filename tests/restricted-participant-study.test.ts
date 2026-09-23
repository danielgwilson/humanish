import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRestrictedParticipantStudy } from "../src/restricted-codex-participant-run.js";
import { parseLabConfig } from "../src/lab-config.js";
import { runRestrictedCodexSession } from "../src/restricted-codex-session.js";
import { PARTICIPANT_PROFILE } from "../src/restricted-codex-participant-policy.js";
import { estimateActorCostForExecution, estimateActorCost, contradictsAccountBilling } from "../src/pricing.js";
import { readRunDetail } from "../src/run-detail.js";
import { verifyRun } from "../src/run.js";
vi.mock("../src/restricted-codex-session.js", () => ({ runRestrictedCodexSession: vi.fn() }));
const session = vi.mocked(runRestrictedCodexSession);
const directories: string[] = [];
afterEach(async () => { session.mockReset(); await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
function config(analysis: false | { provider: "codex" } = false) {
  const parsed = parseLabConfig({ schema: "humanish.lab.v2", id: "synthetic-account", title: "Synthetic account study",
    subject: { source: "local-app", appUrl: "http://localhost:5173/" }, actors: [{ type: "openai-computer-use", model: "gpt-6-astra", mission: "Save the synthetic note." }],
    scenario: { mode: "live" }, execution: { timeoutMs: 10_000 }, review: { analysis } });
  if (!parsed.ok) throw new Error(parsed.error.message); return parsed.config;
}
const success = { status: "completed" as const, usage: { input: 50, output: 10 }, usageComplete: true, dispatched: true, errorCode: null,
  output: { schema: PARTICIPANT_PROFILE.participantSchema, narration: "I finished the synthetic task.", done: true, outcome: "reached", actions: [] } };
describe("account participant producer and accounting", () => {
  it("keeps actual model API rates separate from account billing", () => {
    const tokens = { input: 1000, output: 10 };
    expect(estimateActorCost(tokens, "gpt-6-astra").estimatedCostUsd).toBeGreaterThan(0);
    for (const usage of [tokens, { input: 2 }, undefined]) expect(estimateActorCostForExecution(usage, "gpt-6-astra", PARTICIPANT_PROFILE))
      .toMatchObject({ estimatedCostUsd: null, ratesAsOf: null, reason: "account_billing_unknown" });
    const streams = [{ id: "account", laneId: "account-lane", actor: { executionProfile: PARTICIPANT_PROFILE } }, { id: "api", laneId: "api-lane" }];
    const line = { kind: "model-tokens", estimatedCostUsd: 1 };
    expect(contradictsAccountBilling(streams, { fullyEstimated: false, breakdown: [{ ...line, laneId: "account-lane" }] })).toBe(true);
    expect(contradictsAccountBilling(streams, { fullyEstimated: false, breakdown: [line] })).toBe(true);
    expect(contradictsAccountBilling(streams, { fullyEstimated: false, breakdown: [{ ...line, laneId: "api-lane" }, { kind: "desktop-minutes", estimatedCostUsd: 2 }] })).toBe(false);
  });
  it("uses the normal finalized producer and automatic boundary after exact cleanup", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-account-study-")); directories.push(cwd);
    session.mockResolvedValue(success);
    const close = vi.fn(async () => ({ status: "released" as const, reason: "terminated" as const }));
    const automatic = vi.fn(async () => {
      expect(close).toHaveBeenCalledTimes(1);
      const run = JSON.parse(await readFile(path.join(cwd, ".humanish/runs/account-proof/run.json"), "utf8"));
      expect(run.streams[0].actor.providerRequests[0].cleanup).toBe("confirmed");
      return { state: "skipped" as const, reason: "synthetic_domain_test" };
    });
    const frame = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    const r = await runRestrictedParticipantStudy({ cwd, runId: "account-proof", config: config({ provider: "codex" }),
      desktop: { resourceId: "synthetic-owned", close, executor: { observe: async () => ({ screenshot: frame, stateSignature: "synthetic" }), execute: vi.fn() } },
      automaticAnalysis: { run: automatic } });
    expect(r.providerCleanup.status).toBe("confirmed"); expect(automatic).toHaveBeenCalledTimes(1);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish/runs/account-proof/run.json"), "utf8"));
    expect(bundle.streams[0].actor.executionProfile).toEqual(PARTICIPANT_PROFILE);
    expect(bundle.streams[0].actor.estimatedCost).toMatchObject({ estimatedCostUsd: null, reason: "account_billing_unknown" });
    expect(bundle.cost).toMatchObject({ estimatedTotalUsd: null, fullyEstimated: false });
    expect(bundle.cost.breakdown).toContainEqual(expect.objectContaining({ reason: "account_billing_unknown", estimatedCostUsd: null }));
    const detail = await readRunDetail(cwd, "account-proof"); expect(detail?.participants[0]?.estimatedCostUsd).toBeNull();
    expect((await verifyRun(cwd, "account-proof")).ok).toBe(true);
    const numericModelCost = structuredClone(bundle);
    const modelLine = numericModelCost.cost.breakdown.find((line: { kind: string }) => line.kind === "model-tokens");
    modelLine.estimatedCostUsd = 1; numericModelCost.cost.estimatedTotalUsd = 1;
    await writeFile(path.join(cwd, ".humanish/runs/account-proof/run.json"), JSON.stringify(numericModelCost));
    expect((await verifyRun(cwd, "account-proof")).ok).toBe(false);
    const chargedTokens = structuredClone(bundle); chargedTokens.streams[0].actor.tokenUsage.costUsd = 0;
    await writeFile(path.join(cwd, ".humanish/runs/account-proof/run.json"), JSON.stringify(chargedTokens));
    expect((await verifyRun(cwd, "account-proof")).ok).toBe(false);
    const nullProfile = structuredClone(bundle); nullProfile.streams[0].actor.executionProfile = null;
    await writeFile(path.join(cwd, ".humanish/runs/account-proof/run.json"), JSON.stringify(nullProfile));
    expect((await verifyRun(cwd, "account-proof")).ok).toBe(false);
  });
  it("awaits one pending desktop finalizer before automatic completion and final return", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-account-finalizer-")); directories.push(cwd);
    session.mockResolvedValue(success);
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    let confirm!: (value: { status: "released"; reason: "terminated" }) => void;
    const closed = new Promise<{ status: "released"; reason: "terminated" }>(resolve => { confirm = resolve; });
    const close = vi.fn(() => { release(); return closed; });
    const automatic = vi.fn(async () => ({ state: "skipped" as const, reason: "synthetic_domain_test" }));
    const frame = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    let returned = false;
    const pending = runRestrictedParticipantStudy({ cwd, config: config({ provider: "codex" }), desktop: { resourceId: "synthetic-owned", close,
      executor: { observe: async () => ({ screenshot: frame, stateSignature: "synthetic" }), execute: vi.fn() } }, automaticAnalysis: { run: automatic } })
      .then(result => { returned = true; return result; });
    await started; expect(returned).toBe(false); expect(automatic).not.toHaveBeenCalled();
    confirm({ status: "released", reason: "terminated" });
    await pending; expect(close).toHaveBeenCalledTimes(1); expect(automatic).toHaveBeenCalledTimes(1);
  });
  it("preflight rejects unsupported caps and still releases the already-owned desktop", async () => {
    const cfg = config(); cfg.execution!.caps = { maxUsd: 0 };
    const close = vi.fn(async () => ({ status: "released" as const, reason: "terminated" as const }));
    const observe = vi.fn();
    await expect(runRestrictedParticipantStudy({ cwd: "/unused", config: cfg,
      desktop: { resourceId: "synthetic-owned", close, executor: { observe, execute: vi.fn() } } })).rejects.toMatchObject({ code: "request_rejected" });
    expect(close).toHaveBeenCalledTimes(1); expect(observe).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled();
  });
  it("never calls automatic analysis when a finalized request lost cleanup confirmation", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-account-unclean-")); directories.push(cwd);
    session.mockResolvedValue({ ...success, status: "failed", output: null, errorCode: "codex_cleanup_failed", usageComplete: false });
    const automatic = vi.fn(); const frame = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    const r = await runRestrictedParticipantStudy({ cwd, config: config({ provider: "codex" }),
      desktop: { resourceId: "synthetic-owned", close: async () => ({ status: "released", reason: "terminated" }), executor: {
        observe: async () => ({ screenshot: frame, stateSignature: "synthetic" }), execute: vi.fn() } }, automaticAnalysis: { run: automatic } });
    expect(r.providerCleanup.status).toBe("unconfirmed"); expect(automatic).not.toHaveBeenCalled();
  });
});
