import { createHash } from "node:crypto";
import { createTerminalParticipantReader } from "./participant-text.js";
import {
  MAX_TRANSCRIPT_BYTES,
  type CommandLogRecord,
  type InterventionRecord,
  type LifecycleRecord,
  type TerminalEventRecord,
} from "./types.js";

/**
 * The terminal run's ledgers and capture buffers, mutated through the live lifecycle. Every chunk
 * is scrubbed and redacted as it is stored. Raw bytes leave the append functions only for the
 * in-memory participant reader, which keeps sanitized decoded text.
 */
export function createTerminalRecorder(args: {
  nowIso: () => string;
  sanitize: (text: string) => string;
  knownSecretValues: readonly string[];
}) {
  const { nowIso, sanitize, knownSecretValues } = args;
  const lifecycle: LifecycleRecord[] = [];
  const commandLog: CommandLogRecord[] = [];
  const terminalEvents: TerminalEventRecord[] = [];
  // Capture may stop inside a known key. Keep only enough following characters to finish the
  // cross-chunk redaction below; this overlap is never added to terminal events/artifacts.
  const discardedPrefixes = { stdout: "", stderr: "", combined: "" };
  const maxDiscardedPrefixChars = Math.max(
    0,
    ...knownSecretValues.map((value) => value.length - 1),
  );
  const interventions: InterventionRecord[] = []; // ALWAYS empty while no assisted-input path ships.
  // Reads the agent's text from the raw stdout in memory; it keeps only sanitized decoded text.
  const participantText = createTerminalParticipantReader(sanitize);
  let transcriptBytes = 0;

  const recordLifecycle = (event: string, message: string): void => {
    lifecycle.push({ at: nowIso(), event, message: sanitize(message) });
  };
  const appendTerminalChunk = (stream: "stdout" | "stderr", raw: string): void => {
    if (transcriptBytes >= MAX_TRANSCRIPT_BYTES) {
      for (const order of [stream, "combined"] as const) {
        const remaining = maxDiscardedPrefixChars - discardedPrefixes[order].length;
        if (remaining > 0) discardedPrefixes[order] += raw.slice(0, remaining);
      }
      return;
    }
    transcriptBytes += Buffer.byteLength(raw, "utf8");
    // Scrub THEN redact at the SOURCE (safety contract item 5). Only the participant reader below
    // sees the raw bytes, and it stores none of them.
    terminalEvents.push({ at: nowIso(), stream, chunk: sanitize(raw) });
    if (stream === "stdout") participantText.append(raw);
  };

  // E2B can stream every byte through callbacks AND return the same complete output (#667).
  // Track transport delivery, independently per stream, rather than deduplicating participant
  // lines or equal usage records. Hash raw callback bytes before redaction/truncation so the
  // comparison cannot confuse two values that redact identically or lose capped-away delivery.
  // Delivery tracking retains only counts and hashes; payloads still pass the artifact sanitizer.
  const streamedOutput = {
    stdout: { bytes: 0, hash: createHash("sha256") },
    stderr: { bytes: 0, hash: createHash("sha256") },
  };
  const recordStreamedTerminalChunk = (stream: "stdout" | "stderr", raw: string): void => {
    streamedOutput[stream].bytes += Buffer.byteLength(raw, "utf8");
    streamedOutput[stream].hash.update(raw, "utf8");
    appendTerminalChunk(stream, raw);
  };
  const appendReturnedTerminalOutput = (stream: "stdout" | "stderr", raw: string): void => {
    const delivered = streamedOutput[stream];
    const returned = Buffer.from(raw, "utf8");
    if (delivered.bytes > 0 && returned.length >= delivered.bytes) {
      const returnedPrefixHash = createHash("sha256")
        .update(returned.subarray(0, delivered.bytes))
        .digest("hex");
      if (returnedPrefixHash === delivered.hash.copy().digest("hex")) {
        // A complete replay adds nothing; a partly streamed prefix keeps only the unseen tail.
        const suffix = returned.subarray(delivered.bytes).toString("utf8");
        if (suffix) appendTerminalChunk(stream, suffix);
        return;
      }
    }
    // Older/final-only SDK delivery, or output that does not match the streamed prefix: keep it.
    // Guessing at overlap here could erase legitimate repeated participant text.
    appendTerminalChunk(stream, raw);
  };

  return {
    lifecycle,
    commandLog,
    terminalEvents,
    interventions,
    discardedPrefixes,
    participantText,
    recordLifecycle,
    recordStreamedTerminalChunk,
    appendReturnedTerminalOutput,
  };
}
