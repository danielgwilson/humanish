import { describe, expect, it } from "vitest";

import type { CodexAppServerRunResult, CodexAppServerStatus, CodexAppServerTrace } from "../src/codex-app-server.js";
import {
  ACTOR_TRACE_SCHEMA,
  CODEX_APP_SERVER_CAPABILITIES,
  codexResultToActorTrace,
  codexStatusToCompletionReason,
  type ActorPersonaRef
} from "../src/actor-contract.js";
import { actorRegistry, getActor, type ActorId } from "../src/actor-registry.js";

const persona: ActorPersonaRef = { id: "synthetic-new-user", traitsApplied: [], promptDigest: "abc123def456" };

function buildCodexResult(): CodexAppServerRunResult {
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

describe("codexResultToActorTrace", () => {
  const actorTrace = codexResultToActorTrace(buildCodexResult(), persona);

  it("emits a conformant mimetic.actor-trace.v1 envelope", () => {
    expect(actorTrace.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(actorTrace.schema).toBe("mimetic.actor-trace.v1");
    expect(actorTrace.provider).toBe("codex-app-server");
    expect(actorTrace.providerVersion).toBe("1.2.3");
    expect(actorTrace.protocol).toBe("json-rpc");
    expect(actorTrace.lane).toBe("code");
    expect(actorTrace.status).toBe("passed");
    expect(actorTrace.completionReason).toBe("turn_completed");
    expect(actorTrace.reason).toBe("turn completed");
    expect(actorTrace.capabilities).toEqual(CODEX_APP_SERVER_CAPABILITIES);
  });

  it("threads persona, ids, redaction, counts, and token usage", () => {
    expect(actorTrace.persona).toEqual(persona);
    expect(actorTrace.ids).toEqual({ sessionId: "session-1", threadId: "thread-1", turnId: "turn-1", model: "synthetic-model" });
    expect(actorTrace.redaction).toEqual({ status: "passed", screenshots: "n/a", notes: "synthetic redaction note" });
    expect(actorTrace.counts.envelopes).toBe(9);
    expect(actorTrace.tokenUsage).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("flattens every codex evidence kind into items, including sibling-array rows", () => {
    const kinds = new Set(actorTrace.items.map((item) => item.kind));
    for (const kind of ["message", "reasoning", "command", "file_change", "tool_call", "approval", "plan", "notice"]) {
      expect(kinds).toContain(kind);
    }
    const command = actorTrace.items.find((item) => item.kind === "command");
    expect(command?.command).toEqual({ text: "echo hello", cwd: "[target-cwd]", exitCode: 0, outputTail: "hello" });
    const tool = actorTrace.items.find((item) => item.kind === "tool_call");
    expect(tool?.tool).toEqual({ server: "synthetic-server", name: "synthetic-tool" });
    const message = actorTrace.items.find((item) => item.kind === "message");
    expect(message?.text).toBe("synthetic assistant message");
    const approval = actorTrace.items.find((item) => item.kind === "approval");
    expect(approval?.status).toBe("decline");
    // Two notices (one warning + one error) must both survive.
    expect(actorTrace.items.filter((item) => item.kind === "notice")).toHaveLength(2);
  });

  it("carries no absolute local path", () => {
    expect(JSON.stringify(actorTrace)).not.toContain("/Users/");
    expect(JSON.stringify(actorTrace)).not.toContain("/private/");
  });
});

describe("codexStatusToCompletionReason", () => {
  it("maps each codex status to a stable completion reason", () => {
    expect(codexStatusToCompletionReason("passed")).toBe("turn_completed");
    expect(codexStatusToCompletionReason("timed_out")).toBe("timed_out");
    expect(codexStatusToCompletionReason("blocked")).toBe("blocked_approval");
    expect(codexStatusToCompletionReason("failed")).toBe("actor_error");
  });
});

describe("actorRegistry", () => {
  it("exposes the codex-app-server descriptor with declared capabilities", () => {
    const actor = getActor("codex-app-server");
    expect(actor.id).toBe("codex-app-server");
    expect(actor.capabilities).toEqual(CODEX_APP_SERVER_CAPABILITIES);
    expect(actor.capabilities.lanes).toEqual(["code"]);
    expect(typeof actor.runSession).toBe("function");
  });

  it("maps a result to an ActorTrace through the descriptor", () => {
    const actorTrace = getActor("codex-app-server").toActorTrace(buildCodexResult(), persona);
    expect(actorTrace.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(actorTrace.provider).toBe("codex-app-server");
  });

  it("throws on an unknown actor id", () => {
    expect(() => getActor("does-not-exist" as ActorId)).toThrow(/Unknown actor/);
    expect(Object.keys(actorRegistry)).toContain("codex-app-server");
  });
});

function withStatus(status: CodexAppServerStatus): CodexAppServerRunResult {
  const result = buildCodexResult();
  result.status = status;
  result.trace.status = status;
  return result;
}

describe("codexResultToActorTrace edge cases", () => {
  it("maps every terminal status through the full transform", () => {
    expect(codexResultToActorTrace(withStatus("blocked"), persona).completionReason).toBe("blocked_approval");
    expect(codexResultToActorTrace(withStatus("blocked"), persona).status).toBe("blocked");
    expect(codexResultToActorTrace(withStatus("failed"), persona).completionReason).toBe("actor_error");
    expect(codexResultToActorTrace(withStatus("timed_out"), persona).completionReason).toBe("timed_out");
  });

  it("omits tokenUsage and optional ids/providerVersion when the codex result lacks them", () => {
    const result = buildCodexResult();
    delete result.trace.tokenUsage;
    delete result.sessionId;
    delete result.threadId;
    delete result.turnId;
    delete result.model;
    delete result.trace.server.codexCliVersion;
    const actorTrace = codexResultToActorTrace(result, persona);
    expect(actorTrace.tokenUsage).toBeUndefined();
    expect(actorTrace).not.toHaveProperty("providerVersion");
    expect(actorTrace.ids).toEqual({});
  });

  it("picks only finite token-usage fields and drops the rest", () => {
    const partial = buildCodexResult();
    partial.trace.tokenUsage = { input_tokens: 100 };
    expect(codexResultToActorTrace(partial, persona).tokenUsage).toEqual({ input: 100 });

    const notFinite = buildCodexResult();
    notFinite.trace.tokenUsage = { input_tokens: Number.NaN, output_tokens: "nope" };
    expect(codexResultToActorTrace(notFinite, persona).tokenUsage).toBeUndefined();
  });

  it("maps unknown item types via the fallback and leaves orphaned items unenriched", () => {
    const result = buildCodexResult();
    result.trace.items = [
      { id: "i-unknown", type: "unknownType", lifecycle: "completed", title: "unknown" },
      { id: "i-toolish", type: "toolExecution", lifecycle: "completed", title: "toolish" },
      { id: "i-msgish", type: "someMessageThing", lifecycle: "completed", title: "msgish" },
      { id: "i-orphan-cmd", type: "commandExecution", lifecycle: "completed", title: "orphan command" }
    ];
    result.trace.commands = [];
    result.trace.approvals = [];
    result.trace.plans = [];
    result.trace.warnings = [];
    result.trace.errors = [];
    const items = codexResultToActorTrace(result, persona).items;
    const byId = (id: string) => items.find((item) => item.id === id);
    expect(byId("i-unknown")?.kind).toBe("notice");
    expect(byId("i-toolish")?.kind).toBe("tool_call");
    expect(byId("i-msgish")?.kind).toBe("message");
    const orphan = byId("i-orphan-cmd");
    expect(orphan?.kind).toBe("command");
    expect(orphan?.command).toBeUndefined();
  });

  it("adds no synthetic items when sibling arrays are empty", () => {
    const result = buildCodexResult();
    result.trace.approvals = [];
    result.trace.plans = [];
    result.trace.warnings = [];
    result.trace.errors = [];
    const items = codexResultToActorTrace(result, persona).items;
    expect(items).toHaveLength(result.trace.items.length);
    for (const kind of ["approval", "plan", "notice"]) {
      expect(items.some((item) => item.kind === kind)).toBe(false);
    }
  });

  it("falls back to a default plan title when explanation is missing", () => {
    const result = buildCodexResult();
    result.trace.plans = [{ steps: ["only step"] }];
    const plan = codexResultToActorTrace(result, persona).items.find((item) => item.kind === "plan");
    expect(plan?.title).toBe("Plan update");
  });
});
