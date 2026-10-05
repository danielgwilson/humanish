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
    /** Publish a run whose route reported no participant session start. */
    noParticipant?: boolean;
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
    if (options.noParticipant !== true) started.run.participantStarted();
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
