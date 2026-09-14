import { createHash } from "node:crypto";
import { z } from "zod";

import {
  STUDY_ANALYSIS_SCHEMA,
  STUDY_ANALYSIS_CORRECTION_SCHEMA,
  type StudyAnalysisArtifact,
  type StudyAnalysisCorrection,
  type StudyAnalysisInput,
  type StudyAnalysisResult
} from "./study-analysis.js";

const text = (max: number) => z.string().max(max).refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), "Invalid text.");
const label = text(240).min(1);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const sourceId = text(256).min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const sourceIds = z.array(sourceId).max(128);
const refs = z.array(id).min(1).max(100);
const limitations = z.array(text(2000).min(1)).max(100);

export const studyAnalysisResultSchema = z.object({
  summary: text(4000).min(1),
  participants: z.array(z.object({
    streamId: sourceId,
    summary: text(4000).min(1),
    intent: text(2000).min(1),
    outcome: z.enum(["completed", "blocked", "abandoned", "interrupted", "unknown"]),
    outcomeReason: text(2000).min(1),
    evidenceIds: z.array(id).max(100),
    feedback: z.array(z.object({ evidenceId: id, text: text(4000).min(1) }).strict()).max(20),
    limitations
  }).strict()).max(128),
  findings: z.array(z.object({
    id,
    title: label,
    summary: text(4000).min(1),
    impact: z.enum(["blocked_task", "friction", "recovery", "uncertain"]),
    affectedStreamIds: sourceIds.min(1),
    exposedStreamIds: sourceIds.min(1),
    exposureReason: text(2000).min(1),
    recovery: z.enum(["recovered", "not_observed", "unknown"]),
    confidence: z.enum(["low", "medium", "high"]),
    observations: z.array(z.object({
      claim: text(2000).min(1),
      basis: z.enum(["visual", "action", "participant_statement", "inference"]),
      evidenceIds: refs,
      limitation: text(2000)
    }).strict()).min(1).max(30),
    nextStep: text(2000).min(1),
    priorityReason: text(2000).min(1)
  }).strict()).max(100),
  limitations
}).strict();

export const studyAnalysisResultJsonSchema = z.toJSONSchema(studyAnalysisResultSchema);

export const studyAnalysisCoverageSchema = z.object({
  includedStreamIds: sourceIds,
  omittedStreamIds: sourceIds,
  evidenceCount: z.number().int().min(0).max(2000),
  captureCount: z.number().int().min(0).max(64),
  complete: z.boolean(),
  omissions: limitations
}).strict();

const artifactPath = z.string().min(1).max(1024).refine((value) =>
  !/[\\:\x00-\x1f\x7f]/.test(value)
  && !value.startsWith("/")
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Invalid evidence path.");

export const studyAnalysisEvidenceSchema = z.object({
  id,
  streamId: sourceId,
  eventId: sourceId,
  kind: text(128).min(1),
  text: text(16000),
  quoteEligible: z.boolean(),
  at: timestamp.nullable(),
  elapsedMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  frame: z.number().int().min(0).max(100000).nullable(),
  capture: z.object({
    eventId: sourceId,
    path: artifactPath,
    sha256: digest,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"])
  }).strict().nullable()
}).strict();

export const studyAnalysisArtifactSchema = z.object({
  schema: z.literal(STUDY_ANALYSIS_SCHEMA),
  id,
  runId: sourceId,
  status: z.enum(["complete", "partial", "failed", "cancelled"]),
  createdAt: timestamp,
  completedAt: timestamp,
  sourceRunSha256: digest,
  inputDigest: digest,
  configDigest: digest,
  config: z.object({
    model: label,
    question: text(4000).nullable(),
    maxCostUsd: z.number().positive().max(1000),
    timeoutMs: z.number().int().positive().max(3600000),
    maxOutputTokens: z.number().int().positive().max(128000)
  }).strict(),
  promptVersion: label,
  provider: z.literal("openai"),
  usage: z.object({
    cacheWriteInputTokens: z.number().int().min(0).max(1e12).nullable(),
    cachedInputTokens: z.number().int().min(0).max(1e12).nullable(),
    usageComplete: z.boolean(),
    dispatched: z.boolean(),
    ratesAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    estimatedAdmissionUsd: z.number().min(0).max(1e9).nullable(),
    inputTokens: z.number().int().min(0).max(1e12).nullable(),
    outputTokens: z.number().int().min(0).max(1e12).nullable(),
    estimatedCostUsd: z.number().min(0).max(1e9).nullable()
  }).strict(),
  participants: z.array(z.object({
    streamId: sourceId,
    label: text(1000),
    assignment: text(8000).nullable(),
    recordedStatus: text(128).min(1),
    recordedReason: text(4000).nullable()
  }).strict()).max(128),
  coverage: studyAnalysisCoverageSchema,
  evidence: z.array(studyAnalysisEvidenceSchema).max(2000),
  result: studyAnalysisResultSchema.nullable(),
  error: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/).nullable()
}).strict();

export const studyAnalysisCorrectionSchema = z.object({
  schema: z.literal(STUDY_ANALYSIS_CORRECTION_SCHEMA),
  id,
  analysisId: id,
  analysisSha256: digest,
  findingId: id,
  findingSha256: digest,
  createdAt: timestamp,
  status: z.enum(["confirmed", "dismissed", "amended"]),
  reason: text(4000).min(1),
  replacementClaim: text(4000).min(1).nullable()
}).strict();

/** Stable hashing is independent of object insertion order and excludes no fields implicitly. */
export function hashStudyAnalysisValue(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]));
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function digestStudyAnalysisInput(input: Pick<StudyAnalysisInput, "runId" | "sourceRunSha256" | "participants" | "coverage" | "evidence">): string {
  return hashStudyAnalysisValue({ runId: input.runId, sourceRunSha256: input.sourceRunSha256,
    participants: input.participants, coverage: input.coverage, evidence: input.evidence });
}

const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length;

export function checkAnalysisResult(input: StudyAnalysisInput, value: unknown):
  { ok: true; result: StudyAnalysisResult } | { ok: false; errors: string[] } {
  const parsed = studyAnalysisResultSchema.safeParse(value);
  if (!parsed.success) return { ok: false, errors: ["ANALYSIS_RESULT_SCHEMA_INVALID"] };
  const result = parsed.data;
  const errors = new Set<string>();
  const included = new Set(input.coverage.includedStreamIds);
  const evidence = new Map(input.evidence.map((entry) => [entry.id, entry]));
  if (!distinct(input.coverage.includedStreamIds) || evidence.size !== input.evidence.length) errors.add("ANALYSIS_INPUT_DUPLICATES");
  if (!distinct(result.participants.map((participant) => participant.streamId))
    || result.participants.length !== included.size
    || result.participants.some((participant) => !included.has(participant.streamId))) errors.add("ANALYSIS_PARTICIPANT_COVERAGE_INVALID");
  for (const participant of result.participants) {
    if (!distinct(participant.evidenceIds) || participant.evidenceIds.some((ref) => evidence.get(ref)?.streamId !== participant.streamId)) {
      errors.add("ANALYSIS_PARTICIPANT_REFERENCE_INVALID");
    }
    if (participant.outcome !== "unknown" && participant.evidenceIds.length === 0) errors.add("ANALYSIS_OUTCOME_WITHOUT_EVIDENCE");
    for (const quote of participant.feedback) {
      const entry = evidence.get(quote.evidenceId);
      if (!entry || entry.streamId !== participant.streamId || !entry.quoteEligible || !entry.text.includes(quote.text)) {
        errors.add("ANALYSIS_QUOTE_INVALID");
      }
    }
  }
  if (!distinct(result.findings.map((finding) => finding.id))) errors.add("ANALYSIS_FINDING_ID_DUPLICATE");
  for (const finding of result.findings) {
    const exposed = new Set(finding.exposedStreamIds);
    if (!distinct(finding.affectedStreamIds) || !distinct(finding.exposedStreamIds)
      || finding.exposedStreamIds.some((stream) => !included.has(stream))
      || finding.affectedStreamIds.some((stream) => !exposed.has(stream))) errors.add("ANALYSIS_FINDING_MEMBERSHIP_INVALID");
    const citedStreams = new Set<string>();
    for (const observation of finding.observations) {
      const refs = observation.evidenceIds.map((ref) => evidence.get(ref));
      if (!distinct(observation.evidenceIds) || refs.some((ref) => !ref || !included.has(ref.streamId))) errors.add("ANALYSIS_OBSERVATION_REFERENCE_INVALID");
      for (const ref of refs) if (ref) citedStreams.add(ref.streamId);
      if (observation.basis === "visual" && !refs.some((ref) => ref?.capture !== null && ref?.capture !== undefined)) errors.add("ANALYSIS_VISUAL_WITHOUT_CAPTURE");
      if (observation.basis === "participant_statement" && refs.some((ref) => !ref?.quoteEligible)) errors.add("ANALYSIS_STATEMENT_SOURCE_INVALID");
    }
    if (finding.affectedStreamIds.some((stream) => !citedStreams.has(stream))) errors.add("ANALYSIS_AFFECTED_WITHOUT_EVIDENCE");
  }
  return errors.size ? { ok: false, errors: [...errors] } : { ok: true, result };
}

export function validateAnalysisResult(input: StudyAnalysisInput, value: unknown): StudyAnalysisResult {
  const checked = checkAnalysisResult(input, value);
  if (!checked.ok) throw new Error(checked.errors.join(", "));
  return checked.result;
}

export function validateStudyAnalysisArtifact(value: unknown): StudyAnalysisArtifact {
  const parsed = studyAnalysisArtifactSchema.safeParse(value);
  if (!parsed.success) throw new Error("ANALYSIS_ARTIFACT_SCHEMA_INVALID");
  const artifact = parsed.data;
  if (artifact.configDigest !== hashStudyAnalysisValue(artifact.config)
    || artifact.inputDigest !== digestStudyAnalysisInput(artifact)) throw new Error("ANALYSIS_DIGEST_INVALID");
  if (Date.parse(artifact.completedAt) < Date.parse(artifact.createdAt)) throw new Error("ANALYSIS_TIME_INVALID");
  const coverage = artifact.coverage;
  const included = new Set(coverage.includedStreamIds);
  const captureIds = new Set(artifact.evidence.filter((entry) => entry.capture !== null)
    .map((entry) => `${entry.streamId}\0${entry.capture!.eventId}`));
  if (!distinct(coverage.includedStreamIds) || !distinct(coverage.omittedStreamIds)
    || coverage.omittedStreamIds.some((stream) => included.has(stream))
    || coverage.evidenceCount !== artifact.evidence.length || coverage.captureCount !== captureIds.size
    || !distinct(artifact.evidence.map((entry) => entry.id))
    || artifact.evidence.some((entry) => !included.has(entry.streamId)
      || (entry.quoteEligible && !["message", "reasoning"].includes(entry.kind))
      || (entry.capture !== null && entry.frame === null))
    || (coverage.complete && (coverage.omittedStreamIds.length > 0 || coverage.omissions.length > 0))) {
    throw new Error("ANALYSIS_COVERAGE_INVALID");
  }
  if (!distinct(artifact.participants.map((participant) => participant.streamId))
    || artifact.participants.length !== included.size
    || artifact.participants.some((participant) => !included.has(participant.streamId))) throw new Error("ANALYSIS_PARTICIPANT_INPUT_INVALID");
  const usage = artifact.usage;
  if ((usage.usageComplete && (usage.inputTokens === null || usage.outputTokens === null))
    || (!usage.dispatched && (usage.inputTokens !== null || usage.outputTokens !== null || usage.cachedInputTokens !== null
      || usage.cacheWriteInputTokens !== null || usage.estimatedCostUsd !== null || usage.usageComplete))
    || ((usage.cachedInputTokens !== null || usage.cacheWriteInputTokens !== null) && (usage.inputTokens === null
      || (usage.cachedInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0) > usage.inputTokens))) {
    throw new Error("ANALYSIS_USAGE_INVALID");
  }
  const hasResult = artifact.status === "complete" || artifact.status === "partial";
  if (hasResult !== (artifact.result !== null)
    || (hasResult && artifact.error !== null && !(artifact.status === "partial" && artifact.error === "analysis_admission_estimate_exceeded"))
    || (!hasResult && artifact.error === null)
    || (artifact.status === "complete" && !coverage.complete)) throw new Error("ANALYSIS_STATUS_INVALID");
  if (artifact.result !== null) validateAnalysisResult({ ...artifact, images: [] }, artifact.result);
  return artifact;
}

export function validateStudyAnalysisCorrection(value: unknown): StudyAnalysisCorrection {
  const parsed = studyAnalysisCorrectionSchema.safeParse(value);
  if (!parsed.success || (parsed.data.status === "amended") !== (parsed.data.replacementClaim !== null)) {
    throw new Error("ANALYSIS_CORRECTION_INVALID");
  }
  return parsed.data;
}
