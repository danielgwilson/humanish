import { feedbackProofCommands } from "../../feedback/proof.js";
import type { ActorTrace } from "../../actors/contract.js";
import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import { containsSensitive, redactText } from "../../evidence/redaction.js";
import {
  type RunBundle,
  type RunFeedbackCandidate,
  type RunProviderResource,
  type RunSubjectProvenance,
} from "../../run/bundle.js";
import { participantPassed, type ParticipantFacts } from "../../run/judge.js";
import { digestUrl } from "./lane-plan.js";
import { resolveSelfReportedFriction } from "./self-report.js";
import {
  CUA_FANOUT_STRATEGY,
  type CuaLanePlan,
  type CuaLaneSummary,
  type CuaSubjectProvenanceArg,
  type LaneRunOutcome,
} from "./types.js";

/** A lane outcome's facts for the judge. */
export function participantFactsOf(outcome: LaneRunOutcome): ParticipantFacts {
  return {
    ...(outcome.session === undefined
      ? {}
      : { status: outcome.session.status, completionReason: outcome.session.completionReason }),
    ...(outcome.sessionError === undefined ? {} : { sessionError: outcome.sessionError }),
    skipped: outcome.skippedReason !== undefined,
    noEngagement: outcome.noEngagement === true,
    selfReportedBlocker: outcome.selfReportedBlocker === true,
  };
}

export function laneOutcomeOk(outcome: LaneRunOutcome | undefined, dryRun: boolean): boolean {
  if (dryRun) return true;
  return outcome !== undefined && participantPassed(participantFactsOf(outcome));
}

/** Aggregate lane counts for the result projection. */
export function buildLaneSummary(
  outcomes: LaneRunOutcome[] | undefined,
  laneCount: number,
  plan: CuaLanePlan,
  dryRun: boolean,
): CuaLaneSummary {
  if (dryRun || !outcomes) {
    return {
      strategy: CUA_FANOUT_STRATEGY,
      total: laneCount,
      passed: 0,
      skipped: 0,
      harnessErrors: 0,
      hollow: 0,
      concurrency: plan.concurrency,
      waves: plan.waves,
    };
  }
  let passed = 0;
  let skipped = 0;
  let harnessErrors = 0;
  let hollow = 0;
  for (const outcome of outcomes) {
    if (outcome.skippedReason !== undefined) {
      skipped += 1;
      continue;
    }
    if (outcome.harnessError) harnessErrors += 1;
    if (outcome.noEngagement) hollow += 1;
    if (laneOutcomeOk(outcome, dryRun)) passed += 1;
  }
  return {
    strategy: CUA_FANOUT_STRATEGY,
    total: laneCount,
    passed,
    skipped,
    harnessErrors,
    hollow,
    concurrency: plan.concurrency,
    waves: plan.waves,
  };
}

/** The human-readable state story appended to the provenance event (and review.md via it). */
export function describeSubjectState(
  state: RunSubjectProvenance["state"],
  dryRun: boolean,
): string {
  switch (state.provenance) {
    case "seeded":
      return `seeded (${state.seed?.length ?? 0} step(s): ${(state.seed ?? []).map((record) => record.name).join(", ")})`;
    case "unpinned":
      return `UNPINNED (external: ${(state.externalEnvNames ?? []).join(", ")})`;
    case "declared-not-run":
      return `declared, not run (${dryRun ? "dry-run contract" : "provisioning did not complete"})`;
    case "undeclared":
      return "undeclared";
    case "external-public":
      return "external-public (operator-declared, operator-owned public deployment; neither provisioned nor seeded)";
  }
}

/**
 * Feedback candidates derived from what LIVE participants actually reported (#392).
 *
 * A live run's feedback draft used to fall through to a dry-run template, because no browser route
 * ever built a candidate. The candidate worth filing is the one the study produced: a participant
 * who reported friction on the way (the most valuable thing a run captures), or one who stopped
 * trying. A clean pass files nothing here — feedback exists to carry findings, and a run without
 * any falls back to an honest live summary in the draft layer instead of a template.
 *
 * Everything quoted is already scrub+redacted — participant messages and `session.reason` pass
 * through redactNarration in the loop — and passes redactText again here as defense-in-depth.
 */
export function participantFeedbackCandidates(args: {
  runId: string;
  scenarioId: string;
  adapterId: string;
  /** The already-redacted study goal (what bundle.scenario.goal carries). */
  goal: string;
  substrate: RunFeedbackCandidate["substrate"];
  lanes: Array<{
    laneId: string;
    streamId: string;
    personaId: string;
    session?: CuaLoopResult;
    traceArtifactPath?: string;
    screenshots: string[];
    commsArtifactPath?: string;
  }>;
}): RunFeedbackCandidate[] {
  const candidates: RunFeedbackCandidate[] = [];
  for (const lane of args.lanes) {
    const session = lane.session;
    if (session === undefined) continue;
    const friction = resolveSelfReportedFriction(session);
    const abandoned = session.status === "abandoned";
    if (friction === undefined && !abandoned) continue;
    const summary =
      friction !== undefined
        ? `Participant ${lane.personaId} (${lane.laneId}) reported friction on the way through the study goal`
        : `Participant ${lane.personaId} (${lane.laneId}) stopped before completing the study goal`;
    const lastScreenshot = lane.screenshots[lane.screenshots.length - 1];
    candidates.push({
      schema: "humanish.feedback-candidate.v1",
      id: `participant-report-${lane.laneId}`,
      run_id: args.runId,
      stream_id: lane.streamId,
      adapter_id: args.adapterId,
      scenario_id: args.scenarioId,
      persona_id: lane.personaId,
      actor: "computer-use",
      substrate: args.substrate,
      // The participant is reporting on the PRODUCT: friction and abandonment are target-app
      // findings by the three-roles rule. A harness failure never reaches this builder — it is
      // not a participant report.
      failure_owner: "target-app",
      summary,
      expected: args.goal,
      actual: redactText(friction ?? session.reason),
      evidence: [
        ...(lane.traceArtifactPath === undefined
          ? []
          : [
              {
                path: lane.traceArtifactPath,
                kind: "trace" as const,
                note: "Full actor trace: turns, actions, and the participant's own report.",
              },
            ]),
        ...(lastScreenshot === undefined
          ? []
          : [
              {
                path: lastScreenshot,
                kind: "screenshot" as const,
                note: "Final screenshot at the moment the session ended.",
              },
            ]),
        ...(lane.commsArtifactPath === undefined
          ? []
          : [
              {
                path: lane.commsArtifactPath,
                kind: "log" as const,
                note: "Digest-only comms thread captured in-sandbox.",
              },
            ]),
      ],
      redaction: {
        status: "passed",
        notes:
          "Quoted participant text passed the loop's known-value scrub and pattern redaction before persisting, and redactText again here.",
      },
      idempotency_key: `humanish:${args.runId}:${lane.laneId}:participant-report`,
      proposed_next_state: "study-quality-review",
      acceptance_proof: [
        feedbackProofCommands(args.runId).verify,
        feedbackProofCommands(args.runId).watch,
      ],
    });
  }
  return candidates;
}

/** Human-readable provenance line for the single-lane subject.provenance event (invariant 5):
 *  claims "cloned/packed and served" ONLY when it actually happened. */
export function subjectProvenanceMessage(
  provenance: CuaSubjectProvenanceArg,
  publicAppUrl: string,
  dryRun: boolean,
  hasSession: boolean,
): string {
  if (provenance.source === "clone") {
    if (dryRun) {
      return `Subject declared: clone of ${provenance.repo}, to be served at ${publicAppUrl} in-sandbox (dry-run contract; nothing cloned)`;
    }
    if (provenance.commit) {
      return hasSession
        ? `Subject cloned from ${provenance.repo}@${provenance.commit} and served at ${publicAppUrl} in-sandbox`
        : `Subject cloned from ${provenance.repo}@${provenance.commit}; serving at ${publicAppUrl} did not complete (see session error)`;
    }
    return `Subject clone attempted from ${provenance.repo}; commit unresolved (provisioning failed before resolution)`;
  }
  if (dryRun) {
    return `Subject declared: local working tree, to be packed and served at ${publicAppUrl} in-sandbox (dry-run contract; nothing packed)`;
  }
  if (provenance.archiveSha256) {
    const dirtyLabel =
      provenance.dirty === true
        ? ", dirty working tree"
        : provenance.dirty === false
          ? ", clean working tree"
          : "";
    return hasSession
      ? `Subject packed (archiveSha256 ${provenance.archiveSha256}${dirtyLabel}) and served at ${publicAppUrl} in-sandbox`
      : `Subject packed (archiveSha256 ${provenance.archiveSha256}${dirtyLabel}); serving at ${publicAppUrl} did not complete (see session error)`;
  }
  return "Subject local-tree packing attempted; archive digest unresolved (provisioning failed before resolution)";
}

export function providerResourcesForOutcome(args: {
  outcome: LaneRunOutcome | undefined;
  createdAt: string;
  simId: string;
  streamId: string;
  laneId: string;
}): RunProviderResource[] {
  if (args.outcome?.sandboxId === undefined) {
    return [];
  }

  return [
    {
      schema: "humanish.provider-resource.v1",
      provider: "e2b-desktop",
      kind: "sandbox",
      id: args.outcome.sandboxId,
      owner: "humanish",
      status: args.outcome.killed ? "killed" : "running",
      simId: args.simId,
      streamId: args.streamId,
      laneId: args.laneId,
      createdAt: args.createdAt,
      cleanup: {
        killed: args.outcome.killed,
        reason: args.outcome.killed
          ? "killed during normal lane teardown"
          : "not killed during normal lane teardown; cleanup may reclaim by exact recorded id",
      },
    },
  ];
}

export function renderCuaReviewMarkdown(bundle: RunBundle): string {
  const trace: ActorTrace | undefined = bundle.streams[0]?.actor;
  const provenance = bundle.events.find((event) => event.type === "cua-lab.subject.provenance");
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- run gate: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(provenance ? [`- subject: ${provenance.message}`] : []),
    ...(trace
      ? [
          `- actor: ${trace.provider} (${trace.lane}/${trace.protocol})`,
          // Honest count: name the trace's actual screenshot mode ("raw" | "blurred"); say
          // nothing when no frames exist ("n/a") rather than claim a redaction that never ran.
          `- evidence: ${trace.items.length} trace item(s), ${trace.counts.screenshots ?? 0} ${
            trace.redaction.screenshots === "raw" || trace.redaction.screenshots === "blurred"
              ? `${trace.redaction.screenshots} screenshot(s)`
              : "screenshot(s)"
          }`,
        ]
      : []),
    ...(bundle.review.gaps.length > 0
      ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)]
      : []),
    "",
  ].join("\n");
}

export function publicSafeAppUrlLabel(url: string): string {
  return containsSensitive(url) ? `[target-url:${digestUrl(url)}]` : url;
}
