import { describe, expect, it } from "vitest";
import { actorEnding } from "../src/actor-stop-cause.js";
import type { ActorStopCause, ActorTrace } from "../src/actor-contract.js";
import liveBundle from "./golden/labs/live.json" with { type: "json" };
import { buildObserverData } from "../src/observer-data.js";
import { tallyParticipantOutcomes, type RunBundle } from "../src/run.js";

function actor(overrides: Partial<ActorTrace> = {}): ActorTrace {
  return { ...structuredClone(liveBundle.streams[0]!.actor), status: "incomplete", completionReason: "budget_reached",
    reason: "The recorded reason stays verbatim.", items: [], ...overrides } as ActorTrace;
}

const cases: [ActorStopCause, string][] = [
  ["provider_output_limit", "provider output limit"], ["provider_token_limit", "provider token limit"],
  ["time_limit", "time limit"], ["spend_limit", "estimated spend limit"], ["study_spend_limit", "study spend limit"],
  ["provider_incomplete", "provider response incomplete"], ["provider_status", "unexpected provider status"],
  ["harness_aborted", "stopped by harness"], ["adapter_limit", "adapter admission limit"]
];

describe("recorded stop causes", () => {
  it.each(cases)("projects %s without changing the source", (stopCause, label) => {
    const source = actor({ stopCause });
    const original = structuredClone(source);
    expect(actorEnding(source)).toEqual({ cause: stopCause, label });
    expect(source).toEqual(original);
  });

  it("recognizes the exact retained provider notice but does not invent output versus context detail", () => {
    const source = actor({ items: [{ id: "notice-003", kind: "notice", lifecycle: "completed", status: "warn",
      title: "provider token limit reached", text: "Synthetic retained notice" }] });
    expect(actorEnding(source)).toEqual({ cause: "provider_token_limit", label: "provider token limit" });
  });

  it("never classifies free-form participant or reason text as a cause", () => {
    expect(actorEnding(actor({ reason: "estimated spend $5 crossed the time budget and provider limit",
      items: [{ id: "message", kind: "message", lifecycle: "completed", title: "provider token limit reached" }] })))
      .toEqual({ cause: "unspecified_limit", label: "limit reached" });
    expect(actorEnding(actor({ completionReason: "gave_up", reason: "provider token limit reached" }))).toBeUndefined();
  });

  it("does not use a token notice to override a different terminal reason", () => {
    expect(actorEnding(actor({ completionReason: "goal_satisfied", items: [{ id: "notice", kind: "notice", lifecycle: "completed", title: "provider token limit reached" }] }))).toBeUndefined();
  });

  it("does not infer an adapter limit from a historical generic error", () => {
    expect(actorEnding(actor({ status: "failed", completionReason: "actor_error", reason: "OpenAI Responses network error",
      items: [{ id: "notice", kind: "notice", lifecycle: "completed", title: "adapter admission limit reached" }] }))).toBeUndefined();
  });

  it.each(["__proto__", "constructor", "future_cause"])("ignores an unknown cause %s", (stopCause) => {
    expect(actorEnding(actor({ stopCause: stopCause as ActorStopCause }))?.cause).toBe("unspecified_limit");
  });

  it("keeps counts and evidence while distinguishing mixed session endings", () => {
    const bundle = structuredClone(liveBundle) as unknown as RunBundle;
    const statuses = ["passed", "incomplete", "timed_out", "incomplete", "abandoned", "failed"] as const;
    const causes = [undefined, "provider_output_limit", "time_limit", undefined, "spend_limit", "provider_incomplete"] as const;
    bundle.streams = statuses.map((status, i) => ({ ...bundle.streams[0]!, id: `stream-${i}`, status,
      actor: actor({ status, completionReason: status === "passed" ? "goal_satisfied" : "budget_reached",
        ...(causes[i] === undefined ? {} : { stopCause: causes[i] }) }) }));
    bundle.review.participants = tallyParticipantOutcomes(statuses);
    const original = structuredClone(bundle);
    const data = buildObserverData(bundle);
    expect(data.run.participantsLine).toBe("1/6 recorded completions (1 other or unavailable source), 1 interrupted (estimated spend limit), 1 interrupted (provider output limit), 1 interrupted (time limit), 1 interrupted (limit reached), 1 interrupted (provider response incomplete)");
    expect(data.streams[1]!.statusLabel).toBe("Interrupted");
    expect(data.streams[4]!.statusLabel).toBe("Interrupted");
    expect(data.run.participants).toEqual(original.review.participants);
    expect(data.streams.map(s => s.actor)).toEqual(original.streams.map(s => s.actor));
    expect(bundle).toEqual(original);
  });

  it("does not fill gaps in an aggregate tally with unmatched traces", () => {
    const bundle = structuredClone(liveBundle) as unknown as RunBundle;
    bundle.streams[0]!.actor = actor({ stopCause: "provider_output_limit" });
    bundle.review.participants = tallyParticipantOutcomes(["incomplete", "incomplete"]);
    expect(buildObserverData(bundle).run.participantsLine).toBe("0/2 recorded completions, 2 interrupted (stop details unavailable)");
  });
});
