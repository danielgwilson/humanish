import { countTerminalParticipantItems } from "./participant-activity.js";
import type {
  ActorCompletionReason,
  ActorPersonaRef,
  ActorRuntimeProvenance,
  ActorStatus,
  ActorTokenUsage,
  ActorTrace,
  ActorTraceItem,
} from "../../actors/contract.js";
import { ACTOR_TRACE_SCHEMA, TERMINAL_AGENT_CAPABILITIES } from "../../actors/contract.js";
import type { LabRuntimeAuth } from "../../lab/types.js";
import { redactedTail } from "../../evidence/redaction.js";
import { normalizeLocalActorTranscript } from "../../run/verify-actor.js";
import { type CommandLogRecord, TAIL_CHARS, type TerminalEventRecord } from "./types.js";

/**
 * Per-chunk sanitization cannot recognize a value split across deliveries. Redact those complete
 * known values before persistence without collapsing events or changing stdout/stderr ordering.
 * Work backwards through matches so edits to later text leave earlier offsets valid.
 */
export function scrubSplitKnownValues(
  events: TerminalEventRecord[],
  knownValues: string[],
  discardedPrefixes: Record<"stdout" | "stderr" | "combined", string>,
): void {
  for (const order of ["stdout", "stderr", "combined"] as const) {
    const chunks: Array<{ chunk: string }> =
      order === "combined" ? [...events] : events.filter((event) => event.stream === order);
    // A virtual final chunk makes a key crossing the capture cap recognizable. Edits to retained
    // events redact evidence; the raw overlap and this virtual chunk are never persisted.
    if (discardedPrefixes[order]) chunks.push({ chunk: discardedPrefixes[order] });
    for (const value of knownValues) {
      if (!value) continue;
      let offset = 0;
      const starts = chunks.map((event) => {
        const start = offset;
        offset += event.chunk.length;
        return start;
      });
      const text = chunks.map((event) => event.chunk).join("");
      const matches: number[] = [];
      for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length))
        matches.push(at);
      for (const at of matches.reverse()) {
        let first = 0;
        while (first + 1 < starts.length && (starts[first + 1] ?? Infinity) <= at) first += 1;
        let last = first;
        while (last + 1 < starts.length && (starts[last + 1] ?? Infinity) < at + value.length)
          last += 1;
        const firstChunk = chunks[first];
        const lastChunk = chunks[last];
        if (!firstChunk || !lastChunk) continue;
        const before = firstChunk.chunk.slice(0, at - (starts[first] ?? 0));
        const after = lastChunk.chunk.slice(at + value.length - (starts[last] ?? 0));
        firstChunk.chunk = `${before}[REDACTED_SECRET]${first === last ? after : ""}`;
        for (let index = first + 1; index < last; index += 1) {
          const middle = chunks[index];
          if (middle) middle.chunk = "";
        }
        if (first !== last) lastChunk.chunk = after;
      }
    }
  }
}

/** Redacted, ellipsis-prefixed tail of a captured stream/log for a message field. */
export function tailOf(text: string): string {
  return redactedTail(text, TAIL_CHARS);
}

/**
 * Project the live terminal session into the provider-neutral humanish.actor-trace.v1 (lane
 * "terminal", protocol "terminal-exec"). counts.actions/messages drive the no-engagement honesty
 * guard (a real run bumps them; a no-op is caught). No screenshots on this lane.
 */
export function buildTerminalActorTrace(args: {
  persona: ActorPersonaRef;
  productName: string;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  createdAt: string;
  completedAt: string;
  durationMs: number;
  terminalEvents: TerminalEventRecord[];
  commandLog: CommandLogRecord[];
  transcriptTail: string;
  runtimeAuth: LabRuntimeAuth;
  runtime: ActorRuntimeProvenance;
  /** Runtime-turn aggregate usage parsed from the exec stream (#531). Absent when the stream
   *  carried no usage record, which stays distinct from a measured zero. */
  tokenUsage?: ActorTokenUsage;
}): ActorTrace {
  const items: ActorTraceItem[] = [
    ...args.commandLog.map((entry, index): ActorTraceItem => ({
      id: `command-${String(index + 1).padStart(3, "0")}`,
      kind: "command",
      lifecycle: "completed",
      ...(entry.exitCode === undefined ? {} : { status: String(entry.exitCode) }),
      title: `${entry.label} (${entry.envNames.join(",") || "no command-scoped env"})`,
      command: {
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
        outputTail: args.transcriptTail,
      },
    })),
    // One message item carrying the (already-redacted) transcript tail so the trace shows the agent
    // narrated SOMETHING — the engagement signal the no-engagement guard reads.
    ...(args.terminalEvents.length > 0
      ? [
          {
            id: "message-001",
            kind: "message",
            lifecycle: "completed",
            title: "agent terminal output",
            text: args.transcriptTail,
          } as ActorTraceItem,
        ]
      : []),
  ];
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "codex",
    ...(args.runtime.versionStatus === "verified"
      ? { providerVersion: args.runtime.observedVersion }
      : {}),
    runtime: args.runtime,
    protocol: "terminal-exec",
    lane: "terminal",
    persona: args.persona,
    redaction: {
      status: "passed",
      screenshots: "n/a",
      notes:
        "Terminal exec output captured via commands.run onStdout/onStderr, scrubbed (literal known values) then redacted (shape patterns) AT THE SOURCE before persisting; no screenshots on this lane.",
    },
    startedAt: args.createdAt,
    completedAt: args.completedAt,
    durationMs: args.durationMs,
    status: args.status,
    completionReason: args.completionReason,
    reason: args.reason,
    ids: {}, // Runtime model requests are not observed; declarations live in runtime provenance.
    ...(args.tokenUsage ? { tokenUsage: args.tokenUsage } : {}),
    counts: {
      commands: args.commandLog.length,
      // Unlike the legacy transcript message/actions counts, this establishes
      // actual runtime item activity. Stderr and bootstrap commands never count.
      // Read the full retained stdout: its early items may no longer be in the tail.
      runtimeParticipantItems: countTerminalParticipantItems(
        normalizeLocalActorTranscript(
          args.terminalEvents
            .filter((event) => event.stream === "stdout")
            .map((event) => event.chunk)
            .join(""),
        ),
      ),
      // actions == executed commands; messages == 1 when the agent produced any output. The
      // no-engagement guard (run/verify-actor.ts) reads these: a real run bumps them, a no-op is caught.
      actions: args.commandLog.length,
      messages: args.terminalEvents.length > 0 ? 1 : 0,
      terminalEvents: args.terminalEvents.length,
    },
    items,
    capabilities:
      args.runtimeAuth === "openai-egress"
        ? { ...TERMINAL_AGENT_CAPABILITIES, keyPlacement: "external" }
        : TERMINAL_AGENT_CAPABILITIES,
  };
}
