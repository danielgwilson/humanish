import type { ActorStatus, ActorCompletionReason, ActorStopCause, ParticipantDeclaredOutcome } from "./actor-contract.js";
import type { CuaGoalSource } from "./actor-goal-source.js";
import type { AutomaticStudyAnalysisView } from "./study-analysis-job.js";

/** Independent interpretation of retained evidence; never a participant or harness verdict. */
export const STUDY_ANALYSIS_SCHEMA = "humanish.study-analysis.v1" as const;
export const STUDY_ANALYSIS_CORRECTION_SCHEMA = "humanish.study-analysis-correction.v1" as const;
export type AnalysisStatus = "complete" | "partial" | "failed" | "cancelled";
export type AnalysisOutcome = "completed" | "blocked" | "abandoned" | "interrupted" | "unknown";
export type AnalysisBasis = "visual" | "action" | "participant_statement" | "inference";

export interface AnalysisEvidence {
  /** Opaque packet-local key; model output never supplies a filesystem path. */
  id: string;
  streamId: string;
  eventId: string;
  kind: string;
  text: string;
  quoteEligible: boolean;
  at: string | null;
  /** Relative to first retained capture, not a video offset; null for nonvisual evidence. */
  elapsedMs: number | null;
  frame: number | null;
  capture: { eventId: string; path: string; sha256: string; mimeType: "image/png" | "image/jpeg" | "image/webp" } | null;
}
export interface AnalysisCoverage {
  includedStreamIds: string[];
  omittedStreamIds: string[];
  evidenceCount: number;
  captureCount: number;
  complete: boolean;
  omissions: string[];
}
export interface AnalysisParticipantInput {
  streamId: string;
  label: string;
  assignment: string | null;
  recordedStatus: string;
  recordedReason: string | null;
  provenance: {
    actorStatus: ActorStatus | null;
    completionReason: ActorCompletionReason | null;
    stopCause: ActorStopCause | null;
    goalSource: CuaGoalSource | null;
    declaredOutcome: ParticipantDeclaredOutcome | null;
    taskOutcomes: Array<{ taskId: string; completed: boolean; observable: boolean; inputsObserved: boolean | null; turn: number | null }> | null;
  };
}
export interface StudyAnalysisInput {
  runId: string;
  sourceRunSha256: string;
  inputDigest: string;
  participants: AnalysisParticipantInput[];
  coverage: AnalysisCoverage;
  evidence: AnalysisEvidence[];
  /** Ephemeral input only: never persisted in the analysis artifact. */
  images: { evidenceId: string; dataUrl: string }[];
}
export interface AnalysisQuote { evidenceId: string; text: string }
export interface AnalysisParticipantReview {
  streamId: string;
  summary: string;
  intent: string;
  outcome: AnalysisOutcome;
  outcomeReason: string;
  evidenceIds: string[];
  feedback: AnalysisQuote[];
  limitations: string[];
}
export interface AnalysisObservation {
  claim: string;
  basis: AnalysisBasis;
  evidenceIds: string[];
  limitation: string;
}
export interface AnalysisFinding {
  id: string;
  title: string;
  summary: string;
  impact: "blocked_task" | "friction" | "recovery" | "uncertain";
  affectedStreamIds: string[];
  exposedStreamIds: string[];
  exposureReason: string;
  recovery: "recovered" | "not_observed" | "unknown";
  confidence: "low" | "medium" | "high";
  observations: AnalysisObservation[];
  nextStep: string;
  priorityReason: string;
}
export interface StudyAnalysisResult {
  summary: string;
  participants: AnalysisParticipantReview[];
  /** Highest priority first; counts are derived from distinct stream sets. */
  findings: AnalysisFinding[];
  limitations: string[];
}
export interface StudyAnalysisConfig {
  model: string;
  question: string | null;
  maxCostUsd: number;
  timeoutMs: number;
  maxOutputTokens: number;
}
export interface AnalysisUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  usageComplete: boolean;
  dispatched: boolean;
  ratesAsOf: string | null;
  estimatedAdmissionUsd: number | null;
}
export interface StudyAnalysisArtifact {
  schema: typeof STUDY_ANALYSIS_SCHEMA;
  id: string;
  runId: string;
  status: AnalysisStatus;
  createdAt: string;
  completedAt: string;
  sourceRunSha256: string;
  inputDigest: string;
  configDigest: string;
  config: StudyAnalysisConfig;
  promptVersion: string;
  provider: "openai";
  usage: AnalysisUsage;
  participants: AnalysisParticipantInput[];
  coverage: AnalysisCoverage;
  evidence: AnalysisEvidence[];
  result: StudyAnalysisResult | null;
  /** Safe stable failure code, never a provider error payload. */
  error: string | null;
}
export interface StudyAnalysisCorrection {
  schema: typeof STUDY_ANALYSIS_CORRECTION_SCHEMA;
  id: string;
  analysisId: string;
  analysisSha256: string;
  findingId: string;
  findingSha256: string;
  createdAt: string;
  status: "confirmed" | "dismissed" | "amended";
  reason: string;
  replacementClaim: string | null;
}
export interface LoadedStudyAnalysis {
  state: "none" | "ready" | "stale" | "invalid";
  analysis: StudyAnalysisArtifact | null;
  corrections: StudyAnalysisCorrection[];
  warnings: string[];
  /** Independent post-run execution metadata; never changes evidence sharing grades. */
  automatic?: AutomaticStudyAnalysisView;
}
