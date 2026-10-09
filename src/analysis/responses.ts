// What the provider responses of one attempt give it: the usage they report, the warnings a Codex
// response carries, and each response checked before it becomes an analysis result (the response
// schema, the scrub of known transient values from generated prose, and the evidence rules in
// validation.ts). Only an allowlisted code leaves a check; the rejected output goes to the caller
// for local diagnosis.

import {
  truncatedFrameWarning,
  unknownNotificationsWarning,
} from "../actors/codex/restricted-notifications.js";
import {
  protocolAdditionsWarning,
  protocolIncompatibilityMessage,
} from "../actors/codex/protocol-compat.js";
import { estimateActorCost } from "../run/pricing.js";
import { transientCommsKnownValueScrub } from "../run/transient-comms-secrets.js";
import type { RejectedAnalysisOutput } from "./diagnostics.js";
import type { AnalysisProviderResult } from "./provider.js";
import type {
  AnalysisArtifact,
  AnalysisConfig,
  AnalysisInput,
  AnalysisObservation,
  AnalysisResult,
} from "./types.js";
import { analysisResponseSchema, checkAnalysisResult } from "./validation.js";

/** Scrub only generated prose. Source evidence, provenance and integrity hashes remain exact. A
 * known value is found as written and in its encoded forms. */
function scrubGeneratedNarrative(result: AnalysisResult): AnalysisResult {
  const scrub = transientCommsKnownValueScrub();
  const observation = <T extends AnalysisObservation>(value: T): T => ({
    ...value,
    claim: scrub(value.claim),
    limitation: scrub(value.limitation),
  });
  // A model can also echo a key as a syntactically valid finding ID. Refuse it without rewriting
  // IDs, references or enums (including accidental collisions); never repair citation structure.
  const structural = [
    ...result.participants.flatMap((value) => [
      value.streamId,
      value.outcome,
      ...value.evidenceIds,
      ...value.feedback.map((quote) => quote.evidenceId),
    ]),
    ...result.findings.flatMap((value) => [
      value.id,
      value.impact,
      value.recovery,
      value.confidence,
      ...value.affectedStreamIds,
      ...value.exposedStreamIds,
      ...value.observations.flatMap((item) => [item.basis, ...item.evidenceIds]),
    ]),
    ...(result.designFindings ?? []).flatMap((value) => [
      value.id,
      value.severity,
      value.confidence,
      ...value.seenByStreamIds,
      ...value.evidenceIds,
    ]),
    ...(result.concernReviews ?? []).flatMap((value) => [
      value.basis,
      value.disposition,
      ...(value.findingId === null ? [] : [value.findingId]),
      ...value.evidenceIds,
    ]),
  ];
  if (structural.some((value) => scrub(value) !== value))
    throw new Error("ANALYSIS_TRANSIENT_SECRET_IN_STRUCTURE");
  return {
    ...result,
    summary: scrub(result.summary),
    limitations: result.limitations.map(scrub),
    participants: result.participants.map((value) => ({
      ...value,
      summary: scrub(value.summary),
      intent: scrub(value.intent),
      outcomeReason: scrub(value.outcomeReason),
      limitations: value.limitations.map(scrub),
      feedback: value.feedback.map((quote) => ({ ...quote, text: scrub(quote.text) })),
    })),
    findings: result.findings.map((value) => ({
      ...value,
      title: scrub(value.title),
      ...(value.headline === undefined ? {} : { headline: scrub(value.headline) }),
      ...(value.experience === undefined ? {} : { experience: scrub(value.experience) }),
      summary: scrub(value.summary),
      exposureReason: scrub(value.exposureReason),
      nextStep: scrub(value.nextStep),
      priorityReason: scrub(value.priorityReason),
      observations: value.observations.map(observation),
    })),
    ...(result.designFindings === undefined
      ? {}
      : {
          designFindings: result.designFindings.map((value) => ({
            ...value,
            headline: scrub(value.headline),
            screen: scrub(value.screen),
            notice: scrub(value.notice),
            whyItMatters: scrub(value.whyItMatters),
            suggestion: scrub(value.suggestion),
          })),
        }),
    ...(result.concernReviews === undefined
      ? {}
      : {
          concernReviews: result.concernReviews.map((value) => ({
            ...observation(value),
            reason: scrub(value.reason),
          })),
        }),
  };
}

const VALIDATION_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  ANALYSIS_RESULT_SCHEMA_INVALID: "analysis_validation_failed_schema_invalid",
  ANALYSIS_DESIGN_FINDING_ID_DUPLICATE: "analysis_validation_failed_design_finding_id_duplicate",
  ANALYSIS_DESIGN_REFERENCE_INVALID: "analysis_validation_failed_design_reference_invalid",
  ANALYSIS_DESIGN_WITHOUT_CAPTURE: "analysis_validation_failed_design_without_capture",
  ANALYSIS_DESIGN_MEMBERSHIP_INVALID: "analysis_validation_failed_design_membership_invalid",
  ANALYSIS_INPUT_DUPLICATES: "analysis_validation_failed_input_duplicates",
  ANALYSIS_PARTICIPANT_COVERAGE_INVALID: "analysis_validation_failed_participant_coverage_invalid",
  ANALYSIS_PARTICIPANT_REFERENCE_INVALID:
    "analysis_validation_failed_participant_reference_invalid",
  ANALYSIS_OUTCOME_WITHOUT_EVIDENCE: "analysis_validation_failed_outcome_without_evidence",
  ANALYSIS_QUOTE_INVALID: "analysis_validation_failed_quote_invalid",
  ANALYSIS_FINDING_ID_DUPLICATE: "analysis_validation_failed_finding_id_duplicate",
  ANALYSIS_OBSERVATION_REFERENCE_INVALID:
    "analysis_validation_failed_observation_reference_invalid",
  ANALYSIS_VISUAL_WITHOUT_CAPTURE: "analysis_validation_failed_visual_without_capture",
  ANALYSIS_ACTION_SOURCE_INVALID: "analysis_validation_failed_action_source_invalid",
  ANALYSIS_STATEMENT_SOURCE_INVALID: "analysis_validation_failed_statement_source_invalid",
  ANALYSIS_FINDING_MEMBERSHIP_INVALID: "analysis_validation_failed_finding_membership_invalid",
  ANALYSIS_AFFECTED_WITHOUT_EVIDENCE: "analysis_validation_failed_affected_without_evidence",
  ANALYSIS_CONCERN_FINDING_INVALID: "analysis_validation_failed_concern_finding_invalid",
});

export type CheckedProviderAnalysis =
  | { ok: true; result: AnalysisResult }
  | { ok: false; error: string; rejected?: RejectedAnalysisOutput };

export function checkProviderAnalysis(
  input: AnalysisInput,
  value: unknown,
): CheckedProviderAnalysis {
  try {
    const parsed = analysisResponseSchema.safeParse(value);
    if (!parsed.success) {
      const error = VALIDATION_FAILURES.ANALYSIS_RESULT_SCHEMA_INVALID!;
      return { ok: false, error, rejected: { error, errors: [], output: value } };
    }
    let scrubbed: AnalysisResult;
    try {
      scrubbed = scrubGeneratedNarrative(parsed.data);
    } catch (error) {
      if (!(error instanceof Error && error.message === "ANALYSIS_TRANSIENT_SECRET_IN_STRUCTURE"))
        return { ok: false, error: "analysis_validation_failed_unexpected" };
      const rejected = "analysis_validation_failed_scrub_rejected";
      return {
        ok: false,
        error: rejected,
        rejected: { error: rejected, errors: [], output: value },
      };
    }
    const checked = checkAnalysisResult(input, scrubbed);
    if (!checked.ok) {
      const error =
        VALIDATION_FAILURES[checked.errors[0] ?? ""] ?? "analysis_validation_failed_unexpected";
      return {
        ok: false,
        error,
        rejected: { error, errors: [...checked.errors], output: scrubbed },
      };
    }
    return checked;
  } catch {
    return { ok: false, error: "analysis_validation_failed_unexpected" };
  }
}

/**
 * Copy the reported tokens of every response onto the artifact, summed. OpenAI usage is priced with
 * each response as its own request, since the long-context tier re-prices one request at a time.
 */
export function recordProviderUsage(
  artifact: AnalysisArtifact,
  config: AnalysisConfig,
  responses: readonly AnalysisProviderResult[],
): void {
  const { usage } = artifact;
  usage.dispatched = responses.some((response) => response.dispatched);
  const turns = responses.flatMap((response) => (response.usage ? [response.usage] : []));
  if (turns.length === 0) return;
  const total = (
    key: "input" | "output" | "cachedInput" | "cacheWriteInput",
  ): number | undefined =>
    turns.some((turn) => turn[key] !== undefined)
      ? turns.reduce((sum, turn) => sum + (turn[key] ?? 0), 0)
      : undefined;
  const tokens = {
    input: total("input")!,
    output: total("output")!,
    ...(total("cachedInput") === undefined ? {} : { cachedInput: total("cachedInput")! }),
    ...(total("cacheWriteInput") === undefined
      ? {}
      : { cacheWriteInput: total("cacheWriteInput")! }),
  };
  const priced =
    config.provider === "codex"
      ? { estimatedCostUsd: null, ratesAsOf: null }
      : estimateActorCost({ ...tokens, turns }, config.model);
  usage.inputTokens = tokens.input;
  usage.outputTokens = tokens.output;
  usage.cachedInputTokens = tokens.cachedInput ?? null;
  usage.cacheWriteInputTokens = tokens.cacheWriteInput ?? null;
  usage.usageComplete = responses.every(
    (response) =>
      !response.dispatched ||
      (response.usage !== null && (response.usageComplete ?? config.provider !== "codex")),
  );
  usage.estimatedCostUsd = priced.estimatedCostUsd;
  usage.ratesAsOf = priced.ratesAsOf;
}

/** The warnings a Codex response carries about its CLI release and protocol. */
export function codexWarnings(config: AnalysisConfig, response: AnalysisProviderResult): string[] {
  if (config.provider !== "codex") return [];
  const { cliVersion } = config.identity;
  return [
    response.protocolIncompatibilities === undefined
      ? undefined
      : protocolIncompatibilityMessage(cliVersion, response.protocolIncompatibilities),
    protocolAdditionsWarning(cliVersion, response.protocolAdditions),
    unknownNotificationsWarning(response.unknownNotifications, cliVersion),
    truncatedFrameWarning(response.truncatedFrameBytes),
  ].filter((warning) => warning !== undefined);
}
