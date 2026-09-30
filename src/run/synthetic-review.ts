import { REVIEW_SCHEMA, type ReviewSummary, type RunBundle } from "./bundle.js";

// The review the synthetic preview writes: it claims artifact plumbing only, never product behavior.

export function createReviewSummary(): ReviewSummary {
  return {
    schema: REVIEW_SCHEMA,
    verdict: "contract_proof_only",
    summary:
      "Synthetic dry-run bundle was generated. This proves Humanish artifact plumbing, not product behavior.",
    gaps: [
      "No browser was launched.",
      "No product state was verified.",
      "No model, provider, or E2B substrate was used.",
    ],
  };
}

export function renderReviewMarkdown(bundle: RunBundle): string {
  return `# Humanish Run Review

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
