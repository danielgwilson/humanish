import { describe, expect, it } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import {
  isRecordedCodexCliVersion as serverRecorded,
  validActorExecutionProfile as serverProfile,
  validActorProviderRequests as serverRequests,
} from "../../src/actors/contract";
import {
  isRecordedCodexCliVersion,
  validActorExecutionProfile,
  validActorProviderRequests,
} from "../lib/actor-execution-profile";
import { isObserverData } from "../lib/validate";

const request = {
  ordinal: 1,
  kind: "interaction",
  dispatched: true,
  usageComplete: true,
  cleanup: "confirmed",
  profileVerified: true,
  usage: { input: 20, output: 5 },
};
const baseProfile = {
  schema: "humanish.actor-execution-profile.v1",
  transport: "codex-app-server",
  authentication: "chatgpt-account",
  billing: "account-unknown",
  requestedModel: "gpt-6-astra",
  reasoningEffort: "low",
  cliVersion: "0.154.0",
} as const;
const legacyRollingProfile = {
  ...baseProfile,
  toolPolicy: "restricted-codex-v1",
  participantSchema: "humanish.restricted-participant-turn.v1",
  memoryPolicy: "recent-eight-16k-v1",
} as const;
const legacyContinuingProfile = {
  ...legacyRollingProfile,
  memoryPolicy: "continuing-thread-v1",
} as const;
const uiToolsProfile = {
  ...baseProfile,
  toolPolicy: "codex-ui-tools-v1",
  participantSchema: "humanish.codex-ui-tool.v1",
  memoryPolicy: "continuing-thread-v1",
} as const;
const account = (profile: Record<string, unknown> = legacyContinuingProfile) => {
  const data = structuredClone(live) as unknown as Record<string, any>;
  delete data.cost;
  for (const stream of data.streams) {
    delete stream.liveActor;
    stream.actor.executionProfile = profile;
    stream.actor.providerRequests = [structuredClone(request)];
    stream.actor.estimatedCost = {
      schema: "humanish.actor-estimated-cost.v1",
      estimatedCostUsd: null,
      ratesAsOf: null,
      modelId: "gpt-6-astra",
      reason: "account_billing_unknown",
    };
    stream.actor.tokenUsage = { input: 20, output: 5 };
  }
  return data;
};
// Releases at or above the 0.154.0 floor, whether or not any launch list ever named them.
const recordable = [
  "0.154.0",
  "0.154.1",
  "0.155.0",
  "0.160.0",
  "0.161.0",
  "0.200.3",
  "1.0.0",
  "0.154.1000000000",
  "1000000000.0.0",
  "0.1540.0",
  "99999999999999999999.0.0",
];
const unrecordable = [
  "0.153.9",
  "0.15.400",
  "0.9.999",
  "0.162.0-alpha.4",
  "0.160.0-linux-x64",
  "0.154",
  "00.154.0",
  "0.154.00",
  "v0.160.0",
  " 0.160.0",
  "",
];

describe("account participant durable reader", () => {
  it("opens recordings with finite failure phases and keeps older recordings readable", () => {
    for (const phase of [
      undefined,
      "startup",
      "initialize",
      "config/read",
      "account/read",
      "thread/start",
      "mcpServerStatus/list",
      "turn/start",
      "response",
      "cleanup",
      "private/raw/path",
    ]) {
      const data = account();
      const failed = {
        ...request,
        errorCode: "timeout",
        ...(phase === undefined ? {} : { failurePhase: phase }),
      };
      data.streams[0].actor.providerRequests = [failed];
      expect(validActorProviderRequests([failed])).toBe(serverRequests([failed]));
      expect(isObserverData(data)).toBe(phase !== "private/raw/path");
    }
  });
  it("opens both legacy profiles and the Codex UI-tool profile without reinterpreting recordings", () => {
    for (const profile of [
      legacyRollingProfile,
      legacyContinuingProfile,
      uiToolsProfile,
      { ...uiToolsProfile, requestedModel: "gpt-5.6-sol", reasoningEffort: "high" },
    ]) {
      expect(validActorExecutionProfile(profile)).toBe(true);
      expect(serverProfile(profile)).toBe(true);
      const data = account(profile);
      const before = structuredClone(data);
      expect(isObserverData(data)).toBe(true);
      expect(data).toEqual(before);
    }
  });
  it("reads every stable CLI release from the floor, and only 0.154.0 for the legacy action schema", () => {
    for (const cliVersion of [...recordable, ...unrecordable, 154, null])
      expect(isRecordedCodexCliVersion(cliVersion), String(cliVersion)).toBe(
        serverRecorded(cliVersion),
      );
    const recorded = recordable.map((cliVersion) => ({ ...uiToolsProfile, cliVersion }));
    for (const profile of [legacyRollingProfile, legacyContinuingProfile, ...recorded]) {
      expect(validActorExecutionProfile(profile)).toBe(true);
      expect(serverProfile(profile)).toBe(true);
      expect(isObserverData(account(profile))).toBe(true);
    }
    for (const profile of [
      { ...legacyContinuingProfile, cliVersion: "0.157.1" },
      ...unrecordable.map((cliVersion) => ({ ...uiToolsProfile, cliVersion })),
    ]) {
      expect(validActorExecutionProfile(profile)).toBe(false);
      expect(serverProfile(profile)).toBe(false);
      expect(isObserverData(account(profile))).toBe(false);
    }
  });
  it("rejects mixed policy, schema and memory generations", () => {
    const invalid = [
      { ...legacyContinuingProfile, requestedModel: "gpt-5.6-sol" },
      { ...uiToolsProfile, requestedModel: "" },
      { ...uiToolsProfile, reasoningEffort: "invalid" },
      { ...legacyContinuingProfile, participantSchema: uiToolsProfile.participantSchema },
      { ...uiToolsProfile, participantSchema: legacyContinuingProfile.participantSchema },
      { ...uiToolsProfile, memoryPolicy: "recent-eight-16k-v1" },
      { ...legacyContinuingProfile, toolPolicy: "codex-ui-tools-v1" },
      { ...legacyContinuingProfile, memoryPolicy: "future-policy" },
    ];
    for (const profile of invalid) {
      expect(validActorExecutionProfile(profile)).toBe(false);
      expect(serverProfile(profile)).toBe(false);
      expect(isObserverData(account(profile))).toBe(false);
    }
  });
  it("agrees with the server's durable profile and closed request schema", () => {
    for (const value of [
      legacyContinuingProfile,
      uiToolsProfile,
      { ...uiToolsProfile, cliVersion: "unqualified" },
      { ...uiToolsProfile, secret: "synthetic" },
      null,
    ])
      expect(validActorExecutionProfile(value)).toBe(serverProfile(value));
    for (const value of [
      [request],
      [],
      [{ ...request, usage: { costUsd: 0 } }],
      [{ ...request, ordinal: 2 }],
      [{ ...request, dispatched: false }],
      [{ ...request, kind: ["interaction"] }],
      [{ ...request, cleanup: ["confirmed"] }],
      [{ ...request, errorCode: ["busy"] }],
      [{ ...request, cleanup: "late" }],
      [{ ...request, rawTranscript: "synthetic" }],
      [{ ...request, usage: { input: -1, output: 5 } }],
      [{ ...request, usage: { input: 1.5, output: 5 } }],
      [{ ...request, usage: { input: Number.MAX_SAFE_INTEGER + 1, output: 5 } }],
      [{ ...request, usage: { input: 1, output: 5, cachedInput: 2 } }],
    ])
      expect(validActorProviderRequests(value)).toBe(serverRequests(value));
  });
  it("accepts unknown account dollars and rejects contradictory actor or model-line money", () => {
    const original = account();
    expect(isObserverData(original)).toBe(true);
    const missingReceipts = account();
    delete missingReceipts.streams[0].actor.providerRequests;
    expect(isObserverData(missingReceipts)).toBe(false);
    for (const mutation of [
      (d: Record<string, any>) => {
        d.streams[0].actor.estimatedCost.estimatedCostUsd = 0;
      },
      (d: Record<string, any>) => {
        d.streams[0].actor.tokenUsage.costUsd = 0;
      },
      (d: Record<string, any>) => {
        d.streams[0].actor.providerRequests[0].usage.costUsd = 0;
      },
      (d: Record<string, any>) => {
        d.cost = {
          estimatedTotalUsd: 1,
          fullyEstimated: false,
          ratesAsOf: "2026-09-23",
          breakdown: [{ kind: "model-tokens", estimatedCostUsd: 1, laneId: d.streams[0].id }],
        };
      },
    ]) {
      const data = account();
      mutation(data);
      expect(isObserverData(data)).toBe(false);
    }
    expect(isObserverData(live)).toBe(true);
  });
});
