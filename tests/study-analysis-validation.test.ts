import { describe, expect, it } from "vitest";
import {
  checkAnalysisResult, digestStudyAnalysisInput, hashStudyAnalysisValue, studyAnalysisResultJsonSchema,
  validateAnalysisResult, validateStudyAnalysisArtifact, validateStudyAnalysisCorrection,
  validateStudyAnalysisInputMetadata, validateStudyAnalysisExecutionReceipt
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
  it("rejects malformed input metadata before a paid request", () => {
    const input = syntheticInput();
    expect(() => validateStudyAnalysisInputMetadata(input)).not.toThrow();
    input.evidence[0]!.kind = "x".repeat(129);
    input.inputDigest = digestStudyAnalysisInput(input);
    expect(() => validateStudyAnalysisInputMetadata(input)).toThrow("ANALYSIS_INPUT_INVALID");
    const duplicate = syntheticInput();
    duplicate.evidence.push({ ...duplicate.evidence[0]!, id: "e000003" });
    duplicate.coverage.evidenceCount++;
    duplicate.inputDigest = digestStudyAnalysisInput(duplicate);
    expect(() => validateStudyAnalysisInputMetadata(duplicate)).toThrow("ANALYSIS_INPUT_INVALID");
  });

  it("requires an action source for observations labeled as actions", () => {
    const result = syntheticResult();
    result.findings[0]!.observations[0]!.basis = "action";
    expect(checkAnalysisResult(syntheticInput(), result)).toMatchObject({ ok: false, errors: ["ANALYSIS_ACTION_SOURCE_INVALID"] });
  });

  it("keeps runtime accounting context from satisfying an action observation", () => {
    const input = syntheticInput();
    const result = syntheticResult(input);
    input.evidence.push({ id: "runtime-context", streamId: input.participants[0]!.streamId,
      eventId: "runtime-accounting", kind: "run_event:runtime.accounted", text: "The harness recorded model usage.",
      quoteEligible: false, at: null, elapsedMs: null, frame: null, capture: null });
    input.coverage.evidenceCount++;
    input.inputDigest = digestStudyAnalysisInput(input);
    const observation = result.findings[0]!.observations[0]!;
    observation.claim = "The harness record describes model usage, not a participant-issued service call.";
    observation.evidenceIds = ["runtime-context"];
    observation.basis = "action";
    expect(checkAnalysisResult(input, result)).toMatchObject({ ok: false, errors: ["ANALYSIS_ACTION_SOURCE_INVALID"] });
    observation.basis = "inference";
    observation.limitation = "The record does not attribute a service call to the participant.";
    expect(checkAnalysisResult(input, result).ok).toBe(true);
  });

  it("does not accept invented complete usage in a standalone accounting receipt", () => {
    const artifact = syntheticArtifact();
    const { config: _config, participants: _participants, evidence: _evidence, coverage: _coverage,
      result: _result, ...metadata } = artifact;
    const receipt = { ...metadata, schema: "humanish.analysis-execution.v1", model: artifact.config.model,
      maxCostUsd: artifact.config.maxCostUsd, usage: { ...artifact.usage, inputTokens: null } };
    expect(() => validateStudyAnalysisExecutionReceipt(receipt)).toThrow("ANALYSIS_USAGE_INVALID");
  });


  it("bounds and validates task provenance before dispatch", () => {
    for (const tasks of [
      [{ taskId: "task-1", completed: false, observable: true, inputsObserved: null, turn: -1 }],
      Array.from({ length: 129 }, (_, index) => ({ taskId: `task-${index}`, completed: false, observable: true, inputsObserved: null, turn: null })),
      Array.from({ length: 2 }, () => ({ taskId: "duplicate", completed: false, observable: true, inputsObserved: null, turn: null }))
    ]) {
      const input = syntheticInput();
      input.participants[0]!.provenance.taskOutcomes = tasks;
      input.inputDigest = digestStudyAnalysisInput(input);
      expect(() => validateStudyAnalysisInputMetadata(input)).toThrow("ANALYSIS_INPUT_INVALID");
    }
  });

});
