// A feedback draft: the public-safe issue body humanish proposes from one run, built from a
// participant's feedback candidate or from a reviewed analysis finding, and its markdown rendering.
// The commands that resolve the run and read or write drafts are in feedback.ts.

import path from "node:path";
import { analysisSharingProblems } from "../analysis/sharing.js";
import { loadAnalysis } from "../analysis/load.js";
import { hashAnalysisValue } from "../analysis/validation.js";
import type { RunBundle, RunFeedbackCandidate } from "../run/bundle.js";
import {
  formatParticipantOutcomes,
  formatRunTaskFunnel,
  participantOutcomeDetails,
  withCuaReviewProvenance,
} from "../run/outcomes.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { loadRunBundlePrepared } from "../run/locate.js";
import { isFeedbackIdempotencyKey } from "../run/feedback-shape.js";
import { isRecord } from "../run/type-guards.js";
import { feedbackProofCommands, projectFeedbackAcceptanceProof } from "./proof.js";

export const FEEDBACK_SCHEMA = "humanish.feedback.v1";

export interface FeedbackDraft {
  schema: typeof FEEDBACK_SCHEMA;
  run_id: string;
  adapter_id: string;
  scenario_id: string;
  persona_id: string;
  actor: RunFeedbackCandidate["actor"];
  substrate: RunFeedbackCandidate["substrate"];
  failure_owner: RunFeedbackCandidate["failure_owner"];
  summary: string;
  expected: string;
  actual: string;
  source_candidate_id?: string;
  source_analysis?: {
    id: string;
    sha256: string;
    finding_id: string;
    finding_sha256: string;
    correction_id: string | null;
  };
  source_bundle: string;
  evidence: Array<{
    path: string;
    kind: RunFeedbackCandidate["evidence"][number]["kind"];
    note: string;
  }>;
  redaction: {
    status: "passed";
    notes: string;
  };
  idempotency_key: string;
  proposed_next_state: RunFeedbackCandidate["proposed_next_state"];
  acceptance_proof: string[];
}

export interface FeedbackDraftOptions {
  /** A candidate id from `feedback list`. Absent: the first usable candidate, as before. */
  candidate?: string;
  /** Explicitly select an independent interpretation, separate from participant-authored candidates. */
  analysis?: string;
  finding?: string;
}

type LoadedRunBundle = NonNullable<Awaited<ReturnType<typeof loadRunBundlePrepared>>>;

export interface FeedbackRunContext {
  cwd: string;
  loaded: LoadedRunBundle;
  physicalCwd: string;
  preparedRunPaths: PreparedRunArtifactPaths;
  storedRunId: string;
}

export function buildDraft(
  bundle: RunBundle,
  bundlePath: string,
  candidateId?: string,
): FeedbackDraft {
  const candidate = bundle.feedbackCandidates.find(
    (item): item is RunFeedbackCandidate =>
      isUsableFeedbackCandidate(item) && (candidateId === undefined || item.id === candidateId),
  );
  if (candidate) {
    return {
      schema: FEEDBACK_SCHEMA,
      run_id: bundle.runId,
      adapter_id: candidate.adapter_id,
      scenario_id: candidate.scenario_id,
      persona_id: candidate.persona_id,
      actor: candidate.actor,
      substrate: candidate.substrate,
      failure_owner: candidate.failure_owner,
      summary: candidate.summary,
      expected: candidate.expected,
      actual: candidate.actual,
      source_candidate_id: candidate.id,
      source_bundle: bundlePath,
      evidence: [
        {
          path: bundlePath,
          kind: "state",
          note: "Source run bundle.",
        },
        ...candidate.evidence.map((item) => ({
          path: path.join(path.dirname(bundlePath), item.path),
          kind: item.kind,
          note: item.note,
        })),
      ],
      redaction: {
        status: "passed",
        notes: candidate.redaction.notes,
      },
      idempotency_key: candidate.idempotency_key,
      proposed_next_state: candidate.proposed_next_state,
      acceptance_proof: projectFeedbackAcceptanceProof(bundle, candidate),
    };
  }

  // The fallback below is DRY-RUN-shaped: it says no browser behavior was exercised. A live
  // bundle without a candidate gets a draft that describes the run that happened instead, built
  // from the same review lines the stakeholder surfaces show (participants and tasks keep their
  // denominators).
  if (bundle.mode === "live") {
    const participantEndings = participantOutcomeDetails(bundle.streams);
    const review = withCuaReviewProvenance(bundle.review, bundle.streams);
    const actualLines = [
      review.summary,
      ...(bundle.review.participants === undefined
        ? []
        : [
            `Participants: ${formatParticipantOutcomes(bundle.review.participants, participantEndings)}.`,
          ]),
      ...(bundle.review.tasks === undefined
        ? []
        : [`Tasks: ${formatRunTaskFunnel(bundle.review.tasks)}.`]),
    ];
    return {
      schema: FEEDBACK_SCHEMA,
      run_id: bundle.runId,
      adapter_id: bundle.source.packageName ?? bundle.scenario.id,
      scenario_id: bundle.scenario.id,
      persona_id: bundle.persona.id,
      actor: (bundle.streams ?? []).some((stream) => stream.actor?.lane === "computer-use")
        ? "computer-use"
        : "unknown",
      substrate: "unknown",
      failure_owner: "unknown",
      summary: "Live study completed without a participant-reported finding",
      expected: bundle.scenario.goal,
      actual: actualLines.join(" "),
      source_bundle: bundlePath,
      evidence: [
        {
          path: bundlePath,
          kind: "state",
          note: "Source run bundle.",
        },
        {
          path: path.join(path.dirname(bundlePath), "review.md"),
          kind: "review",
          note: "The run's review: verdict, participants, and gaps.",
        },
      ],
      redaction: {
        status: "passed",
        notes: bundle.redaction.notes,
      },
      idempotency_key: `humanish:${bundle.runId}:live-run-summary`,
      proposed_next_state: "study-quality-review",
      acceptance_proof: [
        feedbackProofCommands(bundle.runId).verify,
        feedbackProofCommands(bundle.runId).watch,
      ],
    };
  }

  return {
    schema: FEEDBACK_SCHEMA,
    run_id: bundle.runId,
    adapter_id: bundle.source.packageName ?? "synthetic-app",
    scenario_id: bundle.scenario.id,
    persona_id: bundle.persona.id,
    actor: "synthetic-dry-run",
    substrate: "local-filesystem",
    failure_owner: "harness",
    summary: "Dry-run contract proof needs product-evidence follow-up",
    expected:
      "humanish should produce verified, public-safe evidence before product claims are filed.",
    actual:
      "This dry-run produced a contract-proof bundle only; no browser or product behavior was exercised.",
    source_bundle: bundlePath,
    evidence: [
      {
        path: bundlePath,
        kind: "state",
        note: "Synthetic run bundle.",
      },
      {
        path: path.join(path.dirname(bundlePath), "review.md"),
        kind: "review",
        note: "Review skeleton labels this as contract proof only.",
      },
    ],
    redaction: {
      status: "passed",
      notes: bundle.redaction.notes,
    },
    idempotency_key: `humanish:${bundle.runId}:dry-run-contract-proof`,
    proposed_next_state: "watch",
    acceptance_proof: [
      feedbackProofCommands(bundle.runId).verify,
      feedbackProofCommands(bundle.runId).watch,
    ],
  };
}

export async function buildAnalysisDraft(
  context: FeedbackRunContext,
  options: FeedbackDraftOptions,
): Promise<FeedbackDraft | null> {
  if (!options.analysis || !options.finding || options.candidate !== undefined) return null;
  const loaded = await loadAnalysis(context.preparedRunPaths, options.analysis);
  const analysis = loaded.analysis;
  const finding = analysis?.result?.findings.find((item) => item.id === options.finding);
  const sharing = analysisSharingProblems(loaded);
  if (loaded.state !== "ready" || sharing.sensitive || sharing.unverified || !analysis || !finding)
    return null;
  const correction = loaded.corrections.filter((item) => item.findingId === finding.id).at(-1);
  if (correction?.status === "dismissed") return null;
  const bundle = context.loaded.bundle;
  const root = path.dirname(context.loaded.bundlePath);
  const evidenceIds = new Set(finding.observations.flatMap((item) => item.evidenceIds));
  const evidence = analysis.evidence.filter((item) => evidenceIds.has(item.id));
  const claim = correction?.status === "amended" ? correction.replacementClaim! : finding.title;
  const firstLine = claim.trim().split(/\r?\n/)[0] || `Reviewed finding ${finding.id}`;
  const summary =
    Array.from(firstLine).length > 160
      ? Array.from(firstLine).slice(0, 159).join("") + "…"
      : firstLine;
  const source = {
    id: analysis.id,
    sha256: hashAnalysisValue(analysis),
    finding_id: finding.id,
    finding_sha256: hashAnalysisValue(finding),
    correction_id: correction?.id ?? null,
  };
  return {
    schema: FEEDBACK_SCHEMA,
    run_id: bundle.runId,
    adapter_id: bundle.source.packageName ?? bundle.scenario.id,
    scenario_id: bundle.scenario.id,
    persona_id: bundle.persona.id,
    actor: "unknown",
    substrate: "unknown",
    failure_owner: "unknown",
    summary,
    expected:
      "Review the cited behavior against the participant assignment and confirm the expected product behavior.",
    actual: [
      "Independent study analysis; does not replace participant feedback or recorded completion outcomes.",
      correction?.status === "amended"
        ? `Amended claim: ${claim}. Original analysis: ${finding.summary}`
        : finding.summary,
      `Impact: ${finding.impact}. ${finding.affectedStreamIds.length} affected / ${finding.exposedStreamIds.length} observed exposed participants. ${finding.exposureReason}`,
      `Recovery: ${finding.recovery}. Confidence: ${finding.confidence}.`,
      ...finding.observations.map(
        (item) =>
          `${item.basis}: ${item.claim}${item.limitation ? ` Limitation: ${item.limitation}` : ""}`,
      ),
      `Next check: ${finding.nextStep}`,
      correction
        ? `Human review: ${correction.status}. ${correction.reason}`
        : "Human review: not yet recorded.",
    ].join("\n"),
    source_bundle: context.loaded.bundlePath,
    source_analysis: source,
    evidence: [
      {
        path: context.loaded.bundlePath,
        kind: "state",
        note: "Original run evidence; participant outcomes remain authoritative for what was recorded.",
      },
      {
        path: path.join(root, "analysis", analysis.id, "analysis.json"),
        kind: "review",
        note: `Independent analysis ${analysis.id}, finding ${finding.id}; sha256 ${source.sha256}.`,
      },
      ...(correction
        ? [
            {
              path: path.join(
                root,
                "analysis",
                analysis.id,
                "corrections",
                correction.id,
                "correction.json",
              ),
              kind: "review" as const,
              note: "Append-only review of this exact finding version.",
            },
          ]
        : []),
      ...evidence.map((item) => ({
        path: item.capture ? path.join(root, item.capture.path) : context.loaded.bundlePath,
        kind: item.capture ? ("screenshot" as const) : ("state" as const),
        note: `Participant ${item.streamId}, event ${item.eventId}${item.at ? ` at ${item.at}` : ""}; evidence ${item.id}.`,
      })),
    ],
    redaction: {
      status: "passed",
      notes:
        "Source run and derived analysis passed the existing share-safety gate; semantic claims still require human review.",
    },
    idempotency_key: `humanish:${bundle.runId}:analysis:${hashAnalysisValue(source)}`,
    proposed_next_state: "study-quality-review",
    acceptance_proof: [
      feedbackProofCommands(bundle.runId).verify,
      feedbackProofCommands(bundle.runId).watch,
    ],
  };
}

export function isUsableFeedbackCandidate(candidate: unknown): candidate is RunFeedbackCandidate {
  if (
    !isRecord(candidate) ||
    candidate.schema !== "humanish.feedback-candidate.v1" ||
    !isRecord(candidate.redaction) ||
    candidate.redaction.status !== "passed" ||
    typeof candidate.summary !== "string" ||
    candidate.summary.trim().length === 0 ||
    !isFeedbackIdempotencyKey(candidate.idempotency_key) ||
    !Array.isArray(candidate.evidence)
  ) {
    return false;
  }

  return candidate.evidence.every(
    (item) =>
      isRecord(item) &&
      typeof item.path === "string" &&
      item.path.length > 0 &&
      !path.isAbsolute(item.path) &&
      !item.path.includes("://") &&
      !item.path.includes(".."),
  );
}

export function renderMarkdown(draft: FeedbackDraft, repo: string): string {
  return `This issue was drafted by humanish from a verified humanish run bundle.

It contributes to public-safe simulation harness coverage. The feedback command did not mutate GitHub, commit code, or claim unobserved product behavior.

## Summary

${draft.summary}

## Expected

${draft.expected}

## Actual

${draft.actual}

## Evidence

${draft.evidence.map((item) => `- ${item.kind}: \`${item.path}\` - ${item.note}`).join("\n")}

## Filing Notes

- Repository: ${repo}
- GitHub mutation: not performed
- Substrate: ${draft.substrate}
- Production data: not used

\`\`\`yaml
humanish_feedback:
  schema: ${draft.schema}
  run_id: ${draft.run_id}
  adapter_id: ${draft.adapter_id}
  scenario_id: ${draft.scenario_id}
  persona_id: ${draft.persona_id}
  actor: ${draft.actor}
  substrate: ${draft.substrate}
  failure_owner: ${draft.failure_owner}
${draft.source_candidate_id ? `  source_candidate_id: ${draft.source_candidate_id}\n` : ""}  source_bundle: ${draft.source_bundle}
  evidence:
${draft.evidence.map((item) => `    - path: ${item.path}\n      kind: ${item.kind}\n      note: ${item.note}`).join("\n")}
  redaction:
    status: ${draft.redaction.status}
    notes: ${draft.redaction.notes}
  idempotency_key: ${draft.idempotency_key}
  proposed_next_state: ${draft.proposed_next_state}
  acceptance_proof:
${draft.acceptance_proof.map((proof) => `    - ${proof}`).join("\n")}
\`\`\`
`;
}
