import { collectExternalCommsEvidence } from "../../comms/external-evidence.js";
import type { LabCommsEmail, LabCommsExternal } from "../../lab/types.js";
import type { PreparedRunArtifactPaths } from "../../run/paths.js";
import { participantHasInboxRecipient } from "./participant-desktop.js";
import type { DesktopParticipantRun, ParticipantRunOutcome } from "./types.js";

/**
 * Adopter-hosted drain (#380): once per RUN, after every lane finished — the catch is one
 * shared external endpoint, not a per-sandbox file. Same routing and digest-only artifact as
 * the in-sandbox drain; the artifact is registered on every lane that declared a recipient
 * address, since the thread carries each inbox's mail. A drain failure never fails the run.
 *
 * Returns the warnings the drain produced; lanes that received mail get `commsArtifactPath`.
 */
export async function drainExternalComms(args: {
  externalCommsConfig: LabCommsExternal;
  externalCommsEmail: LabCommsEmail;
  env: Record<string, string | undefined>;
  runPaths: PreparedRunArtifactPaths;
  participantRuns: readonly DesktopParticipantRun[];
  outcomes: ParticipantRunOutcome[];
  scrubKnownValues: (text: string) => string;
}): Promise<string[]> {
  const { externalCommsEmail, participantRuns, outcomes } = args;
  const { path: commsPath, warnings } = await collectExternalCommsEvidence({
    external: args.externalCommsConfig,
    email: externalCommsEmail,
    env: args.env,
    runPaths: args.runPaths,
    scrubKnownValues: args.scrubKnownValues,
  });
  if (commsPath !== undefined) {
    for (const [index, outcome] of outcomes.entries()) {
      const participantId = participantRuns[index]?.planned.id;
      if (
        participantId !== undefined &&
        outcome.commsArtifactPath === undefined &&
        participantHasInboxRecipient(externalCommsEmail, participantId)
      ) {
        outcome.commsArtifactPath = commsPath;
      }
    }
  }
  return warnings;
}
