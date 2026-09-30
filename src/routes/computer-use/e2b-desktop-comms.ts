// Off-app email for one E2B desktop lane (#297): the in-sandbox catch the subject app sends to, the
// persona's inbox surface, the real-email receiving surface, and the evidence drained at teardown.

import { setTimeout as delay } from "node:timers/promises";

import { buildOriginMap, type OriginMap } from "../../comms/capture-surface.js";
import { FakeInbox } from "../../comms/fake-inbox.js";
import { deployReceivingInbox } from "../../comms/receiving-surface.js";
import {
  DEFAULT_SANDBOX_CATCH_PORT,
  collectCommsThread,
  deployCommsCatch,
  refreshInboxSurface,
  writeInboxSurface,
  type DeployedCommsCatch,
} from "../../comms/sandbox-catch.js";
import type { CommsAddress } from "../../comms/types.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import type { LabCommsEmail, LabConfig } from "../../lab/types.js";
import { writeContainedOutputFile } from "../../run/selected-output-paths.js";
import type { Shell } from "../../substrates/shell.js";
import type { ReadyCuaDesktop } from "./desktop-lane.js";
import { inboxRecipientFor, laneHasInboxRecipient } from "./desktop-lane.js";
import type { CuaLaneDeps, CuaLaneSpec } from "./types.js";

/** Mid-run inbox-surface render cadence (ms). Coarse enough that the per-tick `cat` + file writes stay
 *  cheap; fine enough that a verification email is visible seconds after the app sends it. */
const INBOX_SURFACE_CADENCE_MS = 2500;

/** A lane's captured-email wiring, decided from config before the sandbox exists. */
export interface LaneComms {
  readonly email: LabCommsEmail;
  readonly port: number;
  readonly smtpPort: number | undefined;
  /** The loopback URL the persona opens to read captured mail. */
  readonly inboxUrl: string;
  readonly originMap: OriginMap;
  readonly surfaceRecipients: { lane: string; address: string }[];
}

/**
 * On an in-sandbox subject route, redirect the app's email-API sends into an in-sandbox catch
 * (loopback) so its verification mail is CAPTURED, not sent to the internet. Undefined when the
 * lab declares no fake email, which leaves the lane unchanged.
 */
export function planLaneComms(
  config: LabConfig,
  targetUrl: string,
  inSandboxSubject: boolean,
): LaneComms | undefined {
  const email =
    inSandboxSubject && config.comms?.email?.kind === "fake" ? config.comms.email : undefined;
  if (email === undefined) return undefined;
  const port = email.port ?? DEFAULT_SANDBOX_CATCH_PORT;
  // The origin-rewrite map is identity on this same-sandbox route, but covers localhost/0.0.0.0
  // alias skew and an operator-declared linkOrigin.
  return {
    email,
    port,
    smtpPort: email.smtp?.port,
    inboxUrl: `http://127.0.0.1:${port}/inbox`,
    originMap: buildOriginMap({
      ...(config.subject.serve?.url === undefined
        ? {}
        : { internalServeUrl: config.subject.serve.url }),
      reachableBaseUrl: targetUrl,
      ...(email.linkOrigin === undefined ? {} : { linkOrigin: email.linkOrigin }),
    }),
    surfaceRecipients: (email.recipients ?? [])
      .filter(
        (recipient): recipient is { lane: string; address: string } =>
          recipient.address !== undefined,
      )
      .map((recipient) => ({ lane: recipient.lane, address: recipient.address })),
  };
}

/** The env the subject app reads to reach the catch, injected at sandbox create so it boots with it. */
export function laneCommsEnv(comms: LaneComms | undefined): Record<string, string> {
  if (comms === undefined) return {};
  // injectEnv is absent on an adopter-hosted plane (#328): there is no subject env to inject
  // because the operator points their own app at their own catch.
  const env: Record<string, string> =
    comms.email.injectEnv === undefined
      ? {}
      : { [comms.email.injectEnv]: `http://127.0.0.1:${comms.port}` };
  // SMTP transport: the same idea as injectEnv, but an app that speaks SMTP needs a host and a port
  // rather than a base URL. The catch accepts any credentials (loopback only), yet many apps refuse
  // to boot unless the user/password vars exist at all, so those are injected when declared.
  const smtp = comms.email.smtp;
  if (smtp && comms.smtpPort !== undefined) {
    env[smtp.hostEnv] = "127.0.0.1";
    env[smtp.portEnv] = String(comms.smtpPort);
    if (smtp.userEnv) env[smtp.userEnv] = smtp.user ?? "humanish";
    if (smtp.passwordEnv) env[smtp.passwordEnv] = smtp.password ?? "humanish";
  }
  return env;
}

/** A started catch and the stop for its inbox-surface loop. */
export interface RunningCommsCatch {
  readonly deployed: DeployedCommsCatch;
  /** Stop the surface loop and wait for it; never throws. */
  stopSurface(): Promise<void>;
}

/**
 * Start the in-sandbox email catch before the subject serve, so the app's send-API base URL
 * resolves the moment it boots. A comms-declared lab that cannot stand the catch up fails closed
 * rather than silently sending real mail.
 */
export async function startCommsCatch(
  shell: Shell,
  comms: LaneComms,
  requestTimeoutMs: number,
): Promise<RunningCommsCatch> {
  const deployed = await deployCommsCatch(shell, {
    port: comms.port,
    ...(comms.smtpPort === undefined ? {} : { smtpPort: comms.smtpPort }),
    requestTimeoutMs,
  });
  if (!deployed.ready) {
    throw new Error(
      `comms email catch did not become ready on 127.0.0.1:${comms.port} in the subject sandbox`,
    );
  }
  // Write the EMPTY inbox once up front so the persona's /inbox always resolves to the "No messages
  // yet." page — never a bare 404 — the instant it navigates there, even before any mail arrives OR if
  // the app sends to an address no declared recipient matches (the loop only re-renders on new mail).
  await writeInboxSurface(shell, deployed.surfaceDir, [], {
    originMap: comms.originMap,
    requestTimeoutMs,
  });
  // The surface uses its OWN FakeInbox + cursor, independent of the teardown evidence drain (two
  // readers of the append-only NDJSON — no double-count).
  const stop = new AbortController();
  let renderedCount = 0;
  const loop = (async () => {
    // Render-first (so even a short session gets a populated inbox), then refresh on a cadence. The
    // cadence uses a REAL timer, NOT the injected instant clock: this loop is unbounded, so an instant
    // sleep would busy-spin and starve the session's own timers. `stop` interrupts the wait
    // (and clears the timer) so teardown never blocks for a full cadence. Each refresh
    // is a full, idempotent rebuild; `renderedCount` only advances on a SUCCESSFUL render so a
    // transient failure retries cleanly (no duplicate emails).
    for (;;) {
      try {
        const refreshed = await refreshInboxSurface({
          shell,
          deployed,
          recipients: comms.surfaceRecipients,
          sinceCount: renderedCount,
          originMap: comms.originMap,
          requestTimeoutMs,
        });
        if (refreshed.rendered) renderedCount = refreshed.count;
      } catch {
        // Never throw into the render loop; the teardown drain + by-id teardown must still run.
      }
      if (stop.signal.aborted) break;
      await delay(INBOX_SURFACE_CADENCE_MS, undefined, { signal: stop.signal }).catch(
        () => undefined,
      );
      if (stop.signal.aborted) break;
    }
  })();
  return {
    deployed,
    async stopSurface() {
      stop.abort();
      await loop.catch(() => undefined);
    },
  };
}

/** Stand up the real-email receiving surface and attach it to the lane; returns the inbox URL. */
export async function attachReceivingInbox(
  shell: Shell,
  spec: CuaLaneSpec,
  deps: CuaLaneDeps & { receiving: NonNullable<CuaLaneDeps["receiving"]> },
  targetUrl: string,
): Promise<string> {
  const { config } = deps;
  const surface = await deployReceivingInbox(shell, {
    leaseId: spec.streamId,
    requestTimeoutMs: Math.min(deps.requestTimeoutMs, 30_000),
  });
  const email = config.comms?.email;
  try {
    await deps.receiving.attach(spec.laneId, {
      surface,
      allowedOrigins: [...new Set([new URL(targetUrl).origin, ...(email?.allowedOrigins ?? [])])],
      originMap: buildOriginMap({
        ...(config.subject.serve?.url === undefined
          ? {}
          : { internalServeUrl: config.subject.serve.url }),
        reachableBaseUrl: targetUrl,
        ...(email?.linkOrigin === undefined ? {} : { linkOrigin: email.linkOrigin }),
      }),
    });
  } catch (error) {
    await surface.stop().catch(() => {});
    throw error;
  }
  return surface.url;
}

function optionalAddress(address: string | undefined): { address?: string } {
  return address === undefined ? {} : { address };
}

/** The inbox the persona is told about: real receiving, the captured catch, or an external inbox. */
export function laneInbox(args: {
  spec: CuaLaneSpec;
  deps: CuaLaneDeps;
  receivingInboxUrl: string | undefined;
  comms: LaneComms | undefined;
  catchReady: boolean;
}): ReadyCuaDesktop["inbox"] {
  const { spec, deps, receivingInboxUrl, comms } = args;
  if (deps.receiving && receivingInboxUrl)
    return {
      url: receivingInboxUrl,
      address: deps.receiving.address(spec.laneId),
      receiving: true,
    };
  if (comms && args.catchReady && laneHasInboxRecipient(comms.email, spec.laneId))
    return {
      url: comms.inboxUrl,
      ...optionalAddress(inboxRecipientFor(comms.email, spec.laneId)?.address),
    };
  if (deps.externalComms && laneHasInboxRecipient(deps.externalComms.email, spec.laneId))
    return {
      url: deps.externalComms.inboxUrl,
      ...optionalAddress(inboxRecipientFor(deps.externalComms.email, spec.laneId)?.address),
    };
  return undefined;
}

/**
 * Before this lane's sandbox is torn down, drain everything the in-sandbox catch captured, route it
 * into a host fake inbox addressed to the declared recipients, and write the digest-only thread
 * artifact. Returns the artifact path when one was written. A drain failure is a warning and never
 * breaks teardown: the sandbox must still be killed either way.
 */
export async function drainCommsEvidence(args: {
  shell: Shell;
  comms: LaneComms;
  deployed: DeployedCommsCatch;
  spec: CuaLaneSpec;
  deps: CuaLaneDeps;
  warnings: string[];
}): Promise<string | undefined> {
  const { comms, deps, spec, warnings } = args;
  try {
    const commsChannel = new FakeInbox();
    const commsInboxes: CommsAddress[] = [];
    for (const recipient of comms.email.recipients ?? []) {
      if (recipient.address !== undefined) {
        commsInboxes.push(await commsChannel.provisionAddress(recipient.lane, recipient.address));
      }
    }
    const collected = await collectCommsThread({
      shell: args.shell,
      deployed: args.deployed,
      channel: commsChannel,
      inboxes: commsInboxes,
      requestTimeoutMs: deps.requestTimeoutMs,
    });
    if (collected.artifact) {
      const path =
        deps.laneCount === 1 ? "comms/thread.json" : `comms/${spec.streamId}.thread.json`;
      await writeContainedOutputFile(
        deps.artifactRoot,
        path,
        `${JSON.stringify(collected.artifact, null, 2)}\n`,
        "utf8",
      );
      return path;
    }
    if (collected.captured > 0) {
      // Captured mail that matched no declared recipient must not vanish silently (invariant 6:
      // honest signals): tell the operator to declare comms.email.recipients[].address to match
      // the address the app actually sends to (e.g. the one the persona surface will sign up with).
      warnings.push(
        `Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`,
      );
    } else {
      // Zero captures is the silent-broken shape (#351): the app never posted to the catch at
      // all, so the personas stared at an empty inbox. Most common cause: the app does not
      // actually read the declared injectEnv var for its email API base URL.
      const transportHint = comms.email.smtp
        ? `Verify the app reads ${comms.email.smtp.hostEnv}/${comms.email.smtp.portEnv} for its SMTP host and port`
        : `Verify the app reads ${comms.email.injectEnv} for its email API base URL (an SDK that ignores it sends real mail or throws)`;
      warnings.push(
        `Comms catch captured ZERO email sends — the app never delivered mail through the catch. ${transportHint} and that the flow reached an email step.`,
      );
    }
  } catch (error) {
    warnings.push(
      `Comms evidence collection failed (run continues; sandbox still torn down): ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`,
    );
  }
  return undefined;
}
