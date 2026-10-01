import { FakeInbox } from "../../comms/fake-inbox.js";
import { collectExternalCommsThread } from "../../comms/sandbox-catch.js";
import type { CommsAddress } from "../../comms/types.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { LabCommsEmail, LabCommsExternal } from "../../lab/types.js";
import type { PreparedRunArtifactPaths } from "../../run/paths.js";
import { writeContainedOutputFile } from "../../run/contained-output.js";
import { laneHasInboxRecipient } from "./participant-desktop.js";
import type { DesktopParticipantRun, LaneRunOutcome } from "./types.js";

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
  laneSpecs: readonly DesktopParticipantRun[];
  outcomes: LaneRunOutcome[];
  scrubKnownValues: (text: string) => string;
}): Promise<string[]> {
  const {
    externalCommsConfig,
    externalCommsEmail,
    env,
    runPaths,
    laneSpecs,
    outcomes,
    scrubKnownValues,
  } = args;
  const warnings: string[] = [];
  try {
    const commsChannel = new FakeInbox();
    const commsInboxes: CommsAddress[] = [];
    for (const recipient of externalCommsEmail.recipients ?? []) {
      if (recipient.address !== undefined) {
        commsInboxes.push(await commsChannel.provisionAddress(recipient.lane, recipient.address));
      }
    }
    const authToken =
      externalCommsConfig.authTokenEnv === undefined
        ? undefined
        : env[externalCommsConfig.authTokenEnv];
    const collected = await collectExternalCommsThread({
      external: { ...externalCommsConfig, ...(authToken === undefined ? {} : { authToken }) },
      channel: commsChannel,
      inboxes: commsInboxes,
    });
    if (collected.artifact) {
      const commsPath = "comms/thread.json";
      await writeContainedOutputFile(
        runPaths,
        commsPath,
        `${JSON.stringify(collected.artifact, null, 2)}\n`,
        "utf8",
      );
      for (const [index, outcome] of outcomes.entries()) {
        const laneId = laneSpecs[index]?.planned.id;
        if (
          laneId !== undefined &&
          outcome.commsArtifactPath === undefined &&
          laneHasInboxRecipient(externalCommsEmail, laneId)
        ) {
          outcome.commsArtifactPath = commsPath;
        }
      }
    } else if (collected.captured > 0) {
      warnings.push(
        `Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`,
      );
    } else {
      warnings.push(
        `Comms catch captured ZERO email sends — your app never delivered mail through the catch at ${externalCommsConfig.catchBaseUrl}. Verify the app's email-API base URL points at it and that the flow reached an email step.`,
      );
    }
  } catch (error) {
    warnings.push(
      `Comms evidence collection failed against the adopter-hosted catch (run continues): ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
    );
  }
  return warnings;
}
