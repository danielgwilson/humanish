import path from "node:path";

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
import {
  prepareContainedOutputDirectory,
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  type PreparedOutputDirectory,
  writeContainedOutputFile
} from "./selected-output-paths.js";

// This module holds both halves of the Claude adapter:
//  - the PURE mapper (claudeSessionToActorTrace) over a locally-declared
//    structural mirror of the SDK message stream; it imports no SDK; and
//  - the live shim (runClaudeAgentSession) which drives the real
//    @anthropic-ai/claude-agent-sdk query() (loaded lazily as an optional peer)
//    and is injectable via queryFn so CI tests run with a fake (no key/SDK/spend).
// The local ClaudeMessage union mirrors only the fields the mapper reads; unknown
// message subtypes are ignored. The init-by-subtype lookup + this mirror were
// validated against real SDK output in a bounded live run.

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
  // The SDK emits many system subtypes (init, hook_started, hook_response, ...).
  // Only the init message carries model/session config; the rest are ignored.
  | { type: "system"; subtype: string; session_id?: string; model?: string }
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
  // Match the init message by subtype: the SDK emits other system messages
  // (hook_started/hook_response) first, and only init carries model/session.
  const init = session.messages.find((message) => message.type === "system" && message.subtype === "init");
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

// ---------------------------------------------------------------------------
// Live shim: drive the real Claude Agent SDK and project it through the pure
// mapper above. The SDK call is injectable (queryFn) so the collection, mapping,
// redaction, timeout, and artifact-writing are fully unit-testable in CI with a
// fake generator (no key, no SDK import, no spend). Only loadClaudeAgentSdk()
// touches the optional peer dependency, lazily, mirroring the @e2b/desktop pattern.

export type ClaudeQueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;

export interface ClaudeAgentSessionOptions {
  cwd: string;
  runRoot: string;
  prompt: string;
  persona: ActorPersonaRef;
  timeoutMs: number;
  model?: string;
  // SDK resource ceiling (a runaway guard like timeoutMs), NOT the persona's
  // abandonment: persona-judged gave_up is separate and lives in the actor loop.
  maxTurns?: number;
  // Caller-compiled persona preamble (e.g. renderPersonaPromptSection); when
  // absent a minimal one is derived from the persona ref. A string systemPrompt
  // REPLACES the SDK default, which (with settingSources/tools empty) keeps the
  // session minimal and cheap.
  systemPrompt?: string;
  queryFn?: ClaudeQueryFn;
  // Injectable loader for the optional SDK (tests can force a load failure).
  loadQueryFn?: () => Promise<ClaudeQueryFn>;
}

export interface ClaudeAgentSessionResult {
  status: ActorStatus;
  reason: string;
  durationMs: number;
  trace: ActorTrace;
  session: ClaudeSessionResult;
  transcriptPath: string;
  tracePath: string;
  eventsPath: string;
  tail: string;
}

function defaultClaudeSystemPrompt(persona: ActorPersonaRef): string {
  const traits = persona.traitsApplied.length > 0 ? persona.traitsApplied.join(", ") : "none";
  return `You are simulating a software user persona for a public-safe UX test harness. Persona id: ${persona.id}. Applied traits: ${traits}. Stay in character, attempt the requested task, then stop; do not ask clarifying questions. Never print secrets, keys, or local file paths.`;
}

function isMissingClaudeAgentSdk(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND" &&
    String((error as { message?: string }).message ?? "").includes("@anthropic-ai/claude-agent-sdk")
  );
}

async function loadClaudeAgentSdkQuery(): Promise<ClaudeQueryFn> {
  try {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as { query: ClaudeQueryFn };
    return sdk.query;
  } catch (error) {
    if (isMissingClaudeAgentSdk(error)) {
      throw new Error(
        "Live Claude Agent SDK runs require the optional peer dependency @anthropic-ai/claude-agent-sdk. Install it with `npm i -D @anthropic-ai/claude-agent-sdk`, or inject a queryFn for tests."
      );
    }
    throw error;
  }
}

// Recursively redact every string in a value so the near-raw event log cannot
// carry a secret or local path (the mapper only redacts the trace projection).
function redactJsonDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonDeep(entry));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactJsonDeep(entry);
    }
    return out;
  }
  return value;
}

function renderClaudeTranscript(trace: ActorTrace): string {
  const lines: string[] = [];
  for (const item of trace.items) {
    if (item.kind === "message" && item.text) {
      lines.push(`assistant: ${item.text}`);
    } else if (item.kind === "reasoning" && item.text) {
      lines.push(`reasoning: ${item.text}`);
    } else if (item.kind === "tool_call") {
      lines.push(`tool ${item.lifecycle}: ${item.tool?.name ?? item.title}`);
    }
  }
  return lines.join("\n");
}

const CLAUDE_ARTIFACT_DIR = "claude-agent-sdk";

// Map the session through the pure mapper and write the three evidence artifacts.
// Shared by the normal path and the load-failure path so both always leave a bundle.
async function finishClaudeSession(
  runRoot: PreparedOutputDirectory,
  persona: ActorPersonaRef,
  session: ClaudeSessionResult,
  envelopeLines: string[]
): Promise<ClaudeAgentSessionResult> {
  const eventsPath = path.join(CLAUDE_ARTIFACT_DIR, "events.ndjson");
  const tracePath = path.join(CLAUDE_ARTIFACT_DIR, "summary.json");
  const transcriptPath = path.join(CLAUDE_ARTIFACT_DIR, "transcript.txt");
  const trace = claudeSessionToActorTrace(session, persona);
  const transcript = renderClaudeTranscript(trace);
  await writeContainedOutputFile(runRoot, eventsPath, envelopeLines.length > 0 ? `${envelopeLines.join("\n")}\n` : "", "utf8");
  await writeContainedOutputFile(runRoot, tracePath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(
    runRoot,
    transcriptPath,
    transcript.length > 0 ? transcript : "No Claude Agent SDK transcript output captured.\n",
    "utf8"
  );
  return {
    status: trace.status,
    reason: trace.reason,
    durationMs: trace.durationMs,
    trace,
    session,
    transcriptPath,
    tracePath,
    eventsPath,
    tail: transcript.slice(-6000)
  };
}

/**
 * Drive a Claude Agent SDK session (or an injected fake) and write the three
 * provider-neutral evidence artifacts, mirroring runCodexAppServerSession. The
 * mapping is delegated to the pure claudeSessionToActorTrace. A load failure or
 * timeout still produces a (failed/timed_out) bundle rather than throwing.
 */
export async function runClaudeAgentSession(options: ClaudeAgentSessionOptions): Promise<ClaudeAgentSessionResult> {
  const preparedRunRoot = await prepareSelectedOutputDirectory(process.cwd(), options.runRoot);
  const runRoot = preparedRunRoot;
  await prepareContainedOutputDirectory(runRoot, CLAUDE_ARTIFACT_DIR);
  await Promise.all([
    prepareContainedOutputFile(runRoot, path.join(CLAUDE_ARTIFACT_DIR, "events.ndjson")),
    prepareContainedOutputFile(runRoot, path.join(CLAUDE_ARTIFACT_DIR, "summary.json")),
    prepareContainedOutputFile(runRoot, path.join(CLAUDE_ARTIFACT_DIR, "transcript.txt"))
  ]);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  // Resolve the query function. A failure to load the optional SDK is captured as
  // a failed bundle (artifacts still written) rather than propagated.
  let queryFn: ClaudeQueryFn;
  try {
    queryFn = options.queryFn ?? (await (options.loadQueryFn ?? loadClaudeAgentSdkQuery)());
  } catch (error) {
    const reason = redactText(error instanceof Error ? error.message : String(error));
    const session: ClaudeSessionResult = {
      startedAt,
      completedAt: new Date().toISOString(),
      messages: [{ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: Date.now() - startedMs, result: reason }]
    };
    return finishClaudeSession(runRoot, options.persona, session, [JSON.stringify({ at: startedAt, error: reason })]);
  }

  const queryOptions: Record<string, unknown> = {
    systemPrompt: options.systemPrompt ?? defaultClaudeSystemPrompt(options.persona),
    settingSources: [],
    allowedTools: [],
    disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Task", "NotebookEdit"],
    permissionMode: "default",
    cwd: options.cwd,
    maxTurns: options.maxTurns ?? 8,
    includePartialMessages: false,
    ...(options.model ? { model: options.model } : {})
  };

  const messages: ClaudeMessage[] = [];
  const envelopeLines: string[] = [];
  let timedOut = false;

  // Drive the iterator manually, racing each step against the deadline so a hung
  // generator (or a non-cooperative one) cannot block past timeoutMs. abort() also
  // signals the real SDK to stop its underlying request.
  const abortController = new AbortController();
  queryOptions.abortController = abortController;
  const deadline = startedMs + options.timeoutMs;
  const iterator = queryFn({ prompt: options.prompt, options: queryOptions })[Symbol.asyncIterator]();

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        abortController.abort();
        break;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), remaining);
      });
      let step: IteratorResult<unknown> | { timedOut: true };
      try {
        step = await Promise.race([iterator.next(), timeout]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
      if ("timedOut" in step) {
        timedOut = true;
        abortController.abort();
        // Best-effort generator teardown; swallow rejection (the real SDK manages
        // a subprocess that can reject on cleanup) to avoid an unhandled rejection.
        const returned = iterator.return?.();
        if (returned) {
          void returned.catch(() => undefined);
        }
        break;
      }
      if (step.done) {
        break;
      }
      messages.push(step.value as ClaudeMessage);
      envelopeLines.push(JSON.stringify({ at: new Date().toISOString(), message: redactJsonDeep(step.value) }));
    }
  } catch (error) {
    envelopeLines.push(
      JSON.stringify({ at: new Date().toISOString(), error: redactText(error instanceof Error ? error.message : String(error)) })
    );
  }

  const completedAt = new Date().toISOString();

  // Synthesize a terminal if the stream never produced a result message (timeout,
  // abort, or a clean finish without one). The mapper maps these to timed_out/failed.
  if (!messages.some((message) => message.type === "result")) {
    messages.push({
      type: "result",
      subtype: timedOut ? "error_max_turns" : "error_during_execution",
      is_error: true,
      duration_ms: Date.now() - startedMs,
      result: timedOut ? "Claude session timed out before completion." : "Claude session ended without a result message."
    });
  }

  return finishClaudeSession(runRoot, options.persona, { messages, startedAt, completedAt }, envelopeLines);
}
