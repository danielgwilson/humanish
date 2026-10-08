// How a finding opens for a reader, the same in `review`, a feedback draft and the Observer. The
// Observer bundles this module, so it imports types only (observer/tests/contract-lock.test.ts).

import type { AnalysisCorrection, AnalysisResult } from "./types.js";

type Severity = NonNullable<AnalysisResult["designFindings"]>[number]["severity"];

export interface FindingLead {
  /** The reviewer's amended claim, or the plain headline. */
  headline: string;
  /**
   * The line under the headline: the plain experience, or after an amendment a sentence saying the
   * reviewer's claim replaced the headline and account. Null when the analysis wrote no experience.
   */
  account: string | null;
  /** The headline is a reviewer's amended claim. */
  corrected: boolean;
}

/**
 * The headline and account a finding leads with, given its latest human review note. An amendment
 * replaces both, since they describe the claim the reviewer replaced. Null for an analysis written
 * before headlines, which leads with the finding's title.
 */
export function findingLead(
  finding: { headline?: string | null; experience?: string | null },
  correction: Pick<AnalysisCorrection, "status" | "replacementClaim"> | null | undefined,
): FindingLead | null {
  if (finding.headline === undefined || finding.headline === null) return null;
  if (correction?.status === "amended" && correction.replacementClaim)
    return {
      headline: correction.replacementClaim,
      account:
        "Corrected in human review. The reviewer's claim replaces the original headline and account.",
      corrected: true,
    };
  return { headline: finding.headline, account: finding.experience ?? null, corrected: false };
}

const SEVERITY_ORDER: readonly Severity[] = ["major", "moderate", "minor"];

/** Design findings most severe first, in a new array; equal severity keeps the analysis order. */
export function bySeverity<T extends { severity: Severity }>(findings: readonly T[]): T[] {
  return findings.toSorted(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}
