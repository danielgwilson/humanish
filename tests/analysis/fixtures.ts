import type { AnalysisArtifact, AnalysisInput, AnalysisResult } from "../../src/analysis/types.js";
import { digestAnalysisInput, hashAnalysisValue } from "../../src/analysis/validation.js";

export function syntheticInput(): AnalysisInput {
  const input: AnalysisInput = {
    runId: "synthetic-study",
    sourceRunSha256: "a".repeat(64),
    inputDigest: "",
    participants: [
      {
        streamId: "participant-a",
        label: "Participant A",
        assignment: "Create an item.",
        recordedStatus: "complete",
        recordedReason: "Finished.",
        provenance: {
          actorStatus: null,
          completionReason: null,
          stopCause: null,
          goalSource: null,
          declaredOutcome: null,
          taskOutcomes: null,
        },
      },
    ],
    coverage: {
      includedStreamIds: ["participant-a"],
      omittedStreamIds: [],
      evidenceCount: 2,
      captureCount: 1,
      complete: true,
      omissions: [],
    },
    evidence: [
      {
        id: "e000001",
        streamId: "participant-a",
        eventId: "capture-1",
        kind: "screenshot",
        text: "Capture",
        quoteEligible: false,
        at: null,
        elapsedMs: null,
        frame: 0,
        capture: {
          eventId: "capture-1",
          path: "captures/frame.png",
          sha256: "b".repeat(64),
          mimeType: "image/png",
        },
      },
      {
        id: "e000002",
        streamId: "participant-a",
        eventId: "account-1",
        kind: "message",
        text: "I could not create the item.",
        quoteEligible: true,
        at: null,
        elapsedMs: null,
        frame: 0,
        capture: null,
      },
    ],
    images: [],
  };
  input.inputDigest = digestAnalysisInput(input);
  return input;
}

export function syntheticResult(input = syntheticInput()): AnalysisResult {
  const first = input.coverage.includedStreamIds[0]!;
  const firstEvidence = input.evidence.find((entry) => entry.streamId === first)!;
  const firstCapture = input.evidence.find(
    (entry) => entry.streamId === first && entry.capture !== null,
  );
  return {
    summary: "The participant encountered an obstacle.",
    concernReviews: [],
    participants: input.participants.map((participant) => ({
      streamId: participant.streamId,
      summary: "The participant attempted the assigned task.",
      intent: "Create an item.",
      outcome: "blocked",
      outcomeReason: "The retained evidence shows an obstacle.",
      evidenceIds: input.evidence
        .filter((entry) => entry.streamId === participant.streamId)
        .map((entry) => entry.id),
      feedback: input.evidence
        .filter((entry) => entry.streamId === participant.streamId && entry.quoteEligible)
        .map((entry) => ({ evidenceId: entry.id, text: entry.text })),
      limitations: [],
    })),
    findings: [
      {
        id: "finding-1",
        title: "Item creation was blocked",
        headline: "The participant could not create an item.",
        experience:
          "They were trying to add an item. The create step did not finish, and they said they could not create it.",
        summary: "The participant could not create an item.",
        impact: "blocked_task",
        affectedStreamIds: [first],
        exposedStreamIds: input.coverage.includedStreamIds,
        exposureReason: "The included participants attempted the same task.",
        recovery: "not_observed",
        confidence: "medium",
        observations: [
          {
            claim: "The creation attempt did not produce an item.",
            basis: firstEvidence.capture ? "visual" : "inference",
            evidenceIds: [firstEvidence.id],
            limitation: "This is a synthetic fixture.",
          },
        ],
        nextStep: "Check the create interaction.",
        priorityReason: "The obstacle affected the assigned task.",
      },
    ],
    designFindings: firstCapture
      ? [
          {
            id: "D1",
            headline: "The create button is hard to find.",
            screen: "Item list",
            notice: "The create button is small and sits apart from the list it adds to.",
            whyItMatters: "A person adding an item may not see where to start.",
            suggestion: "Put the create button above the list and give it a text label.",
            severity: "moderate",
            confidence: "medium",
            seenByStreamIds: [first],
            evidenceIds: [firstCapture.id],
          },
        ]
      : [],
    limitations: ["Synthetic fixture; no real product behavior is measured."],
  };
}

export function syntheticArtifact(input = syntheticInput(), id = "analysis-1"): AnalysisArtifact {
  const config = {
    model: "synthetic-reviewer",
    question: null,
    maxCostUsd: 1,
    timeoutMs: 60000,
    maxOutputTokens: 4000,
  };
  return {
    schema: "humanish.study-analysis.v1",
    id,
    runId: input.runId,
    status: input.coverage.complete ? "complete" : "partial",
    createdAt: "2026-09-01T00:01:00.000Z",
    completedAt: "2026-09-01T00:02:00.000Z",
    sourceRunSha256: input.sourceRunSha256,
    inputDigest: input.inputDigest,
    configDigest: hashAnalysisValue(config),
    ...(input.captureVersion === undefined ? {} : { captureVersion: input.captureVersion }),
    config,
    promptVersion: "synthetic-v1",
    provider: "openai",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      usageComplete: true,
      dispatched: true,
      ratesAsOf: null,
      estimatedAdmissionUsd: null,
    },
    participants: input.participants,
    coverage: input.coverage,
    evidence: input.evidence,
    result: syntheticResult(input),
    error: null,
  };
}
