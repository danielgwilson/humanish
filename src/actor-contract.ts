import type { CodexAppServerRunResult, CodexAppServerStatus, CodexAppServerTrace } from "./codex-app-server.js";
import { redactText } from "./redaction.js";

// The provider-neutral evidence schema. Codex item/* events, Claude
// ToolUse/ToolResult blocks, pi tool_execution_* events, and computer-use
// cycles all map onto this one ActorTrace. See docs/architecture/actor-contract.md.
//
// This PR ships the evidence schema + the first provider mapping (Codex) + the
// registry. The full Actor.run(input: ActorRunInput) interface, RedactionHooks
// injection, ApprovalPolicy, and ResolvedPersona are specified in the design doc
// and land with the load-bearing-personas and adapter PRs; they are intentionally
// not declared here yet to avoid unimplemented placeholder types.

export const ACTOR_TRACE_SCHEMA = "mimetic.actor-trace.v1";

export type ActorStatus = "passed" | "failed" | "blocked" | "timed_out";

export type ActorCompletionReason =
  | "goal_satisfied"
  | "turn_completed"
  | "gave_up"
  | "blocked_approval"
  | "timed_out"
  | "actor_error"
  // A deterministic scripted step or expectation evaluated false: the scenario predicate
  // failed. Distinct from actor_error/harness_error — the harness executed faithfully; the
  // SUBJECT did not satisfy the script.
  | "step_failed"
  | "harness_error";

// "scripted-browser" is the deterministic, model-free browser-actuation lane — distinct from
// "computer-use" (raw pixels + a model) and "app".
export type ActorLane = "code" | "app" | "computer-use" | "scripted-browser";

export type ActorProtocol = "json-rpc" | "json-stream" | "in-process-sdk" | "cua-loop" | "scripted-steps";

export type ActorTraceItemKind =
  | "message"
  | "reasoning"
  | "tool_call"
  | "command"
  | "file_change"
  | "approval"
  | "screenshot"
  | "ui_action"
  | "plan"
  | "notice";

export interface ActorTraceItem {
  id: string;
  kind: ActorTraceItemKind;
  lifecycle: "started" | "completed";
  status?: string;
  title: string;
  tool?: { server?: string; name?: string };
  command?: { text?: string; cwd?: string; exitCode?: number; outputTail?: string };
  screenshotRef?: { path: string; redaction: "blurred" | "ocr_scrubbed" | "none" };
  text?: string;
}

export interface ActorCapabilities {
  headless: boolean;
  structuredTrace: boolean;
  lanes: ActorLane[];
  producesScreenshots: boolean;
  byoModel: boolean;
  preGrantableApprovals: boolean;
  inProcessTools: boolean;
  license: "open" | "source-available" | "proprietary";
}

export interface ActorPersonaRef {
  id: string;
  traitsApplied: string[];
  promptDigest: string;
}

export interface ActorTokenUsage {
  input?: number;
  output?: number;
  total?: number;
  costUsd?: number;
}

export interface ActorTrace {
  schema: typeof ACTOR_TRACE_SCHEMA;
  provider: string;
  providerVersion?: string;
  protocol: ActorProtocol;
  lane: ActorLane;
  persona: ActorPersonaRef;
  // status: "passed" means the trace conforms to its declared redaction policy and carries no
  // secret VALUES in text. screenshots: "raw" = full-fidelity frames retained (valid for LOCAL
  // use; redact before publishing); "blurred"/"ocr_scrubbed" = publish-safe; "n/a" = none captured.
  redaction: { status: "passed"; screenshots: "n/a" | "raw" | "blurred" | "ocr_scrubbed"; notes: string };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  ids: { sessionId?: string; threadId?: string; turnId?: string; model?: string };
  counts: Record<string, number>;
  items: ActorTraceItem[];
  tokenUsage?: ActorTokenUsage;
  capabilities: ActorCapabilities;
}

export const CODEX_APP_SERVER_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["code"],
  producesScreenshots: false,
  byoModel: false,
  preGrantableApprovals: true,
  inProcessTools: false,
  license: "open"
};

// pi-agent-core (@earendil-works/pi-agent-core): an embeddable, provider-agnostic
// agent loop (MIT). byoModel: 15+ providers incl. local. No confirmed pre-grant
// approval hook today, so preGrantableApprovals is false until verified.
export const PI_AGENT_CORE_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["code", "app"],
  producesScreenshots: false,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: true,
  license: "open"
};

// Claude Agent SDK (@anthropic-ai/claude-agent-sdk): in-process query() stream
// with typed SDK messages. Pre-grant approvals via permissionMode/allowedTools.
// Anthropic-centric models (others via a proxy), so byoModel is false.
export const CLAUDE_AGENT_SDK_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["code", "app"],
  producesScreenshots: false,
  byoModel: false,
  preGrantableApprovals: true,
  inProcessTools: true,
  license: "open"
};

// Scripted browser driver (src/scripted-browser-actor.ts): deterministic Playwright step
// replay against a loopback app. byoModel is false because there is NO model — the committed
// scenario steps are the whole behavior; tokenUsage on its traces records zeros by mechanism.
export const SCRIPTED_BROWSER_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["scripted-browser"],
  producesScreenshots: true,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open" // playwright-core (Apache-2.0), already a lazy-imported production dependency
};

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
    ...(costUsd === undefined ? {} : { costUsd })
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
      ...(item.status === undefined ? {} : { status: item.status })
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
            ...(command.outputTail === undefined ? {} : { outputTail: command.outputTail })
          }
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
            ...(tool.tool === undefined ? {} : { name: tool.tool })
          }
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
      ...(approval.reason ? { text: approval.reason } : {})
    });
  }
  trace.plans.forEach((plan, index) => {
    items.push({
      id: `plan-${index + 1}`,
      kind: "plan",
      lifecycle: "completed",
      title: plan.explanation ?? "Plan update",
      ...(plan.steps.length > 0 ? { text: plan.steps.join("\n") } : {})
    });
  });
  [...trace.warnings, ...trace.errors].forEach((notice, index) => {
    items.push({
      id: `notice-${index + 1}`,
      kind: "notice",
      lifecycle: "completed",
      title: notice.method,
      ...(notice.message ? { text: notice.message } : {})
    });
  });

  return items;
}

/**
 * Map a Codex app-server run result into the provider-neutral ActorTrace. Pure
 * and side-effect-free. The persona reference is supplied by the harness; until
 * personas are load-bearing it is a minimal stub ({ id, traitsApplied: [],
 * promptDigest }).
 */
export function codexResultToActorTrace(result: CodexAppServerRunResult, persona: ActorPersonaRef): ActorTrace {
  const trace = result.trace;
  const tokenUsage = pickTokenUsage(trace.tokenUsage);
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "codex-app-server",
    ...(trace.server.codexCliVersion === undefined ? {} : { providerVersion: trace.server.codexCliVersion }),
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
      ...(result.model === undefined ? {} : { model: result.model })
    },
    counts: { ...trace.counts },
    items: codexTraceToActorItems(trace),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    capabilities: CODEX_APP_SERVER_CAPABILITIES
  };
}
