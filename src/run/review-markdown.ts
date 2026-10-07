import type { RunBundle } from "./bundle.js";
import { reviewOutcome } from "./display.js";
import { verdictText } from "./judge.js";

type ReviewBundle = Pick<RunBundle, "runId" | "mode" | "review"> &
  Partial<Pick<RunBundle, "outcome" | "simulations">> & {
    scenario: Pick<RunBundle["scenario"], "title">;
  };

/** The review's common head and gaps, around the route's evidence lines. */
export function renderReviewMarkdown(
  bundle: ReviewBundle,
  middle: readonly string[],
  options: { beforeVerdict?: readonly string[]; style?: "preview" } = {},
): string {
  const preview = options.style === "preview";
  const field = (name: string, value: string): string[] =>
    preview ? [`${name[0]!.toUpperCase()}${name.slice(1)}: ${value}`, ""] : [`- ${name}: ${value}`];
  return [
    `# ${preview ? "humanish Run Review" : bundle.scenario.title}`,
    "",
    ...field("run", bundle.runId),
    ...field("mode", bundle.mode),
    ...(options.beforeVerdict ?? []),
    ...field("verdict", verdictText(bundle.review.verdict, bundle.mode)),
    ...field("outcome", reviewOutcome(bundle)),
    ...(preview ? [bundle.review.summary, ""] : field("summary", bundle.review.summary)),
    ...middle,
    ...(preview || bundle.review.gaps.length > 0
      ? ["", "## Gaps", ...(preview ? [""] : []), ...bundle.review.gaps.map((gap) => `- ${gap}`)]
      : []),
    "",
  ].join("\n");
}
