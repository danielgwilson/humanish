import type { RunBundle } from "../run/bundle.js";
import { concurrencyFacts, type SharedWorldEvidence } from "../run/shared-world-evidence.js";
import {
  COMMAND_DIGEST_PATTERN,
  SHARED_WORLD_STATESERIES_KEYS,
  planeProvenanceFindings,
  sharedWorldCommonFindings,
} from "../run/shared-world-shape.js";
import { isRecord } from "../run/type-guards.js";

// Concurrent: the required set (all must be present) and a forbidden set (any present == a
// sequential claim leaking into a concurrent bundle == overclaim). verify needs both checks, because
// presence-only would let an incoherent union pass.
const CONCURRENT_REQUIRED_LIMITS = [
  "concurrent",
  "best-effort-causal-attribution",
  "non-deterministic-shared-state",
  "window-and-snapshot-granularity",
  "contention-observed-not-proven-safe",
  "state-change-not-isolated-to-actors",
] as const;

const CONCURRENT_FORBIDDEN_LIMITS = ["sequential-only", "no-concurrent-races"] as const;

// External-public plane class: the honest-downgrade required set. Keeps the concurrent family (an
// honest ceiling) and adds the mandatory disclosures for a plane the harness does not own: the
// operator-attested target the harness does not control, the absence of a synthetic attestation (you
// cannot claim synthetic on a real site), the absence of an authoritative shared-state proof (no
// in-sandbox filesystem to digest), and concurrency evidenced by temporal co-occupancy only. Verify
// fails closed if any is missing (an absent honest-downgrade limit overclaims).
const EXTERNAL_PUBLIC_EXTRA_LIMITS = [
  "external-public-plane",
  "operator-attested-target-not-harness-controlled",
  "no-synthetic-attestation",
  "no-authoritative-shared-state-proof",
  "concurrency-by-temporal-co-occupancy-only",
] as const;

// Any seeded/synthetic limit on this class is a getHost claim leaking onto a real public site; forbid
// it alongside the sequential family. (A synthetic attestation on a plane the harness did not seed is a lie.)
const EXTERNAL_PUBLIC_FORBIDDEN_LIMITS = [
  "sequential-only",
  "no-concurrent-races",
  "seeded",
  "synthetic",
] as const;

/**
 * Concurrent branch: N personas drove one getHost-exposed plane at once. Verify fail-closed: the
 * shape (laneWindows + stateSeries + outcomes, no timeline); the required and forbidden
 * attributionLimits; the harness-minted getHost target every actor drove; the synthetic-subject
 * provenance gate; digest-only state series with the allowed-keys tripwire; single-plane
 * provenance; and the concurrency-on-pass gate (genuine overlap and a state delta at or after an
 * overlap start).
 */
export function concurrentSharedWorldFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
): string[] {
  // The plane-class discriminator. Absent means the provisioned-getHost plane. Every
  // getHost-specific assertion (hostDigest, exposure: synthetic, seeded provenance, state-delta on
  // pass) is gated on this, so it never leaks onto the external-public class, and the external-public
  // assertions never leak onto getHost.
  const planeClass = (sw as { planeClass?: string }).planeClass;
  if (planeClass === "external-public") {
    return externalPublicConcurrentFindings(bundle, sw);
  }
  if (planeClass !== undefined && planeClass !== "provisioned-getHost") {
    return [
      ...sharedWorldCommonFindings(bundle, sw),
      `sharedWorld.planeClass must be "provisioned-getHost" or "external-public" (got "${planeClass}")`,
    ];
  }
  return provisionedGetHostConcurrentFindings(bundle, sw);
}

type Row = Record<string, unknown>;

const participantIdOf = (window: Row): string =>
  typeof window.roleId === "string" ? window.roleId : "(unnamed)";

/**
 * Provisioned-getHost concurrent branch: a clone/local-tree subject served and getHost-exposed
 * in-sandbox. The harness minted the host, so this asserts the synthetic-seeded attestation, the
 * harness-minted host identity, and an authoritative in-sandbox checkpoint state-delta on pass.
 */
function provisionedGetHostConcurrentFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);

  // Shape coherence: concurrent carries laneWindows/stateSeries/outcomes and no timeline.
  if (Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push(
      "a concurrent shared-world bundle must NOT carry a sequential timeline (topologyMode mismatch)",
    );
  }
  const windows = recordsOf(sw.laneWindows);
  const stateSeries = recordsOf(sw.stateSeries);
  const outcomes = recordsOf(sw.outcomes);
  if (windows === null) findings.push("a concurrent shared-world bundle must carry laneWindows");
  if (stateSeries === null)
    findings.push("a concurrent shared-world bundle must carry stateSeries");
  if (outcomes === null) findings.push("a concurrent shared-world bundle must carry outcomes");
  if (windows === null || stateSeries === null || outcomes === null) {
    return findings; // can't reason further without the core series
  }

  // Required limits all present and forbidden limits all absent.
  findings.push(
    ...attributionLimitFindings(sw, CONCURRENT_REQUIRED_LIMITS, CONCURRENT_FORBIDDEN_LIMITS, {
      missing: (limit) =>
        `attributionLimits is missing the mandatory concurrent disclosure "${limit}" — an absent ceiling overclaims`,
      forbidden: (limit) =>
        `attributionLimits carries the forbidden disclosure "${limit}" — a concurrent run cannot claim a sequential guarantee`,
    }),
    ...participantCoverageFindings(sw, windows, outcomes),
    ...windowFindings(bundle, windows, "the host it drove"),
    ...getHostPlaneFindings(bundle, sw, windows),
    ...stateSeriesFindings(stateSeries),
    ...concurrencyOnPassFindings(bundle, windows, stateSeries),
  );
  return findings;
}

/** An array field's record entries, or null when the field is not an array. */
function recordsOf(value: unknown): Row[] | null {
  return Array.isArray(value) ? (value as unknown[]).filter(isRecord) : null;
}

function attributionLimitFindings(
  sw: SharedWorldEvidence,
  required: readonly string[],
  forbidden: readonly string[],
  messages: { missing: (limit: string) => string; forbidden: (limit: string) => string },
): string[] {
  const limits: readonly string[] = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  return [
    ...required.filter((limit) => !limits.includes(limit)).map(messages.missing),
    ...forbidden.filter((limit) => limits.includes(limit)).map(messages.forbidden),
  ];
}

/**
 * Phantom/dropped role: laneWindows + outcomes each cover exactly roleCount (actors are
 * independent: none are blocked by another, so all N produce a window + outcome).
 */
function participantCoverageFindings(
  sw: SharedWorldEvidence,
  windows: Row[],
  outcomes: Row[],
): string[] {
  const findings: string[] = [];
  if (windows.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: laneWindows count (${windows.length}) must equal roleCount (${sw.roleCount})`,
    );
  }
  if (outcomes.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: outcomes count (${outcomes.length}) must equal roleCount (${sw.roleCount})`,
    );
  }
  return findings;
}

/** laneWindows: numeric well-ordered windows; sim/stream resolve; route-host digest present. */
function windowFindings(bundle: RunBundle, windows: Row[], routeTarget: string): string[] {
  const findings: string[] = [];
  for (const window of windows) {
    const participantId = participantIdOf(window);
    const startedAt = window.startedAt;
    const endedAt = window.endedAt;
    if (typeof startedAt !== "number" || typeof endedAt !== "number" || !(startedAt <= endedAt)) {
      findings.push(
        `laneWindow "${participantId}" must carry numeric startedAt <= endedAt on one clock`,
      );
    }
    if (
      typeof window.routeHostDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(window.routeHostDigest)
    ) {
      findings.push(
        `laneWindow "${participantId}" must record a sha256-16 routeHostDigest of ${routeTarget}`,
      );
    }
    if (!bundle.simulations.some((simulation) => simulation.id === window.simId)) {
      findings.push(
        `laneWindow "${participantId}" references unknown simId "${String(window.simId)}"`,
      );
    }
    if (!bundle.streams.some((stream) => stream.id === window.streamId)) {
      findings.push(
        `laneWindow "${participantId}" references unknown streamId "${String(window.streamId)}"`,
      );
    }
  }
  return findings;
}

/**
 * The getHost plane: every actor drove exactly the harness-minted host, the subject is
 * attested synthetic and seeded, and every laneWindow shares the plane's provenance.
 */
function getHostPlaneFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
  windows: Row[],
): string[] {
  const findings: string[] = [];
  // The harness-minted getHost target. plane.hostDigest present (sha256-16) + every actor's
  // routeHostDigest equals it.
  const plane: Row = isRecord(sw.plane) ? sw.plane : {};
  const hostDigest = typeof plane.hostDigest === "string" ? plane.hostDigest : undefined;
  if (!hostDigest || !COMMAND_DIGEST_PATTERN.test(hostDigest)) {
    findings.push(
      "sharedWorld.plane.hostDigest (sha256-16 of the harness-minted getHost origin) is required on the concurrent route",
    );
  } else {
    for (const window of windows) {
      if (typeof window.routeHostDigest === "string" && window.routeHostDigest !== hostDigest) {
        findings.push(
          `laneWindow "${participantIdOf(window)}" drove a host that differs from the harness-minted plane.hostDigest (invariant 2)`,
        );
      }
    }
  }

  // Synthetic-subject provenance gate (a getHost URL is internet-reachable; real/external data
  // behind it is the hazard). Author attestation + a seeded provenance check.
  if (plane.exposure !== "synthetic") {
    findings.push(
      'sharedWorld.plane.exposure must be "synthetic" — the getHost route requires the author attestation that the subject is synthetic seeded data (author-trust + provenance gate, not a no-real-data guarantee)',
    );
  }
  if (bundle.subject?.state.provenance !== "seeded") {
    findings.push(
      `the concurrent getHost route requires subject.state.provenance == "seeded" (got "${bundle.subject?.state.provenance ?? "absent"}") — external/unpinned/undeclared data behind an internet-reachable URL is rejected`,
    );
  }

  // Single-plane provenance: every laneWindow shares one (commit, seedDigest) matching plane.
  findings.push(
    ...planeProvenanceFindings(windows, plane, {
      items: "laneWindows",
      item: "laneWindow",
      run: "concurrent",
    }),
  );
  return findings;
}

/** stateSeries is digest-only with the allowed-keys tripwire (no per-delta→actor field). */
function stateSeriesFindings(stateSeries: Row[]): string[] {
  const findings: string[] = [];
  for (const snapshot of stateSeries) {
    if (typeof snapshot.timestamp !== "number") {
      findings.push("a stateSeries snapshot must carry a numeric timestamp");
    }
    if (typeof snapshot.digest !== "string" || !COMMAND_DIGEST_PATTERN.test(snapshot.digest)) {
      findings.push(
        "a stateSeries snapshot digest is not a sha256-16 value (a value-shaped field is rejected)",
      );
    }
    for (const key of Object.keys(snapshot)) {
      if (!SHARED_WORLD_STATESERIES_KEYS.has(key)) {
        findings.push(
          `a stateSeries snapshot carries an unexpected field "${key}" — the series is digest-only (no per-delta attribution)`,
        );
      }
    }
  }
  return findings;
}

/** The laneWindows rows with numeric start and end, as the shared concurrency facts read them. */
function participantWindows(windows: Row[]): { startedAt: number; endedAt: number }[] {
  return windows.flatMap((window) =>
    typeof window.startedAt === "number" && typeof window.endedAt === "number"
      ? [{ startedAt: window.startedAt, endedAt: window.endedAt }]
      : [],
  );
}

/**
 * The concurrency-on-pass gate: a passed concurrent run must show genuine overlap (≥2 laneWindows
 * overlapping in time) and a stateSeries delta whose timestamp is at or after the start of an
 * overlap interval. Otherwise it was not actually concurrent, or the world never changed under
 * contention (a hollow concurrent claim). The facts come from concurrencyFacts, which the judge
 * also reads.
 */
function concurrencyOnPassFindings(
  bundle: RunBundle,
  windows: Row[],
  stateSeries: Row[],
): string[] {
  if (bundle.review.verdict !== "pass") return [];
  const facts = concurrencyFacts(
    participantWindows(windows),
    stateSeries.flatMap((snapshot) =>
      typeof snapshot.timestamp === "number"
        ? [{ timestamp: snapshot.timestamp, digest: String(snapshot.digest) }]
        : [],
    ),
  );
  if (!facts.overlap) {
    return [
      "review verdict is pass but no two laneWindows overlap in time — the run was not actually concurrent",
    ];
  }
  if (facts.stateChangedUnderOverlap === true) return [];
  return [
    "review verdict is pass but no stateSeries delta occurs at/after an overlap interval start — the shared world did not change under concurrent load (hollow concurrent claim)",
  ];
}

/**
 * External-public concurrent branch: N participants drove one real operator-owned public deployment
 * at once. The evidence class for a plane the harness does not own. Verify fails closed on the
 * downgrades (asserted-absent, never silently dropped): provenance is "external-public" (never
 * seeded), exposure is absent (claiming synthetic on a real site would be false), plane control is
 * operator-attested (publicOriginDigest; there is no harness-minted hostDigest), there is no
 * authoritative shared-state proof (stateSeries omitted), and concurrency is proven by temporal
 * co-occupancy only (relaxed concurrency-on-pass: ≥2 overlapping windows, no state delta). Every
 * getHost-only claim (exposure: synthetic / plane.hostDigest / seeded / synthetic limit) appearing
 * here fails closed.
 */
function externalPublicConcurrentFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);

  // Shape coherence: concurrent carries laneWindows + outcomes and no timeline. stateSeries is
  // deliberately omitted on this class (no in-sandbox filesystem to authoritatively digest).
  if (Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push(
      "an external-public concurrent bundle must NOT carry a sequential timeline (topologyMode mismatch)",
    );
  }
  const windows = recordsOf(sw.laneWindows);
  const outcomes = recordsOf(sw.outcomes);
  if (windows === null)
    findings.push("an external-public concurrent bundle must carry laneWindows");
  if (outcomes === null) findings.push("an external-public concurrent bundle must carry outcomes");
  // No authoritative shared-state proof: a non-empty stateSeries would falsely imply the harness
  // digested the plane's backend state (it cannot; there is no in-sandbox filesystem).
  const stateSeries = (sw as { stateSeries?: unknown }).stateSeries;
  if (Array.isArray(stateSeries) && stateSeries.length > 0) {
    findings.push(
      "an external-public concurrent bundle must NOT carry a stateSeries — the harness cannot authoritatively digest a real public plane's backend state (no in-sandbox filesystem); concurrency is proven by temporal co-occupancy, not a state series",
    );
  }
  if (windows === null || outcomes === null) {
    return findings; // can't reason further without the core series
  }

  // Attribution ceiling: the concurrent family and every external-public honest-downgrade disclosure
  // must be present; the sequential family + any seeded/synthetic limit must be absent.
  findings.push(
    ...attributionLimitFindings(
      sw,
      [...CONCURRENT_REQUIRED_LIMITS, ...EXTERNAL_PUBLIC_EXTRA_LIMITS],
      EXTERNAL_PUBLIC_FORBIDDEN_LIMITS,
      {
        missing: (limit) =>
          `attributionLimits is missing the mandatory external-public disclosure "${limit}" — an absent honest-downgrade ceiling overclaims`,
        forbidden: (limit) =>
          `attributionLimits carries the forbidden disclosure "${limit}" — the external-public plane cannot claim a sequential guarantee or a seeded/synthetic attestation on a real site`,
      },
    ),
    ...participantCoverageFindings(sw, windows, outcomes),
    ...windowFindings(bundle, windows, "the origin it reached"),
    ...externalPublicPlaneFindings(bundle, sw, windows),
  );

  // The relaxed concurrency-on-pass gate: a passed external-public run must show genuine temporal
  // co-occupancy (≥2 laneWindows overlapping in time). There is no state-delta requirement: the
  // observed co-occupancy of one declared origin (plus the optional lobby convergence) carries the
  // "they shared a world" claim, disclosed as concurrency-by-temporal-co-occupancy-only.
  if (
    bundle.review.verdict === "pass" &&
    !concurrencyFacts(participantWindows(windows), undefined).overlap
  ) {
    findings.push(
      "review verdict is pass but no two laneWindows overlap in time — the external-public run was not actually concurrent (concurrency is proven by temporal co-occupancy on this class)",
    );
  }
  return findings;
}

/**
 * The external-public plane (the counterpart of the harness-minted-URL rule, with a weaker,
 * disclosed claim): the participants converged on one observed origin, nothing claims harness
 * control or a synthetic seeded subject, and every laneWindow shares the plane's provenance.
 */
function externalPublicPlaneFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
  windows: Row[],
): string[] {
  const findings: string[] = [];
  // The convergence proof is about what the participants observed; the declared origin is not part
  // of it. plane.publicOriginDigest is the observed origin the participants converged on; verify
  // requires every participant's CDP-observed routeHostDigest to agree on one origin, and that
  // publicOriginDigest be that origin. Convergence on one observed origin proves cross-participant
  // co-location. It does not prove harness control of the plane. Operator ownership rests on the
  // subject.publicTarget.authorized attestation + the declared appUrl. Digest equality plays no
  // part, because a normal cross-origin redirect (apex->www, http->https) makes the observed origin
  // differ from the declared one, which is expected and must never fail verify
  // (declaredOriginDigest is evidence-only).
  const plane: Row = isRecord(sw.plane) ? sw.plane : {};
  const publicOriginDigest =
    typeof plane.publicOriginDigest === "string" ? plane.publicOriginDigest : undefined;
  if (!publicOriginDigest || !COMMAND_DIGEST_PATTERN.test(publicOriginDigest)) {
    findings.push(
      "sharedWorld.plane.publicOriginDigest (sha256-16 of the OBSERVED origin the participants converged on) is required on the external-public plane class",
    );
  }
  // The observed origins across participants must agree on exactly one (that agreement is the
  // convergence).
  const observedOrigins = windows
    .map((window) =>
      typeof window.routeHostDigest === "string" ? window.routeHostDigest : undefined,
    )
    .filter((digest): digest is string => digest !== undefined);
  const distinctObserved = [...new Set(observedOrigins)];
  if (distinctObserved.length > 1) {
    findings.push(
      `the participants did not converge on ONE OBSERVED origin; distinct observed origin digests: ${distinctObserved.join(", ")}`,
    );
  } else if (
    publicOriginDigest &&
    distinctObserved.length === 1 &&
    distinctObserved[0] !== publicOriginDigest
  ) {
    findings.push(
      `sharedWorld.plane.publicOriginDigest (${publicOriginDigest}) must equal the single OBSERVED origin the participants converged on (${distinctObserved[0]})`,
    );
  }
  // declaredOriginDigest is recorded for evidence only. Validate its shape when present, but never
  // assert it equals the observed origin: a cross-origin redirect is normal and expected.
  if (
    plane.declaredOriginDigest !== undefined &&
    (typeof plane.declaredOriginDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(plane.declaredOriginDigest))
  ) {
    findings.push(
      "sharedWorld.plane.declaredOriginDigest, when present, must be a sha256-16 digest of the operator-declared origin (evidence-only; not asserted equal to the observed origin)",
    );
  }

  // Invert the getHost gate: exposure must be absent (claiming synthetic on a real site would be false) and
  // the harness-minted hostDigest must be absent (the harness minted no host here).
  if (plane.exposure !== undefined) {
    findings.push(
      'sharedWorld.plane.exposure must be ABSENT on the external-public plane class — the harness neither provisioned nor exposed the plane, so it cannot attest "synthetic" on a real site',
    );
  }
  if (plane.hostDigest !== undefined) {
    findings.push(
      "sharedWorld.plane.hostDigest must be ABSENT on the external-public plane class — a harness-minted host identity is a getHost claim; this plane is operator-attested, not harness-minted",
    );
  }
  // Provenance is the external-public marker, which is neither seeded (nothing was seeded) nor unpinned.
  if (bundle.subject?.state.provenance !== "external-public") {
    findings.push(
      `the external-public plane class requires subject.state.provenance == "external-public" (got "${bundle.subject?.state.provenance ?? "absent"}") — a seeded/unpinned/undeclared claim on an operator-owned public deployment is dishonest`,
    );
  }
  if (bundle.subject?.source !== "app-url") {
    findings.push(
      'the external-public plane class requires subject.source == "app-url" — the plane is a real public deployment, not a provisioned subject',
    );
  }

  // Single-plane provenance: every laneWindow shares one (commit, seedDigest) matching plane. commit
  // is absent on this class (nothing cloned); seedDigest is the constant empty-recipe digest.
  findings.push(
    ...planeProvenanceFindings(windows, plane, {
      items: "laneWindows",
      item: "laneWindow",
      run: "shared-world",
    }),
  );

  // The lobby-convergence proof (optional-but-strong): if present it must be a sha256-16 digest of the
  // shared `/lobby/CODE` path all participants converged on (digest-only; the raw lobby code never
  // lands).
  const lobbyConvergenceDigest = (sw as { lobbyConvergenceDigest?: unknown })
    .lobbyConvergenceDigest;
  if (
    lobbyConvergenceDigest !== undefined &&
    (typeof lobbyConvergenceDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(lobbyConvergenceDigest))
  ) {
    findings.push(
      "sharedWorld.lobbyConvergenceDigest must be a sha256-16 digest (digest-only; the raw lobby code never lands)",
    );
  }
  return findings;
}
