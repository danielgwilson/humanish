import type {
  ActorStatus,
  ActorCompletionReason,
  ActorStopCause,
  ParticipantDeclaredOutcome,
} from "../actors/contract.js";
import type { CuaGoalSource } from "../actors/goal-source.js";
import type { AutomaticAnalysisView } from "./job.js";
import type { RunAnalysisCost } from "../run/run-cost.js";

/** Independent interpretation of retained evidence; never a participant or harness verdict. */
export const ANALYSIS_SCHEMA = "humanish.study-analysis.v1" as const;
export const ANALYSIS_CORRECTION_SCHEMA = "humanish.study-analysis-correction.v1" as const;
/**
 * Capture mapping version 2: it also maps each scripted action's own screenshot. An artifact without
 * captureVersion uses the original screenshot-only mapping. A different mapping needs a new version,
 * because saved v2 artifacts are validated against this one.
 */
export const ACTION_CAPTURE_VERSION = 2 as const;
export type CaptureVersion = typeof ACTION_CAPTURE_VERSION;
/** Run, analysis, correction and attempt ids: safe as one path segment. */
export const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
type AnalysisStatus = "complete" | "partial" | "failed" | "cancelled";
type AnalysisOutcome = "completed" | "blocked" | "abandoned" | "interrupted" | "unknown";
type AnalysisBasis = "visual" | "action" | "participant_statement" | "inference";

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
  capture: {
    eventId: string;
    path: string;
    sha256: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
  } | null;
}
interface AnalysisCoverage {
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
    taskOutcomes: Array<{
      taskId: string;
      completed: boolean;
      observable: boolean;
      inputsObserved: boolean | null;
      turn: number | null;
    }> | null;
  };
}
export interface AnalysisInput {
  runId: string;
  sourceRunSha256: string;
  inputDigest: string;
  /** Absent selects the original capture mapping for historical artifact validation. */
  captureVersion?: CaptureVersion;
  participants: AnalysisParticipantInput[];
  coverage: AnalysisCoverage;
  evidence: AnalysisEvidence[];
  /** Ephemeral input only: never persisted in the analysis artifact. */
  images: { evidenceId: string; dataUrl: string }[];
}
interface AnalysisQuote {
  evidenceId: string;
  text: string;
}
interface AnalysisParticipantReview {
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
interface AnalysisFinding {
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
/** Evidence-grounded disposition of a material concern, not model reasoning. */
interface AnalysisConcernReview extends AnalysisObservation {
  disposition: "finding" | "context" | "unsupported";
  findingId: string | null;
  reason: string;
}
export interface AnalysisResult {
  summary: string;
  participants: AnalysisParticipantReview[];
  /** Absent in older reports. New analyses account for material exclusions as well as findings. */
  concernReviews?: AnalysisConcernReview[];
  /** Highest priority first; counts are derived from distinct stream sets. */
  findings: AnalysisFinding[];
  limitations: string[];
}
interface OpenAIAnalysisConfig {
  provider?: "openai" | undefined;
  model: string;
  question: string | null;
  maxCostUsd: number;
  timeoutMs: number;
  maxOutputTokens: number;
}
/** Required, qualified execution profile, confirmed by the launcher before a turn.
 * A failed pre-dispatch artifact does not prove this CLI/model was observed.
 * These settings participate in cache and immutable attempt identity. */
export interface CodexAnalysisIdentity {
  transport: "codex-app-server";
  authentication: "chatgpt-account";
  billing: "account-unknown";
  requestedModel: string;
  resolvedModel: string;
  reasoningEffort: "low";
  toolPolicy: string;
  cliVersion: string;
}
export interface CodexAnalysisConfig {
  provider: "codex";
  model: string;
  question: string | null;
  maxCostUsd: null;
  timeoutMs: number;
  maxOutputTokens: null;
  identity: CodexAnalysisIdentity;
}
/** Omitted provider remains the historical OpenAI API contract, including its exact hash. */
export type AnalysisConfig = OpenAIAnalysisConfig | CodexAnalysisConfig;
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
export interface AnalysisArtifact {
  schema: typeof ANALYSIS_SCHEMA;
  id: string;
  runId: string;
  status: AnalysisStatus;
  createdAt: string;
  completedAt: string;
  sourceRunSha256: string;
  inputDigest: string;
  captureVersion?: CaptureVersion;
  configDigest: string;
  config: AnalysisConfig;
  promptVersion: string;
  provider: "openai" | "codex";
  usage: AnalysisUsage;
  participants: AnalysisParticipantInput[];
  coverage: AnalysisCoverage;
  evidence: AnalysisEvidence[];
  result: AnalysisResult | null;
  /** Safe stable failure code, never a provider error payload. */
  error: string | null;
}
export interface AnalysisCorrection {
  schema: typeof ANALYSIS_CORRECTION_SCHEMA;
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
export interface LoadedAnalysis {
  state: "none" | "ready" | "stale" | "invalid";
  analysis: AnalysisArtifact | null;
  corrections: AnalysisCorrection[];
  warnings: string[];
  /** Independent post-run execution metadata; never changes evidence sharing grades. */
  automatic?: AutomaticAnalysisView;
  /**
   * What the run's analysis requests cost, every attempt counted once (src/run/costs.ts
   * readAnalysisAccounting, the reader stats uses). Absent when the run sent none.
   */
  spend?: RunAnalysisCost;
}
