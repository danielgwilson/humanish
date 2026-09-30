// Shared fixtures for actor-trace tests (per-adapter conformance + cross-harness
// conformance). Not a test file (no .test.ts suffix), so vitest does not run it.
import type {
  CodexAppServerRunResult,
  CodexAppServerTrace,
} from "../../src/actors/codex/app-server.js";
import type { ActorPersonaRef } from "../../src/actors/contract.js";

export const fixturePersona: ActorPersonaRef = {
  id: "synthetic-new-user",
  traitsApplied: ["patience:low", "skill:high"],
  promptDigest: "abc123def456",
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
    warnings: 1,
  };
  const trace: CodexAppServerTrace = {
    schema: "humanish.codex-app-server-trace.v1",
    provider: "codex-app-server",
    protocolVersion: "v2",
    redaction: { status: "passed", notes: "synthetic redaction note" },
    client: { name: "humanish_cli", title: "Humanish CLI", experimentalApi: false },
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
      {
        id: "i-cmd",
        type: "commandExecution",
        lifecycle: "completed",
        status: "completed",
        title: "Run command",
      },
      { id: "i-file", type: "fileChange", lifecycle: "completed", title: "Edit file" },
      { id: "i-tool", type: "mcpToolCall", lifecycle: "completed", title: "Tool call" },
    ],
    messages: [{ itemId: "i-msg", text: "synthetic assistant message" }],
    reasoning: [{ itemId: "i-rsn", text: "synthetic reasoning summary" }],
    plans: [{ explanation: "synthetic plan", steps: ["step one", "step two"] }],
    commands: [
      {
        itemId: "i-cmd",
        command: "echo hello",
        cwd: "[target-cwd]",
        status: "completed",
        exitCode: 0,
        outputTail: "hello",
      },
    ],
    fileChanges: [
      { itemId: "i-file", status: "completed", changeCount: 1, outputTail: "1 change" },
    ],
    tools: [
      {
        itemId: "i-tool",
        kind: "mcp",
        server: "synthetic-server",
        tool: "synthetic-tool",
        status: "completed",
      },
    ],
    approvals: [
      {
        id: 7,
        method: "execCommandApproval",
        itemId: "i-cmd",
        decision: "decline",
        reason: "synthetic decline",
      },
    ],
    warnings: [{ method: "warn/method", message: "synthetic warning" }],
    errors: [{ method: "error/method", message: "synthetic error" }],
    tokenUsage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
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
    eventsPath: "codex-app-server/events.ndjson",
  };
}
