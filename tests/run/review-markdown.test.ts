import { describe, expect, it } from "vitest";
import { REVIEW_SCHEMA } from "../../src/run/bundle.js";
import { renderReviewMarkdown } from "../../src/run/review-markdown.js";

const bundle = {
  runId: "example-run",
  mode: "live" as const,
  scenario: { title: "Example study" },
  review: {
    schema: REVIEW_SCHEMA,
    verdict: "blocked" as const,
    summary: "Approval was unavailable.",
    gaps: ["Approval needed"],
  },
} satisfies Parameters<typeof renderReviewMarkdown>[0];

describe("review markdown", () => {
  it("renders the common head and gaps around the route's middle lines", () => {
    expect(renderReviewMarkdown(bundle, ["- actor: example"])).toBe(
      [
        "# Example study",
        "",
        "- run: example-run",
        "- mode: live",
        "- verdict: blocked",
        "- outcome: blocked",
        "- summary: Approval was unavailable.",
        "- actor: example",
        "",
        "## Gaps",
        "- Approval needed",
        "",
      ].join("\n"),
    );
  });
  it("keeps shared-world metadata before the verdict and omits an empty gaps section", () => {
    expect(
      renderReviewMarkdown({ ...bundle, review: { ...bundle.review, gaps: [] } }, [], {
        beforeVerdict: ["- topology: shared"],
      }),
    ).toBe(
      [
        "# Example study",
        "",
        "- run: example-run",
        "- mode: live",
        "- topology: shared",
        "- verdict: blocked",
        "- outcome: blocked",
        "- summary: Approval was unavailable.",
        "",
      ].join("\n"),
    );
  });

  it("preserves the preview's paragraph layout and gaps spacing", () => {
    expect(
      renderReviewMarkdown(
        {
          ...bundle,
          mode: "dry-run",
          review: {
            ...bundle.review,
            verdict: "contract_proof_only",
            summary: "Contract recorded.",
          },
        },
        ["## Public-Safety", "", "- Redaction: passed"],
        { style: "preview" },
      ),
    ).toBe(
      [
        "# humanish Run Review",
        "",
        "Run: example-run",
        "",
        "Mode: dry-run",
        "",
        "Verdict: dry run",
        "",
        "Outcome: dry run",
        "",
        "Contract recorded.",
        "",
        "## Public-Safety",
        "",
        "- Redaction: passed",
        "",
        "## Gaps",
        "",
        "- Approval needed",
        "",
      ].join("\n"),
    );
  });
});
