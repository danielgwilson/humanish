// A long study's run.json stays small from run bundle v4: 30 participants working 8 hours at a
// model request every 10 s make 2,880 requests each, and each request's usage row, conversation
// row and account receipt is written once, in the participant's trace file. Each run here goes
// through the run writer (a mid-run flush, then the final write) in one of three shapes: threaded
// conversations, explicit_context conversations, and account participants with receipts. Analysis
// reads it whole, and the loader gives every participant back its 2,880 rows. Every row has the
// same input, so verify warns that each participant's context did not grow, on the threaded v4 run
// and on a v3 copy of it whose run.json summaries hold the rows. A participant whose trace passes
// 16 MiB is analysed as the loader, verify and the Observer read it.

import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ActorExecutionProfile, ActorTrace } from "../../src/actors/contract.js";
import { captureEvidence, validateAnalysisEvidence } from "../../src/analysis/evidence.js";
import { loadRunBundle, verifyRun } from "../../src/index.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { runScope } from "../../src/run/run.js";
import type { RunStream } from "../../src/run/streams.js";
import { PASSING_OUTCOME } from "../helpers/finished-run.js";
import { syntheticActor, writeRunBundle } from "../helpers/run-traces.js";
import { syntheticArtifact } from "./fixtures.js";

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

const IDS = Array.from(
  { length: PARTICIPANTS },
  (_, index) => `stream-${String(index + 1).padStart(3, "0")}`,
);

/** A new project with a dry run, `template`, whose run.json the runs here are built from. */
async function templateProject(): Promise<{ cwd: string; template: RunBundle }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-long-run-"));
  expect((await runDryRun({ cwd, dryRun: true, runId: "template" })).ok).toBe(true);
  const runJson = path.join(cwd, ".humanish", "runs", "template", "run.json");
  return { cwd, template: JSON.parse(await readFile(runJson, "utf8")) as RunBundle };
}

describe("a 30-participant, 8-hour run written as v4", () => {
  let template: RunBundle;
  let cwd: string;
  const projects: string[] = [];

  beforeAll(async () => {
    ({ cwd, template } = await templateProject());
    projects.push(cwd);
  });
  afterAll(async () => {
    for (const project of projects) await rm(project, { recursive: true, force: true });
  });

  /**
   * The run in `shape` written through the run writer as run `runId`: a mid-run flush with every
   * participant running, then the final write. Returns the sizes of run.json and
   * observer-data.json after the flush.
   */
  async function writeLongRun(
    shape: Shape,
    runId: string,
  ): Promise<{ runDir: string; sizes: { run: number; observer: number } }> {
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    const [base] = template.streams;
    const [simulation] = template.simulations;
    const { outcome: _outcome, ...head } = template;
    const bundle = (streams: RunStream[]): RunBundle => ({
      ...head,
      runId,
      mode: "live",
      artifactRoot: path.join(".humanish", "runs", runId),
      simulations: [{ ...simulation!, streamIds: IDS }],
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
          IDS.map((id) => ({
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
          IDS.map((id) => ({
            ...stream,
            id,
            status: "passed",
            actor: { ...syntheticActor(`${id} finished.`), ...model, ...finished },
          })),
        ),
        PASSING_OUTCOME,
      );
    });
    return { runDir, sizes };
  }

  it.each(["threaded", "explicit_context", "account"] as const)(
    "keeps run.json and observer-data.json under 1 MiB with %s participants, and analysis reads it",
    async (shape) => {
      const runId = `long-run-${shape.replace("_", "-")}`;
      const { runDir, sizes } = await writeLongRun(shape, runId);
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
      ).toEqual(IDS.map(() => REQUESTS));
      const requests = loaded?.bundle.streams.map((stream) =>
        shape === "account"
          ? stream.actor?.providerRequests?.length
          : stream.actor?.conversation?.requests.length,
      );
      expect(requests).toEqual(IDS.map(() => REQUESTS));
    },
    120_000,
  );

  it("gives verify's flat-context warning for every participant on its v4 run and a v3 copy", async () => {
    const runId = "long-run-copies";
    const { runDir } = await writeLongRun("threaded", runId);
    // The v3 copy: the same trace files, and run.json summaries that hold every field of each
    // trace file but its items and screenshot entries, as the v3 writer kept them.
    const copy = await mkdtemp(path.join(tmpdir(), "humanish-long-run-v3-"));
    projects.push(copy);
    const copyDir = path.join(copy, ".humanish", "runs", runId);
    await cp(runDir, copyDir, { recursive: true });
    const v4 = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const streams = await Promise.all(
      v4.streams.map(async (stream) => {
        const file = await readFile(path.join(runDir, stream.trace!.path), "utf8");
        const { items: _items, artifacts: _artifacts, ...actor } = JSON.parse(file);
        return { ...stream, actor };
      }),
    );
    const v3 = { ...v4, schema: "humanish.run-bundle.v3", streams };
    await writeFile(path.join(copyDir, "run.json"), `${JSON.stringify(v3, null, 2)}\n`);

    const warnings = (await verifyRun(cwd, runId)).warnings;
    expect(warnings.filter((warning) => /its context did not grow/.test(warning))).toEqual(
      IDS.map(
        (id) =>
          `${id}: its context did not grow. Its prompt stayed near 31000 tokens from turn 2 to turn 2880, so it likely answered each turn without the earlier ones.`,
      ),
    );
    expect((await verifyRun(copy, runId)).warnings).toEqual(warnings);
  }, 120_000);
});

describe("a participant whose trace passes 16 MiB", () => {
  let template: RunBundle;
  let cwd: string;

  beforeAll(async () => {
    ({ cwd, template } = await templateProject());
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("is analysed, and a saved analysis of it checks against the run", async () => {
    const runId = "long-trace";
    const runDir = path.join(cwd, ".humanish", "runs", runId);
    await mkdir(runDir, { recursive: true });
    const [base] = template.streams;
    const { actor: _actor, trace: _trace, ...stream } = base!;
    // 6,000 turns of 2.9 KB of reasoning, then the participant's closing message.
    const actor = syntheticActor("I exported the report.", { id: "closing" });
    actor.items.unshift(
      ...Array.from({ length: 6_000 }, (_, turn) => ({
        id: `turn-${turn}`,
        kind: "reasoning" as const,
        lifecycle: "completed" as const,
        title: "reasoning",
        text: `Turn ${turn}: ${"I compare the filters before I export. ".repeat(74)}`,
      })),
    );
    const written = await writeRunBundle(runDir, {
      ...template,
      runId,
      mode: "live",
      streams: [{ ...stream, status: "passed", actor }],
    });
    expect(written.streams[0]!.trace!.bytes).toBeGreaterThan(16 * MIB);

    const bytes = await readFile(path.join(runDir, "run.json"));
    const prepared = (await resolveRunPath(cwd, runId))!;
    const input = await captureEvidence(prepared, bytes);
    expect(input.evidence.map((entry) => entry.eventId)).toContain("closing");
    await expect(
      validateAnalysisEvidence(prepared, syntheticArtifact(input), bytes),
    ).resolves.toBeUndefined();
  }, 120_000);
});
