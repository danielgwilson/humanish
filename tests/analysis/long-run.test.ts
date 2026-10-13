// A long study's run.json stays small from run bundle v4: 30 participants working 8 hours at a
// model request every 10 s make 2,880 requests each, and each request's usage row, conversation
// row and account receipt is written once, in the participant's trace file. Each run here goes
// through the run writer (a mid-run flush, then the final write) in one of three shapes: threaded
// conversations, explicit_context conversations, and account participants with receipts. Analysis
// reads it whole, and the loader gives every participant back its 2,880 rows.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ActorExecutionProfile, ActorTrace } from "../../src/actors/contract.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import { loadRunBundle } from "../../src/index.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { runScope } from "../../src/run/run.js";
import type { RunStream } from "../../src/run/streams.js";
import { PASSING_OUTCOME } from "../helpers/finished-run.js";
import { syntheticActor } from "../helpers/run-traces.js";

const MIB = 1024 * 1024;
const PARTICIPANTS = 30;
const REQUESTS = 2_880;
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
type Shape = "threaded" | "explicit_context" | "account";

/** A participant's per-request lists in `shape`, with totals that match its rows. */
function lists(shape: Shape): Partial<ActorTrace> {
  const row = { input: 31_000, cachedInput: 29_000, output: 120 };
  const usage = {
    input: row.input * REQUESTS,
    cachedInput: row.cachedInput * REQUESTS,
    output: row.output * REQUESTS,
    turns: Array.from({ length: REQUESTS }, () => ({ ...row })),
  };
  if (shape === "account")
    return {
      tokenUsage: usage,
      executionProfile: PROFILE,
      historyTurnsOmitted: 0,
      providerRequests: Array.from({ length: REQUESTS }, (_, index) => ({
        ordinal: index + 1,
        kind: "interaction" as const,
        dispatched: true,
        usageComplete: true,
        cleanup: "confirmed" as const,
        profileVerified: true,
        usage: { ...row },
      })),
    };
  return {
    tokenUsage: usage,
    conversation: {
      mode: shape,
      summarizedTurns: 0,
      requests: Array.from({ length: REQUESTS }, () =>
        shape === "threaded"
          ? { mode: "threaded" as const }
          : {
              mode: "explicit_context" as const,
              carriedExchanges: 8,
              carriedScreenshots: 3,
              estimatedInputTokens: 31_000,
            },
      ),
    },
  };
}

describe("a 30-participant, 8-hour run written as v4", () => {
  let template: RunBundle;
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-long-run-"));
    expect((await runDryRun({ cwd, dryRun: true, runId: "template" })).ok).toBe(true);
    template = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", "template", "run.json"), "utf8"),
    ) as RunBundle;
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(["threaded", "explicit_context", "account"] as const)(
    "keeps run.json and observer-data.json under 1 MiB with %s participants, and analysis reads it",
    async (shape) => {
      const runId = `long-run-${shape.replace("_", "-")}`;
      const runDir = path.join(cwd, ".humanish", "runs", runId);
      const [base] = template.streams;
      const [simulation] = template.simulations;
      const ids = Array.from(
        { length: PARTICIPANTS },
        (_, index) => `stream-${String(index + 1).padStart(3, "0")}`,
      );
      const { outcome: _outcome, ...head } = template;
      const bundle = (streams: RunStream[]): RunBundle => ({
        ...head,
        runId,
        mode: "live",
        artifactRoot: path.join(".humanish", "runs", runId),
        simulations: [{ ...simulation!, streamIds: ids }],
        streams,
      });
      const finished = lists(shape);
      const model = { ids: { model: "gpt-5.6-sol" } };
      const sizes = { run: 0, observer: 0 };
      await runScope(async (scope) => {
        const started = await scope.startRun({
          cwd,
          runId,
          mintRunId: () => runId,
          mode: "live",
          renderReview: (written) => `# Review ${written.runId}\n`,
        });
        if (!started.ok) throw new Error(started.message);
        const { actor: _actor, trace: _trace, ...stream } = base!;
        await started.run.writeSnapshot(
          bundle(
            ids.map((id) => ({
              ...stream,
              id,
              status: "running",
              liveActor: {
                schema: "humanish.live-actor.v1",
                updatedAt: "2026-10-13T16:00:00.000Z",
                ...model,
                tokenUsage: finished.tokenUsage!,
                ...(finished.providerRequests === undefined
                  ? {}
                  : {
                      executionProfile: PROFILE,
                      providerRequests: finished.providerRequests,
                    }),
                items: syntheticActor(`${id} is still working.`).items,
              },
            })),
          ),
        );
        sizes.run = (await stat(path.join(runDir, "run.json"))).size;
        sizes.observer = (await stat(path.join(runDir, "observer", "observer-data.json"))).size;
        await started.run.finish(
          bundle(
            ids.map((id) => ({
              ...stream,
              id,
              status: "passed",
              actor: { ...syntheticActor(`${id} finished.`), ...model, ...finished },
            })),
          ),
          PASSING_OUTCOME,
        );
      });
      expect(sizes.run).toBeLessThan(MIB);
      expect(sizes.observer).toBeLessThan(MIB);
      const bytes = await readFile(path.join(runDir, "run.json"));
      expect(bytes.length).toBeLessThan(MIB);
      expect((await stat(path.join(runDir, "observer", "observer-data.json"))).size).toBeLessThan(
        MIB,
      );

      const prepared = (await resolveRunPath(cwd, runId))!;
      expect((await captureEvidence(prepared, bytes)).participants).toHaveLength(PARTICIPANTS);
      const loaded = await loadRunBundle(cwd, runId);
      expect(
        loaded?.bundle.streams.map((stream) => stream.actor?.tokenUsage?.turns?.length),
      ).toEqual(ids.map(() => REQUESTS));
      const requests = loaded?.bundle.streams.map((stream) =>
        shape === "account"
          ? stream.actor?.providerRequests?.length
          : stream.actor?.conversation?.requests.length,
      );
      expect(requests).toEqual(ids.map(() => REQUESTS));
    },
    120_000,
  );
});
