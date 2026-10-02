// Maps a Codex app-server run into the provider-neutral ActorTrace.
import {
  ACTOR_TRACE_SCHEMA,
  CODEX_APP_SERVER_CAPABILITIES,
  type ActorCompletionReason,
  type ActorPersonaRef,
  type ActorTokenUsage,
  type ActorTrace,
  type ActorTraceItem,
  type ActorTraceItemKind,
} from "../contract.js";
import { redactText } from "../../evidence/redaction.js";
import type { CodexAppServerRunResult } from "./app-server.js";
import type { CodexAppServerStatus, CodexAppServerTrace } from "./app-server-trace.js";

// Codex app-server reports four terminal statuses but no explicit completion
// reason enum, so map status -> reason. App-server "blocked" is approval-driven
// (an action was declined and the turn could not proceed). "goal_satisfied" and
// "gave_up" are not reachable from Codex today; they arrive with persona-driven
// scenario predicates and harness-enforced turn budgets in a later PR.
export function codexStatusToCompletionReason(status: CodexAppServerStatus): ActorCompletionReason {
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

function codexItemKind(type: string): ActorTraceItemKind {
  switch (type) {
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file_change";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "tool_call";
    case "agentMessage":
      return "message";
    case "reasoning":
      return "reasoning";
    default: {
      const lowered = type.toLowerCase();
      if (lowered.includes("message")) return "message";
      if (lowered.includes("reason")) return "reasoning";
      if (lowered.includes("command")) return "command";
      if (lowered.includes("file")) return "file_change";
      if (lowered.includes("tool")) return "tool_call";
      if (lowered.includes("plan")) return "plan";
      return "notice";
    }
  }
}

function pickTokenUsage(raw: CodexAppServerTrace["tokenUsage"]): ActorTokenUsage | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const numberFrom = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  };
  const input = numberFrom(["input", "input_tokens", "inputTokens", "prompt_tokens"]);
  const output = numberFrom(["output", "output_tokens", "outputTokens", "completion_tokens"]);
  const total = numberFrom(["total", "total_tokens", "totalTokens"]);
  const costUsd = numberFrom(["costUsd", "cost_usd", "cost"]);
  const usage: ActorTokenUsage = {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

// Flatten the Codex trace into provider-neutral items. The lifecycle rows in
// trace.items only cover message/reasoning/command/file/tool; approvals, plans,
// warnings, and errors live only in sibling arrays and are synthesized here so
// no evidence is silently dropped.
function codexTraceToActorItems(trace: CodexAppServerTrace): ActorTraceItem[] {
  const commandByItem = new Map(trace.commands.map((command) => [command.itemId, command]));
  const toolByItem = new Map(trace.tools.map((tool) => [tool.itemId, tool]));
  const messageByItem = new Map(trace.messages.map((message) => [message.itemId, message]));
  const reasoningByItem = new Map(trace.reasoning.map((entry) => [entry.itemId, entry]));
  const fileChangeByItem = new Map(trace.fileChanges.map((change) => [change.itemId, change]));

  const items: ActorTraceItem[] = trace.items.map((item) => {
    const kind = codexItemKind(item.type);
    const base: ActorTraceItem = {
      id: item.id,
      kind,
      lifecycle: item.lifecycle,
      title: item.title,
      ...(item.status === undefined ? {} : { status: item.status }),
    };
    if (kind === "command") {
      const command = commandByItem.get(item.id);
      if (command) {
        return {
          ...base,
          command: {
            ...(command.command === undefined ? {} : { text: command.command }),
            ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
            ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
            ...(command.outputTail === undefined ? {} : { outputTail: command.outputTail }),
          },
        };
      }
    }
    if (kind === "tool_call") {
      const tool = toolByItem.get(item.id);
      if (tool) {
        return {
          ...base,
          tool: {
            ...(tool.server === undefined ? {} : { server: tool.server }),
            ...(tool.tool === undefined ? {} : { name: tool.tool }),
          },
        };
      }
    }
    if (kind === "message") {
      const message = messageByItem.get(item.id);
      if (message) {
        return { ...base, text: message.text };
      }
    }
    if (kind === "reasoning") {
      const reasoning = reasoningByItem.get(item.id);
      if (reasoning) {
        return { ...base, text: reasoning.text };
      }
    }
    if (kind === "file_change") {
      const change = fileChangeByItem.get(item.id);
      if (change?.outputTail !== undefined) {
        return { ...base, text: change.outputTail };
      }
    }
    return base;
  });

  for (const approval of trace.approvals) {
    items.push({
      id: `approval-${String(approval.id)}`,
      kind: "approval",
      lifecycle: "completed",
      status: approval.decision,
      title: `${approval.method} (${approval.decision})`,
      ...(approval.reason ? { text: approval.reason } : {}),
    });
  }
  trace.plans.forEach((plan, index) => {
    items.push({
      id: `plan-${index + 1}`,
      kind: "plan",
      lifecycle: "completed",
      title: plan.explanation ?? "Plan update",
      ...(plan.steps.length > 0 ? { text: plan.steps.join("\n") } : {}),
    });
  });
  [...trace.warnings, ...trace.errors].forEach((notice, index) => {
    items.push({
      id: `notice-${index + 1}`,
      kind: "notice",
      lifecycle: "completed",
      title: notice.method,
      ...(notice.message ? { text: notice.message } : {}),
    });
  });

  return items;
}

/**
 * Map a Codex app-server run result into the provider-neutral ActorTrace. Pure
 * and side-effect-free. The persona reference is supplied by the harness; until
 * the Codex route uses personas it is a minimal stub ({ id, traitsApplied: [],
 * promptDigest }).
 */
export function codexResultToActorTrace(
  result: CodexAppServerRunResult,
  persona: ActorPersonaRef,
): ActorTrace {
  const trace = result.trace;
  const tokenUsage = pickTokenUsage(trace.tokenUsage);
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "codex-app-server",
    ...(trace.server.codexCliVersion === undefined
      ? {}
      : { providerVersion: trace.server.codexCliVersion }),
    protocol: "json-rpc",
    lane: "code",
    persona,
    redaction: { status: "passed", screenshots: "n/a", notes: trace.redaction.notes },
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
    durationMs: trace.durationMs,
    status: trace.status,
    completionReason: codexStatusToCompletionReason(trace.status),
    // result.reason is the raw reason; the codex trace redacts its own reason, so
    // redact here too to keep the actor projection consistent (defense in depth).
    reason: redactText(result.reason),
    ids: {
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
      ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
      ...(result.model === undefined ? {} : { model: result.model }),
    },
    counts: { ...trace.counts },
    items: codexTraceToActorItems(trace),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    capabilities: CODEX_APP_SERVER_CAPABILITIES,
  };
}
