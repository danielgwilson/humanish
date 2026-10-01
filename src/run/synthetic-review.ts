import { REVIEW_SCHEMA, type ReviewSummary, type RunBundle } from "./bundle.js";
import type { Verdict } from "./judge.js";

// The review the synthetic preview writes: it claims artifact plumbing only, never product behavior.

/** The preview's review, with the verdict judgePreview gave it. */
export function createReviewSummary(verdict: Verdict): ReviewSummary {
  return {
    schema: REVIEW_SCHEMA,
    verdict,
    summary:
      "Synthetic dry-run bundle was generated. This proves humanish artifact plumbing, not product behavior.",
    gaps: [
      "No browser was launched.",
      "No product state was verified.",
      "No model, provider, or E2B substrate was used.",
    ],
  };
}

export function renderReviewMarkdown(bundle: RunBundle): string {
  return `# humanish Run Review

Run: ${bundle.runId}

Mode: ${bundle.mode}

Verdict: ${bundle.review.verdict}

${bundle.review.summary}

## Public-Safety

- Redaction: ${bundle.redaction.status}
- Notes: ${bundle.redaction.notes}

## Gaps

${bundle.review.gaps.map((gap) => `- ${gap}`).join("\n")}
`;
}
