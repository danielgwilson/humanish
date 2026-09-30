import type { ActorTrace } from "../../actors/contract.js";
import type { PreparedRunArtifactPaths } from "../../run/paths.js";
import { writeContainedOutputFile } from "../../run/contained-output.js";
import {
  TERMINAL_EVENTS_ARTIFACT,
  TERMINAL_LEDGERS_ARTIFACT,
  TERMINAL_TRANSCRIPT_ARTIFACT,
} from "../../run/terminal-contract.js";
import type { TerminalEventRecord, TerminalLedgers } from "./types.js";

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
