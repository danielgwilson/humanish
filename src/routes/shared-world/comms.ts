// Off-app comms for the concurrent shared-world route: which email catch a plane gets (in the
// subject sandbox, or adopter-hosted), and the drains that match captured mail to the seats'
// declared inboxes and write the digest-only thread.

import {
  catchTokenOf,
  catchTokenRefusal,
  collectExternalCommsEvidence,
} from "../../comms/external-evidence.js";
import { FakeInbox } from "../../comms/fake-inbox.js";
import { prepareReceivingRun, type ReceivingSource } from "../../comms/receiving-runtime.js";
import type { SharedWorldPlan } from "../../lab/plan-types.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import {
  DEFAULT_SANDBOX_CATCH_PORT,
  collectCommsThread,
  externalCatchHealthy,
  externalInboxUrl,
  type DeployedCommsCatch,
} from "../../comms/sandbox-catch.js";
import type { CommsAddress } from "../../comms/types.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { LabCommsEmail, LabConfig } from "../../lab/types.js";
import { writeContainedOutputFile } from "../../run/contained-output.js";
import type { Shell } from "../../substrates/shell.js";
import type {
  ConcurrentSharedWorldPlaneClass,
  ExternalCommsWiring,
  PlaneContext,
} from "./types.js";
import { addressedRecipients } from "../../lab/parse/comms.js";

/** The in-sandbox email catch a provisioned plane deploys, when the lab declares one. */
export interface SubjectComms {
  email: LabCommsEmail | undefined;
  port: number | undefined;
  /** The catch's base URL, injected into the subject sandbox's env at create. */
  env: Record<string, string>;
}

// Off-app comms (#297): on the provisioned-getHost plane the harness owns the ONE subject sandbox, so
// it can redirect the app's email-API sends into an in-sandbox catch and evidence them. Gated ENTIRELY
// on config.comms — no comms declared → zero change. The base-URL env is injected into the subject
// sandbox at create (fixed port known up front); the catch is deployed before serve; the drain + digest
// evidence run at subject teardown, then register run-level in the bundle. NOT available on the
// external-public plane (the app is an operator-owned deployment the harness never provisions).
export function subjectCommsOf(
  config: Pick<LabConfig, "comms">,
  planeClass: ConcurrentSharedWorldPlaneClass,
): SubjectComms {
  const commsEmail =
    planeClass === "provisioned-getHost" && config.comms?.email?.kind === "fake"
      ? config.comms.email
      : undefined;
  const commsPort = commsEmail ? (commsEmail.port ?? DEFAULT_SANDBOX_CATCH_PORT) : undefined;
  // injectEnv is absent on an adopter-hosted plane (#328): there is no subject env to inject
  // because the operator points their own app at their own catch.
  const commsEnv: Record<string, string> =
    commsEmail?.injectEnv !== undefined && commsPort !== undefined
      ? { [commsEmail.injectEnv]: `http://127.0.0.1:${commsPort}` }
      : {};
  return { email: commsEmail, port: commsPort, env: commsEnv };
}

/**
 * ADOPTER-HOSTED ingress (#328): on the external-public plane the harness provisions nothing, so
 * it cannot host a catch — but the OPERATOR can, and then humanish still does every other part of
 * the funnel: it tells each persona its address and inbox URL, drains the declared catch over
 * HTTP at teardown, and writes the same digest-only evidence. Declaring `external` is what turns
 * the previously-inert block into a working one. Returns an error message when the declared catch
 * does not answer as a humanish catch.
 */
export async function prepareExternalComms(
  config: Pick<LabConfig, "comms">,
  planeClass: ConcurrentSharedWorldPlaneClass,
  dryRun: boolean,
  warnings: string[],
  env: Record<string, string | undefined>,
): Promise<
  | { ok: true; wiring: ExternalCommsWiring | undefined }
  | {
      ok: false;
      code:
        | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_TOKEN_INVALID"
        | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_CATCH_UNREACHABLE";
      message: string;
    }
> {
  const externalComms =
    planeClass === "external-public" ? config.comms?.email?.external : undefined;
  const externalCommsEmail = externalComms ? config.comms?.email : undefined;
  if (
    config.comms?.email?.kind === "fake" &&
    planeClass === "external-public" &&
    externalComms === undefined
  ) {
    warnings.push(
      "comms.email is declared but this is the external-public plane (the shared plane is an operator-owned public deployment the harness does not provision) — the in-sandbox email catch cannot be deployed and no comms evidence is collected. Declare `comms.email.external` to host the catch yourself (#328).",
    );
  }
  if (!externalComms || !externalCommsEmail) return { ok: true, wiring: undefined };
  const inboxUrl = externalInboxUrl(externalComms);
  const tokenRefusal = catchTokenRefusal(catchTokenOf(externalComms, env));
  if (tokenRefusal !== undefined)
    return {
      ok: false,
      code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_TOKEN_INVALID",
      message: tokenRefusal,
    };
  // Fail closed BEFORE any actor sandbox is created: a comms lab whose catch is unreachable
  // collects nothing while every participant still spends. The probe asserts OUR service marker in
  // /health, so an adopter's proxy answering 200 for everything cannot pass for a catch.
  if (!dryRun && !(await externalCatchHealthy(externalComms))) {
    return {
      ok: false,
      code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_CATCH_UNREACHABLE",
      message: `The external comms catch or inbox is unreachable or incompatible (GET /health must identify humanish-comms-catch and advertise recipient-inbox-v1). Update humanish on the catch host and restart it with \`humanish comms catch\` on that host, or drop comms.email to run without the inbox funnel.`,
    };
  }
  return { ok: true, wiring: { external: externalComms, email: externalCommsEmail, inboxUrl } };
}

/**
 * Off-app comms evidence (#297): drain everything the in-sandbox catch captured, route it into a
 * host fake inbox addressed to the declared recipients, and write the run-level digest-only thread
 * artifact — while the subject is STILL alive, before it is killed. Wrapped so a drain error
 * never blocks teardown (invariant: all sandboxes torn down by id in the plane's finally). Returns
 * the thread's path when one was written.
 */
export async function drainSubjectComms(
  ctx: PlaneContext,
  commsEmail: LabCommsEmail,
  subjectShell: Shell,
  deployedComms: DeployedCommsCatch,
): Promise<string | undefined> {
  const { runPaths, warnings, requestTimeoutMs, scrubKnownValues } = ctx;
  try {
    const commsChannel = new FakeInbox();
    const commsInboxes: CommsAddress[] = [];
    for (const recipient of addressedRecipients(commsEmail)) {
      commsInboxes.push(
        await commsChannel.provisionAddress(recipient.participantId, recipient.address),
      );
    }
    const collected = await collectCommsThread({
      shell: subjectShell,
      deployed: deployedComms,
      channel: commsChannel,
      inboxes: commsInboxes,
      requestTimeoutMs,
    });
    if (collected.artifact) {
      await writeContainedOutputFile(
        runPaths,
        "comms/thread.json",
        `${JSON.stringify(collected.artifact, null, 2)}\n`,
        "utf8",
      );
      return "comms/thread.json";
    } else if (collected.captured > 0) {
      warnings.push(
        `Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`,
      );
    } else {
      // Zero captures is the silent-broken shape (#351): the app never posted to the catch.
      warnings.push(
        `Comms catch captured ZERO email sends — the app never delivered mail through the catch. Verify the app reads ${commsEmail.injectEnv} for its email API base URL (an SDK that ignores it sends real mail or throws) and that the flow reached an email step.`,
      );
    }
  } catch (error) {
    warnings.push(
      `Comms evidence collection failed (run continues; subject still torn down): ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
    );
  }
  return undefined;
}

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
  const { path, warnings } = await collectExternalCommsEvidence({
    external: comms.external,
    email: comms.email,
    env: ctx.env,
    runPaths: ctx.runPaths,
    knownSecretValues: ctx.knownSecretValues,
  });
  ctx.warnings.push(...warnings);
  return path;
}

/** What receiving guards: the lab's email declaration and the subject env names and values. */
export function receivingSourceOf(
  residual: SharedWorldPlan["residual"],
  env: readonly string[],
): ReceivingSource {
  const { comms } = residual;
  const { envValues } = residual.subject;
  return {
    ...(comms === undefined ? {} : { comms }),
    subject: { env, ...(envValues === undefined ? {} : { envValues }) },
  };
}

/**
 * Real email receiving, when the lab declares it on a live run. It registers the connection's
 * secrets with the run's scrub before any desktop starts. Returns the message the run fails with
 * when setup fails.
 */
export async function prepareEmailReceiving(args: {
  cwd: string;
  runId: string;
  source: ReceivingSource;
  env: Record<string, string | undefined>;
  participants: string[];
  runPaths: PlaneContext["runPaths"];
  knownSecretValues: string[];
  dryRun: boolean;
}): Promise<
  { ok: true; receiving: CommsReceivingRun | undefined } | { ok: false; message: string }
> {
  const { source, knownSecretValues } = args;
  if (args.dryRun || source.comms?.email?.kind !== "real")
    return { ok: true, receiving: undefined };
  try {
    const receiving = await prepareReceivingRun({
      cwd: args.cwd,
      runId: args.runId,
      config: source,
      env: args.env,
      participants: args.participants,
      runPaths: args.runPaths,
      registerSecrets: (values) => {
        for (const value of values)
          if (value.length >= 4 && !knownSecretValues.includes(value))
            knownSecretValues.push(value);
      },
    });
    return { ok: true, receiving };
  } catch {
    return {
      ok: false,
      message:
        "Real email setup failed before desktop allocation. Run humanish comms check --online and humanish comms recover to inspect authentication and pending cleanup.",
    };
  }
}
