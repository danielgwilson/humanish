import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { runScope, type FinishedRun } from "../../src/run/run.js";

/**
 * Publish a run through the run scope and return the FinishedRun its final write issued, the only
 * token automatic analysis accepts. The bundle starts as the synthetic preview of the same project,
 * written under `<runId>-template`; `shape` edits it before publication.
 */
export async function publishRun(
  cwd: string,
  runId: string,
  options: { mode?: "dry-run" | "live"; shape?: (bundle: RunBundle) => RunBundle } = {},
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
    await started.run.finish(options.shape ? options.shape(bundle) : bundle);
  });
  if (finished === undefined) throw new Error(`run ${runId} did not publish`);
  return finished;
}

/** The synthetic bundle as a live run with a completed first stream, as analysis reads one. */
export function asLiveRecording(bundle: RunBundle): RunBundle {
  const [first, ...rest] = bundle.streams;
  return { ...bundle, streams: first ? [{ ...first, status: "complete" }, ...rest] : rest };
}
