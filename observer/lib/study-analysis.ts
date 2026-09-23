import { validCodexAnalysisConfig } from "../../src/study-analysis-codex-config";
import type { StudyAnalysisConfig } from "../../src/study-analysis";
import type { LoadedStudyAnalysis, StudyAnalysisArtifact, StudyAnalysisCorrection } from "../../src/study-analysis";
import { traceItems } from "./artifact-href";
import type { ObserverData } from "./observer-data";
import { participantLabels } from "./participant-label";
import { type StudyReport } from "./study-report";
import { parseAutomaticAnalysis } from "./automatic-analysis";
import { buildPlayerModel } from "./player-model";

export type { LoadedStudyAnalysis } from "../../src/study-analysis";
export const STUDY_ANALYSIS_SCHEMA = "humanish.study-analysis.v1";
export const STUDY_ANALYSIS_PLACEHOLDER = ["__HUMANISH", "STUDY_ANALYSIS__"].join("_");
export const NO_ANALYSIS: LoadedStudyAnalysis = { state: "none", analysis: null, corrections: [], warnings: [] };
const invalid = (): LoadedStudyAnalysis => ({ state: "invalid", analysis: null, corrections: [], warnings: ["The saved analysis could not be read. Participant evidence is still available."] });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 32_000;
const id = (v: unknown): v is string => text(v) && v.length > 0 && v.length <= 256;
const list = (v: unknown, check: (x: unknown) => boolean, max = 1000): boolean => Array.isArray(v) && v.length <= max && v.every(check);
const strings = (v: Record<string, unknown>, keys: string[]) => keys.every((key) => text(v[key]));
const enumeration = (v: unknown, values: string[]) => typeof v === "string" && values.includes(v);
const ids = (v: unknown) => list(v, id) && new Set(v as string[]).size === (v as string[]).length;
const nullableText = (v: unknown) => v === null || text(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const nullableNumber = (v: unknown) => v === null || number(v);
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const quote = (v: unknown) => object(v) && id(v.evidenceId) && text(v.text);
const observation = (v: unknown) => object(v) && strings(v, ["claim", "limitation"])
  && enumeration(v.basis, ["visual", "action", "participant_statement", "inference"]) && ids(v.evidenceIds);
const concernReview = (v: unknown) => object(v) && observation(v) && text(v.reason)
  && enumeration(v.disposition, ["finding", "context", "unsupported"]) && (v.findingId === null || id(v.findingId));
const participant = (v: unknown) => object(v) && id(v.streamId) && strings(v, ["summary", "intent", "outcomeReason"])
  && enumeration(v.outcome, ["completed", "blocked", "abandoned", "interrupted", "unknown"])
  && ids(v.evidenceIds) && list(v.feedback, quote) && list(v.limitations, text);
const finding = (v: unknown) => object(v) && id(v.id) && strings(v, ["title", "summary", "exposureReason", "nextStep", "priorityReason"])
  && enumeration(v.impact, ["blocked_task", "friction", "recovery", "uncertain"])
  && enumeration(v.recovery, ["recovered", "not_observed", "unknown"]) && enumeration(v.confidence, ["low", "medium", "high"])
  && ids(v.affectedStreamIds) && ids(v.exposedStreamIds) && list(v.observations, observation);
const correction = (v: unknown): v is StudyAnalysisCorrection => object(v) && v.schema === "humanish.study-analysis-correction.v1"
  && id(v.id) && id(v.analysisId) && id(v.findingId) && hash(v.analysisSha256) && hash(v.findingSha256)
  && strings(v, ["createdAt", "reason"]) && nullableText(v.replacementClaim) && enumeration(v.status, ["confirmed", "dismissed", "amended"]);

/** Browser admission protects rendering; the producer owns filesystem/hash verification.
 * Do not reclassify a stale report as current just because its shape is readable. */
export function parseStudyAnalysis(value: unknown, data: ObserverData): LoadedStudyAnalysis {
  const selected = parseSelectedAnalysis(value, data);
  const automatic = parseAutomaticAnalysis(object(value) ? value.automatic : undefined);
  return automatic ? { ...selected, automatic } : selected;
}

function parseSelectedAnalysis(value: unknown, data: ObserverData): LoadedStudyAnalysis {
  if (!object(value) || !enumeration(value.state, ["none", "ready", "stale", "invalid"])
    || !list(value.warnings, text) || !list(value.corrections, correction)) return invalid();
  if (value.analysis === null) return value.state === "none" || value.state === "invalid"
    ? { state: value.state, analysis: null, corrections: [], warnings: value.warnings as string[] } : invalid();
  if (value.state === "none") return invalid();
  const a = value.analysis;
  if (!object(a) || a.schema !== STUDY_ANALYSIS_SCHEMA || !id(a.id) || a.runId !== data.run.runId
    || !(a.captureVersion === undefined || a.captureVersion === 2)
    || !enumeration(a.status, ["complete", "partial", "failed", "cancelled"])
    || !strings(a, ["createdAt", "completedAt", "promptVersion"]) || !enumeration(a.provider, ["openai", "codex"])
    || ![a.sourceRunSha256, a.inputDigest, a.configDigest].every(hash) || !nullableText(a.error)
    || !object(a.config) || !text(a.config.model) || !nullableText(a.config.question)
    || !number(a.config.timeoutMs)
    || (a.provider === "codex" ? !validCodexAnalysisConfig(a.config as unknown as StudyAnalysisConfig)
      : (a.config.provider !== undefined && a.config.provider !== "openai") || ![a.config.maxCostUsd, a.config.maxOutputTokens].every(number))
    || !object(a.usage) || ![a.usage.inputTokens, a.usage.outputTokens, a.usage.estimatedCostUsd, a.usage.estimatedAdmissionUsd].every(nullableNumber)
    || typeof a.usage.usageComplete !== "boolean" || typeof a.usage.dispatched !== "boolean" || !nullableText(a.usage.ratesAsOf)
    || !object(a.coverage) || !ids(a.coverage.includedStreamIds) || !ids(a.coverage.omittedStreamIds)
    || ![a.coverage.evidenceCount, a.coverage.captureCount].every(number) || typeof a.coverage.complete !== "boolean" || !list(a.coverage.omissions, text)
    || !list(a.evidence, (e) => object(e) && id(e.id) && id(e.streamId) && id(e.eventId) && strings(e, ["kind", "text"])
      && typeof e.quoteEligible === "boolean" && nullableText(e.at) && nullableNumber(e.elapsedMs)
      && (e.frame === null || (number(e.frame) && Number.isInteger(e.frame)))
      && (e.capture === null || (object(e.capture) && id(e.capture.eventId) && text(e.capture.path) && hash(e.capture.sha256)
        && enumeration(e.capture.mimeType, ["image/png", "image/jpeg", "image/webp"]))), 10_000)
    || !(a.result === null || (object(a.result) && text(a.result.summary) && list(a.result.participants, participant)
      && list(a.result.findings, finding, 100) && list(a.result.limitations, text)
      && (a.result.concernReviews === undefined || list(a.result.concernReviews, concernReview, 60))))) return invalid();
  if (a.provider === "codex" && (a.usage.estimatedCostUsd !== null || a.usage.estimatedAdmissionUsd !== null || a.usage.ratesAsOf !== null)) return invalid();
  if ((a.status === "complete" || a.status === "partial") && a.result === null) return invalid();
  // A failed latest attempt is a valid artifact under the store's invalid
  // selection state. Preserve that terminal status without admitting claims.
  const terminal = a.status === "failed" || a.status === "cancelled";
  if ((value.state === "invalid" && !terminal) || (terminal && a.result !== null)) return invalid();
  const analysis = a as unknown as StudyAnalysisArtifact;
  const streams = new Set(data.streams.map((s) => s.id));
  const evidence = new Map(analysis.evidence.map((e) => [e.id, e]));
  const included = analysis.coverage.includedStreamIds;
  const omitted = analysis.coverage.omittedStreamIds;
  if (evidence.size !== analysis.evidence.length || included.some((s) => omitted.includes(s))) return invalid();
  // A stale analysis may name a participant that is no longer in this source.
  // Preserve its claim; resolution against current data disables that evidence.
  if (value.state !== "stale" && [...included, ...omitted].some((s) => !streams.has(s))) return invalid();
  if (analysis.evidence.some((e) => !included.includes(e.streamId))) return invalid();
  // Link addresses come from the current evidence, never the manifest's stored path.
  // Stale reports remain readable, but missing references render as unavailable.
  const recordedIds = new Map(data.streams.map((stream) => [stream.id, new Set([...traceItems(stream).map((item) => item.id), ...stream.timeline.map((event) => event.id)])]));
  if (value.state === "ready" && analysis.evidence.some((e) => !recordedIds.get(e.streamId)?.has(e.eventId))) return invalid();
  const result = analysis.result;
  if (result) {
    if (new Set(result.findings.map((f) => f.id)).size !== result.findings.length
      || new Set(result.participants.map((p) => p.streamId)).size !== result.participants.length) return invalid();
    for (const p of result.participants) {
      if (!included.includes(p.streamId) || p.evidenceIds.some((key) => evidence.get(key)?.streamId !== p.streamId)
        || p.feedback.some((q) => { const e = evidence.get(q.evidenceId); return !e?.quoteEligible || e.streamId !== p.streamId || !q.text || !e.text.includes(q.text); })) return invalid();
    }
    for (const f of result.findings) {
      if (!f.observations.length || !f.affectedStreamIds.length || f.exposedStreamIds.some((s) => !included.includes(s))
        || f.affectedStreamIds.some((s) => !f.exposedStreamIds.includes(s))
        || f.observations.some((o) => !o.evidenceIds.length || o.evidenceIds.some((key) => !evidence.has(key)))) return invalid();
    }
    for (const review of result.concernReviews ?? []) {
      const refs = review.evidenceIds.map(key => evidence.get(key));
      if (!refs.length || refs.some(ref => !ref)) return invalid();
      if (review.basis === "visual" && !refs.some(ref => ref?.capture)) return invalid();
      if (review.basis === "participant_statement" && refs.some(ref => !ref?.quoteEligible)) return invalid();
      if (review.basis === "action" && !refs.some(ref => ref && ["ui_action", "command", "tool_call", "file_change", "approval"].includes(ref.kind))) return invalid();
      const matched = result.findings.find(f => f.id === review.findingId);
      if (review.disposition === "finding" ? !matched || refs.some(ref => ref && !matched.exposedStreamIds.includes(ref.streamId)) : review.findingId !== null) return invalid();
    }
  }
  const corrections = (value.corrections as StudyAnalysisCorrection[]).filter((c) => c.analysisId === analysis.id && result?.findings.some((f) => f.id === c.findingId));
  return { state: value.state as LoadedStudyAnalysis["state"], analysis, corrections, warnings: value.warnings as string[] };
}

export function readInlineStudyAnalysis(doc: Document, data: ObserverData | null): LoadedStudyAnalysis {
  if (!data) return NO_ANALYSIS;
  const value = doc.getElementById("study-analysis")?.textContent?.trim();
  if (!value || value === "null" || value === STUDY_ANALYSIS_PLACEHOLDER) return NO_ANALYSIS;
  if (value.length > 8_000_000) return invalid();
  try { return parseStudyAnalysis(JSON.parse(value), data); } catch { return invalid(); }
}

export async function fetchStudyAnalysis(fetchImpl: typeof fetch, data: ObserverData, signal: AbortSignal): Promise<LoadedStudyAnalysis | null> {
  try {
    const response = await fetchImpl("study-analysis.json", { signal, cache: "no-store" });
    if (response.status === 404) return NO_ANALYSIS;
    if (!response.ok) return null;
    const maxBytes = 8_000_000;
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > maxBytes) { await response.body?.cancel(); return invalid(); }
    const reader = response.body?.getReader();
    if (!reader) return invalid();
    const decoder = new TextDecoder();
    let bytes = 0, value = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); return invalid(); }
        value += decoder.decode(chunk.value, { stream: true });
      }
      value += decoder.decode();
    } finally { reader.releaseLock(); }
    return parseStudyAnalysis(JSON.parse(value), data);
  } catch { return null; }
}

const impact = { blocked_task: "Task blocked", friction: "Friction", recovery: "Recovered", uncertain: "Uncertain" };
const outcomeLabel = (outcome: string) => outcome.charAt(0).toUpperCase() + outcome.slice(1);
export function projectStudyAnalysis(loaded: LoadedStudyAnalysis, data: ObserverData): StudyReport | undefined {
  if (loaded.state === "none") return undefined;
  const a = loaded.analysis, result = a?.result;
  const labels = participantLabels(data.streams);
  const evidence = new Map(a?.evidence.map((e) => [e.id, e]) ?? []);
  const state = loaded.state === "ready" || (loaded.state === "invalid" && (a?.status === "failed" || a?.status === "cancelled")) ? a?.status ?? "invalid" : loaded.state;
  return { id: a?.id ?? "unavailable", runId: data.run.runId, state,
    admissionExceeded: a?.error === "analysis_admission_estimate_exceeded",
    summary: result?.summary ?? "", scope: a ? `${a.coverage.includedStreamIds.length} of ${data.streams.length} participants included` : "",
    ...(a && result ? { overview: {
      includedParticipants: a.coverage.includedStreamIds.length,
      // A changed recording is not the denominator of an older analysis.
      totalParticipants: loaded.state === "ready" ? data.streams.length : null,
      sampledCaptures: a.coverage.captureCount,
      totalCaptures: loaded.state === "ready" ? data.streams.reduce((count, stream) => count + (buildPlayerModel(stream)?.frames.length ?? 0), 0) : null,
      outcomes: loaded.state === "ready" ? ["completed", "blocked", "abandoned", "interrupted", "unknown"].flatMap(outcome => {
        const count = result.participants.filter(participant => participant.outcome === outcome).length;
        return count ? [{ label: outcomeLabel(outcome), count }] : [];
      }) : [],
    } } : {}),
    messages: [...new Set([...loaded.warnings, ...(a?.coverage.omissions ?? []), ...(result?.limitations ?? [])])],
    findings: result?.findings.map((f) => {
      const cited = new Set(f.observations.flatMap((o) => o.evidenceIds));
      const moments = [...cited].flatMap((key) => {
        const e = evidence.get(key), observations = f.observations.filter((o) => o.evidenceIds.includes(key));
        return e ? [{ streamId: e.streamId, eventId: e.eventId, label: e.kind === "screenshot" ? "Recorded capture" : e.kind === "reasoning" ? "Reported thinking" : "Recorded evidence",
          note: (observations.find(o => o.basis === "visual") ?? observations[0])!.claim,
          bases: [...new Set(observations.map((o) => o.basis))],
          observationCount: new Set(observations.filter(o => o.basis === "visual" || o.basis === "action").map(o => JSON.stringify([o.basis, o.claim]))).size }] : [];
      });
      const accounts = result.participants.filter((p) => f.affectedStreamIds.includes(p.streamId)).flatMap((p) => p.feedback.filter((q) => cited.has(q.evidenceId)).map((q) => ({ text: q.text, label: labels.get(p.streamId) ?? p.streamId, streamId: p.streamId, eventId: evidence.get(q.evidenceId)!.eventId })));
      return { id: f.id, title: f.title, impact: impact[f.impact], summary: f.summary,
        scope: `${f.affectedStreamIds.length} of ${f.exposedStreamIds.length} exposed participants affected`,
        limitation: [...new Set(f.observations.map((o) => o.limitation).filter(Boolean)), `Exposure: ${f.exposureReason}`, `Recovery: ${f.recovery === "not_observed" ? "not observed" : f.recovery}. Confidence: ${f.confidence}.`].join(" "),
        assessment: { confidence: f.confidence, recovery: f.recovery === "not_observed" ? "Not observed" : outcomeLabel(f.recovery),
          exposureReason: f.exposureReason, limitations: [...new Set(f.observations.map(o => o.limitation).filter(Boolean))] },
        nextStep: f.nextStep, priorityReason: f.priorityReason, account: "", accountSource: "", accounts, observations: f.observations.map(({ claim, basis, limitation }) => ({ claim, basis, limitation })), moments,
        corrections: loaded.corrections.filter((c) => c.findingId === f.id).map((c) => ({ status: c.status, reason: c.reason, replacementClaim: c.replacementClaim, createdAt: c.createdAt })) };
    }) ?? [],
    outcomes: loaded.state === "ready" ? result?.participants.map((p) => ({ streamId: p.streamId, label: outcomeLabel(p.outcome) })) ?? [] : [],
    participants: result?.participants.map((p) => ({ streamId: p.streamId, summary: p.summary, intent: p.intent, outcome: outcomeLabel(p.outcome), outcomeReason: p.outcomeReason,
      limitations: p.limitations, stale: loaded.state === "stale", moments: p.evidenceIds.flatMap((key) => { const e = evidence.get(key); return e ? [{ eventId: e.eventId, label: e.kind === "screenshot" ? "Recorded capture" : e.kind === "reasoning" ? "Reported thinking" : "Recorded evidence", elapsedMs: e.elapsedMs, at: e.at, text: e.text }] : []; }) })) ?? [],
    ...(result?.concernReviews === undefined ? {} : { concernReviews: result.concernReviews.map(({ evidenceIds, ...review }) => ({ ...review,
      moments: evidenceIds.flatMap(key => { const e = evidence.get(key); return e ? [{ streamId: e.streamId, eventId: e.eventId }] : []; }) })) }),
    methodology: a ? [`Analysis ${a.id} · ${a.status} · ${a.completedAt}`, `Model ${a.config.model} · ${a.promptVersion}`,
      ...(a.config.provider === "codex" ? [`Qualified Codex account profile · ${a.config.identity.reasoningEffort} effort · CLI ${a.config.identity.cliVersion} · ${a.config.identity.toolPolicy}. Remote inference; dollar cost and output-token ceiling unknown.`,
        `Observed token usage ${a.usage.usageComplete ? "complete" : "incomplete"}: ${a.usage.inputTokens ?? "unknown"} input, ${a.usage.outputTokens ?? "unknown"} output.`] : ["OpenAI API analysis · high reasoning effort."]), `Included ${a.coverage.evidenceCount} evidence entries and ${a.coverage.captureCount} captures. ${a.coverage.complete ? "Declared coverage complete." : "Coverage incomplete."}`,
      "This independent interpretation does not change the participant account or recorded completion evidence.", ...(a.config.question ? [`Additional review question: ${a.config.question}`] : [])] : [] };
}
