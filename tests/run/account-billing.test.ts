import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestrictedCodexParticipant } from "../../src/actors/codex/restricted-participant.js";
import { PARTICIPANT_PROFILE } from "../../src/actors/codex/restricted-participant-policy.js";
import type {
  RestrictedCodexRequest,
  RestrictedCodexResult,
} from "../../src/actors/codex/restricted-policy.js";
import { parseStudy } from "../../src/study/config.js";
import { runLab } from "../../src/run-lab.js";
import { readRunDetail } from "../../src/run/detail.js";
import { estimateActorCost, estimateActorCostForExecution } from "../../src/run/pricing.js";
import { contradictsAccountBilling } from "../../src/verify/costs.js";
import { verifyRun } from "../../src/verify/verify.js";

const { session } = vi.hoisted(() => ({
  session: vi.fn<(request: RestrictedCodexRequest) => Promise<RestrictedCodexResult>>(),
}));
// The participant talks to a local Codex process; the fake stands in for that session so the
// study runs offline with the real participant, loop, bundle writer and verifier.
// The detected release differs from the Linux default (0.157.1), so the bundle proves which one it used.
vi.mock("../../src/actors/codex/restricted-session.js", () => ({
  createRestrictedCodexSession: vi.fn(() => ({
    run: session,
    close: async () => true,
    cliVersion: "0.154.0",
  })),
}));

const directories: string[] = [];
afterEach(async () => {
  session.mockReset();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function accountBilledConfig() {
  const parsed = parseStudy({
    schema: "humanish.lab.v2",
    id: "synthetic-account",
    title: "Synthetic account study",
    subject: { source: "local-app", appUrl: "http://localhost:5173/" },
    actors: [
      { type: "openai-computer-use", model: "gpt-6-astra", mission: "Save the synthetic note." },
    ],
    scenario: { mode: "live" },
    execution: { timeoutMs: 10_000 },
    review: { analysis: false },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("account-billed participants", () => {
  it("keeps actual model API rates separate from account billing", () => {
    const tokens = { input: 1000, output: 10 };
    expect(estimateActorCost(tokens, "gpt-6-astra").estimatedCostUsd).toBeGreaterThan(0);
    for (const usage of [tokens, { input: 2 }, undefined])
      expect(
        estimateActorCostForExecution(usage, "gpt-6-astra", PARTICIPANT_PROFILE),
      ).toMatchObject({
        estimatedCostUsd: null,
        ratesAsOf: null,
        reason: "account_billing_unknown",
      });
    const streams = [
      { id: "account", laneId: "account-lane", actor: { executionProfile: PARTICIPANT_PROFILE } },
      { id: "api", laneId: "api-lane" },
    ];
    const line = { kind: "model-tokens", estimatedCostUsd: 1 };
    expect(
      contradictsAccountBilling(streams, {
        fullyEstimated: false,
        breakdown: [{ ...line, laneId: "account-lane" }],
      }),
    ).toBe(true);
    expect(contradictsAccountBilling(streams, { fullyEstimated: false, breakdown: [line] })).toBe(
      true,
    );
    expect(
      contradictsAccountBilling(streams, {
        fullyEstimated: false,
        breakdown: [
          { ...line, laneId: "api-lane" },
          { kind: "desktop-minutes", estimatedCostUsd: 2 },
        ],
      }),
    ).toBe(false);
  });

  it("writes no dollar estimate for the participant and verify rejects one added later", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-account-billing-"));
    directories.push(cwd);
    session.mockResolvedValue({
      status: "completed",
      usage: { input: 50, output: 10 },
      usageComplete: true,
      dispatched: true,
      errorCode: null,
      output: {
        outcome: "reached",
        summary: "I finished the synthetic task.",
        frictionReports: [],
      },
    });
    const participant = createRestrictedCodexParticipant();
    const frame = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    try {
      await runLab(accountBilledConfig(), {
        cwd,
        runId: "account-proof",
        dryRun: false,
        open: false,
        env: {},
        inProcess: {
          executor: async () => ({
            observe: async () => ({ screenshot: frame, stateSignature: "synthetic" }),
            execute: vi.fn(),
          }),
        },
        createProvider: async () => participant.provider,
      });
    } finally {
      await participant.close();
    }

    const runPath = path.join(cwd, ".humanish/runs/account-proof/run.json");
    const bundle = JSON.parse(await readFile(runPath, "utf8"));
    expect(bundle.streams[0].actor.executionProfile).toEqual({
      ...PARTICIPANT_PROFILE,
      cliVersion: "0.154.0",
    });
    expect(bundle.streams[0].actor.estimatedCost).toMatchObject({
      estimatedCostUsd: null,
      reason: "account_billing_unknown",
    });
    expect(bundle.cost).toMatchObject({ estimatedTotalUsd: null, fullyEstimated: false });
    // With no priced line, the note says account billing is unknown, not that a rate is missing.
    expect(bundle.cost.note).toContain("Account billing remains unknown");
    expect(bundle.cost.breakdown).toContainEqual(
      expect.objectContaining({ reason: "account_billing_unknown", estimatedCostUsd: null }),
    );
    const detail = await readRunDetail(cwd, "account-proof");
    expect(detail?.participants[0]?.estimatedCostUsd).toBeNull();
    expect((await verifyRun(cwd, "account-proof")).ok).toBe(true);

    const numericModelCost = structuredClone(bundle);
    const modelLine = numericModelCost.cost.breakdown.find(
      (line: { kind: string }) => line.kind === "model-tokens",
    );
    modelLine.estimatedCostUsd = 1;
    numericModelCost.cost.estimatedTotalUsd = 1;
    await writeFile(runPath, JSON.stringify(numericModelCost));
    expect((await verifyRun(cwd, "account-proof")).ok).toBe(false);

    const chargedTokens = structuredClone(bundle);
    chargedTokens.streams[0].actor.tokenUsage.costUsd = 0;
    await writeFile(runPath, JSON.stringify(chargedTokens));
    expect((await verifyRun(cwd, "account-proof")).ok).toBe(false);

    const nullProfile = structuredClone(bundle);
    nullProfile.streams[0].actor.executionProfile = null;
    await writeFile(runPath, JSON.stringify(nullProfile));
    expect((await verifyRun(cwd, "account-proof")).ok).toBe(false);
  });
});
