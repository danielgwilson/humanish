// Feedback candidates from what live participants reported. The computer-use bundles (single and
// fan-out) and the shared-world bundle all build them here, so a participant's report becomes the
// same candidate whichever route ran it.

import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import { redactText } from "../../evidence/redaction.js";
import { feedbackProofCommands } from "../../feedback/proof.js";
import type { RunFeedbackCandidate } from "../../run/bundle.js";
import { resolveSelfReportedFriction } from "./self-report.js";

/**
 * Feedback candidates derived from what live participants actually reported.
 *
 * A live run's feedback draft comes from these candidates, never from a dry-run template. The
 * candidate worth filing is the one the study produced: a participant
 * who reported friction on the way (the most valuable thing a run captures), or one who stopped
 * trying. A clean pass files nothing here: feedback exists to carry findings, and a run without
 * any falls back to a live summary in the draft layer instead of a template.
 *
 * Everything quoted is already scrub+redacted (participant messages and `session.reason` pass
 * through redactNarration in the loop) and passes redactText again here as defense-in-depth.
 */
export function participantFeedbackCandidates(args: {
  runId: string;
  scenarioId: string;
  adapterId: string;
  substrate: RunFeedbackCandidate["substrate"];
  participants: Array<{
    /** The participant's plan id; it names the candidate and its idempotency key. */
    participantId: string;
    streamId: string;
    personaId: string;
    /** The participant's own already-redacted instructions, which the candidate's `expected`
     *  quotes. Participants of one study get different instructions, each naming its persona. */
    goal: string;
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
      expected: participant.goal,
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
        feedbackProofCommands(args.runId).observe,
      ],
    });
  }
  return candidates;
}
