import { describe, expect, it } from "vitest";

import { scoreOssMetaMeaningfulUse } from "../src/oss-meta-lab-scoring.js";
import type { RunSetupQualitySnapshot } from "../src/run.js";

function setupQualityFixture(): RunSetupQualitySnapshot {
  return {
    schema: "humanish.setup-quality.v1",
    generatedAt: "2026-06-05T12:00:00.000Z",
    redaction: {
      status: "passed",
      rawPreviews: "included",
      notes: "Only allowlisted setup files are previewed."
    },
    summary: "Humanish setup is app-specific and proof-oriented.",
    status: "passed",
    checks: [
      {
        id: "humanish-config",
        label: "Humanish config",
        ok: true,
        detail: "humanish/config.ts exists."
      },
      {
        id: "package-script",
        label: "Package script",
        ok: true,
        detail: "package.json exposes a Humanish watch script."
      }
    ],
    tree: [
      { path: "package.json", type: "file", sizeBytes: 540 },
      { path: "humanish", type: "directory" },
      { path: "humanish/config.ts", type: "file", sizeBytes: 180 },
      { path: "humanish/personas/product-researcher.yaml", type: "file", sizeBytes: 220 }
    ],
    previews: [
      {
        path: "humanish/config.ts",
        language: "typescript",
        truncated: false,
        text: "export default { run: { appUrl: 'http://127.0.0.1:5173', sims: 2 } };"
      }
    ],
    studyQuality: {
      schema: "humanish.study-quality.v1",
      rating: "high_leverage",
      summary: "Study-quality rating high_leverage from app-specific personas, scenarios, app URL proof, and actor insight.",
      checks: [
        {
          id: "persona-customized",
          label: "Persona customized",
          ok: true,
          detail: "Personas are specific to the product audience."
        }
      ],
      signals: {
        appUrlProofBlocked: false,
        appUrlProofMentioned: true,
        actorInsightCaptured: true,
        coverageCustomized: true,
        personaCustomized: true,
        scenarioCustomized: true
      }
    },
    packageScripts: {
      dev: "vite",
      humanish: "humanish watch"
    },
    humanish: {
      configPresent: true,
      gitignoreContainsRuntimeIgnore: true,
      packageScriptPresent: true,
      personaCount: 2,
      scenarioCount: 2
    }
  };
}

describe("OSS meta-lab meaningful-use scoring", () => {
  it("passes only when every evidence component passes", () => {
    const result = scoreOssMetaMeaningfulUse({
      actorLastMessageTail: "Finished an app-specific Humanish study and summarized useful feedback.",
      actorRequired: true,
      actorStatus: "passed",
      appStatus: "running",
      appUrl: "http://127.0.0.1:5173",
      nestedObserverPresent: true,
      nestedVerifyPassed: true,
      setupQuality: setupQualityFixture(),
      status: "passed",
      visualStatus: "visible"
    });

    expect(result).toMatchObject({
      schema: "humanish.meaningful-use-score.v1",
      hardFailures: [],
      score: 100,
      status: "pass"
    });
    expect(result.summary).not.toContain("needs stronger");
    expect(result.components.every((component) => component.status === "pass")).toBe(true);
  });

  it("does not pass a high numeric score when actor evidence is weak", () => {
    const result = scoreOssMetaMeaningfulUse({
      actorRequired: false,
      appStatus: "running",
      appUrl: "http://127.0.0.1:5173",
      nestedObserverPresent: true,
      nestedVerifyPassed: true,
      setupQuality: setupQualityFixture(),
      status: "passed",
      visualStatus: "visible"
    });

    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.status).toBe("partial");
    expect(result.summary).toContain("needs stronger actor activity");
  });

  it("fails completed lanes that did not prove a visible product surface", () => {
    const result = scoreOssMetaMeaningfulUse({
      actorRequired: true,
      actorStatus: "passed",
      appStatus: "missing",
      nestedObserverPresent: true,
      nestedVerifyPassed: true,
      setupQuality: setupQualityFixture(),
      status: "passed",
      visualStatus: "blocked"
    });

    expect(result.status).toBe("fail");
    expect(result.hardFailures).toContain("Completed lane did not prove a running, visible product surface.");
  });

  it("uses clear public wording for timed-out bootstrap hard failures", () => {
    const result = scoreOssMetaMeaningfulUse({
      actorRequired: false,
      status: "timed_out"
    });

    expect(result.status).toBe("fail");
    expect(result.hardFailures).toContain("Remote bootstrap timed out.");
    expect(result.summary).not.toContain("completed with timed_out");
  });

  it("accepts intentionally suppressed file previews when setup tree evidence is strong", () => {
    const setupQuality = setupQualityFixture();
    setupQuality.redaction.rawPreviews = "suppressed";
    setupQuality.redaction.notes = "Raw setup file previews were suppressed for private-repo safety.";
    setupQuality.previews = [];

    const result = scoreOssMetaMeaningfulUse({
      actorLastMessageTail: "Finished an app-specific Humanish study and summarized useful feedback.",
      actorRequired: true,
      actorStatus: "passed",
      appStatus: "running",
      appUrl: "http://127.0.0.1:5173",
      nestedObserverPresent: true,
      nestedVerifyPassed: true,
      setupQuality,
      status: "passed",
      visualStatus: "visible"
    });

    expect(result.status).toBe("pass");
    expect(result.components.find((component) => component.id === "filesystem-evidence")).toMatchObject({
      status: "pass"
    });
    expect(result.summary).not.toContain("file previews");
  });
});
