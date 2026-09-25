import { describe, expect, it } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { PARTICIPANT_PROFILE } from "../../src/restricted-codex-participant-policy";
import { validActorExecutionProfile as serverProfile, validActorProviderRequests as serverRequests } from "../../src/actor-contract";
import { validActorExecutionProfile, validActorProviderRequests } from "../lib/actor-execution-profile";
import { isObserverData } from "../lib/validate";

const request = { ordinal: 1, kind: "interaction", dispatched: true, usageComplete: true, cleanup: "confirmed", profileVerified: true, usage: { input: 20, output: 5 } };
const account = () => {
  const data = structuredClone(live) as unknown as Record<string, any>;
  delete data.cost;
  for (const stream of data.streams) {
    delete stream.liveActor;
    stream.actor.executionProfile = PARTICIPANT_PROFILE;
    stream.actor.providerRequests = [structuredClone(request)];
    stream.actor.estimatedCost = { schema: "humanish.actor-estimated-cost.v1", estimatedCostUsd: null, ratesAsOf: null, modelId: "gpt-6-astra", reason: "account_billing_unknown" };
    stream.actor.tokenUsage = { input: 20, output: 5 };
  }
  return data;
};
describe("account participant durable reader", () => {
  it("opens recordings with finite failure phases and keeps older recordings readable", () => {
    for (const phase of [undefined, "startup", "initialize", "config/read", "account/read", "thread/start",
      "mcpServerStatus/list", "turn/start", "response", "cleanup", "private/raw/path"]) {
      const data = account();
      const failed = { ...request, errorCode: "timeout", ...(phase === undefined ? {} : { failurePhase: phase }) };
      data.streams[0].actor.providerRequests = [failed];
      expect(validActorProviderRequests([failed])).toBe(serverRequests([failed]));
      expect(isObserverData(data)).toBe(phase !== "private/raw/path");
    }
  });
  it("opens both memory-policy generations without reinterpreting old recordings", () => {
    for (const policy of ["recent-eight-16k-v1", "continuing-thread-v1", "future-policy", ["continuing-thread-v1"], null]) {
      const profile = { ...PARTICIPANT_PROFILE, memoryPolicy: policy };
      const valid = policy === "recent-eight-16k-v1" || policy === "continuing-thread-v1";
      expect(validActorExecutionProfile(profile)).toBe(valid); expect(serverProfile(profile)).toBe(valid);
      const data = account(); data.streams[0].actor.executionProfile = profile;
      const before = structuredClone(data); expect(isObserverData(data)).toBe(valid); expect(data).toEqual(before);
    }
  });
  it("agrees with the server's durable profile and closed request schema", () => {
    for (const value of [PARTICIPANT_PROFILE, { ...PARTICIPANT_PROFILE, cliVersion: "unqualified" }, { ...PARTICIPANT_PROFILE, secret: "synthetic" }, null])
      expect(validActorExecutionProfile(value)).toBe(serverProfile(value));
    for (const value of [[request], [], [{ ...request, usage: { costUsd: 0 } }], [{ ...request, ordinal: 2 }], [{ ...request, dispatched: false }],
      [{ ...request, kind: ["interaction"] }], [{ ...request, cleanup: ["confirmed"] }], [{ ...request, errorCode: ["busy"] }], [{ ...request, cleanup: "late" }], [{ ...request, rawTranscript: "synthetic" }], [{ ...request, usage: { input: -1, output: 5 } }], [{ ...request, usage: { input: 1.5, output: 5 } }],
      [{ ...request, usage: { input: Number.MAX_SAFE_INTEGER + 1, output: 5 } }], [{ ...request, usage: { input: 1, output: 5, cachedInput: 2 } }]])
      expect(validActorProviderRequests(value)).toBe(serverRequests(value));
  });
  it("accepts unknown account dollars and rejects contradictory actor or model-line money", () => {
    const original = account(); expect(isObserverData(original)).toBe(true);
    const missingReceipts = account(); delete missingReceipts.streams[0].actor.providerRequests; expect(isObserverData(missingReceipts)).toBe(false);
    for (const mutation of [
      (d: Record<string, any>) => { d.streams[0].actor.estimatedCost.estimatedCostUsd = 0; },
      (d: Record<string, any>) => { d.streams[0].actor.tokenUsage.costUsd = 0; },
      (d: Record<string, any>) => { d.streams[0].actor.providerRequests[0].usage.costUsd = 0; },
      (d: Record<string, any>) => { d.cost = { estimatedTotalUsd: 1, fullyEstimated: false, ratesAsOf: "2026-09-23", breakdown: [{ kind: "model-tokens", estimatedCostUsd: 1, laneId: d.streams[0].id }] }; }
    ]) { const data = account(); mutation(data); expect(isObserverData(data)).toBe(false); }
    expect(isObserverData(live)).toBe(true);
  });
});
