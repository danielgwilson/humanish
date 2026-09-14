import { describe, expect, it } from "vitest";
import {
  checkAnalysisResult, digestStudyAnalysisInput, hashStudyAnalysisValue, studyAnalysisResultJsonSchema,
  validateAnalysisResult, validateStudyAnalysisArtifact, validateStudyAnalysisCorrection
} from "../src/study-analysis-validation.js";
import { syntheticArtifact, syntheticInput, syntheticResult } from "./study-analysis-fixtures.js";

describe("study analysis validation", () => {
  it("accepts bounded results and exports a strict provider JSON schema", () => {
    const input = syntheticInput();
    expect(validateAnalysisResult(input, syntheticResult(input))).toEqual(syntheticResult(input));
    const visit = (value: unknown) => {
      if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        if (obj.type === "object") expect(obj.additionalProperties).toBe(false);
        Object.values(obj).forEach(visit);
      }
    };
    visit(studyAnalysisResultJsonSchema);
  });
  it("rejects unknown properties, invented evidence, and unsupported visual claims", () => {
    const input = syntheticInput();
    const extra = { ...syntheticResult(), command: "synthetic" };
    expect(checkAnalysisResult(input, extra).ok).toBe(false);
    const result = syntheticResult();
    result.findings[0]!.observations[0]!.evidenceIds = ["unselected"];
    expect(checkAnalysisResult(input, result).ok).toBe(false);
    result.findings[0]!.observations[0]!.evidenceIds = ["e000002"];
    expect(checkAnalysisResult(input, result)).toMatchObject({ ok: false, errors: ["ANALYSIS_VISUAL_WITHOUT_CAPTURE"] });
  });
  it("requires exact participant quotes and source ownership", () => {
    const input = syntheticInput();
    const result = syntheticResult();
    result.participants[0]!.feedback[0]!.text = "I created the item.";
    expect(checkAnalysisResult(input, result).ok).toBe(false);
    result.participants[0]!.feedback = [{ evidenceId: "e000001", text: "Capture" }];
    expect(checkAnalysisResult(input, result).ok).toBe(false);
    result.participants[0]!.feedback = [];
    input.evidence[0]!.streamId = "participant-b";
    expect(checkAnalysisResult(input, result).ok).toBe(false);
  });
  it("rejects duplicate denominators, omitted participants, and unsupported affected IDs", () => {
    for (const mutate of [
      (value: ReturnType<typeof syntheticResult>) => { value.findings[0]!.affectedStreamIds.push("participant-a"); },
      (value: ReturnType<typeof syntheticResult>) => { value.findings[0]!.exposedStreamIds = ["participant-b"]; },
      (value: ReturnType<typeof syntheticResult>) => { value.participants = []; },
      (value: ReturnType<typeof syntheticResult>) => { value.findings.push(value.findings[0]!); }
    ]) {
      const result = syntheticResult(); mutate(result);
      expect(checkAnalysisResult(syntheticInput(), result).ok).toBe(false);
    }
  });
  it("bounds arrays and text before semantic validation", () => {
    const result = syntheticResult();
    result.findings[0]!.title = "x".repeat(241);
    expect(checkAnalysisResult(syntheticInput(), result)).toEqual({ ok: false, errors: ["ANALYSIS_RESULT_SCHEMA_INVALID"] });
  });
  it("hashes participants and config canonically and rejects changed persisted content", () => {
    expect(hashStudyAnalysisValue({ b: 1, a: 2 })).toBe(hashStudyAnalysisValue({ a: 2, b: 1 }));
    const input = syntheticInput();
    input.participants[0]!.assignment = "A different assignment.";
    expect(digestStudyAnalysisInput(input)).not.toBe(input.inputDigest);
    const artifact = syntheticArtifact();
    expect(validateStudyAnalysisArtifact(artifact)).toEqual(artifact);
    artifact.config.model = "changed-reviewer";
    expect(() => validateStudyAnalysisArtifact(artifact)).toThrow("ANALYSIS_DIGEST_INVALID");
  });
  it("keeps failed and partial execution separate from completed findings", () => {
    const artifact = syntheticArtifact();
    artifact.status = "failed";
    expect(() => validateStudyAnalysisArtifact(artifact)).toThrow("ANALYSIS_STATUS_INVALID");
    artifact.result = null; artifact.error = "analysis_provider_failed";
    expect(validateStudyAnalysisArtifact(artifact).status).toBe("failed");
    const partial = syntheticArtifact();
    partial.status = "partial"; partial.error = "analysis_admission_estimate_exceeded";
    expect(validateStudyAnalysisArtifact(partial).result).not.toBeNull();
  });
  it("requires amended corrections to carry replacement text", () => {
    const correction = { schema: "humanish.study-analysis-correction.v1", id: "correction-1", analysisId: "analysis-1",
      analysisSha256: "a".repeat(64), findingId: "finding-1", findingSha256: "b".repeat(64),
      createdAt: "2026-09-01T00:03:00Z", status: "amended", reason: "The claim needs qualification.", replacementClaim: null };
    expect(() => validateStudyAnalysisCorrection(correction)).toThrow("ANALYSIS_CORRECTION_INVALID");
    expect(validateStudyAnalysisCorrection({ ...correction, replacementClaim: "An obstacle was observed." }).status).toBe("amended");
  });
});
