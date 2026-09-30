import type { ActorTrace } from "../../actors/contract.js";
import type { RunBundle } from "../../run/bundle.js";
import type { PreparedRunArtifactPaths } from "../../run/paths.js";
import {
  writeContainedOutputFile,
  writePreparedRunLatestPointer,
} from "../../run/selected-output-paths.js";
import { runStatusOutcome, type RunStatusHandle } from "../../run/status.js";
import { renderTerminalReviewMarkdown } from "./bundle.js";
import {
  TERMINAL_EVENTS_ARTIFACT,
  TERMINAL_LEDGERS_ARTIFACT,
  TERMINAL_TRANSCRIPT_ARTIFACT,
  type TerminalEventRecord,
  type TerminalLedgers,
} from "./types.js";

/** Persist the terminal evidence: redacted events, normalized transcript, ledgers, actor trace. */
export async function writeTerminalEvidence(
  runPaths: PreparedRunArtifactPaths,
  evidence: {
    terminalEvents: readonly TerminalEventRecord[];
    normalizedTranscript: string;
    ledgers: TerminalLedgers;
    trace: ActorTrace;
  },
): Promise<void> {
  const { terminalEvents, normalizedTranscript, ledgers, trace } = evidence;
  await writeContainedOutputFile(
    runPaths,
    TERMINAL_EVENTS_ARTIFACT,
    `${terminalEvents.map((e) => JSON.stringify(e)).join("\n")}${terminalEvents.length > 0 ? "\n" : ""}`,
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    TERMINAL_TRANSCRIPT_ARTIFACT,
    `${normalizedTranscript}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    TERMINAL_LEDGERS_ARTIFACT,
    `${JSON.stringify(ledgers, null, 2)}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    "actor.json",
    `${JSON.stringify(trace, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Write the run bundle, finalize the status record from it, then the review, events and latest
 * pointer. A throw before the status finish leaves the record stale, which reads as interrupted
 * rather than as a false outcome.
 */
export async function writeTerminalRunFiles(args: {
  runPaths: PreparedRunArtifactPaths;
  runStatus: RunStatusHandle;
  bundle: RunBundle;
  runId: string;
  createdAt: string;
}): Promise<void> {
  const { runPaths, runStatus, bundle, runId, createdAt } = args;
  await writeContainedOutputFile(
    runPaths,
    "run.json",
    `${JSON.stringify(bundle, null, 2)}\n`,
    "utf8",
  );
  await runStatus.finish(runStatusOutcome(bundle));
  await writeContainedOutputFile(
    runPaths,
    "review.json",
    `${JSON.stringify(bundle.review, null, 2)}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    "review.md",
    renderTerminalReviewMarkdown(bundle),
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    "events.ndjson",
    `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({ schema: "humanish.latest-run.v1", runId, path: runPaths.relativeRunRoot, updatedAt: createdAt }, null, 2)}\n`,
    "utf8",
  );
}
