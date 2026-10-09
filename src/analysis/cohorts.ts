// A run with more participants than one request covers is analysed in cohorts: each cohort's
// request reads only its own participants' evidence, and one more request merges the cohort
// reports into the run's one report.

import { z } from "zod";
import { analysisCohorts } from "./analysis-limits.js";
import { checkProviderAnalysis, type CheckedProviderAnalysis } from "./responses.js";
import type { AnalysisInput, AnalysisResult } from "./types.js";
import { analysisResponseSchema } from "./validation.js";

/**
 * The input each cohort request sends: the input itself when it is one cohort. `includedStreamIds`
 * keeps the bundle's stream order, the order captureEvidence split the packet by. A cohort's input
 * is never stored, so it keeps the run's input digest.
 */
export function cohortInputs(input: AnalysisInput): AnalysisInput[] {
  const cohorts = analysisCohorts(input.coverage.includedStreamIds);
  if (cohorts.length === 1) return [input];
  return cohorts.map((streamIds) => {
    const members = new Set(streamIds);
    const evidence = input.evidence.filter((entry) => members.has(entry.streamId));
    const ids = new Set(evidence.map((entry) => entry.id));
    return {
      ...input,
      participants: input.participants.filter((participant) => members.has(participant.streamId)),
      coverage: {
        ...input.coverage,
        includedStreamIds: streamIds,
        evidenceCount: evidence.length,
        captureCount: evidence.filter((entry) => entry.capture !== null).length,
      },
      evidence,
      images: input.images.filter((image) => ids.has(image.evidenceId)),
    };
  });
}

/**
 * The merge request's packet: the participants, the coverage and each cohort's report. With no
 * reports it is the part admission prices before any request is sent.
 */
export function mergePacket(input: AnalysisInput, reports: readonly AnalysisResult[] = []): string {
  return JSON.stringify({
    runId: input.runId,
    participants: input.participants.map(({ streamId, label }) => ({ streamId, label })),
    coverage: input.coverage,
    cohorts: analysisCohorts(input.coverage.includedStreamIds).map((streamIds, index) => ({
      streamIds,
      report: reports[index] ?? null,
    })),
  });
}

/** The merge request writes everything but the participant reviews, which the cohorts wrote. */
export const mergeResultJsonSchema = z.toJSONSchema(
  analysisResponseSchema.omit({ participants: true }),
);

/** The evidence a report's findings, design findings and concern reviews cite. */
const findingEvidence = (report: AnalysisResult): string[] => [
  ...report.findings.flatMap((finding) =>
    finding.observations.flatMap((observation) => observation.evidenceIds),
  ),
  ...(report.designFindings ?? []).flatMap((finding) => finding.evidenceIds),
  ...(report.concernReviews ?? []).flatMap((review) => review.evidenceIds),
];

/**
 * Check the merge request's answer as a whole report: with the cohorts' participant reviews, in
 * the run's participant order, it passes the same check as any request's report. Its findings,
 * design findings and concern reviews may cite only evidence that the cohort reports cite in
 * theirs: the merge request saw no evidence, so any other citation would be a new claim.
 */
export function checkMergedResponse(
  input: AnalysisInput,
  reports: readonly AnalysisResult[],
  output: unknown,
): CheckedProviderAnalysis {
  const reviews = new Map(
    reports.flatMap((report) => report.participants).map((review) => [review.streamId, review]),
  );
  const merged =
    output === null || typeof output !== "object" || Array.isArray(output)
      ? output
      : {
          ...output,
          participants: input.participants.flatMap(({ streamId }) => reviews.get(streamId) ?? []),
        };
  const checked = checkProviderAnalysis(input, merged);
  if (!checked.ok) return checked;
  const cited = new Set(reports.flatMap(findingEvidence));
  if (findingEvidence(checked.result).every((id) => cited.has(id))) return checked;
  const error = "analysis_validation_failed_merge_reference_invalid";
  return { ok: false, error, rejected: { error, errors: [], output: checked.result } };
}
