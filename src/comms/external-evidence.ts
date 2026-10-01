// An adopter-hosted catch's thread, collected into a run. The computer-use and shared-world routes
// both call this, so a failed collection is scrubbed the same way on both: the error text can quote
// a provisioned value or the catch's bearer token, and neither has a secret's shape for pattern
// redaction to find.

import { redactText, scrubLiterals, toErrorMessage } from "../evidence/redaction.js";
import { addressedRecipients } from "../lab/parse/comms.js";
import type { LabCommsEmail, LabCommsExternal } from "../lab/types.js";
import { writeContainedOutputFile } from "../run/contained-output.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { FakeInbox } from "./fake-inbox.js";
import { collectExternalCommsThread } from "./sandbox-catch.js";
import type { CommsAddress } from "./types.js";

/**
 * Drains the catch, routes its sends to the declared recipients' inboxes and writes the thread to
 * `comms/thread.json`. Returns that path when a message matched, and the warnings to add to the
 * run. It never throws: the run continues without comms evidence.
 */
export async function collectExternalCommsEvidence(args: {
  external: LabCommsExternal;
  email: LabCommsEmail;
  env: Record<string, string | undefined>;
  runPaths: PreparedRunArtifactPaths;
  /** The run's literal scrub of its known secret values. */
  scrubKnownValues: (text: string) => string;
}): Promise<{ path?: string; warnings: string[] }> {
  const { external, email, env, runPaths, scrubKnownValues } = args;
  const authToken = external.authTokenEnv === undefined ? undefined : env[external.authTokenEnv];
  // The same 4-character floor as the routes' known values: a shorter literal would scrub common
  // text, and an empty one would split every character.
  const scrubToken = scrubLiterals(
    authToken !== undefined && authToken.length >= 4 ? [authToken] : [],
  );
  try {
    const channel = new FakeInbox();
    const inboxes: CommsAddress[] = [];
    for (const recipient of addressedRecipients(email)) {
      inboxes.push(await channel.provisionAddress(recipient.participantId, recipient.address));
    }
    const collected = await collectExternalCommsThread({
      external: { ...external, ...(authToken === undefined ? {} : { authToken }) },
      channel,
      inboxes,
    });
    if (collected.artifact) {
      const path = "comms/thread.json";
      await writeContainedOutputFile(
        runPaths,
        path,
        `${JSON.stringify(collected.artifact, null, 2)}\n`,
        "utf8",
      );
      return { path, warnings: [] };
    }
    if (collected.captured > 0) {
      return {
        warnings: [
          `Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`,
        ],
      };
    }
    return {
      warnings: [
        `Comms catch captured ZERO email sends — your app never delivered mail through the catch at ${external.catchBaseUrl}. Verify the app's email-API base URL points at it and that the flow reached an email step.`,
      ],
    };
  } catch (error) {
    return {
      warnings: [
        `Comms evidence collection failed against the adopter-hosted catch (run continues): ${redactText(scrubKnownValues(scrubToken(toErrorMessage(error))))}`,
      ],
    };
  }
}
