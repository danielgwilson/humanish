import { afterEach, describe, expect, it, vi } from "vitest";
import { syntheticArtifact } from "./fixtures.js";
import type { AnalysisArtifact } from "../../src/analysis/study-analysis.js";

// Literal persisted profile: do not derive this historical fixture from the current launcher.
function historical(): AnalysisArtifact {
  const artifact = syntheticArtifact();
  artifact.provider = "codex";
  artifact.config = {
    provider: "codex",
    model: "gpt-6-astra",
    question: null,
    timeoutMs: 1000,
    maxCostUsd: null,
    maxOutputTokens: null,
    identity: {
      transport: "codex-app-server",
      authentication: "chatgpt-account",
      billing: "account-unknown",
      requestedModel: "gpt-6-astra",
      resolvedModel: "gpt-6-astra",
      reasoningEffort: "low",
      toolPolicy: "restricted-codex-v1",
      cliVersion: "0.154.0",
    },
  };
  return artifact;
}
afterEach(() => {
  vi.doUnmock("../src/restricted-codex-policy.js");
  vi.resetModules();
});

describe("durable analyst profile reading", () => {
  it("reads every recorded profile and admits execution only for the host's qualified releases", async () => {
    vi.resetModules();
    const config = await import("../../src/analysis/codex-config.js");
    const withVersion = (cliVersion: string) => {
      const value = historical().config;
      if (value.provider !== "codex") throw new Error("expected a Codex profile");
      value.identity.cliVersion = cliVersion;
      return value;
    };
    for (const cliVersion of ["0.154.0", "0.157.1"])
      expect(config.validStoredCodexAnalysisConfig(withVersion(cliVersion))).toBe(true);
    expect(config.validCodexAnalysisConfig(withVersion("0.154.0"), "linux", "x64")).toBe(true);
    expect(config.validCodexAnalysisConfig(withVersion("0.157.1"), "linux", "x64")).toBe(true);
    expect(config.validCodexAnalysisConfig(withVersion("0.154.0"), "darwin", "arm64")).toBe(true);
    // 0.157.1 was not qualified on a Mac.
    expect(config.validCodexAnalysisConfig(withVersion("0.157.1"), "darwin", "arm64")).toBe(false);
    expect(config.validCodexAnalysisConfig(withVersion("0.158.0"), "linux", "x64")).toBe(false);
    expect(config.validStoredCodexAnalysisConfig(withVersion("0.158.0"))).toBe(false);
  });
  it("retains the literal historical profile after the current launcher qualification changes", async () => {
    vi.resetModules();
    // A hypothetical later qualification is a policy mutation test, not a claimed supported CLI.
    vi.doMock("../../src/actors/codex/restricted-policy.js", () => ({
      RESTRICTED_CODEX_ANALYSIS_IDENTITY: {
        provider: "codex",
        authMode: "chatgpt",
        modelProvider: "openai",
        cliVersion: "0.155.0",
        toolPolicy: "restricted-codex-v2",
        reasoningEffort: "low",
      },
      RESTRICTED_CODEX_ANALYSIS_MODELS: ["gpt-6-astra"],
    }));
    const config = await import("../../src/analysis/codex-config.js");
    const validator = await import("../../src/analysis/validation.js");
    const artifact = historical();
    artifact.configDigest = validator.hashStudyAnalysisValue(artifact.config);
    const before = JSON.stringify(artifact);
    expect(config.validCodexAnalysisConfig(artifact.config)).toBe(false);
    expect(config.validStoredCodexAnalysisConfig(artifact.config)).toBe(true);
    expect(validator.validateStudyAnalysisArtifact(artifact)).toEqual(artifact);
    expect(JSON.stringify(artifact)).toBe(before);
    const unqualified = structuredClone(artifact);
    if (unqualified.config.provider === "codex")
      unqualified.config.identity.cliVersion = "unqualified";
    unqualified.configDigest = validator.hashStudyAnalysisValue(unqualified.config);
    expect(() => validator.validateStudyAnalysisArtifact(unqualified)).toThrow(
      "ANALYSIS_PROVIDER_INVALID",
    );
  });
});
