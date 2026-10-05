import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { OUTCOME_POLICIES } from "../../src/run/judge.js";
import { activeRuns } from "../../src/run/active-runs.js";
import { runScope, type FinishedRun, type FinishOutcome } from "../../src/run/run.js";
import type { RunInterruptSignal } from "../../src/run/status.js";

/** The outcome of a run that worked, on the computer-use route's policy. */
export const PASSING_OUTCOME: FinishOutcome = {
  ok: true,
  execution: { succeeded: true, failures: [] },
  policy: OUTCOME_POLICIES["computer-use"],
};

/**
 * Publish a run through the run scope and return the FinishedRun its final write issued, the only
 * token automatic analysis accepts. The bundle starts as the synthetic preview of the same project,
 * written under `<runId>-template`; `shape` edits it before publication.
 */
export async function publishRun(
  cwd: string,
  runId: string,
  options: {
    mode?: "dry-run" | "live";
    shape?: (bundle: RunBundle) => RunBundle;
    /** Interrupt the run as the CLI's signal handler does, before the route finishes it. */
    interruptedBy?: RunInterruptSignal;
  } = {},
): Promise<FinishedRun> {
  const mode = options.mode ?? "live";
  const templateId = `${runId}-template`;
  const preview = await runDryRun({ cwd, dryRun: true, runId: templateId });
  if (!preview.ok) throw new Error(preview.error?.message ?? "the preview template failed");
  const template = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", templateId, "run.json"), "utf8"),
  ) as RunBundle;
  const bundle: RunBundle = {
    ...template,
    runId,
    mode,
    artifactRoot: path.join(".humanish", "runs", runId),
  };
  const { finished } = await runScope(async (scope) => {
    const started = await scope.startRun({
      cwd,
      runId,
      mintRunId: () => runId,
      mode,
      renderReview: (published) => `# Review ${published.runId}\n`,
    });
    if (!started.ok) throw new Error(started.message);
    if (options.interruptedBy !== undefined) {
      const active = activeRuns().find((run) => run.runId === runId);
      if (active === undefined) throw new Error(`run ${runId} is not registered as active`);
      await active.status.interrupt(options.interruptedBy);
    }
    await started.run.finish(options.shape ? options.shape(bundle) : bundle, PASSING_OUTCOME);
  });
  if (finished === undefined) throw new Error(`run ${runId} did not publish`);
  return finished;
}

/** The synthetic bundle as a live run with a completed first stream, as analysis reads one. */
export function asLiveRecording(bundle: RunBundle): RunBundle {
  const [first, ...rest] = bundle.streams;
  return { ...bundle, streams: first ? [{ ...first, status: "complete" }, ...rest] : rest };
}

/**
 * The synthetic bundle with a participant that ran: its first stream carries an actor trace, as
 * every route writes once a session returns. The preview template has none.
 */
export function withParticipantTrace(bundle: RunBundle): RunBundle {
  const [first, ...rest] = bundle.streams;
  if (first === undefined) throw new Error("the template bundle has no stream");
  return {
    ...bundle,
    streams: [
      {
        ...first,
        actor: {
          schema: "humanish.actor-trace.v1",
          provider: "synthetic",
          protocol: "cua-loop",
          lane: "computer-use",
          persona: { id: "synthetic-participant", traitsApplied: [], promptDigest: "a".repeat(64) },
          redaction: { status: "passed", screenshots: "n/a", notes: "Synthetic trace." },
          startedAt: "2026-09-01T00:00:00.000Z",
          completedAt: "2026-09-01T00:01:00.000Z",
          durationMs: 60000,
          status: "failed",
          completionReason: "harness_error",
          reason: "The synthetic session failed.",
          ids: {},
          counts: {},
          items: [],
          capabilities: {
            headless: true,
            structuredTrace: true,
            lanes: ["computer-use"],
            producesScreenshots: false,
            byoModel: false,
            preGrantableApprovals: false,
            inProcessTools: false,
            license: "open",
          },
        },
      },
      ...rest,
    ],
  };
}
