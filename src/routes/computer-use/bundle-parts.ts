// The parts both computer-use bundle shapes share: the subject-state story and provenance line,
// feedback candidates from what live participants reported, provider-resource records, and the
// public-safe app URL label, the URL digest and the subject-phase event id suffix. The builders are bundle.ts (the dispatcher and the judge),
// single-bundle.ts and fanout-bundle.ts.

import { feedbackProofCommands } from "../../feedback/proof.js";
import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import { containsSensitive, digestText, redactText } from "../../evidence/redaction.js";
import {
  type RunFeedbackCandidate,
  type RunProviderResource,
  type RunSubjectProvenance,
} from "../../run/bundle.js";
import { participantResourceIds, type ParticipantIds } from "../../run/participant-records.js";
import { resolveSelfReportedFriction } from "./self-report.js";
import { type CuaSubjectProvenanceArg, type ParticipantRunOutcome } from "./types.js";

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
      return `declared, not run (${dryRun ? "dry run" : "provisioning did not complete"})`;
    case "undeclared":
      return "undeclared";
    case "external-public":
      return "external-public (operator-declared, operator-owned public deployment; neither provisioned nor seeded)";
  }
}

/**
 * Feedback candidates derived from what live participants actually reported.
 *
 * A live run's feedback draft used to fall through to a dry-run template, because no browser route
 * ever built a candidate. The candidate worth filing is the one the study produced: a participant
 * who reported friction on the way (the most valuable thing a run captures), or one who stopped
 * trying. A clean pass files nothing here: feedback exists to carry findings, and a run without
 * any falls back to an honest live summary in the draft layer instead of a template.
 *
 * Everything quoted is already scrub+redacted (participant messages and `session.reason` pass
 * through redactNarration in the loop) and passes redactText again here as defense-in-depth.
 */
export function participantFeedbackCandidates(args: {
  runId: string;
  scenarioId: string;
  adapterId: string;
  /** The already-redacted study goal (what bundle.scenario.goal carries). */
  goal: string;
  substrate: RunFeedbackCandidate["substrate"];
  participants: Array<{
    /** The participant's plan id; it names the candidate and its idempotency key. */
    participantId: string;
    streamId: string;
    personaId: string;
    session?: CuaLoopResult;
    traceArtifactPath?: string;
    screenshots: string[];
    commsArtifactPath?: string;
  }>;
}): RunFeedbackCandidate[] {
  const candidates: RunFeedbackCandidate[] = [];
  for (const participant of args.participants) {
    const session = participant.session;
    if (session === undefined) continue;
    const friction = resolveSelfReportedFriction(session);
    const abandoned = session.status === "abandoned";
    if (friction === undefined && !abandoned) continue;
    const summary =
      friction !== undefined
        ? `Participant ${participant.personaId} (${participant.participantId}) reported friction on the way through the study goal`
        : `Participant ${participant.personaId} (${participant.participantId}) stopped before completing the study goal`;
    const lastScreenshot = participant.screenshots[participant.screenshots.length - 1];
    candidates.push({
      schema: "humanish.feedback-candidate.v1",
      id: `participant-report-${participant.participantId}`,
      run_id: args.runId,
      stream_id: participant.streamId,
      adapter_id: args.adapterId,
      scenario_id: args.scenarioId,
      persona_id: participant.personaId,
      actor: "computer-use",
      substrate: args.substrate,
      // The participant is reporting on the product: friction and abandonment are target-app
      // findings by the three-roles rule. A harness failure never reaches this builder; it is
      // not a participant report.
      failure_owner: "target-app",
      summary,
      expected: args.goal,
      actual: redactText(friction ?? session.reason),
      evidence: [
        ...(participant.traceArtifactPath === undefined
          ? []
          : [
              {
                path: participant.traceArtifactPath,
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
        ...(participant.commsArtifactPath === undefined
          ? []
          : [
              {
                path: participant.commsArtifactPath,
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
      idempotency_key: `humanish:${args.runId}:${participant.participantId}:participant-report`,
      proposed_next_state: "study-quality-review",
      acceptance_proof: [
        feedbackProofCommands(args.runId).verify,
        feedbackProofCommands(args.runId).watch,
      ],
    });
  }
  return candidates;
}

/** Human-readable provenance line for the single-participant subject.provenance event:
 *  claims "cloned/packed and served" only when it actually happened. */
export function subjectProvenanceMessage(
  provenance: CuaSubjectProvenanceArg,
  publicAppUrl: string,
  dryRun: boolean,
  hasSession: boolean,
): string {
  if (provenance.source === "clone") {
    if (dryRun) {
      return `Subject declared: clone of ${provenance.repo}, to be served at ${publicAppUrl} in-sandbox (dry run; nothing cloned)`;
    }
    if (provenance.commit) {
      return hasSession
        ? `Subject cloned from ${provenance.repo}@${provenance.commit} and served at ${publicAppUrl} in-sandbox`
        : `Subject cloned from ${provenance.repo}@${provenance.commit}; serving at ${publicAppUrl} did not complete (see session error)`;
    }
    return `Subject clone attempted from ${provenance.repo}; commit unresolved (provisioning failed before resolution)`;
  }
  if (dryRun) {
    return `Subject declared: local working tree, to be packed and served at ${publicAppUrl} in-sandbox (dry run; nothing packed)`;
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
  outcome: ParticipantRunOutcome | undefined;
  createdAt: string;
  ids: ParticipantIds;
  participantId: string;
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
      // Only a sandbox kept on purpose is known to be running; an unconfirmed release may or may
      // not have stopped it.
      status: args.outcome.killed
        ? "killed"
        : args.outcome.sandboxRelease?.state === "retained"
          ? "running"
          : "unknown",
      ...participantResourceIds(args.ids, args.participantId),
      createdAt: args.createdAt,
      cleanup: {
        killed: args.outcome.killed,
        reason: args.outcome.killed
          ? "killed during normal participant teardown"
          : (args.outcome.sandboxRelease?.warning ??
            "not killed during normal participant teardown; cleanup may reclaim by exact recorded id"),
      },
    },
  ];
}

export function publicSafeAppUrlLabel(url: string): string {
  return containsSensitive(url) ? `[target-url:${digestUrl(url)}]` : url;
}

/** Short id-safe suffix for a subject-phase RunEvent: drops the shared prefix/suffix so each
 *  phase gets a distinct bundle event id (e.g. "clone", "state-before-build"). */
export function phaseEventIdSuffix(type: string): string {
  return type
    .replace(/^cua-lab\.subject\./, "")
    .replace(/\.(started|completed)$/, "")
    .replace(/\./g, "-");
}

export function digestUrl(url: string): string {
  return digestText(url, 16);
}
