// The analysis input's and result's limits and prompt revision boundaries, kept apart from the zod
// schemas in validation.ts so the Observer can read them: it bundles this module, and zod stays out
// of its page.

/**
 * What one run's analysis reads. `participants` is the most participants it covers, which is also
 * the most streams the analysis reads from a run bundle. Each request covers at most
 * `cohortParticipants` of them, and the counts and byte limits below apply to each request's
 * packet: a run with more participants is analysed in cohorts, one request each, and one more
 * request merges their reports. `sourceBytes` bounds the run bundle file.
 */
export const EVIDENCE_LIMITS = Object.freeze({
  participants: 128,
  cohortParticipants: 16,
  evidence: 800,
  captures: 40,
  textBytes: 160 * 1024,
  imageBytes: 8 * 1024 * 1024,
  totalImageBytes: 20 * 1024 * 1024,
  sourceBytes: 16 * 1024 * 1024,
});

/** The most cohorts one analysis sends: every participant it covers, in cohorts at the limit. */
export const MAX_ANALYSIS_COHORTS = Math.ceil(
  EVIDENCE_LIMITS.participants / EVIDENCE_LIMITS.cohortParticipants,
);

/** How many cohorts this many participants are analysed in. */
export const analysisCohortCount = (participants: number): number =>
  Math.max(1, Math.ceil(participants / EVIDENCE_LIMITS.cohortParticipants));

/**
 * The cohorts a run's participants are analysed in: one when there are at most
 * `cohortParticipants`, otherwise the fewest that hold at most that many each. Participants are
 * dealt in turn, so cohort sizes differ by at most one and each cohort holds a spread of the roster.
 */
export function analysisCohorts<T>(participants: readonly T[]): T[][] {
  const count = analysisCohortCount(participants.length);
  return Array.from({ length: count }, (_, cohort) =>
    participants.filter((_, index) => index % count === cohort),
  );
}

/**
 * How much an analysis result may hold, for the fields the Observer checks as well. Characters are
 * counted as `String.length` counts them.
 */
export const ANALYSIS_LIMITS = Object.freeze({
  /** A label: a finding's title and headline, a design finding's headline and screen, or a name. */
  labelChars: 240,
  experienceChars: 1200,
  noticeChars: 1500,
  whyItMattersChars: 1000,
  suggestionChars: 1000,
  /** Evidence one observation or design finding may cite. */
  evidenceRefs: 100,
  findings: 100,
  designFindings: 40,
  concernReviews: 60,
});

/** Whether text holds a control character other than tab, line feed and carriage return. */
export function hasControlCharacter(text: string): boolean {
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

// The prompt revision from which a result must carry each field. A boundary stays where it is when
// the prompt version advances, so a later prompt cannot bring back a legacy omission.
const CONCERN_REVIEWS_FROM = 5;
const HEADLINES_AND_DESIGN_FINDINGS_FROM = 7;

/** The parts of an analysis result the revision boundaries read. */
interface RevisionFields {
  readonly concernReviews?: unknown;
  readonly designFindings?: unknown;
  readonly findings: ReadonlyArray<{ readonly headline?: unknown; readonly experience?: unknown }>;
}

/**
 * Whether a result carries every field its prompt revision requires: concern reviews from
 * study-evidence-5, and headlines, experiences and design findings from study-evidence-7. A prompt
 * version without a study-evidence revision number requires none of them.
 */
export function hasRevisionFields(promptVersion: string, result: RevisionFields): boolean {
  const revision = Number(/^study-evidence-(\d+)$/.exec(promptVersion)?.[1] ?? 0);
  if (revision >= CONCERN_REVIEWS_FROM && result.concernReviews === undefined) return false;
  return (
    revision < HEADLINES_AND_DESIGN_FINDINGS_FROM ||
    (result.designFindings !== undefined &&
      result.findings.every(
        (finding) => finding.headline !== undefined && finding.experience !== undefined,
      ))
  );
}
