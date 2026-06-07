import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, PI_AGENT_CORE_CAPABILITIES, type ActorPersonaRef } from "../src/actor-contract.js";
import {
  piSessionToActorTrace,
  piStatusToCompletionReason,
  piStopReasonToStatus
} from "../src/pi-agent-core.js";
import { actorRegistry, getActor } from "../src/actor-registry.js";
import { buildPiSession } from "./actor-fixtures.js";

const persona: ActorPersonaRef = { id: "synthetic-new-user", traitsApplied: ["patience:low", "skill:high"], promptDigest: "deadbeef1234" };

describe("piSessionToActorTrace", () => {
  const trace = piSessionToActorTrace(buildPiSession(), persona);

  it("emits a conformant mimetic.actor-trace.v1 envelope for the pi provider", () => {
    expect(trace.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(trace.schema).toBe("mimetic.actor-trace.v1");
    expect(trace.provider).toBe("pi-agent-core");
    expect(trace.providerVersion).toBe("0.75.5");
    expect(trace.protocol).toBe("in-process-sdk");
    expect(trace.lane).toBe("code");
    expect(trace.status).toBe("passed");
    expect(trace.completionReason).toBe("turn_completed");
    expect(trace.capabilities).toEqual(PI_AGENT_CORE_CAPABILITIES);
  });

  it("threads persona, ids, and token usage", () => {
    expect(trace.persona).toEqual(persona);
    expect(trace.ids).toEqual({ sessionId: "pi-session-1", model: "synthetic-model" });
    expect(trace.tokenUsage).toEqual({ input: 120, output: 60, total: 180, costUsd: 0.0021 });
    expect(trace.counts.events).toBe(18);
    expect(trace.counts.items).toBe(trace.items.length);
  });

  it("projects the pi event stream into items of every expected kind", () => {
    const kinds = new Set(trace.items.map((item) => item.kind));
    for (const kind of ["message", "reasoning", "tool_call", "plan", "notice"]) {
      expect(kinds).toContain(kind);
    }
    // Per-kind lifecycle distribution: incremental kinds carry both started and
    // completed; snapshot kinds (reasoning, plan) are completed-only.
    const lifecyclesOf = (kind: string) =>
      new Set(trace.items.filter((item) => item.kind === kind).map((item) => item.lifecycle));
    expect(lifecyclesOf("message")).toEqual(new Set(["started", "completed"]));
    expect(lifecyclesOf("tool_call")).toEqual(new Set(["started", "completed"]));
    expect(lifecyclesOf("reasoning")).toEqual(new Set(["completed"]));
    expect(lifecyclesOf("plan")).toEqual(new Set(["completed"]));
    const tool = trace.items.find((item) => item.kind === "tool_call" && item.tool?.name === "read_file");
    expect(tool?.tool).toEqual({ name: "read_file" });
    const erroredTool = trace.items.find((item) => item.kind === "tool_call" && item.lifecycle === "completed" && item.tool?.name === "bash");
    expect(erroredTool?.status).toBe("error");
    const message = trace.items.find((item) => item.kind === "message" && item.lifecycle === "completed");
    expect(message?.text).toContain("project structure");
  });

  it("carries no absolute local path", () => {
    expect(JSON.stringify(trace)).not.toContain("/Users/");
    expect(JSON.stringify(trace)).not.toContain("/private/");
  });

  it("does not fabricate kinds pi never emits (command, file_change, screenshot, ui_action, approval)", () => {
    const kinds = new Set(trace.items.map((item) => item.kind));
    expect(kinds.has("command")).toBe(false);
    expect(kinds.has("file_change")).toBe(false);
    expect(kinds.has("screenshot")).toBe(false);
    expect(kinds.has("ui_action")).toBe(false);
    expect(kinds.has("approval")).toBe(false);
  });

  it("preserves partial assistant text when the stream ends without message_end", () => {
    const truncated = buildPiSession();
    truncated.status = "failed";
    truncated.events = [
      { type: "agent_start" },
      { type: "message_start", role: "assistant" },
      { type: "message_update", textDelta: "partial answer before crash" }
    ];
    const items = piSessionToActorTrace(truncated, persona).items;
    const message = items.find((item) => item.kind === "message" && item.lifecycle === "completed");
    expect(message?.text).toContain("partial answer before crash");
  });

  it("redacts a leaky path embedded in item text (not just the reason)", () => {
    const leakyPath = ["", "Users", "synthetic", "notes"].join("/");
    const session = buildPiSession();
    session.events = [
      { type: "queue_update", summary: `next: inspect ${leakyPath}` },
      { type: "notice", method: "extension_error", message: `failed near ${leakyPath}` }
    ];
    const trace2 = piSessionToActorTrace(session, persona);
    expect(JSON.stringify(trace2.items)).not.toContain(leakyPath);
    expect(JSON.stringify(trace2.items)).toContain("[REDACTED_LOCAL_PATH]");
  });
});

describe("pi status and stop-reason mapping", () => {
  it("maps each terminal status to a completion reason", () => {
    expect(piStatusToCompletionReason("passed")).toBe("turn_completed");
    expect(piStatusToCompletionReason("timed_out")).toBe("timed_out");
    expect(piStatusToCompletionReason("blocked")).toBe("blocked_approval");
    expect(piStatusToCompletionReason("failed")).toBe("actor_error");
  });

  it("maps pi stop reasons onto actor statuses", () => {
    expect(piStopReasonToStatus("stop")).toBe("passed");
    expect(piStopReasonToStatus("toolUse")).toBe("passed");
    expect(piStopReasonToStatus("length")).toBe("timed_out");
    expect(piStopReasonToStatus("aborted")).toBe("blocked");
    expect(piStopReasonToStatus("error")).toBe("failed");
  });

  it("redacts the reason and runs the full transform for non-passed statuses", () => {
    const leakyPath = ["", "Users", "synthetic", "work"].join("/");
    const session = buildPiSession();
    session.status = "failed";
    session.reason = `aborted at ${leakyPath}`;
    const trace = piSessionToActorTrace(session, persona);
    expect(trace.status).toBe("failed");
    expect(trace.completionReason).toBe("actor_error");
    expect(trace.reason).not.toContain(leakyPath);
    expect(trace.reason).toContain("[REDACTED_LOCAL_PATH]");
  });
});

describe("pi edge cases", () => {
  it("omits tokenUsage when stats are absent and drops non-finite token fields", () => {
    const noStats = buildPiSession();
    delete noStats.stats;
    expect(piSessionToActorTrace(noStats, persona).tokenUsage).toBeUndefined();

    const partial = buildPiSession();
    partial.stats = { tokens: { input: 10, output: Number.NaN } };
    expect(piSessionToActorTrace(partial, persona).tokenUsage).toEqual({ input: 10 });
  });

  it("handles an empty event stream without crashing", () => {
    const empty = buildPiSession();
    empty.events = [];
    const trace = piSessionToActorTrace(empty, persona);
    expect(trace.items).toEqual([]);
    expect(trace.counts.events).toBe(0);
  });
});

describe("actorRegistry with the pi adapter", () => {
  it("registers pi-agent-core with declared capabilities and a mapper", () => {
    const pi = getActor("pi-agent-core");
    expect(pi.id).toBe("pi-agent-core");
    expect(pi.capabilities).toEqual(PI_AGENT_CORE_CAPABILITIES);
    expect(typeof pi.toActorTrace).toBe("function");
  });

  it("keeps the codex descriptor intact (runSession still present)", () => {
    const codex = getActor("codex-app-server");
    expect(codex.id).toBe("codex-app-server");
    expect(typeof codex.runSession).toBe("function");
    expect(Object.keys(actorRegistry)).toContain("codex-app-server");
    expect(Object.keys(actorRegistry)).toContain("pi-agent-core");
  });

  it("maps a pi session through the registry descriptor", () => {
    const trace = getActor("pi-agent-core").toActorTrace(buildPiSession(), persona);
    expect(trace.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(trace.provider).toBe("pi-agent-core");
  });
});
