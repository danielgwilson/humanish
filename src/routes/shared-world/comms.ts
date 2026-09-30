// Off-app comms evidence for the concurrent shared-world route: draining the email a comms catch
// captured, matching it to the seats' declared inboxes and writing the digest-only thread.

import { FakeInbox } from "../../comms/fake-inbox.js";
import { collectExternalCommsThread } from "../../comms/sandbox-catch.js";
import type { CommsAddress } from "../../comms/types.js";
import { redactText } from "../../evidence/redaction.js";
import { writeContainedOutputFile } from "../../run/selected-output-paths.js";
import { toErrorMessage } from "../../substrates/command-failure.js";
import type { ExternalCommsWiring, PlaneContext } from "./types.js";

/**
 * Adopter-hosted drain (#328/#387): same routing and digest-only artifact as the in-sandbox
 * catch — only the transport differs (HTTP GET /deliveries against the catch the operator
 * runs). Called in the plane's finally so the evidence survives a failed run; a drain error never
 * masks the run's own outcome. Returns the thread's path when one was written.
 */
export async function drainExternalComms(
  ctx: PlaneContext,
  comms: ExternalCommsWiring,
): Promise<string | undefined> {
  const { env, runPaths, warnings } = ctx;
  const externalComms = comms.external;
  const externalCommsEmail = comms.email;
  try {
    const commsChannel = new FakeInbox();
    const commsInboxes: CommsAddress[] = [];
    for (const recipient of externalCommsEmail.recipients ?? []) {
      if (recipient.address !== undefined) {
        commsInboxes.push(await commsChannel.provisionAddress(recipient.lane, recipient.address));
      }
    }
    const authToken =
      externalComms.authTokenEnv === undefined ? undefined : env[externalComms.authTokenEnv];
    const collected = await collectExternalCommsThread({
      external: { ...externalComms, ...(authToken === undefined ? {} : { authToken }) },
      channel: commsChannel,
      inboxes: commsInboxes,
    });
    if (collected.artifact) {
      const path = "comms/thread.json";
      await writeContainedOutputFile(
        runPaths,
        path,
        `${JSON.stringify(collected.artifact, null, 2)}\n`,
        "utf8",
      );
      return path;
    } else if (collected.captured > 0) {
      warnings.push(
        `Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`,
      );
    } else {
      warnings.push(
        `Comms catch captured ZERO email sends — your app never delivered mail through the catch at ${externalComms.catchBaseUrl}. Verify the app's email-API base URL points at it and that the flow reached an email step.`,
      );
    }
  } catch (error) {
    warnings.push(
      `Comms evidence collection failed against the adopter-hosted catch (run continues): ${redactText(toErrorMessage(error))}`,
    );
  }
  return undefined;
}
