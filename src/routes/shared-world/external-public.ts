// External-public plane: no subject sandbox, no getHost, no prober. The shared plane is the
// operator-declared public deployment (publicAppUrl); each participant opens it directly and
// reaches the shared session through the real UI. A host-first barrier extracts the /lobby/CODE
// from the host's CDP-observed URL (onObservedUrl) and threads it into the follower missions; a
// follower fails closed without opening if the host never yields a code within the handoff
// deadline.

import { liveObserverResult } from "../../observer/live.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import { mapWithConcurrency } from "../../run/concurrency.js";
import { buildConcurrentSharedWorldBundle, judgeSharedWorldRun } from "./bundle.js";
import { drainExternalComms } from "./comms.js";
import { LobbyHandoff, runFollower, runHost, type HandoffParticipantDeps } from "./handoff.js";
import { readLobbyCodeFromFrame } from "./lobby-code.js";
import { hostOriginDigest } from "./provenance.js";
import { participantRunDeps, startParticipantFlush } from "./participant-specs.js";
import type {
  ActorRunResult,
  ConcurrentBundleArgs,
  ExternalCommsWiring,
  LiveParticipants,
  PlaneContext,
} from "./types.js";

/** What the external-public plane hands back to the orchestrator. */
export interface ExternalPublicPlaneOutcome {
  actorResults: ActorRunResult[];
  runError: string | undefined;
  publicOriginDigest: string | undefined;
  lobbyConvergenceDigest: string | undefined;
  handoffTimedOut: boolean;
  hostHandoffFailure: string | undefined;
  /** Set when the adopter-hosted drain wrote a thread. */
  commsArtifactPath: string | undefined;
}

/**
 * The operator-declared origin (from subject.appUrl), recorded for evidence and reference only. The
 * operator-ownership claim rests on the subject.publicTarget.authorized attestation + this declared
 * appUrl; digest equality plays no part: a normal cross-origin redirect (apex->www, http->https;
 * lobby-trivia.example.test 307-redirects) makes the participants' observed origin differ from the
 * declared one, which is expected and must not fail the run. Persisted digest-only (never the raw
 * origin).
 */
export function declaredOriginDigestOf(publicAppUrl: string): string | undefined {
  return publicAppUrl ? hostOriginDigest(publicAppUrl) : undefined;
}

export async function runExternalPublicPlane(
  ctx: PlaneContext,
  live: LiveParticipants,
  inbox: ExternalCommsWiring | undefined,
): Promise<ExternalPublicPlaneOutcome> {
  const { plan, deps: seams, actorSpecs, concurrency, warnings } = ctx;
  const participants = plan.plane.participants;
  // publicAppUrl is the operator-declared shared plane; its origin is persisted digest-only
  // (publicOriginDigest), never raw (the raw URL and the runtime observed lobby code never land in
  // the bundle). The latch code is scrubbed from all narration.
  const publicAppUrl = plan.plane.kind === "external-public" ? plan.plane.appUrl : "";
  const declaredOriginDigest = declaredOriginDigestOf(publicAppUrl);
  const handoff = new LobbyHandoff({
    participantCount: participants.length,
    timeoutMs: ctx.timeoutMs,
    deadlineMs: seams.handoffDeadlineMs,
    scrubKnownValues: ctx.scrubKnownValues,
    // The per-participant vision lobby-code reader (default: the real single-frame OpenAI read).
    // Injectable so the barrier's handoff + convergence proof are testable without a live vision
    // call.
    readLobbyCode: seams.readLobbyCodeFromFrame ?? readLobbyCodeFromFrame,
    openaiApiKey: ctx.openaiApiKey,
  });
  const deps: HandoffParticipantDeps = {
    // Scrub the latched lobby code (known once the host resolves it) from all narration.
    runDeps: participantRunDeps(ctx, live, handoff.scrub),
    publicAppUrl,
    inbox,
    now: ctx.now,
  };

  // Publish the in-progress bundle and attach any live Observer before fan-out, as on the
  // provisioned path.
  const snapshotArgs: Omit<ConcurrentBundleArgs, "judgment"> = {
    plan,
    run: ctx.run,
    descriptor: ctx.descriptor,
    dryRun: false,
    inProgress: true,
    source: ctx.source,
    actorSpecs,
    actorResults: [],
    stateSnapshots: [],
    subject: { source: "app-url", envNames: [], state: { provenance: "external-public" } },
    seedDigest: ctx.seedDigest,
    planeClass: "external-public",
    // Pre-fan-out snapshot: no participant has observed an origin yet, so the observed
    // publicOriginDigest is not available; surface the declared origin for the live Observer's
    // reference.
    ...(declaredOriginDigest === undefined ? {} : { declaredOriginDigest }),
  };
  const inProgressBundle = buildConcurrentSharedWorldBundle({
    ...snapshotArgs,
    judgment: judgeSharedWorldRun(snapshotArgs),
  });
  await ctx.run.writeSnapshot(inProgressBundle);
  if (ctx.input.onObserverReady) {
    live.observer = liveObserverResult(ctx.cwd, ctx.runId, ctx.artifactRoot, [
      "Live external-public concurrent shared-world Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted.",
    ]);
    await ctx.input.onObserverReady(live.observer);
  }
  startParticipantFlush(ctx, live, inProgressBundle);

  // The host-first handoff barrier.
  handoff.startDeadline();
  let actorResults: ActorRunResult[] = [];
  let runError: string | undefined;
  let commsArtifactPath: string | undefined;
  // Split the roster into the designated host and the followers, preserving each follower's
  // original plan index so results land back in plan order (validation allows exactly one host).
  const hostIndex = participants.findIndex((participant) => participant.host === true);
  const followerEntries = actorSpecs
    .map((spec, index) => ({ spec, index }))
    .filter(({ index }) => index !== hostIndex);
  const orderedResults: ActorRunResult[] = new Array(actorSpecs.length);
  try {
    const hostPromise =
      hostIndex >= 0 && actorSpecs[hostIndex] !== undefined
        ? runHost(handoff, deps, actorSpecs[hostIndex]!, hostIndex)
        : undefined;
    const followerResultsPromise = mapWithConcurrency(
      followerEntries,
      Math.max(1, concurrency - 1),
      ({ spec, index }) => runFollower(handoff, deps, spec, index),
    );
    const [hostResult, followerResults] = await Promise.all([hostPromise, followerResultsPromise]);
    if (hostResult !== undefined && hostIndex >= 0) {
      orderedResults[hostIndex] = hostResult;
    }
    followerEntries.forEach((entry, i) => {
      orderedResults[entry.index] = followerResults[i]!;
    });
    actorResults = orderedResults;
  } catch (error) {
    runError = redactText(handoff.scrub(toErrorMessage(error)));
    warnings.push(
      `External-public concurrent shared-world run failed before completion: ${runError}`,
    );
  } finally {
    handoff.stopDeadline();
    if (inbox) commsArtifactPath = await drainExternalComms(ctx, inbox);
  }

  const { publicOriginDigest, lobbyConvergenceDigest } = handoff.convergence(declaredOriginDigest);
  if (handoff.timedOut && runError === undefined) {
    runError = `The host participant never produced a /lobby/CODE URL within the ${handoff.deadlineMs}ms handoff deadline; follower participants failed closed without opening.`;
  }
  return {
    actorResults,
    runError,
    publicOriginDigest,
    lobbyConvergenceDigest,
    handoffTimedOut: handoff.timedOut,
    hostHandoffFailure: handoff.hostFailure,
    commsArtifactPath,
  };
}
