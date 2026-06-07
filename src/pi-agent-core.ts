import {
  ACTOR_TRACE_SCHEMA,
  PI_AGENT_CORE_CAPABILITIES,
  type ActorCompletionReason,
  type ActorPersonaRef,
  type ActorStatus,
  type ActorTokenUsage,
  type ActorTrace,
  type ActorTraceItem
} from "./actor-contract.js";
import { redactText } from "./redaction.js";

// Package-identity note (resolve before the live shim):
// Verification surfaced two candidate artifacts for "pi": @earendil-works/pi-agent-core
// (an embeddable Agent class with a .subscribe() event stream; Node >=22.19, ESM)
// and @mariozechner/pi-coding-agent (the `pi` CLI with --mode json/rpc + session
// JSONL v3). They may not be the same package. This module depends on NEITHER: it
// is a PURE mapper over a locally-declared structural mirror of pi's documented
// EVENT vocabulary (event names are stable across both). Live invocation (importing
// a pi package, driving the agent, writing artifacts) is deferred behind a DI seam
// to a follow-up shim PR that must (a) pin the real package against an installed
// build, and (b) reconcile pi's Node >=22.19 requirement with this repo's engines >=20.

export type PiStopReason = "stop" | "toolUse" | "length" | "error" | "aborted";

// Locally-declared mirror of pi's documented event stream. NOT imported from any
// pi package, so it cannot drift-break the build; the shim PR re-validates it
// against the installed .d.ts.
export type PiAgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; role?: string }
  | { type: "message_update"; textDelta?: string; thinkingDelta?: string }
  | { type: "message_end"; text?: string; thinking?: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName?: string; isError?: boolean }
  | { type: "queue_update"; summary?: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "auto_retry_start" }
  | { type: "auto_retry_end" }
  | { type: "notice"; method?: string; message?: string };

export interface PiSessionStats {
  tokens?: { input?: number; output?: number; total?: number; cacheRead?: number; cacheWrite?: number };
  cost?: number;
}

export interface PiSessionResult {
  events: PiAgentEvent[];
  sessionId?: string;
  model?: string;
  providerVersion?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: ActorStatus;
  reason: string;
  stats?: PiSessionStats;
}

export function piStopReasonToStatus(stop: PiStopReason): ActorStatus {
  switch (stop) {
    case "stop":
    case "toolUse":
      return "passed";
    case "length":
      return "timed_out";
    case "aborted":
      return "blocked";
    case "error":
      return "failed";
  }
}

export function piStatusToCompletionReason(status: ActorStatus): ActorCompletionReason {
  switch (status) {
    case "passed":
      return "turn_completed";
    case "timed_out":
      return "timed_out";
    case "blocked":
      return "blocked_approval";
    case "failed":
      return "actor_error";
  }
}

function pickPiTokenUsage(stats: PiSessionStats | undefined): ActorTokenUsage | undefined {
  if (!stats) {
    return undefined;
  }
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = num(stats.tokens?.input);
  const output = num(stats.tokens?.output);
  const total = num(stats.tokens?.total);
  const costUsd = num(stats.cost);
  const usage: ActorTokenUsage = {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
    ...(costUsd === undefined ? {} : { costUsd })
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

// Project the pi event stream into provider-neutral ActorTraceItems. pi has no
// native file_change / screenshot / ui_action / approval events today, so none
// are fabricated (intentional, not incomplete). Bash runs surface as tool_call,
// not command, until the live shim can inspect tool results.
function piEventsToActorItems(events: PiAgentEvent[]): ActorTraceItem[] {
  const items: ActorTraceItem[] = [];
  const toolNames = new Map<string, string>();
  let messageOrdinal = 0;
  let noticeOrdinal = 0;
  let textBuffer = "";
  let thinkingBuffer = "";

  const flushMessage = (endText: string | undefined, endThinking: string | undefined): void => {
    const text = (endText ?? textBuffer).trim();
    const thinking = (endThinking ?? thinkingBuffer).trim();
    messageOrdinal += 1;
    if (thinking.length > 0) {
      items.push({
        id: `reasoning-${messageOrdinal}`,
        kind: "reasoning",
        lifecycle: "completed",
        title: "Reasoning",
        text: redactText(thinking)
      });
    }
    items.push({
      id: `message-${messageOrdinal}`,
      kind: "message",
      lifecycle: "completed",
      title: "Assistant message",
      ...(text.length > 0 ? { text: redactText(text) } : {})
    });
    textBuffer = "";
    thinkingBuffer = "";
  };

  for (const event of events) {
    switch (event.type) {
      case "message_start":
        items.push({ id: `message-start-${messageOrdinal + 1}`, kind: "message", lifecycle: "started", title: "Assistant message" });
        break;
      case "message_update":
        if (event.textDelta) {
          textBuffer += event.textDelta;
        }
        if (event.thinkingDelta) {
          thinkingBuffer += event.thinkingDelta;
        }
        break;
      case "message_end":
        flushMessage(event.text, event.thinking);
        break;
      case "tool_execution_start": {
        toolNames.set(event.toolCallId, event.toolName);
        const name = redactText(event.toolName);
        items.push({
          id: event.toolCallId,
          kind: "tool_call",
          lifecycle: "started",
          title: name,
          tool: { name }
        });
        break;
      }
      case "tool_execution_end": {
        const name = redactText(event.toolName ?? toolNames.get(event.toolCallId) ?? "tool");
        items.push({
          id: `${event.toolCallId}-end`,
          kind: "tool_call",
          lifecycle: "completed",
          ...(event.isError ? { status: "error" } : {}),
          title: name,
          tool: { name }
        });
        break;
      }
      case "queue_update":
        noticeOrdinal += 1;
        items.push({
          id: `plan-${noticeOrdinal}`,
          kind: "plan",
          lifecycle: "completed",
          title: "Queue update",
          ...(event.summary ? { text: redactText(event.summary) } : {})
        });
        break;
      case "compaction_start":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        noticeOrdinal += 1;
        items.push({
          id: `notice-${noticeOrdinal}`,
          kind: "notice",
          lifecycle: event.type.endsWith("_start") ? "started" : "completed",
          title: event.type
        });
        break;
      case "notice":
        noticeOrdinal += 1;
        items.push({
          id: `notice-${noticeOrdinal}`,
          kind: "notice",
          lifecycle: "completed",
          title: event.method ?? "notice",
          ...(event.message ? { text: redactText(event.message) } : {})
        });
        break;
      default:
        // agent_start / agent_end / turn_start / turn_end carry no item evidence.
        break;
    }
  }
  // Terminal flush: if the stream ended mid-message (abnormal termination such as
  // an error/abort/length cutoff), preserve the partial assistant text/reasoning.
  if (textBuffer.length > 0 || thinkingBuffer.length > 0) {
    flushMessage(undefined, undefined);
  }
  return items;
}

/**
 * Map a pi-agent-core session into the provider-neutral ActorTrace. Pure and
 * side-effect-free; mirrors codexResultToActorTrace. The persona reference is
 * supplied by the harness. Used by the actorRegistry to prove the contract is
 * provider-neutral ahead of the live SDK shim.
 */
export function piSessionToActorTrace(session: PiSessionResult, persona: ActorPersonaRef): ActorTrace {
  const tokenUsage = pickPiTokenUsage(session.stats);
  const items = piEventsToActorItems(session.events);
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "pi-agent-core",
    ...(session.providerVersion === undefined ? {} : { providerVersion: session.providerVersion }),
    protocol: "in-process-sdk",
    lane: "code",
    persona,
    redaction: {
      status: "passed",
      screenshots: "n/a",
      notes: "pi event stream projected to actor trace; secret-like text is rejected by verify."
    },
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    durationMs: session.durationMs,
    status: session.status,
    completionReason: piStatusToCompletionReason(session.status),
    reason: redactText(session.reason),
    ids: {
      ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
      ...(session.model === undefined ? {} : { model: session.model })
    },
    counts: {
      events: session.events.length,
      items: items.length
    },
    items,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    capabilities: PI_AGENT_CORE_CAPABILITIES
  };
}
