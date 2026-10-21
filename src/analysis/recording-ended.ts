// Whether a run's recording has ended, so analysis can read it: the completion gate's reading of
// status.json and the bundle's streams. A refusal says what the run is doing and the command that
// moves it on, since "wait" helps only a run that is still alive.

import { cli } from "../cli/invocation.js";
import { classifyRunStatus, runOwnerGone, type RunStatusRecord } from "../run/status.js";
import { studyProvenanceOf } from "../run/study-provenance.js";
import { AnalysisSourceRefusedError } from "./source.js";

/** What the gate reads: the run's status record, when it has one, and its streams. */
export interface RecordingFacts {
  runId: string;
  status: RunStatusRecord | undefined;
  /** How many of the bundle's streams are still running or still hold live items. */
  runningStreams: number;
  streams: number;
}

/**
 * Throws the refusal for a recording that has not ended. A `finished` record, an `interrupted`
 * one, and a stale `running` one whose process is gone from this host have ended; analysis then
 * also needs every stream ended. A fresh `running` record is a live run, and a stale one whose pid
 * is still in use cannot be told apart from a live run, so both are refused.
 */
export function assertRecordingEnded(
  facts: RecordingFacts,
  nowMs: number = Date.now(),
  processRunning?: (pid: number) => boolean,
): void {
  const { runId, status } = facts;
  const runs = `\`${cli("runs")}\``;
  if (status?.state === "running") {
    if (classifyRunStatus(status, nowMs) === "running")
      throw new AnalysisSourceRefusedError(
        "ANALYSIS_RUN_ACTIVE",
        `Participants are still running in this run, so its recording has not ended. Automatic analysis starts when they finish; ${runs} shows when the run is analyzing.`,
      );
    if (!runOwnerGone(status, nowMs, processRunning))
      throw new AnalysisSourceRefusedError(
        "ANALYSIS_RUN_UNCONFIRMED",
        `This run's process stopped updating status.json at ${status.updatedAt}, but pid ${status.pid} is still in use on this machine, so humanish cannot tell whether the run is still writing. If the run is gone, \`${cli(`reclaim --run ${runId}`)}\` stops its sandboxes and marks it interrupted; then analyze it again.`,
      );
  }
  if (facts.runningStreams === 0) return;
  if (status?.state === "finished")
    throw new AnalysisSourceRefusedError(
      "ANALYSIS_RUN_ACTIVE",
      `${facts.runningStreams} of ${facts.streams} participant streams in this run have not ended. ${runs} shows the run's state.`,
    );
  const study = status === undefined ? undefined : studyProvenanceOf(status)?.id;
  throw new AnalysisSourceRefusedError(
    "ANALYSIS_RUN_INCOMPLETE",
    `This run ended while ${facts.runningStreams} of ${facts.streams} participant streams were still running, so its recording is incomplete and is not analyzed. Run the study again with \`${cli(`run ${study ?? "<study>"}`)}\`.`,
  );
}
