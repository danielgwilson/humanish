import {
  ACTOR_TRACE_SCHEMA,
  CLAUDE_AGENT_SDK_CAPABILITIES,
  type ActorCompletionReason,
  type ActorPersonaRef,
  type ActorStatus,
  type ActorTokenUsage,
  type ActorTrace,
  type ActorTraceItem
} from "./actor-contract.js";
import { redactText } from "./redaction.js";

// Live invocation is deferred behind a DI seam: this module is a PURE mapper over
// a locally-declared structural mirror of the Claude Agent SDK's documented
// message stream (@anthropic-ai/claude-agent-sdk query() output). It imports no
// SDK. The follow-up live-shim PR collects the query() yields into a
// ClaudeSessionResult and re-validates these local types against the installed
// .d.ts (the SDK message union is large and evolves; only the fields mapped here
// are mirrored, defensively).

export type ClaudeResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries";

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string }
  | { type: "tool_result"; tool_use_id: string; is_error?: boolean };

export type ClaudeMessage =
  | { type: "system"; subtype: "init"; session_id?: string; model?: string }
  | { type: "assistant"; message: { content: ClaudeContentBlock[] } }
  | { type: "user"; message: { content: ClaudeContentBlock[] | string } }
  | {
      type: "result";
      subtype: ClaudeResultSubtype;
      is_error?: boolean;
      duration_ms?: number;
      num_turns?: number;
      session_id?: string;
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
      result?: string;
    };

export interface ClaudeSessionResult {
  messages: ClaudeMessage[];
  startedAt: string;
  completedAt: string;
  providerVersion?: string;
}

// SDK result subtypes -> ActorStatus. error_max_turns / error_max_budget_usd are
// the SDK's own configured resource limits (a harness ceiling), mapped to
// timed_out. They are NOT the persona's "gave_up": that is reserved for
// persona-judged abandonment in the live actor loop.
export function claudeResultSubtypeToStatus(subtype: ClaudeResultSubtype): ActorStatus {
  switch (subtype) {
    case "success":
      return "passed";
    case "error_max_turns":
    case "error_max_budget_usd":
      return "timed_out";
    case "error_during_execution":
    case "error_max_structured_output_retries":
      return "failed";
  }
}

export function claudeStatusToCompletionReason(status: ActorStatus): ActorCompletionReason {
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

function pickClaudeTokenUsage(
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
  costUsd: number | undefined
): ActorTokenUsage | undefined {
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = num(usage?.input_tokens);
  const output = num(usage?.output_tokens);
  const total = input !== undefined && output !== undefined ? input + output : undefined;
  const cost = num(costUsd);
  const tokenUsage: ActorTokenUsage = {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
    ...(cost === undefined ? {} : { costUsd: cost })
  };
  return Object.keys(tokenUsage).length > 0 ? tokenUsage : undefined;
}

// String content is plain user input text (the Anthropic MessageParam only carries
// tool_use/tool_result as block arrays, never strings), and user input is not
// surfaced as trace items, so returning [] here is intentional, not data loss.
function contentBlocks(message: { content: ClaudeContentBlock[] | string }): ClaudeContentBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

function elapsedMs(startedAt: string, completedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
}

// Project the Claude SDK message stream into provider-neutral items. assistant
// content blocks (text/thinking/tool_use) and user tool_result blocks map to
// message/reasoning/tool_call. Claude does not emit distinct plan/file_change/
// screenshot/approval events in this slice, so none are fabricated. Tool inputs
// are intentionally not surfaced (they can carry arbitrary text); only the tool
// name is, redacted.
function claudeMessagesToActorItems(messages: ClaudeMessage[]): ActorTraceItem[] {
  const items: ActorTraceItem[] = [];
  const toolNames = new Map<string, string>();
  let messageOrdinal = 0;

  for (const message of messages) {
    if (message.type === "assistant") {
      for (const block of contentBlocks(message.message)) {
        if (block.type === "text") {
          messageOrdinal += 1;
          const text = block.text.trim();
          items.push({
            id: `message-${messageOrdinal}`,
            kind: "message",
            lifecycle: "completed",
            title: "Assistant message",
            ...(text.length > 0 ? { text: redactText(text) } : {})
          });
        } else if (block.type === "thinking") {
          messageOrdinal += 1;
          const thinking = block.thinking.trim();
          items.push({
            id: `reasoning-${messageOrdinal}`,
            kind: "reasoning",
            lifecycle: "completed",
            title: "Reasoning",
            ...(thinking.length > 0 ? { text: redactText(thinking) } : {})
          });
        } else if (block.type === "tool_use") {
          const name = redactText(block.name);
          toolNames.set(block.id, name);
          items.push({
            id: block.id,
            kind: "tool_call",
            lifecycle: "started",
            title: name,
            tool: { name }
          });
        }
      }
    } else if (message.type === "user") {
      for (const block of contentBlocks(message.message)) {
        if (block.type === "tool_result") {
          const name = toolNames.get(block.tool_use_id) ?? "tool";
          items.push({
            id: `${block.tool_use_id}-result`,
            kind: "tool_call",
            lifecycle: "completed",
            ...(block.is_error ? { status: "error" } : {}),
            title: name,
            tool: { name }
          });
        }
      }
    }
  }
  return items;
}

/**
 * Map a Claude Agent SDK session into the provider-neutral ActorTrace. Pure and
 * side-effect-free; mirrors codexResultToActorTrace / piSessionToActorTrace. The
 * persona reference is supplied by the harness.
 */
export function claudeSessionToActorTrace(session: ClaudeSessionResult, persona: ActorPersonaRef): ActorTrace {
  const result = [...session.messages].reverse().find((message) => message.type === "result");
  const init = session.messages.find((message) => message.type === "system");
  const subtype: ClaudeResultSubtype = result?.type === "result" ? result.subtype : "error_during_execution";
  const status = claudeResultSubtypeToStatus(subtype);
  const sessionId = (result?.type === "result" ? result.session_id : undefined) ?? (init?.type === "system" ? init.session_id : undefined);
  const model = init?.type === "system" ? init.model : undefined;
  const durationMs =
    result?.type === "result" && typeof result.duration_ms === "number"
      ? result.duration_ms
      : elapsedMs(session.startedAt, session.completedAt);
  const reason = result?.type === "result" ? result.result ?? `claude session ended: ${subtype}` : "claude session produced no result message";
  const tokenUsage = result?.type === "result" ? pickClaudeTokenUsage(result.usage, result.total_cost_usd) : undefined;
  const items = claudeMessagesToActorItems(session.messages);

  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "claude-agent-sdk",
    ...(session.providerVersion === undefined ? {} : { providerVersion: session.providerVersion }),
    protocol: "in-process-sdk",
    lane: "code",
    persona,
    redaction: {
      status: "passed",
      screenshots: "n/a",
      notes: "Claude Agent SDK message stream projected to actor trace; secret-like text is rejected by verify."
    },
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    durationMs,
    status,
    completionReason: claudeStatusToCompletionReason(status),
    reason: redactText(reason),
    ids: {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(model === undefined ? {} : { model })
    },
    counts: {
      messages: session.messages.length,
      items: items.length
    },
    items,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    capabilities: CLAUDE_AGENT_SDK_CAPABILITIES
  };
}
