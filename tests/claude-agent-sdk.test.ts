import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, CLAUDE_AGENT_SDK_CAPABILITIES, type ActorPersonaRef } from "../src/actor-contract.js";
import {
  claudeResultSubtypeToStatus,
  claudeSessionToActorTrace,
  claudeStatusToCompletionReason,
  type ClaudeSessionResult
} from "../src/claude-agent-sdk.js";
import { actorRegistry, getActor } from "../src/actor-registry.js";
import { buildClaudeSession } from "./actor-fixtures.js";

const persona: ActorPersonaRef = { id: "synthetic-new-user", traitsApplied: ["patience:medium", "skill:medium"], promptDigest: "cafef00d5678" };

describe("claudeSessionToActorTrace", () => {
  const trace = claudeSessionToActorTrace(buildClaudeSession(), persona);

  it("emits a conformant mimetic.actor-trace.v1 envelope for the claude provider", () => {
    expect(trace.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(trace.provider).toBe("claude-agent-sdk");
    expect(trace.providerVersion).toBe("0.3.168");
    expect(trace.protocol).toBe("in-process-sdk");
    expect(trace.lane).toBe("code");
    expect(trace.status).toBe("passed");
    expect(trace.completionReason).toBe("turn_completed");
    expect(trace.capabilities).toEqual(CLAUDE_AGENT_SDK_CAPABILITIES);
  });

  it("derives ids, duration, reason, and token usage from the result and init messages", () => {
    expect(trace.persona).toEqual(persona);
    expect(trace.ids).toEqual({ sessionId: "claude-session-1", model: "synthetic-model" });
    expect(trace.durationMs).toBe(4000);
    expect(trace.reason).toBe("Completed the inspection.");
    expect(trace.tokenUsage).toEqual({ input: 200, output: 80, total: 280, costUsd: 0.0034 });
  });

  it("projects assistant content blocks and tool results into items", () => {
    const kinds = new Set(trace.items.map((item) => item.kind));
    for (const kind of ["message", "reasoning", "tool_call"]) {
      expect(kinds).toContain(kind);
    }
    const toolStarted = trace.items.find((item) => item.kind === "tool_call" && item.lifecycle === "started");
    expect(toolStarted?.tool).toEqual({ name: "Read" });
    const toolCompleted = trace.items.find((item) => item.kind === "tool_call" && item.lifecycle === "completed");
    expect(toolCompleted?.tool).toEqual({ name: "Read" });
    const message = trace.items.find((item) => item.kind === "message");
    expect(message?.text).toContain("project setup");
  });

  it("does not fabricate kinds claude does not emit (command, file_change, screenshot, ui_action, approval, plan, notice)", () => {
    const kinds = new Set<string>(trace.items.map((item) => item.kind));
    for (const kind of ["command", "file_change", "screenshot", "ui_action", "approval", "plan", "notice"]) {
      expect(kinds.has(kind)).toBe(false);
    }
  });
});

describe("claude status mapping", () => {
  it("maps each result subtype to a status", () => {
    expect(claudeResultSubtypeToStatus("success")).toBe("passed");
    expect(claudeResultSubtypeToStatus("error_max_turns")).toBe("timed_out");
    expect(claudeResultSubtypeToStatus("error_max_budget_usd")).toBe("timed_out");
    expect(claudeResultSubtypeToStatus("error_during_execution")).toBe("failed");
    expect(claudeResultSubtypeToStatus("error_max_structured_output_retries")).toBe("failed");
  });

  it("maps each status to a completion reason", () => {
    expect(claudeStatusToCompletionReason("passed")).toBe("turn_completed");
    expect(claudeStatusToCompletionReason("timed_out")).toBe("timed_out");
    expect(claudeStatusToCompletionReason("blocked")).toBe("blocked_approval");
    expect(claudeStatusToCompletionReason("failed")).toBe("actor_error");
  });

  it("runs the full transform for a non-success result and redacts the reason", () => {
    const leakyPath = ["", "Users", "synthetic", "claude"].join("/");
    const session: ClaudeSessionResult = buildClaudeSession();
    session.messages = [
      { type: "system", subtype: "init", session_id: "s", model: "m" },
      { type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 100, session_id: "s", result: `crashed at ${leakyPath}` }
    ];
    const trace = claudeSessionToActorTrace(session, persona);
    expect(trace.status).toBe("failed");
    expect(trace.completionReason).toBe("actor_error");
    expect(trace.reason).not.toContain(leakyPath);
    expect(trace.reason).toContain("[REDACTED_LOCAL_PATH]");
  });
});

describe("claude edge cases", () => {
  it("omits tokenUsage when usage is absent", () => {
    const session = buildClaudeSession();
    session.messages = [{ type: "result", subtype: "success", duration_ms: 10, session_id: "s" }];
    expect(claudeSessionToActorTrace(session, persona).tokenUsage).toBeUndefined();
  });

  it("falls back gracefully when there is no result message, deriving duration from timestamps", () => {
    const session = buildClaudeSession();
    session.messages = [{ type: "system", subtype: "init", session_id: "s", model: "m" }];
    const trace = claudeSessionToActorTrace(session, persona);
    expect(trace.status).toBe("failed");
    expect(trace.completionReason).toBe("actor_error");
    expect(trace.reason).toContain("no result message");
    // No result.duration_ms, so duration falls back to completedAt - startedAt (4000ms).
    expect(trace.durationMs).toBe(4000);
  });
});

describe("actorRegistry with the claude adapter", () => {
  it("registers claude-agent-sdk with declared capabilities and a mapper", () => {
    const claude = getActor("claude-agent-sdk");
    expect(claude.id).toBe("claude-agent-sdk");
    expect(claude.capabilities).toEqual(CLAUDE_AGENT_SDK_CAPABILITIES);
    expect(typeof claude.toActorTrace).toBe("function");
    expect(Object.keys(actorRegistry)).toContain("claude-agent-sdk");
  });
});
