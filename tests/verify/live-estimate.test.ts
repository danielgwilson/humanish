// From run bundle v4 a running participant's cost is the estimate the run writer priced from its
// rows, and its rows and receipts are written only when it finishes. verify checks that estimate's
// labeling as it checks a finished participant's, and stops asking a running account participant
// for receipts run.json no longer holds.

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorExecutionProfile } from "../../src/actors/contract.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import type { RunStream } from "../../src/run/streams.js";
import { verifyRun } from "../../src/verify/verify.js";

const RUN = "running-estimate";
const PROFILE: ActorExecutionProfile = {
  schema: "humanish.actor-execution-profile.v1",
  transport: "codex-app-server",
  authentication: "chatgpt-account",
  billing: "account-unknown",
  requestedModel: "gpt-5.6-sol",
  reasoningEffort: "low",
  cliVersion: "0.160.0",
  toolPolicy: "codex-ui-tools-v1",
  participantSchema: "humanish.codex-ui-tool.v1",
  memoryPolicy: "continuing-thread-v1",
};

let cwd: string;
let runDir: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-live-estimate-"));
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runDryRun({ cwd, dryRun: true, runId: RUN });
  runDir = path.join(cwd, ".humanish", "runs", RUN);
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** run.json as a run in progress whose first participant's live actor holds `live` beside its live file. */
async function writeRunning(
  live: Partial<NonNullable<RunStream["liveActor"]>>,
  schema = "humanish.run-bundle.v4",
): Promise<void> {
  const stored = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
  const { outcome: _outcome, ...bundle } = stored;
  await mkdir(path.join(runDir, "live"), { recursive: true });
  await writeFile(path.join(runDir, "live/1.1.ndjson"), "");
  const [first, ...rest] = bundle.streams;
  const running = {
    ...first!,
    status: "running",
    liveActor: {
      schema: "humanish.live-actor.v2",
      updatedAt: "2026-10-13T08:00:00.000Z",
      tokenUsage: { input: 320_000, output: 2_000 },
      ids: { model: "gpt-5.6-sol" },
      ...live,
      itemsFile: {
        path: "live/1.1.ndjson",
        generation: 1,
        items: 0,
        bytes: 0,
        sha256: createHash("sha256").digest("hex"),
      },
    },
  };
  await writeFile(
    path.join(runDir, "run.json"),
    `${JSON.stringify({ ...bundle, schema, streams: [running, ...rest] }, null, 2)}\n`,
  );
}

const costCheck = async () =>
  (await verifyRun(cwd, RUN)).checks.find((check) => check.name === "cost estimate labeling");

describe("verify on a running participant's estimate", () => {
  it("passes a labeled estimate", async () => {
    await writeRunning({
      estimatedCost: {
        schema: "humanish.actor-estimated-cost.v1",
        estimatedCostUsd: 2.53,
        ratesAsOf: "2026-09-03",
        source: "developers.openai.com/api/docs/pricing",
      },
    });
    expect((await costCheck())?.ok).toBe(true);
  });

  it.each([
    [
      "a schema it does not know",
      {
        schema: "humanish.actor-estimated-cost.v0",
        estimatedCostUsd: 2.53,
        ratesAsOf: "2026-09-03",
        source: "developers.openai.com/api/docs/pricing",
      },
      /schema is humanish\.actor-estimated-cost\.v0/,
    ],
    [
      "a figure without its rates date",
      {
        schema: "humanish.actor-estimated-cost.v1",
        estimatedCostUsd: 2.53,
        ratesAsOf: null,
        source: "developers.openai.com/api/docs/pricing",
      },
      /\$2\.53 without a ratesAsOf date/,
    ],
    [
      "a null figure without its reason",
      { schema: "humanish.actor-estimated-cost.v1", estimatedCostUsd: null, ratesAsOf: null },
      /null cost estimate without a reason/,
    ],
  ])("fails an estimate with %s", async (_name, estimatedCost, finding) => {
    await writeRunning({ estimatedCost: estimatedCost as never });
    const check = await costCheck();
    expect(check?.ok).toBe(false);
    expect(check?.message).toMatch(finding);
  });

  it("reads a running account participant without receipts in v4 and asks for them in v3", async () => {
    const account = {
      executionProfile: PROFILE,
      historyTurnsOmitted: 0,
      estimatedCost: {
        schema: "humanish.actor-estimated-cost.v1" as const,
        estimatedCostUsd: null,
        ratesAsOf: null,
        reason: "account_billing_unknown" as const,
        modelId: "gpt-5.6-sol",
      },
    };
    await writeRunning(account);
    expect((await costCheck())?.ok).toBe(true);
    await writeRunning(account, "humanish.run-bundle.v3");
    const v3 = await costCheck();
    expect(v3?.ok).toBe(false);
    expect(v3?.message).toMatch(/request receipts/);
  });
});
