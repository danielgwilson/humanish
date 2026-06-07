import { describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorCapabilities, type ActorTrace } from "../src/actor-contract.js";
import { getActor } from "../src/actor-registry.js";
import { buildClaudeSession, buildCodexResult, buildPiSession, fixturePersona } from "./actor-fixtures.js";

// The shared contract every adapter's ActorTrace must satisfy. This is what makes
// the harnesses interchangeable (ADR step 7): one persona run through codex and pi
// yields the same trace shape, completion vocabulary, and redaction status.
const ACTOR_STATUSES = ["passed", "failed", "blocked", "timed_out"];
const COMPLETION_REASONS = [
  "goal_satisfied",
  "turn_completed",
  "gave_up",
  "blocked_approval",
  "timed_out",
  "actor_error",
  "harness_error"
];
const ITEM_KINDS = [
  "message",
  "reasoning",
  "tool_call",
  "command",
  "file_change",
  "approval",
  "screenshot",
  "ui_action",
  "plan",
  "notice"
];

function assertConformsToActorTrace(trace: ActorTrace): void {
  expect(trace.schema).toBe(ACTOR_TRACE_SCHEMA);
  expect(typeof trace.provider).toBe("string");
  expect(["json-rpc", "json-stream", "in-process-sdk", "cua-loop"]).toContain(trace.protocol);
  expect(["code", "app", "computer-use"]).toContain(trace.lane);
  expect(ACTOR_STATUSES).toContain(trace.status);
  expect(COMPLETION_REASONS).toContain(trace.completionReason);
  expect(typeof trace.reason).toBe("string");
  expect(typeof trace.startedAt).toBe("string");
  expect(typeof trace.completedAt).toBe("string");
  expect(typeof trace.durationMs).toBe("number");

  expect(trace.redaction.status).toBe("passed");
  expect(typeof trace.redaction.notes).toBe("string");
  expect(["n/a", "blurred", "ocr_scrubbed"]).toContain(trace.redaction.screenshots);

  expect(typeof trace.ids).toBe("object");
  expect(trace.ids).not.toBeNull();

  expect(typeof trace.persona.id).toBe("string");
  expect(Array.isArray(trace.persona.traitsApplied)).toBe(true);
  expect(typeof trace.persona.promptDigest).toBe("string");

  const capabilities = trace.capabilities as unknown as Record<keyof ActorCapabilities, unknown>;
  for (const key of ["headless", "structuredTrace", "producesScreenshots", "byoModel", "preGrantableApprovals", "inProcessTools"] as const) {
    expect(typeof capabilities[key]).toBe("boolean");
  }
  expect(Array.isArray(trace.capabilities.lanes)).toBe(true);
  expect(["open", "source-available", "proprietary"]).toContain(trace.capabilities.license);

  for (const value of Object.values(trace.counts)) {
    expect(typeof value).toBe("number");
  }

  for (const item of trace.items) {
    expect(typeof item.id).toBe("string");
    expect(ITEM_KINDS).toContain(item.kind);
    expect(["started", "completed"]).toContain(item.lifecycle);
    expect(typeof item.title).toBe("string");
  }

  expect(JSON.stringify(trace)).not.toContain("/Users/");
  expect(JSON.stringify(trace)).not.toContain("/private/");
}

describe("cross-harness ActorTrace conformance", () => {
  const codex = getActor("codex-app-server").toActorTrace(buildCodexResult(), fixturePersona);
  const pi = getActor("pi-agent-core").toActorTrace(buildPiSession(), fixturePersona);
  const claude = getActor("claude-agent-sdk").toActorTrace(buildClaudeSession(), fixturePersona);
  const traces = [
    { name: "codex-app-server", trace: codex },
    { name: "pi-agent-core", trace: pi },
    { name: "claude-agent-sdk", trace: claude }
  ];

  for (const { name, trace } of traces) {
    it(`${name} produces a conformant trace`, () => {
      assertConformsToActorTrace(trace);
    });
  }

  it("all adapters emit the identical envelope shape (same top-level keys)", () => {
    const codexKeys = Object.keys(codex).sort();
    expect(Object.keys(pi).sort()).toEqual(codexKeys);
    expect(Object.keys(claude).sort()).toEqual(codexKeys);
  });

  it("all adapters thread the same persona reference identically", () => {
    for (const { trace } of traces) {
      expect(trace.persona).toEqual(fixturePersona);
    }
  });

  it("all adapters use the shared status and completion-reason vocabulary", () => {
    for (const { trace } of traces) {
      expect(ACTOR_STATUSES).toContain(trace.status);
      expect(COMPLETION_REASONS).toContain(trace.completionReason);
    }
  });

  it("all adapters report redaction passed", () => {
    for (const { trace } of traces) {
      expect(trace.redaction.status).toBe("passed");
    }
  });

  it("each adapter declares its own distinct provider and protocol", () => {
    expect(codex.provider).toBe("codex-app-server");
    expect(pi.provider).toBe("pi-agent-core");
    expect(claude.provider).toBe("claude-agent-sdk");
    expect(codex.protocol).toBe("json-rpc");
    expect(pi.protocol).toBe("in-process-sdk");
    expect(claude.protocol).toBe("in-process-sdk");
    expect(new Set(traces.map((entry) => entry.trace.provider)).size).toBe(3);
  });
});
