// The sharedWorld block of run.json (humanish.shared-world.v1): the one shared plane, each seat's
// window, state snapshots and the interleaved timeline of checkpoints and turns.

export const SHARED_WORLD_SCHEMA = "humanish.shared-world.v1";

/** The ONE shared service-plane provenance for a shared-world run (#164): single commit + a
 *  seed-recipe digest + the provisioned env NAMES (values never). */
export interface SharedWorldPlane {
  /** The cloned commit SHA of the shared plane (when the clone resolved one). */
  commit?: string;
  /** sha256-16 over the ordered seed-step command digests — the seeded-state RECIPE identity
   *  (not the runtime state). Pins "same seed recipe" across bundles. */
  seedDigest: string;
  /** Declared env NAMES provisioned for the shared plane (values never surface). */
  envNames: string[];
  /**
   * CONCURRENT route only (#164 phase 2): sha256-16 of the harness-minted `getHost` URL's ORIGIN
   * (the first-class provisioned-subject target every actor drove — invariant 2). A DIGEST, not the
   * raw URL: a getHost URL embeds the (live) sandbox id and matches the publish-safety e2b-URL
   * redaction, so — like the stream URL and like sandbox ids — it never lands raw in a published
   * bundle (the raw tokenless URL is surfaced only on the ephemeral lab result). The orchestrator
   * confirms the URL is TOKENLESS (no authKey — invariant 1) before digesting. verify proves every
   * actor drove this host by digest equality. Absent on the sequential route.
   */
  hostDigest?: string;
  /**
   * CONCURRENT route only: the author's REQUIRED attestation that the subject behind the
   * internet-reachable getHost URL is synthetic seeded data (FIX-3). This is author-trust + a
   * provenance gate, NOT a no-real-data guarantee. Verify fails closed if absent on the concurrent route.
   *
   * FORBIDDEN on the external-public plane class: claiming synthetic on a real public site the
   * harness neither provisioned nor exposed would be a lie (verify asserts it ABSENT there).
   */
  exposure?: "synthetic";
  /**
   * EXTERNAL-PUBLIC plane class only (#164 phase 2): sha256-16 of the OBSERVED origin the seats
   * CONVERGED on (the honest analog of hostDigest, but WEAKER and disclosed — the harness only
   * OBSERVES that each seat reached this origin; it never MINTED it). It is derived from what the
   * seats actually reached, NOT from the declared appUrl: verify proves every laneWindow.routeHostDigest
   * (that seat's CDP-observed final URL origin) equals it — inter-seat convergence on ONE OBSERVED
   * origin, not harness control of the plane. A digest, not the raw origin (kept consistent with
   * hostDigest hygiene). Absent on getHost.
   */
  publicOriginDigest?: string;
  /**
   * EXTERNAL-PUBLIC plane class only: sha256-16 of the operator-DECLARED origin (from subject.appUrl),
   * recorded for reference/evidence ONLY. It is NEVER asserted equal to publicOriginDigest: a normal
   * cross-origin redirect (apex->www, http->https) makes the OBSERVED origin differ from the declared
   * one, which is expected. Operator OWNERSHIP rests on the subject.publicTarget.authorized attestation
   * + the declared appUrl, NOT on digest equality. A digest, not the raw origin. Absent on getHost.
   */
  declaredOriginDigest?: string;
}

/**
 * CONCURRENT shape (#164 phase 2): one actor's harness-clocked activity window against the ONE
 * shared plane. OVERLAPPING windows mechanically prove ≥2 personas were active simultaneously.
 * `laneWindows` and `stateSeries` are INDEPENDENT series — there is deliberately NO per-delta→actor
 * field (causation under concurrency is structurally inexpressible — FIX-7).
 */
export interface SharedWorldLaneWindow {
  roleId: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  /** Resolves to a real RunSimulation in this bundle. */
  simId: string;
  /** Resolves to a real RunStream (the actor's trace) in this bundle. */
  streamId: string;
  /** ms on the ONE harness clock — the wrapped [start,end] the orchestrator MEASURED (FIX-1). */
  startedAt: number;
  endedAt: number;
  /** The actor's terminal session verdict (per-persona). */
  verdict: string;
  /** sha256-16 of the ORIGIN of the getHost seat URL this actor drove. verify confirms it equals
   *  plane.hostDigest — i.e. the actor drove EXACTLY the harness-minted host (invariant 2; FIX-2).
   *  A digest, not the raw URL (a getHost URL is not publish-safe — see SharedWorldPlane.hostDigest). */
  routeHostDigest: string;
  /** The shared plane's commit this actor observed (omitted when unresolved). */
  commit?: string;
  /** The shared plane's seed-recipe digest this actor observed. */
  seedDigest: string;
}

/** CONCURRENT shape: one cadence checkpoint of the shared world under load. DIGEST-ONLY — the
 *  allowed-keys tripwire (SHARED_WORLD_STATESERIES_KEYS) permits ONLY {timestamp, digest}. */
export interface SharedWorldStateSnapshot {
  /** ms on the ONE harness clock. */
  timestamp: number;
  /** sha256-16 of the (scrubbed, redacted) combined probe output at this snapshot. */
  digest: string;
}

/** CONCURRENT shape: one persona's OUTCOME against the contended world (the "M of N" headline). */
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

/** A timeline checkpoint: a read-only digest probe of the shared plane at one moment. Persisted
 *  DIGEST-ONLY — `digest` is sha256-16(scrub+redact(stdout)); no raw value ever lands. */
export interface SharedWorldCheckpoint {
  kind: "checkpoint";
  /** "cp-baseline" for the baseline snapshot; "cp-after-<roleId>" after each role's turn. */
  name: string;
  /** sha256-16 of the (scrubbed, redacted) combined probe output at this snapshot. */
  digest: string;
  /** True when this snapshot's digest differs from the previous checkpoint's — the observed
   *  state changed across the intervening turn (delta attributed to the TURN, not an action). */
  deltaFromPrev: boolean;
}

/** A timeline turn: one role's seat session against the shared plane. Carries the plane
 *  provenance it observed (identical across turns by construction — the single-plane proof). */
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

/** Declared seats that were never started after one executed sequential role stopped the run.
 * The executed timeline plus this ordered tail must account for every declared sim/stream. */
interface SharedWorldSkippedTail {
  afterRoleId: string;
  roles: Array<{ roleId: string; simId: string; streamId: string }>;
  cause: "harness_error" | "session_error" | "usage_unreported" | "study_spend_limit";
  /** Present only for a measured aggregate threshold; estimates, not provider billing. */
  maxTotalUsd?: number;
  estimatedTotalUsd?: number;
}

/**
 * The shared-world evidence block (`humanish.shared-world.v1`). TWO variants discriminated by
 * `topologyMode` (FIX-8 — renamed off `RunBundle.mode` to avoid the dry-run|live collision):
 *
 * - SEQUENTIAL (`topologyMode: "sequential"`): `sequence` + an alternating `timeline`
 *   (cp-baseline → turn → cp → … → cp); limits `sequential-only` etc. No route writes it since
 *   0.106.0; verify still reads it so older bundles keep verifying.
 * - CONCURRENT (`topologyMode: "concurrent"`, #164 phase 2): `laneWindows` + `stateSeries` +
 *   `outcomes`; limits `concurrent` etc. NO `timeline`.
 *
 * Additive + optional on `humanish.run-bundle.v1` — absent on every non-shared-world bundle.
 * The mandatory `attributionLimits` are verify-enforced (FAIL CLOSED on a missing required or a
 * present forbidden limit).
 */
export interface SharedWorldEvidence {
  schema: typeof SHARED_WORLD_SCHEMA;
  topology: "shared-world";
  /** The substrate discriminator (FIX-8). Branched on FIRST by validateSharedWorldEvidence. */
  topologyMode: "sequential" | "concurrent";
  /**
   * CONCURRENT route only (#164 phase 2): the PLANE-class discriminator. Absent == the historical
   * "provisioned-getHost" plane (a clone/local-tree subject served + getHost-exposed in-sandbox — the
   * harness MINTED the host; synthetic-seeded attestation + authoritative in-sandbox checkpoint
   * stateSeries). "external-public" == a real operator-owned public deployment used directly as the
   * plane (NO getHost/clone/seed; operator-attested, not harness-controlled; NO authoritative
   * shared-state proof — concurrency evidenced by temporal co-occupancy + observed lobby convergence).
   * verify gates EVERY getHost-specific assertion on this discriminator; existing bundles omit it and
   * default to provisioned-getHost, byte-stable.
   */
  planeClass?: "provisioned-getHost" | "external-public";
  /** The DECLARED number of role seats. */
  roleCount: number;
  plane: SharedWorldPlane;
  /** The pinned, verify-enforced attribution ceiling (the set differs per topologyMode/planeClass). */
  attributionLimits: string[];
  /**
   * EXTERNAL-PUBLIC plane class only (#164 phase 2, optional-but-strong): sha256-16 of the shared
   * `/lobby/CODE` PATH every seat's CDP-observed URL converged on — the concrete "they were in ONE
   * shared world" proof, observation-derived and needing no subject change. Digest-only (the raw
   * 6-char CODE and full URLs are runtime-only and never land). Absent when seats did not converge.
   */
  lobbyConvergenceDigest?: string;
  // --- SEQUENTIAL shape ---
  /** The role ids that actually took a turn, in declared order. */
  sequence?: string[];
  timeline?: SharedWorldTimelineEntry[];
  /** Explicit unstarted suffix; absent on historical/full-execution bundles. */
  skippedTail?: SharedWorldSkippedTail;
  // --- CONCURRENT shape ---
  /** Per-actor harness-clocked windows (overlap proves simultaneity). */
  laneWindows?: SharedWorldLaneWindow[];
  /** Cadence digests of the shared world under load (baseline + periodic + final). */
  stateSeries?: SharedWorldStateSnapshot[];
  /** Per-persona outcomes (the "M of N succeeded" headline). */
  outcomes?: SharedWorldOutcome[];
}
