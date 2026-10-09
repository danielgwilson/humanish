// A run with more participants than one request covers is analysed in cohorts: each cohort's
// request reads only its own participants' evidence, and one more request merges the cohort
// reports into the run's one report.

import { z } from "zod";
import { analysisCohorts } from "./analysis-limits.js";
import type { AnalysisInput, AnalysisResult } from "./types.js";
import { analysisResponseSchema, digestAnalysisInput } from "./validation.js";

/** The input each cohort request sends: the input itself when it is one cohort. */
export function cohortInputs(input: AnalysisInput): AnalysisInput[] {
  const cohorts = analysisCohorts(input.coverage.includedStreamIds);
  if (cohorts.length === 1) return [input];
  return cohorts.map((streamIds) => {
    const members = new Set(streamIds);
    const evidence = input.evidence.filter((entry) => members.has(entry.streamId));
    const ids = new Set(evidence.map((entry) => entry.id));
    const cohort: AnalysisInput = {
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
    cohort.inputDigest = digestAnalysisInput(cohort);
    return cohort;
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

/**
 * The merge request's answer with the cohorts' participant reviews, in the run's participant
 * order: a whole report, for the same check as any request's report.
 */
export function mergedResponse(
  input: AnalysisInput,
  reports: readonly AnalysisResult[],
  output: unknown,
): unknown {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return output;
  const reviews = new Map(
    reports.flatMap((report) => report.participants).map((review) => [review.streamId, review]),
  );
  return {
    ...output,
    participants: input.participants.flatMap(({ streamId }) => reviews.get(streamId) ?? []),
  };
}

/** The input a merged report is checked against: only the evidence the cohort reports cite. */
export function citedInput(
  input: AnalysisInput,
  reports: readonly AnalysisResult[],
): AnalysisInput {
  const cited = new Set(
    reports.flatMap((report) => [
      ...report.participants.flatMap((review) => [
        ...review.evidenceIds,
        ...review.feedback.map((quote) => quote.evidenceId),
      ]),
      ...report.findings.flatMap((finding) =>
        finding.observations.flatMap((observation) => observation.evidenceIds),
      ),
      ...(report.designFindings ?? []).flatMap((finding) => finding.evidenceIds),
      ...(report.concernReviews ?? []).flatMap((review) => review.evidenceIds),
    ]),
  );
  return { ...input, evidence: input.evidence.filter((entry) => cited.has(entry.id)) };
}
