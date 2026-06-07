// Shared fixtures for actor-trace tests (per-adapter conformance + cross-harness
// conformance). Not a test file (no .test.ts suffix), so vitest does not run it.
import type { CodexAppServerRunResult, CodexAppServerTrace } from "../src/codex-app-server.js";
import type { ActorPersonaRef } from "../src/actor-contract.js";
import type { PiSessionResult } from "../src/pi-agent-core.js";
import type { ClaudeSessionResult } from "../src/claude-agent-sdk.js";

export const fixturePersona: ActorPersonaRef = {
  id: "synthetic-new-user",
  traitsApplied: ["patience:low", "skill:high"],
  promptDigest: "abc123def456"
};

export function buildCodexResult(): CodexAppServerRunResult {
  const counts: CodexAppServerTrace["counts"] = {
    approvals: 1,
    commandOutputs: 1,
    envelopes: 9,
    errors: 1,
    fileChanges: 1,
    itemCompletions: 5,
    itemStarts: 5,
    messages: 1,
    reasoning: 1,
    requests: 2,
    responses: 2,
    tools: 1,
    warnings: 1
  };
  const trace: CodexAppServerTrace = {
    schema: "mimetic.codex-app-server-trace.v1",
    provider: "codex-app-server",
    protocolVersion: "v2",
    redaction: { status: "passed", notes: "synthetic redaction note" },
    client: { name: "mimetic_cli", title: "Mimetic CLI", experimentalApi: false },
    server: { commandName: "codex", codexCliVersion: "1.2.3", transport: "stdio" },
    cwd: "[target-cwd]",
    promptDigest: "abc123def456",
    startedAt: "2026-06-06T00:00:00.000Z",
    completedAt: "2026-06-06T00:00:05.000Z",
    durationMs: 5000,
    status: "passed",
    reason: "turn completed",
    threadId: "thread-1",
    turnId: "turn-1",
    sessionId: "session-1",
    model: "synthetic-model",
    counts,
    methods: { "item/started": 5 },
    items: [
      { id: "i-msg", type: "agentMessage", lifecycle: "completed", title: "Agent message" },
      { id: "i-rsn", type: "reasoning", lifecycle: "completed", title: "Reasoning summary" },
      { id: "i-cmd", type: "commandExecution", lifecycle: "completed", status: "completed", title: "Run command" },
      { id: "i-file", type: "fileChange", lifecycle: "completed", title: "Edit file" },
      { id: "i-tool", type: "mcpToolCall", lifecycle: "completed", title: "Tool call" }
    ],
    messages: [{ itemId: "i-msg", text: "synthetic assistant message" }],
    reasoning: [{ itemId: "i-rsn", text: "synthetic reasoning summary" }],
    plans: [{ explanation: "synthetic plan", steps: ["step one", "step two"] }],
    commands: [
      { itemId: "i-cmd", command: "echo hello", cwd: "[target-cwd]", status: "completed", exitCode: 0, outputTail: "hello" }
    ],
    fileChanges: [{ itemId: "i-file", status: "completed", changeCount: 1, outputTail: "1 change" }],
    tools: [{ itemId: "i-tool", kind: "mcp", server: "synthetic-server", tool: "synthetic-tool", status: "completed" }],
    approvals: [{ id: 7, method: "execCommandApproval", itemId: "i-cmd", decision: "decline", reason: "synthetic decline" }],
    warnings: [{ method: "warn/method", message: "synthetic warning" }],
    errors: [{ method: "error/method", message: "synthetic error" }],
    tokenUsage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }
  };
  return {
    status: "passed",
    reason: "turn completed",
    durationMs: 5000,
    threadId: "thread-1",
    turnId: "turn-1",
    sessionId: "session-1",
    model: "synthetic-model",
    codexCliVersion: "1.2.3",
    experimentalApi: false,
    counts,
    tail: "synthetic tail",
    trace,
    transcriptPath: "codex-app-server/transcript.txt",
    tracePath: "codex-app-server/summary.json",
    eventsPath: "codex-app-server/events.ndjson"
  };
}

export function buildPiSession(): PiSessionResult {
  return {
    sessionId: "pi-session-1",
    model: "synthetic-model",
    providerVersion: "0.75.5",
    startedAt: "2026-06-06T00:00:00.000Z",
    completedAt: "2026-06-06T00:00:03.000Z",
    durationMs: 3000,
    status: "passed",
    reason: "agent completed the turn",
    stats: { tokens: { input: 120, output: 60, total: 180 }, cost: 0.0021 },
    events: [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", role: "assistant" },
      { type: "message_update", thinkingDelta: "considering the task" },
      { type: "message_update", textDelta: "Looking at the project" },
      { type: "message_end", text: "Looking at the project structure.", thinking: "considering the task" },
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file" },
      { type: "tool_execution_end", toolCallId: "call-1", isError: false },
      { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash" },
      { type: "tool_execution_end", toolCallId: "call-2", isError: true },
      { type: "queue_update", summary: "steering follow-up queued" },
      { type: "compaction_start" },
      { type: "compaction_end" },
      { type: "auto_retry_start" },
      { type: "auto_retry_end" },
      { type: "notice", method: "extension_error", message: "synthetic extension notice" },
      { type: "turn_end" },
      { type: "agent_end" }
    ]
  };
}

export function buildClaudeSession(): ClaudeSessionResult {
  return {
    startedAt: "2026-06-06T00:00:00.000Z",
    completedAt: "2026-06-06T00:00:04.000Z",
    providerVersion: "0.3.168",
    messages: [
      { type: "system", subtype: "init", session_id: "claude-session-1", model: "synthetic-model" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "considering the request" },
            { type: "text", text: "Inspecting the project setup." },
            { type: "tool_use", id: "toolu_01", name: "Read" }
          ]
        }
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_01", is_error: false }]
        }
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 4000,
        num_turns: 1,
        session_id: "claude-session-1",
        total_cost_usd: 0.0034,
        usage: { input_tokens: 200, output_tokens: 80 },
        result: "Completed the inspection."
      }
    ]
  };
}
