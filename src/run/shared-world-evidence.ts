// The sharedWorld block of run.json (humanish.shared-world.v1): the one shared plane, each
// participant's window, state snapshots and the interleaved timeline of checkpoints and turns.

import type { ParticipantIds } from "./participant-records.js";

export const SHARED_WORLD_SCHEMA = "humanish.shared-world.v1";

/** The shared service-plane provenance for a shared-world run: single commit + a
 *  seed-recipe digest + the provisioned env names (never values). */
export interface SharedWorldPlane {
  /** The cloned commit SHA of the shared plane (when the clone resolved one). */
  commit?: string;
  /** sha256-16 over the ordered seed-step command digests: the seeded-state recipe identity
   *  (not the runtime state). Pins "same seed recipe" across bundles. */
  seedDigest: string;
  /** Declared env names provisioned for the shared plane (values never surface). */
  envNames: string[];
  /**
   * Concurrent route only: sha256-16 of the harness-minted `getHost` URL's origin
   * (the first-class provisioned-subject target every actor drove). A digest replaces the
   * raw URL: a getHost URL embeds the (live) sandbox id and matches the publish-safety e2b-URL
   * redaction, so, like the stream URL and sandbox ids, it never lands raw in a published
   * bundle (the raw tokenless URL is surfaced only on the ephemeral study result). The orchestrator
   * confirms the URL is tokenless (no authKey, so no secret reaches the bundle) before digesting.
   * verify proves every actor drove this host by digest equality. Absent on the sequential route.
   */
  hostDigest?: string;
  /**
   * Concurrent route only: the author's required attestation that the subject behind the
   * internet-reachable getHost URL is synthetic seeded data. This is author-trust + a
   * provenance gate; it does not guarantee the data is synthetic. Verify fails closed if absent on the concurrent route.
   *
   * Forbidden on the external-public plane class: claiming synthetic on a real public site the
   * harness neither provisioned nor exposed would be false (verify asserts it is absent there).
   */
  exposure?: "synthetic";
  /**
   * External-public plane class only: sha256-16 of the observed origin the participants
   * converged on. It is the counterpart of hostDigest with a weaker, disclosed claim: the harness only
   * observes that each participant reached this origin and never minted it. It is derived from what
   * the participants actually reached; the declared appUrl does not feed it. verify proves every
   * laneWindow.routeHostDigest (that participant's CDP-observed final URL origin) equals it, which
   * shows cross-participant convergence on one observed origin, not harness control of the plane. A
   * digest, not the raw origin (kept consistent with hostDigest hygiene). Absent on getHost.
   */
  publicOriginDigest?: string;
  /**
   * External-public plane class only: sha256-16 of the operator-declared origin (from subject.appUrl),
   * recorded for reference/evidence only. It is never asserted equal to publicOriginDigest: a normal
   * cross-origin redirect (apex->www, http->https) makes the observed origin differ from the declared
   * one, which is expected. Operator ownership rests on the subject.publicTarget.authorized attestation
   * + the declared appUrl; digest equality plays no part. Only the digest is stored. Absent on getHost.
   */
  declaredOriginDigest?: string;
}

/**
 * Concurrent shape: one actor's harness-clocked activity window against the one
 * shared plane. Overlapping windows mechanically prove ≥2 personas were active simultaneously.
 * `laneWindows` and `stateSeries` are independent series. There is deliberately no per-delta→actor
 * field, because under concurrency the evidence cannot say which actor caused a state change.
 */
export interface SharedWorldParticipantWindow {
  roleId: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  /** Resolves to a real RunSimulation in this bundle. */
  simId: string;
  /** Resolves to a real RunStream (the actor's trace) in this bundle. */
  streamId: string;
  /** ms on the one harness clock: the wrapped [start,end] the orchestrator measured. */
  startedAt: number;
  endedAt: number;
  /** The actor's terminal session verdict (per-persona). */
  verdict: string;
  /** sha256-16 of the origin of the getHost participant URL this actor drove. verify confirms it
   *  equals plane.hostDigest, so the actor drove exactly the harness-minted host. A digest, not the
   *  raw URL (a getHost URL is not publish-safe; see SharedWorldPlane.hostDigest). */
  routeHostDigest: string;
  /** The shared plane's commit this actor observed (omitted when unresolved). */
  commit?: string;
  /** The shared plane's seed-recipe digest this actor observed. */
  seedDigest: string;
}

/** Concurrent shape: one cadence checkpoint of the shared world under load. Digest-only: the
 *  allowed-keys tripwire (SHARED_WORLD_STATESERIES_KEYS) permits only {timestamp, digest}. */
export interface SharedWorldStateSnapshot {
  /** ms on the one harness clock. */
  timestamp: number;
  /** sha256-16 of the (scrubbed, redacted) combined probe output at this snapshot. */
  digest: string;
}

/** Concurrent shape: one persona's outcome against the contended world (the "M of N" headline). */
export interface SharedWorldOutcome {
  roleId: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  simId: string;
  streamId: string;
  /** Terminal session status. */
  status: string;
  completionReason?: string;
  /** Reached its goal (terminal, engaged, no harness error). */
  ok: boolean;
}

/**
 * The fields a window and an outcome start with, in the saved order: the participant id saved as
 * `roleId`, its taxonomy labels when declared, then its record and stream ids.
 */
export function sharedWorldParticipantKeys(
  ids: ParticipantIds,
  participantId: string,
  labels: { readonly actorType?: string; readonly surface?: string; readonly caseGroup?: string },
): Pick<
  SharedWorldOutcome,
  "roleId" | "actorType" | "surface" | "caseGroup" | "simId" | "streamId"
> {
  return {
    roleId: participantId,
    ...(labels.actorType === undefined ? {} : { actorType: labels.actorType }),
    ...(labels.surface === undefined ? {} : { surface: labels.surface }),
    ...(labels.caseGroup === undefined ? {} : { caseGroup: labels.caseGroup }),
    simId: ids.recordId,
    streamId: ids.streamId,
  };
}

/** A timeline checkpoint: a read-only digest probe of the shared plane at one moment. Persisted
 *  digest-only: `digest` is sha256-16(scrub+redact(stdout)); no raw value ever lands. */
export interface SharedWorldCheckpoint {
  kind: "checkpoint";
  /** "cp-baseline" for the baseline snapshot; "cp-after-<roleId>" after each role's turn. */
  name: string;
  /** sha256-16 of the (scrubbed, redacted) combined probe output at this snapshot. */
  digest: string;
  /** True when this snapshot's digest differs from the previous checkpoint's, meaning the observed
   *  state changed across the intervening turn (the delta is attributed to the whole turn). */
  deltaFromPrev: boolean;
}

/** A timeline turn: one participant's session against the shared plane. Carries the plane
 *  provenance it observed (identical across turns by construction: the single-plane proof). */
interface SharedWorldTurn {
  kind: "turn";
  roleId: string;
  /** Resolves to a real RunSimulation in this bundle. */
  simId: string;
  /** Resolves to a real RunStream (the role's actor trace) in this bundle. */
  streamId: string;
  /** The shared plane's commit the role observed (omitted when unresolved). */
  commit?: string;
  /** The shared plane's seed-recipe digest the role observed. */
  seedDigest: string;
}

type SharedWorldTimelineEntry = SharedWorldCheckpoint | SharedWorldTurn;

/** Declared participants that were never started after one executed sequential role stopped the
 * run. The executed timeline plus this ordered tail must account for every declared sim/stream. */
interface SharedWorldSkippedTail {
  afterRoleId: string;
  roles: Array<{ roleId: string; simId: string; streamId: string }>;
  cause: "harness_error" | "session_error" | "usage_unreported" | "study_spend_limit";
  /** Present only for a measured aggregate threshold; estimates, not provider billing. */
  maxTotalUsd?: number;
  estimatedTotalUsd?: number;
}

/**
 * The shared-world evidence block (`humanish.shared-world.v1`). Two variants discriminated by
 * `topologyMode`, which is named so it does not collide with `RunBundle.mode` (dry-run|live):
 *
 * - Sequential (`topologyMode: "sequential"`): `sequence` + an alternating `timeline`
 *   (cp-baseline → turn → cp → … → cp); limits `sequential-only` etc. No route writes it since
 *   0.106.0; verify still reads it so older bundles keep verifying.
 * - Concurrent (`topologyMode: "concurrent"`): `laneWindows` + `stateSeries` +
 *   `outcomes`; limits `concurrent` etc. No `timeline`.
 *
 * Additive + optional on `humanish.run-bundle.v1`: absent on every non-shared-world bundle.
 * The mandatory `attributionLimits` are verify-enforced (fail closed on a missing required or a
 * present forbidden limit).
 */
export interface SharedWorldEvidence {
  schema: typeof SHARED_WORLD_SCHEMA;
  topology: "shared-world";
  /** The substrate discriminator. Branched on first by sharedWorldEvidenceFindings. */
  topologyMode: "sequential" | "concurrent";
  /**
   * Concurrent route only: the plane-class discriminator. Absent == the historical
   * "provisioned-getHost" plane (a clone/local-tree subject served + getHost-exposed in-sandbox; the
   * harness minted the host; synthetic-seeded attestation + authoritative in-sandbox checkpoint
   * stateSeries). "external-public" == a real operator-owned public deployment used directly as the
   * plane (no getHost/clone/seed; the operator attests it and the harness does not control it; no authoritative
   * shared-state proof: concurrency evidenced by temporal co-occupancy + observed lobby convergence).
   * verify gates every getHost-specific assertion on this discriminator; existing bundles omit it and
   * default to provisioned-getHost, byte-stable.
   */
  planeClass?: "provisioned-getHost" | "external-public";
  /** The declared number of participants. */
  roleCount: number;
  plane: SharedWorldPlane;
  /** The pinned, verify-enforced attribution ceiling (the set differs per topologyMode/planeClass). */
  attributionLimits: string[];
  /**
   * External-public plane class only (optional-but-strong): sha256-16 of the shared
   * `/lobby/CODE` path every participant's CDP-observed URL converged on: the concrete "they were
   * in one shared world" proof, observation-derived and needing no subject change. Digest-only (the
   * raw 6-char lobby code and full URLs are runtime-only and never land). Absent when participants
   * did not converge.
   */
  lobbyConvergenceDigest?: string;
  // --- Sequential shape ---
  /** The role ids that actually took a turn, in declared order. */
  sequence?: string[];
  timeline?: SharedWorldTimelineEntry[];
  /** Explicit unstarted suffix; absent on historical/full-execution bundles. */
  skippedTail?: SharedWorldSkippedTail;
  // --- Concurrent shape ---
  /** Per-actor harness-clocked windows (overlap proves simultaneity). */
  laneWindows?: SharedWorldParticipantWindow[];
  /** Cadence digests of the shared world under load (baseline + periodic + final). */
  stateSeries?: SharedWorldStateSnapshot[];
  /** Per-persona outcomes (the "M of N succeeded" headline). */
  outcomes?: SharedWorldOutcome[];
}

/** A participant's time on the plane, in ms on the harness clock, as laneWindows record it. */
interface ParticipantWindow {
  startedAt: number;
  endedAt: number;
}

/** Where two participant windows overlap in time, the start of each overlap (the later of the two starts). */
function overlapStarts(windows: readonly ParticipantWindow[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i]!;
      const b = windows[j]!;
      if (a.startedAt < b.endedAt && b.startedAt < a.endedAt)
        starts.push(Math.max(a.startedAt, b.startedAt));
    }
  }
  return starts;
}

/**
 * What a shared-world run shows about concurrency, as verify's pass gate and the judge both read
 * it: whether two or more participants were live at once, and, when the plane keeps a state series
 * (the provisioned plane), whether the state changed at or after the first overlap started.
 */
export function concurrencyFacts(
  windows: readonly ParticipantWindow[],
  stateSeries: readonly SharedWorldStateSnapshot[] | undefined,
): { overlap: boolean; stateChangedUnderOverlap?: boolean } {
  const starts = overlapStarts(windows);
  const overlap = starts.length > 0;
  if (stateSeries === undefined) return { overlap };
  if (!overlap) return { overlap, stateChangedUnderOverlap: false };
  const earliestOverlapStart = Math.min(...starts);
  const sorted = [...stateSeries].sort((x, y) => x.timestamp - y.timestamp);
  const stateChangedUnderOverlap = sorted.some(
    (snapshot, i) =>
      i > 0 &&
      snapshot.digest !== sorted[i - 1]!.digest &&
      snapshot.timestamp >= earliestOverlapStart,
  );
  return { overlap, stateChangedUnderOverlap };
}
