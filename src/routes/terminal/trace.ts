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
import { normalizeLocalActorTranscript } from "../../run/terminal-contract.js";
import {
  type CommandLogRecord,
  MESSAGE_CHARS,
  TAIL_CHARS,
  type TerminalEventRecord,
} from "./types.js";

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
 * Project the live terminal session into the provider-neutral humanish.actor-trace.v1 (`lane`
 * "terminal", protocol "terminal-exec"). counts.actions/messages drive the no-engagement honesty
 * guard (a real run bumps them; a no-op is caught). No screenshots on this route.
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
  /** The route's scrub and redaction, re-applied to text decoded out of the JSON stream. */
  sanitize: (text: string) => string;
}): ActorTrace {
  // Read the full retained stdout: its early items may no longer be in the tail.
  const stdout = normalizeLocalActorTranscript(
    args.terminalEvents
      .filter((event) => event.stream === "stdout")
      .map((event) => event.chunk)
      .join(""),
  );
  const textItems = terminalParticipantTextItems(stdout, args.sanitize);
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
    ...textItems,
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
      // Unlike the actions count, this establishes actual runtime item activity. Stderr and
      // bootstrap commands never count.
      runtimeParticipantItems: countTerminalParticipantItems(stdout),
      // actions == executed commands, so the launcher command alone keeps the no-engagement guard
      // (verify/actor.ts) satisfied; messages == the agent's own message items.
      actions: args.commandLog.length,
      messages: textItems.filter((item) => item.kind === "message").length,
      terminalEvents: args.terminalEvents.length,
    },
    items,
    capabilities:
      args.runtimeAuth === "openai-egress"
        ? { ...TERMINAL_AGENT_CAPABILITIES, keyPlacement: "external" }
        : TERMINAL_AGENT_CAPABILITIES,
  };
}

const itemEvents = new Set(["item.started", "item.updated", "item.completed"]);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Each Codex item event in the retained JSON stdout stream, in stream order. */
function* codexStreamItems(
  stdout: string,
): Generator<{ event: string; id: string; item: Record<string, unknown> }> {
  for (const line of stdout.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !object(event) ||
      typeof event.type !== "string" ||
      !itemEvents.has(event.type) ||
      !object(event.item) ||
      !nonempty(event.item.id)
    )
      continue;
    yield { event: event.type, id: event.item.id, item: event.item };
  }
}

/**
 * The participant's own words: one trace item per Codex agent_message or reasoning item, decoded
 * from the JSON stream. Analysis may quote message and reasoning items, so these carry only the
 * agent's text. Command output, usage records and harness lines stay in the command's outputTail.
 */
export function terminalParticipantTextItems(
  stdout: string,
  sanitize: (text: string) => string,
): ActorTraceItem[] {
  const latest = new Map<string, { kind: "message" | "reasoning"; text: string; done: boolean }>();
  for (const { event, id, item } of codexStreamItems(stdout)) {
    const kind =
      item.type === "agent_message" ? "message" : item.type === "reasoning" ? "reasoning" : null;
    const previous = latest.get(id);
    if (kind === null || !nonempty(item.text) || previous?.done) continue;
    latest.set(id, { kind, text: item.text, done: event === "item.completed" });
  }
  const numbers = { message: 0, reasoning: 0 };
  return [...latest.values()].map(({ kind, text, done }) => {
    numbers[kind] += 1;
    // Redact the decoded text before cutting it, so a cut cannot split a value past the patterns.
    const clean = [...sanitize(text)];
    return {
      id: `${kind}-${String(numbers[kind]).padStart(3, "0")}`,
      kind,
      lifecycle: done ? "completed" : "started",
      title: kind === "message" ? "agent message" : "agent reasoning",
      text: clean.length > MESSAGE_CHARS ? clean.slice(0, MESSAGE_CHARS).join("") : clean.join(""),
    };
  });
}

/** Count distinct participant items in the retained Codex JSON stdout stream.
 * The caller supplies stdout only, after transport reconciliation and redaction.
 * Lifecycle, usage, launcher diagnostics, and nested command output are not activity.
 * Zero means no recognized item was retained, not that the participant succeeded.
 */
export function countTerminalParticipantItems(stdout: string): number {
  const ids = new Set<string>();
  for (const { id, item } of codexStreamItems(stdout)) {
    const active =
      ((item.type === "agent_message" || item.type === "reasoning") && nonempty(item.text)) ||
      (item.type === "command_execution" && nonempty(item.command)) ||
      (item.type === "web_search" &&
        (nonempty(item.query) || (object(item.action) && nonempty(item.action.type)))) ||
      (item.type === "file_change" &&
        Array.isArray(item.changes) &&
        item.changes.some(
          (change) => object(change) && nonempty(change.path) && nonempty(change.kind),
        ));
    if (active) ids.add(id);
  }
  return ids.size;
}
