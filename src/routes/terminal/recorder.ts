import { createHash } from "node:crypto";
import { redactJsonLine, redactText } from "../../evidence/redaction.js";
import { createLocalActorVerdictScanner } from "../../run/terminal-contract.js";
import { createTerminalParticipantReader } from "./participant-text.js";
import { terminalUsageRecords } from "./token-usage.js";
import {
  MAX_TRANSCRIPT_BYTES,
  PENDING_LINE_CHARS,
  type CommandLogRecord,
  type InterventionRecord,
  type LifecycleRecord,
  type TerminalEventRecord,
} from "./types.js";

/**
 * The terminal run's ledgers and capture buffers, mutated through the live lifecycle. Every chunk
 * is scrubbed of the run's known values and redacted as it is stored. Stdout is stored a line at a
 * time, each line through redactJsonLine, so a path in the agent's Codex JSON ends where its
 * decoded text ends; call endStdout when the command's output has ended. Raw bytes leave the
 * append functions only for the in-memory participant reader, which keeps sanitized decoded text.
 */
export function createTerminalRecorder(args: {
  nowIso: () => string;
  /** Replaces the run's known values, before any pattern runs. */
  scrub: (text: string) => string;
  knownSecretValues: readonly string[];
  verdictNonce: string;
}) {
  const { nowIso, scrub, knownSecretValues, verdictNonce } = args;
  const sanitize = (text: string): string => redactText(scrub(text));
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
  const interventions: InterventionRecord[] = []; // Always empty while no assisted-input path ships.
  // Reads the agent's text from the raw stdout in memory; it keeps only sanitized decoded text.
  const participantText = createTerminalParticipantReader(sanitize);
  let transcriptBytes = 0;

  // Output past the cap is not stored, but the participant reader, the verdict marker and token
  // usage still read all of it, so a long session is judged and priced as a short one is.
  const notStored = { stdout: 0, stderr: 0 };
  const laterVerdict = createLocalActorVerdictScanner(verdictNonce);
  const laterUsage: string[] = [];
  // The stdout line in progress past the cap. Undefined while the rest of a line is skipped: the
  // line the cap cut through (its start is stored) or one longer than the pending limit.
  let laterLine: string | undefined;
  let stdoutAtLineStart = true;
  let pastCap = false;
  const readLaterStdout = (raw: string): void => {
    let text = raw;
    if (laterLine === undefined) {
      const end = text.indexOf("\n");
      if (end < 0) return;
      text = text.slice(end + 1);
      laterLine = "";
    }
    laterLine += text;
    const end = laterLine.lastIndexOf("\n");
    if (end >= 0) {
      laterUsage.push(...terminalUsageRecords(sanitize(laterLine.slice(0, end))));
      laterLine = laterLine.slice(end + 1);
    }
    if (laterLine.length > PENDING_LINE_CHARS) laterLine = undefined;
  };

  // The received part of the stdout line in progress, raw, so a complete line can be redacted as
  // JSON. Null while the rest of a line is stored a chunk at a time with redactText, as stderr is:
  // after a stderr chunk arrived inside it, which keeps the events in arrival order for the
  // known-value scrub across streams, or past PENDING_LINE_CHARS. Past the cap, or once the
  // command's output has ended, stdout is stored a chunk at a time.
  let stdoutLine: string | null = "";
  let stdoutByLine = true;
  const pushEvent = (stream: "stdout" | "stderr", chunk: string): void => {
    terminalEvents.push({ at: nowIso(), stream, chunk });
  };
  const redactStdoutLine = (line: string): string =>
    line.length > PENDING_LINE_CHARS ? sanitize(line) : redactJsonLine(scrub(line));
  const cutStdoutLine = (): void => {
    if (!stdoutLine) return;
    pushEvent("stdout", sanitize(stdoutLine));
    stdoutLine = null;
  };
  const storeStdout = (raw: string): void => {
    let text = raw;
    let stored = "";
    if (stdoutLine === null) {
      const end = text.indexOf("\n");
      if (end < 0) return pushEvent("stdout", sanitize(text));
      stored = sanitize(text.slice(0, end + 1));
      text = text.slice(end + 1);
      stdoutLine = "";
    }
    stdoutLine += text;
    const end = stdoutLine.lastIndexOf("\n");
    if (end >= 0) {
      stored += `${stdoutLine.slice(0, end).split("\n").map(redactStdoutLine).join("\n")}\n`;
      stdoutLine = stdoutLine.slice(end + 1);
    }
    if (stdoutLine.length > PENDING_LINE_CHARS) {
      stored += sanitize(stdoutLine);
      stdoutLine = null;
    }
    if (stored) pushEvent("stdout", stored);
  };
  const storeChunk = (stream: "stdout" | "stderr", raw: string): void => {
    if (stream === "stdout" && stdoutByLine) return storeStdout(raw);
    if (stream === "stderr" && stdoutByLine) cutStdoutLine();
    pushEvent(stream, sanitize(raw));
  };
  const endStdoutLines = (): void => {
    if (!stdoutByLine) return;
    cutStdoutLine();
    stdoutByLine = false;
  };

  const recordLifecycle = (event: string, message: string): void => {
    lifecycle.push({ at: nowIso(), event, message: sanitize(message) });
  };
  const appendTerminalChunk = (stream: "stdout" | "stderr", raw: string): void => {
    if (stream === "stdout") participantText.append(raw);
    if (transcriptBytes >= MAX_TRANSCRIPT_BYTES) {
      endStdoutLines();
      for (const order of [stream, "combined"] as const) {
        const remaining = maxDiscardedPrefixChars - discardedPrefixes[order].length;
        if (remaining > 0) discardedPrefixes[order] += raw.slice(0, remaining);
      }
      if (!pastCap) {
        pastCap = true;
        // The stored stream seeds the scan, so a marker the cap split in two is still found.
        laterVerdict.push(terminalEvents.map((event) => event.chunk).join(""));
        laterLine = stdoutAtLineStart ? "" : undefined;
      }
      notStored[stream] += Buffer.byteLength(raw, "utf8");
      laterVerdict.push(sanitize(raw));
      if (stream === "stdout") readLaterStdout(raw);
      return;
    }
    transcriptBytes += Buffer.byteLength(raw, "utf8");
    // Scrub, then redact, at the source. Only the participant reader and the readers of output
    // past the cap see raw bytes, and they store none of them.
    storeChunk(stream, raw);
    if (stream === "stdout" && raw) stdoutAtLineStart = raw.endsWith("\n");
  };

  /** What the cap left out, for the transcript, the trace and the run events; undefined when the
   *  whole session was stored. */
  const transcriptCut = ():
    | { notice: string; verdict: ReturnType<typeof laterVerdict.verdict>; usage: string[] }
    | undefined => {
    if (!pastCap) return undefined;
    const bytes = notStored.stdout + notStored.stderr;
    return {
      notice: `Output past the ${MAX_TRANSCRIPT_BYTES / 1024} KiB transcript cap was not stored: ${bytes} bytes (${notStored.stdout} stdout, ${notStored.stderr} stderr). The verdict marker, token usage and agent messages were still read from it.`,
      verdict: laterVerdict.verdict(),
      usage: laterUsage,
    };
  };

  // E2B can stream every byte through callbacks and return the same complete output.
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
    transcriptCut,
    recordLifecycle,
    recordStreamedTerminalChunk,
    appendReturnedTerminalOutput,
    /** The command's output has ended: store the stdout line in progress as it is. */
    endStdout: endStdoutLines,
  };
}
