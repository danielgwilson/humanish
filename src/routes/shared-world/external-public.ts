// EXTERNAL-PUBLIC plane (#164 phase 2): NO subject sandbox, NO getHost, NO prober. The shared plane
// is the operator-declared public deployment (publicAppUrl); each seat opens it directly and reaches
// the shared session through the real UI. A host-first barrier extracts the /lobby/CODE from the host
// seat's CDP-observed URL (onObservedUrl) and threads it into the follower missions; a follower fails
// closed WITHOUT opening if the host never yields a code within the handoff deadline.

import { liveObserverResult } from "../../observer/live.js";
import { redactText, toErrorMessage } from "../../evidence/redaction.js";
import { mapWithConcurrency } from "../../run/concurrency.js";
import { buildConcurrentSharedWorldBundle, judgeSharedWorldRun } from "./bundle.js";
import { drainExternalComms } from "./comms.js";
import { LobbyHandoff, runFollowerLane, runHostLane, type HandoffSeatDeps } from "./handoff.js";
import { readLobbyCodeFromFrame } from "./lobby-code.js";
import { hostOriginDigest } from "./provenance.js";
import { seatLaneDeps, startSeatFlush } from "./seats.js";
import type {
  ActorLaneResult,
  ConcurrentBundleArgs,
  ExternalCommsWiring,
  LiveSeats,
  PlaneContext,
} from "./types.js";

/** What the external-public plane hands back to the orchestrator. */
export interface ExternalPublicPlaneOutcome {
  actorResults: ActorLaneResult[];
  runError: string | undefined;
  publicOriginDigest: string | undefined;
  lobbyConvergenceDigest: string | undefined;
  handoffTimedOut: boolean;
  hostHandoffFailure: string | undefined;
  /** Set when the adopter-hosted drain wrote a thread. */
  commsArtifactPath: string | undefined;
}

/**
 * The operator-DECLARED origin (from subject.appUrl) — recorded for evidence/reference ONLY. The
 * operator-OWNERSHIP claim rests on the subject.publicTarget.authorized attestation + this declared
 * appUrl, NOT on digest equality (blocker 2): a normal cross-origin redirect (apex->www, http->https;
 * lobby-trivia.example.test 307-redirects) makes the seats' OBSERVED origin differ from the declared one, which
 * is expected and MUST NOT fail the run. Persisted digest-only (never the raw origin).
 */
export function declaredOriginDigestOf(publicAppUrl: string): string | undefined {
  return publicAppUrl ? hostOriginDigest(publicAppUrl) : undefined;
}

export async function runExternalPublicPlane(
  ctx: PlaneContext,
  live: LiveSeats,
  inbox: ExternalCommsWiring | undefined,
): Promise<ExternalPublicPlaneOutcome> {
  const { plan, hooks, actorSpecs, concurrency, warnings } = ctx;
  const participants = plan.plane.participants;
  // publicAppUrl is the operator-declared shared plane; its ORIGIN is persisted digest-only
  // (publicOriginDigest), never raw (the raw URL + the runtime observed lobby CODE never land —
  // TENSION 3). The latch code is scrubbed from all narration.
  const publicAppUrl = plan.plane.kind === "external-public" ? plan.plane.appUrl : "";
  const declaredOriginDigest = declaredOriginDigestOf(publicAppUrl);
  const handoff = new LobbyHandoff({
    seatCount: participants.length,
    timeoutMs: ctx.timeoutMs,
    deadlineMs: hooks.handoffDeadlineMs,
    scrubKnownValues: ctx.scrubKnownValues,
    // The per-seat vision lobby-code reader (default: the real single-frame OpenAI read). Injectable
    // so the barrier's handoff + convergence proof are testable without a live vision call.
    readLobbyCode: hooks.readLobbyCodeFromFrame ?? readLobbyCodeFromFrame,
    openaiApiKey: ctx.openaiApiKey,
  });
  const deps: HandoffSeatDeps = {
    // Scrub the latched lobby CODE (known once the host resolves it) from ALL narration.
    laneDeps: seatLaneDeps(ctx, live, handoff.scrub),
    publicAppUrl,
    inbox,
    now: ctx.now,
  };

  // Publish the in-progress bundle and attach any live Observer before fan-out, as on the
  // provisioned path.
  const snapshotArgs: Omit<ConcurrentBundleArgs, "judgment"> = {
    plan,
    descriptor: ctx.descriptor,
    createdAt: ctx.createdAt,
    dryRun: false,
    inProgress: true,
    runId: ctx.runId,
    source: ctx.source,
    actorSpecs,
    actorResults: [],
    stateSnapshots: [],
    subject: { source: "app-url", envNames: [], state: { provenance: "external-public" } },
    seedDigest: ctx.seedDigest,
    planeClass: "external-public",
    // Pre-fan-out snapshot: no seat has observed an origin yet, so the OBSERVED publicOriginDigest
    // is not available; surface the DECLARED origin for the live Observer's reference.
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
  startSeatFlush(ctx, live, inProgressBundle);

  // The host-first handoff barrier.
  handoff.startDeadline();
  let actorResults: ActorLaneResult[] = [];
  let runError: string | undefined;
  let commsArtifactPath: string | undefined;
  // Split the roster into the designated host lane and the followers, preserving each follower's
  // ORIGINAL lane index so results land back in lane order (validation guarantees EXACTLY ONE host).
  const hostLaneIndex = participants.findIndex((participant) => participant.host === true);
  const followerEntries = actorSpecs
    .map((spec, index) => ({ spec, index }))
    .filter(({ index }) => index !== hostLaneIndex);
  const laneResults: ActorLaneResult[] = new Array(actorSpecs.length);
  try {
    const hostPromise =
      hostLaneIndex >= 0 && actorSpecs[hostLaneIndex] !== undefined
        ? runHostLane(handoff, deps, actorSpecs[hostLaneIndex]!, hostLaneIndex)
        : undefined;
    const followerResultsPromise = mapWithConcurrency(
      followerEntries,
      Math.max(1, concurrency - 1),
      ({ spec, index }) => runFollowerLane(handoff, deps, spec, index),
    );
    const [hostResult, followerResults] = await Promise.all([hostPromise, followerResultsPromise]);
    if (hostResult !== undefined && hostLaneIndex >= 0) {
      laneResults[hostLaneIndex] = hostResult;
    }
    followerEntries.forEach((entry, i) => {
      laneResults[entry.index] = followerResults[i]!;
    });
    actorResults = laneResults;
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
    runError = `The host seat never produced a /lobby/CODE URL within the ${handoff.deadlineMs}ms handoff deadline; follower seats failed closed without opening.`;
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
