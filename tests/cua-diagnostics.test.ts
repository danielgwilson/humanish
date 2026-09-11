import { describe, expect, it } from "vitest";
import type { ActorCompletionReason, ActorStatus, ActorStopCause } from "../src/actor-contract.js";
import { cuaLaneDiagnostics, summarizeCuaDiagnostics, type CuaDiagnostics } from "../src/cua-diagnostics.js";

describe("CUA diagnostic control evidence", () => {
  it.each(["provider_output_limit", "provider_token_limit", "time_limit", "spend_limit", "study_spend_limit",
    "provider_incomplete", "provider_status", "harness_aborted", "adapter_limit"])("preserves recorded %s", (cause) => {
    expect(cuaLaneDiagnostics({ dryRun: false, session: { status: "incomplete", completionReason: "budget_reached", stopCause: cause as ActorStopCause } }))
      .toEqual({ category: "session_interrupted", stopCause: cause });
  });

  it("does not invent a provider cause for a legacy budget stop or unknown cause", () => {
    expect(cuaLaneDiagnostics({ dryRun: false, session: { status: "incomplete", completionReason: "budget_reached" } }))
      .toEqual({ category: "session_interrupted", stopCause: "unspecified_limit" });
    expect(cuaLaneDiagnostics({ dryRun: false, session: { status: "incomplete", completionReason: "budget_reached", stopCause: "private.example cause" as ActorStopCause } }))
      .toEqual({ category: "session_interrupted", stopCause: "unknown" });
  });

  it.each([
    ["passed", "goal_satisfied", "participant_outcome"], ["abandoned", "gave_up", "participant_outcome"],
    ["blocked", "blocked_approval", "participant_outcome"], ["failed", "step_failed", "participant_outcome"],
    ["failed", "actor_error", "execution_error"], ["failed", "harness_error", "execution_error"]
  ] as const)("distinguishes %s/%s without reading narration", (status, completionReason, category) => {
    expect(cuaLaneDiagnostics({ dryRun: false, session: { status, completionReason } })).toEqual({ category });
  });

  it("keeps a skipped, missing or hollow session unknown", () => {
    for (const input of [{ skipped: true }, {}, { noEngagement: true, session: { status: "passed" as ActorStatus, completionReason: "goal_satisfied" as ActorCompletionReason } }]) {
      expect(cuaLaneDiagnostics({ dryRun: false, ...input })).toEqual({ category: "unknown" });
    }
    expect(cuaLaneDiagnostics({ dryRun: false, executionError: true })).toEqual({ category: "execution_error" });
  });

  const lane = (status: string, diagnostics?: CuaDiagnostics) => ({ status, ok: status === "passed", ...(diagnostics === undefined ? {} : { diagnostics }) });
  const summary = (...lanes: ReturnType<typeof lane>[]) => summarizeCuaDiagnostics({ dryRun: false, evidenceInvalid: false, lanes });
  it("never projects the first lane over divergent causes or a missing lane diagnostic", () => {
    const limited = lane("incomplete", { category: "session_interrupted", stopCause: "provider_output_limit" });
    const timed = lane("incomplete", { category: "session_interrupted", stopCause: "time_limit" });
    expect(summary(limited, timed)).toEqual({ category: "mixed", stopCause: "mixed" });
    expect(summary(limited, lane("failed"))).toEqual({ category: "mixed", stopCause: "mixed" });
    expect(summary(limited, limited)).toEqual({ category: "session_interrupted", stopCause: "provider_output_limit" });
    expect(summary(lane("failed"), lane("failed"))).toEqual({ category: "unknown" });
  });

  it("keeps different participant outcomes mixed even though both are valid study results", () => {
    expect(summary(lane("passed", { category: "participant_outcome" }), lane("abandoned", { category: "participant_outcome" })))
      .toEqual({ category: "mixed" });
  });

  it("separates invalid evidence and preview from participant endings", () => {
    expect(summarizeCuaDiagnostics({ dryRun: true, evidenceInvalid: false, lanes: [] })).toEqual({ category: "preview" });
    expect(summarizeCuaDiagnostics({ dryRun: true, evidenceInvalid: true, lanes: [] })).toEqual({ category: "evidence_invalid" });
  });
});
