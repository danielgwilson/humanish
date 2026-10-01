// An adopter-hosted catch's thread, collected into a run. The computer-use and shared-world routes
// both call this, so every warning it returns is scrubbed the same way on both: an error or the
// catch URL can carry the catch's bearer token or a provisioned value, and neither has a secret's
// shape for pattern redaction to find.

import { redactText, toErrorMessage } from "../evidence/redaction.js";
import { scrubSecretValues } from "../evidence/secret-scrub.js";
import { addressedRecipients } from "../lab/parse/comms.js";
import type { LabCommsEmail, LabCommsExternal } from "../lab/types.js";
import { writeContainedOutputFile } from "../run/contained-output.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { FakeInbox } from "./fake-inbox.js";
import { collectExternalCommsThread } from "./sandbox-catch.js";
import type { CommsAddress } from "./types.js";

/**
 * The shortest catch bearer token humanish uses. The token guards GET /deliveries on a host the run
 * reaches over the network, so it must not be guessable: 16 random base64 characters are 96 bits.
 * The run also scrubs the token from every warning as a literal, and a short token would scrub
 * ordinary words.
 */
const MIN_CATCH_TOKEN_LENGTH = 16;

/** String.prototype.isWellFormed (ES2024, Node 20+); the ES2023 lib types do not declare it. */
function isWellFormed(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

/**
 * Why a catch token cannot be used, or undefined when it can. An unset or empty token is none. A
 * token that is not well-formed Unicode cannot be sent as a header or encoded as a URL, so it is
 * refused with the short ones.
 */
export function catchTokenRefusal(token: string | undefined): string | undefined {
  if (token === undefined || token.length === 0) return undefined;
  if (!isWellFormed(token))
    return "The comms catch token is not well-formed Unicode; use printable ASCII, such as the output of `openssl rand -hex 16`, on the catch and in the run.";
  if (token.length >= MIN_CATCH_TOKEN_LENGTH) return undefined;
  return `The comms catch token is ${token.length} characters; it must be at least ${MIN_CATCH_TOKEN_LENGTH}, such as the output of \`openssl rand -hex 16\`, on the catch and in the run.`;
}

/** The catch token the run sends: the value of `authTokenEnv`, when the lab names one. */
export function catchTokenOf(
  external: LabCommsExternal,
  env: Record<string, string | undefined>,
): string | undefined {
  return external.authTokenEnv === undefined ? undefined : env[external.authTokenEnv];
}

/**
 * Drains the catch, routes its sends to the declared recipients' inboxes and writes the thread to
 * `comms/thread.json`. Returns that path when a message matched, and the warnings to add to the
 * run, each scrubbed of the run's known secret values and the catch token, then redacted. It never
 * throws: the run continues without comms evidence.
 */
export async function collectExternalCommsEvidence(args: {
  external: LabCommsExternal;
  email: LabCommsEmail;
  env: Record<string, string | undefined>;
  runPaths: PreparedRunArtifactPaths;
  /** The run's known secret values. The route may add to it until the drain runs. */
  knownSecretValues: readonly string[];
}): Promise<{ path?: string; warnings: string[] }> {
  const { external, email, env, runPaths, knownSecretValues } = args;
  const authToken = catchTokenOf(external, env);
  // Pattern redaction alone until the literal scrub exists, so a warning built in the catch below
  // is never unredacted. The scrub is built inside the try, where a failure becomes that warning.
  let scrubbed = (warnings: string[]): string[] => warnings.map(redactText);
  try {
    const scrub = scrubSecretValues([
      ...knownSecretValues,
      ...(authToken === undefined ? [] : [authToken]),
    ]);
    scrubbed = (warnings) => warnings.map((warning) => redactText(scrub(warning)));
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
        warnings: scrubbed([
          `Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`,
        ]),
      };
    }
    return {
      warnings: scrubbed([
        `Comms catch captured ZERO email sends — your app never delivered mail through the catch at ${external.catchBaseUrl}. Verify the app's email-API base URL points at it and that the flow reached an email step.`,
      ]),
    };
  } catch (error) {
    return {
      warnings: scrubbed([
        `Comms evidence collection failed against the adopter-hosted catch (run continues): ${String(toErrorMessage(error))}`,
      ]),
    };
  }
}
