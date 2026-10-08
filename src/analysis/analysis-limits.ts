// The analysis result's limits and prompt revision boundaries, kept apart from the zod schemas in
// validation.ts so the Observer can read them: it bundles this module, and zod stays out of its
// page.

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
