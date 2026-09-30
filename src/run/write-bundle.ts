import { buildObserverData } from "../observer/data.js";
import { type PreparedRunArtifactPaths } from "./paths.js";
import { type RunStatusHandle } from "./status.js";
import { writeContainedOutputFile } from "./selected-output-paths.js";
import { PUBLIC_TARGET_CWD, REVIEW_SCHEMA, type ReviewSummary, type RunBundle } from "./bundle.js";

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

function renderReviewMarkdown(bundle: RunBundle): string {
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

export async function writeRunBundleArtifacts(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
  /** Pass ONLY when this write is the run's final one: the shared writer is also used for
   *  mid-run in-progress snapshots, and finalizing there would declare a live run finished (#455). */
  finalizeStatus?: RunStatusHandle,
): Promise<void> {
  const publicBundle: RunBundle = {
    ...bundle,
    cwd: PUBLIC_TARGET_CWD,
  };
  await writeContainedOutputFile(
    runPaths,
    "run.json",
    `${JSON.stringify(publicBundle, null, 2)}\n`,
    "utf8",
  );
  await finalizeStatus?.finish({
    ...(publicBundle.review?.verdict === undefined ? {} : { verdict: publicBundle.review.verdict }),
    ...(publicBundle.review?.participants === undefined
      ? {}
      : {
          participants: {
            total: publicBundle.review.participants.total,
            reachedGoal: publicBundle.review.participants.reachedGoal,
            ...(publicBundle.review.participants.reportedFriction === undefined
              ? {}
              : { reportedFriction: publicBundle.review.participants.reportedFriction }),
          },
        }),
    ...(publicBundle.cost?.estimatedTotalUsd === undefined
      ? {}
      : { estimatedCostUsd: publicBundle.cost.estimatedTotalUsd }),
  });
  await writeContainedOutputFile(
    runPaths,
    "review.json",
    `${JSON.stringify(publicBundle.review, null, 2)}\n`,
    "utf8",
  );
  await writeContainedOutputFile(runPaths, "review.md", renderReviewMarkdown(publicBundle), "utf8");
  await writeContainedOutputFile(
    runPaths,
    "events.ndjson",
    `${publicBundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    "observer/observer-data.json",
    `${JSON.stringify(buildObserverData(publicBundle), null, 2)}\n`,
    "utf8",
  );
}
