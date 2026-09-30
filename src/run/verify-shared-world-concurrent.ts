import type { RunBundle, SharedWorldEvidence } from "./bundle.js";
import {
  COMMAND_DIGEST_PATTERN,
  SHARED_WORLD_STATESERIES_KEYS,
  sharedWorldCommonFindings,
} from "./guards-shared-world.js";
import { isRecord } from "./primitives.js";

// CONCURRENT (#164 phase 2, FIX-5): the REQUIRED set (all must be present) AND a FORBIDDEN set (any
// present == a sequential claim leaking into a concurrent bundle == overclaim). verify needs BOTH
// checks — presence-only would let an incoherent union pass.
const CONCURRENT_REQUIRED_LIMITS = [
  "concurrent",
  "best-effort-causal-attribution",
  "non-deterministic-shared-state",
  "window-and-snapshot-granularity",
  "contention-observed-not-proven-safe",
  "state-change-not-isolated-to-actors",
] as const;

const CONCURRENT_FORBIDDEN_LIMITS = ["sequential-only", "no-concurrent-races"] as const;

// EXTERNAL-PUBLIC plane class (#164 phase 2): the honest-downgrade required set. Keeps the concurrent
// family (an honest ceiling) AND adds the mandatory disclosures for a plane the harness does NOT own:
// the operator-attested (not harness-controlled) target, the ABSENCE of a synthetic attestation (you
// cannot claim synthetic on a real site), the ABSENCE of an authoritative shared-state proof (no
// in-sandbox filesystem to digest), and concurrency evidenced by temporal co-occupancy ONLY. Verify
// FAILS CLOSED if any is missing (an absent honest-downgrade limit overclaims) — invariant 5.
const EXTERNAL_PUBLIC_EXTRA_LIMITS = [
  "external-public-plane",
  "operator-attested-target-not-harness-controlled",
  "no-synthetic-attestation",
  "no-authoritative-shared-state-proof",
  "concurrency-by-temporal-co-occupancy-only",
] as const;

// Any seeded/synthetic limit on this class is a getHost claim leaking onto a real public site — forbid
// it alongside the sequential family. (A synthetic attestation on a plane the harness did not seed is a lie.)
const EXTERNAL_PUBLIC_FORBIDDEN_LIMITS = [
  "sequential-only",
  "no-concurrent-races",
  "seeded",
  "synthetic",
] as const;

/**
 * CONCURRENT branch (#164 phase 2): N personas drove ONE getHost-exposed plane at once. Verify
 * fail-closed: the shape (laneWindows + stateSeries + outcomes, NO timeline — FIX-8); the
 * corrected required + forbidden attributionLimits (FIX-5); the harness-minted getHost target every
 * actor drove (FIX-2); the synthetic-subject provenance gate (FIX-3); digest-only state series with
 * the allowed-keys tripwire (FIX-7); single-plane provenance; and the concurrency-on-pass gate
 * (genuine overlap + a state delta AT/AFTER an overlap start — FIX-6).
 */
export function concurrentSharedWorldFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
): string[] {
  // The PLANE-class discriminator (#164 phase 2). Absent == the historical provisioned-getHost plane
  // (byte-stable). EVERY getHost-specific assertion (hostDigest, exposure: synthetic, seeded
  // provenance, state-delta on pass) is gated on this — it never leaks onto the external-public class,
  // and the external-public assertions never leak onto getHost.
  const planeClass = (sw as { planeClass?: unknown }).planeClass;
  if (planeClass === "external-public") {
    return externalPublicConcurrentFindings(bundle, sw);
  }
  if (planeClass !== undefined && planeClass !== "provisioned-getHost") {
    return [
      ...sharedWorldCommonFindings(bundle, sw),
      `sharedWorld.planeClass must be "provisioned-getHost" or "external-public" (got "${String(planeClass)}")`,
    ];
  }
  return provisionedGetHostConcurrentFindings(bundle, sw);
}

/**
 * PROVISIONED-getHost concurrent branch (the historical plane; #164 phase 2): a clone/local-tree
 * subject served + getHost-exposed in-sandbox — the harness MINTED the host, so it asserts the
 * synthetic-seeded attestation, the harness-minted host identity, and an authoritative in-sandbox
 * checkpoint state-delta on pass. UNCHANGED from the pre-external-public verify (byte-stable).
 */
function provisionedGetHostConcurrentFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);

  // FIX-8: shape coherence — concurrent carries laneWindows/stateSeries/outcomes, NOT a timeline.
  if (Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push(
      "a concurrent shared-world bundle must NOT carry a sequential timeline (topologyMode mismatch)",
    );
  }
  const laneWindows = Array.isArray(sw.laneWindows)
    ? (sw.laneWindows as unknown[]).filter(isRecord)
    : null;
  const stateSeries = Array.isArray(sw.stateSeries)
    ? (sw.stateSeries as unknown[]).filter(isRecord)
    : null;
  const outcomes = Array.isArray(sw.outcomes) ? (sw.outcomes as unknown[]).filter(isRecord) : null;
  if (laneWindows === null)
    findings.push("a concurrent shared-world bundle must carry laneWindows");
  if (stateSeries === null)
    findings.push("a concurrent shared-world bundle must carry stateSeries");
  if (outcomes === null) findings.push("a concurrent shared-world bundle must carry outcomes");
  if (laneWindows === null || stateSeries === null || outcomes === null) {
    return findings; // can't reason further without the core series
  }

  // FIX-5: required limits all present AND forbidden limits all absent.
  const limits = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  for (const required of CONCURRENT_REQUIRED_LIMITS) {
    if (!limits.includes(required)) {
      findings.push(
        `attributionLimits is missing the mandatory concurrent disclosure "${required}" — an absent ceiling overclaims`,
      );
    }
  }
  for (const forbidden of CONCURRENT_FORBIDDEN_LIMITS) {
    if (limits.includes(forbidden)) {
      findings.push(
        `attributionLimits carries the forbidden disclosure "${forbidden}" — a concurrent run cannot claim a sequential guarantee`,
      );
    }
  }

  // Phantom/dropped role: laneWindows + outcomes each cover exactly roleCount (actors are
  // INDEPENDENT — none are blocked by another, so all N produce a window + outcome).
  if (laneWindows.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: laneWindows count (${laneWindows.length}) must equal roleCount (${sw.roleCount})`,
    );
  }
  if (outcomes.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: outcomes count (${outcomes.length}) must equal roleCount (${sw.roleCount})`,
    );
  }

  // laneWindows: numeric well-ordered windows; sim/stream resolve; route-host digest present.
  for (const window of laneWindows) {
    const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
    const startedAt = window.startedAt;
    const endedAt = window.endedAt;
    if (typeof startedAt !== "number" || typeof endedAt !== "number" || !(startedAt <= endedAt)) {
      findings.push(`laneWindow "${roleId}" must carry numeric startedAt <= endedAt on one clock`);
    }
    if (
      typeof window.routeHostDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(window.routeHostDigest)
    ) {
      findings.push(
        `laneWindow "${roleId}" must record a sha256-16 routeHostDigest of the host it drove`,
      );
    }
    if (!bundle.simulations.some((sim) => sim.id === window.simId)) {
      findings.push(`laneWindow "${roleId}" references unknown simId "${String(window.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === window.streamId)) {
      findings.push(
        `laneWindow "${roleId}" references unknown streamId "${String(window.streamId)}"`,
      );
    }
  }

  // FIX-2: the harness-minted getHost target. plane.hostDigest present (sha256-16) + every actor's
  // routeHostDigest equals it (every actor drove EXACTLY the harness-minted host — invariant 2).
  const plane: Record<string, unknown> = isRecord(sw.plane) ? sw.plane : {};
  const hostDigest = typeof plane.hostDigest === "string" ? plane.hostDigest : undefined;
  if (!hostDigest || !COMMAND_DIGEST_PATTERN.test(hostDigest)) {
    findings.push(
      "sharedWorld.plane.hostDigest (sha256-16 of the harness-minted getHost origin) is required on the concurrent route",
    );
  } else {
    for (const window of laneWindows) {
      const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
      if (typeof window.routeHostDigest === "string" && window.routeHostDigest !== hostDigest) {
        findings.push(
          `laneWindow "${roleId}" drove a host that differs from the harness-minted plane.hostDigest (invariant 2)`,
        );
      }
    }
  }

  // FIX-3: synthetic-subject provenance gate (a getHost URL is internet-reachable; real/external
  // data behind it is the hazard). Author attestation + a seeded provenance check.
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

  // Single-plane provenance: every laneWindow shares ONE (commit, seedDigest) matching plane.
  const planeKeys = new Set(
    laneWindows.map(
      (window) => `${String(window.commit ?? "")}::${String(window.seedDigest ?? "")}`,
    ),
  );
  if (planeKeys.size > 1) {
    findings.push(
      "laneWindows reference divergent plane provenance (commit/seedDigest) — a concurrent run drives ONE plane",
    );
  }
  for (const window of laneWindows) {
    if (
      String(window.seedDigest ?? "") !== String(plane.seedDigest ?? "") ||
      String(window.commit ?? "") !== String(plane.commit ?? "")
    ) {
      const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
      findings.push(`laneWindow "${roleId}" plane provenance diverges from sharedWorld.plane`);
      break;
    }
  }

  // FIX-7: stateSeries is DIGEST-ONLY with the allowed-keys tripwire (no per-delta→actor field).
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

  // The concurrency-on-pass gate (FIX-6): a PASSED concurrent run MUST show genuine overlap (≥2
  // laneWindows overlapping in time) AND a stateSeries delta whose timestamp is AT/AFTER the start
  // of an overlap interval — otherwise it was not actually concurrent, or the world never changed
  // under contention (a hollow concurrent claim).
  if (bundle.review.verdict === "pass") {
    const overlapStarts: number[] = [];
    for (let i = 0; i < laneWindows.length; i += 1) {
      for (let j = i + 1; j < laneWindows.length; j += 1) {
        const a = laneWindows[i]!;
        const b = laneWindows[j]!;
        const aStart = a.startedAt as number;
        const aEnd = a.endedAt as number;
        const bStart = b.startedAt as number;
        const bEnd = b.endedAt as number;
        if (
          typeof aStart === "number" &&
          typeof aEnd === "number" &&
          typeof bStart === "number" &&
          typeof bEnd === "number" &&
          aStart < bEnd &&
          bStart < aEnd
        ) {
          overlapStarts.push(Math.max(aStart, bStart));
        }
      }
    }
    if (overlapStarts.length === 0) {
      findings.push(
        "review verdict is pass but no two laneWindows overlap in time — the run was not actually concurrent",
      );
    } else {
      const earliestOverlapStart = Math.min(...overlapStarts);
      const sorted = [...stateSeries]
        .map((snapshot) => ({
          timestamp: snapshot.timestamp as number,
          digest: String(snapshot.digest),
        }))
        .filter((snapshot) => typeof snapshot.timestamp === "number")
        .sort((x, y) => x.timestamp - y.timestamp);
      let deltaInWindow = false;
      for (let i = 1; i < sorted.length; i += 1) {
        if (
          sorted[i]!.digest !== sorted[i - 1]!.digest &&
          sorted[i]!.timestamp >= earliestOverlapStart
        ) {
          deltaInWindow = true;
          break;
        }
      }
      if (!deltaInWindow) {
        findings.push(
          "review verdict is pass but no stateSeries delta occurs at/after an overlap interval start — the shared world did not change under concurrent load (hollow concurrent claim)",
        );
      }
    }
  }

  return findings;
}

/**
 * EXTERNAL-PUBLIC concurrent branch (#164 phase 2): N seats drove ONE real operator-owned public
 * deployment at once. The honest evidence class for a plane the harness does NOT own. Verify
 * fail-closed on the honest DOWNGRADES (asserted-absent, never silently dropped): provenance is
 * "external-public" (NOT seeded), exposure is ABSENT (claiming synthetic on a real site is a lie),
 * plane control is operator-attested (publicOriginDigest, not a harness-minted hostDigest), there is
 * NO authoritative shared-state proof (stateSeries omitted — option A), and concurrency is proven by
 * temporal co-occupancy ONLY (relaxed concurrency-on-pass: ≥2 overlapping windows, no state delta).
 * Every getHost-only claim (exposure: synthetic / plane.hostDigest / seeded / synthetic limit)
 * appearing here FAILS CLOSED.
 */
function externalPublicConcurrentFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);

  // Shape coherence: concurrent carries laneWindows + outcomes, NOT a timeline. stateSeries is
  // deliberately OMITTED on this class (no in-sandbox filesystem to authoritatively digest).
  if (Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push(
      "an external-public concurrent bundle must NOT carry a sequential timeline (topologyMode mismatch)",
    );
  }
  const laneWindows = Array.isArray(sw.laneWindows)
    ? (sw.laneWindows as unknown[]).filter(isRecord)
    : null;
  const outcomes = Array.isArray(sw.outcomes) ? (sw.outcomes as unknown[]).filter(isRecord) : null;
  if (laneWindows === null)
    findings.push("an external-public concurrent bundle must carry laneWindows");
  if (outcomes === null) findings.push("an external-public concurrent bundle must carry outcomes");
  // Option A: NO authoritative shared-state proof — a non-empty stateSeries would falsely imply the
  // harness digested the plane's backend state (it cannot; there is no in-sandbox filesystem).
  const stateSeries = (sw as { stateSeries?: unknown }).stateSeries;
  if (Array.isArray(stateSeries) && stateSeries.length > 0) {
    findings.push(
      "an external-public concurrent bundle must NOT carry a stateSeries — the harness cannot authoritatively digest a real public plane's backend state (no in-sandbox filesystem); concurrency is proven by temporal co-occupancy, not a state series",
    );
  }
  if (laneWindows === null || outcomes === null) {
    return findings; // can't reason further without the core series
  }

  // Attribution ceiling: the concurrent family AND every external-public honest-downgrade disclosure
  // must be present; the sequential family + any seeded/synthetic limit must be absent.
  const limits = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  for (const required of [...CONCURRENT_REQUIRED_LIMITS, ...EXTERNAL_PUBLIC_EXTRA_LIMITS]) {
    if (!limits.includes(required)) {
      findings.push(
        `attributionLimits is missing the mandatory external-public disclosure "${required}" — an absent honest-downgrade ceiling overclaims`,
      );
    }
  }
  for (const forbidden of EXTERNAL_PUBLIC_FORBIDDEN_LIMITS) {
    if (limits.includes(forbidden)) {
      findings.push(
        `attributionLimits carries the forbidden disclosure "${forbidden}" — the external-public plane cannot claim a sequential guarantee or a seeded/synthetic attestation on a real site`,
      );
    }
  }

  // Phantom/dropped role: laneWindows + outcomes each cover exactly roleCount.
  if (laneWindows.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: laneWindows count (${laneWindows.length}) must equal roleCount (${sw.roleCount})`,
    );
  }
  if (outcomes.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: outcomes count (${outcomes.length}) must equal roleCount (${sw.roleCount})`,
    );
  }

  // laneWindows: numeric well-ordered windows; sim/stream resolve; route-host digest present.
  for (const window of laneWindows) {
    const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
    if (
      typeof window.startedAt !== "number" ||
      typeof window.endedAt !== "number" ||
      !((window.startedAt as number) <= (window.endedAt as number))
    ) {
      findings.push(`laneWindow "${roleId}" must carry numeric startedAt <= endedAt on one clock`);
    }
    if (
      typeof window.routeHostDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(window.routeHostDigest)
    ) {
      findings.push(
        `laneWindow "${roleId}" must record a sha256-16 routeHostDigest of the origin it reached`,
      );
    }
    if (!bundle.simulations.some((sim) => sim.id === window.simId)) {
      findings.push(`laneWindow "${roleId}" references unknown simId "${String(window.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === window.streamId)) {
      findings.push(
        `laneWindow "${roleId}" references unknown streamId "${String(window.streamId)}"`,
      );
    }
  }

  // Plane identity (the honest analog of invariant 2, WEAKER + disclosed): the convergence proof is
  // about what the seats OBSERVED, not what was DECLARED. plane.publicOriginDigest is the OBSERVED
  // origin the seats converged on; verify requires every seat's CDP-OBSERVED routeHostDigest to agree
  // on ONE origin, and that publicOriginDigest BE that origin. Convergence on one observed origin proves
  // inter-seat co-location — NOT harness control of the plane. IMPORTANT: operator OWNERSHIP rests on
  // the subject.publicTarget.authorized attestation + the declared appUrl, NOT on digest equality — a
  // normal cross-origin redirect (apex->www, http->https) makes the observed origin differ from the
  // DECLARED one, which is expected and must NEVER fail verify (declaredOriginDigest is evidence-only).
  const plane: Record<string, unknown> = isRecord(sw.plane) ? sw.plane : {};
  const publicOriginDigest =
    typeof plane.publicOriginDigest === "string" ? plane.publicOriginDigest : undefined;
  if (!publicOriginDigest || !COMMAND_DIGEST_PATTERN.test(publicOriginDigest)) {
    findings.push(
      "sharedWorld.plane.publicOriginDigest (sha256-16 of the OBSERVED origin the seats converged on) is required on the external-public plane class",
    );
  }
  // The observed origins across seats must agree on exactly ONE (that agreement IS the convergence).
  const observedOrigins = laneWindows
    .map((window) =>
      typeof window.routeHostDigest === "string" ? window.routeHostDigest : undefined,
    )
    .filter((digest): digest is string => digest !== undefined);
  const distinctObserved = [...new Set(observedOrigins)];
  if (distinctObserved.length > 1) {
    findings.push(
      `the seats did not converge on ONE OBSERVED origin — distinct observed origin digests: ${distinctObserved.join(", ")}`,
    );
  } else if (
    publicOriginDigest &&
    distinctObserved.length === 1 &&
    distinctObserved[0] !== publicOriginDigest
  ) {
    findings.push(
      `sharedWorld.plane.publicOriginDigest (${publicOriginDigest}) must equal the single OBSERVED origin the seats converged on (${distinctObserved[0]})`,
    );
  }
  // declaredOriginDigest is recorded for evidence ONLY. Validate its shape when present, but NEVER
  // assert it equals the observed origin — a cross-origin redirect is normal and expected.
  if (
    plane.declaredOriginDigest !== undefined &&
    (typeof plane.declaredOriginDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(plane.declaredOriginDigest))
  ) {
    findings.push(
      "sharedWorld.plane.declaredOriginDigest, when present, must be a sha256-16 digest of the operator-declared origin (evidence-only; not asserted equal to the observed origin)",
    );
  }

  // INVERT the getHost gate: exposure MUST be absent (claiming synthetic on a real site is a lie) and
  // the harness-minted hostDigest MUST be absent (the harness minted no host here).
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
  // Provenance is the NEW external-public marker — NOT seeded (nothing was seeded), NOT unpinned.
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

  // Single-plane provenance: every laneWindow shares ONE (commit, seedDigest) matching plane. commit
  // is absent on this class (nothing cloned); seedDigest is the constant empty-recipe digest.
  const planeKeys = new Set(
    laneWindows.map(
      (window) => `${String(window.commit ?? "")}::${String(window.seedDigest ?? "")}`,
    ),
  );
  if (planeKeys.size > 1) {
    findings.push(
      "laneWindows reference divergent plane provenance (commit/seedDigest) — a shared-world run drives ONE plane",
    );
  }
  for (const window of laneWindows) {
    if (
      String(window.seedDigest ?? "") !== String(plane.seedDigest ?? "") ||
      String(window.commit ?? "") !== String(plane.commit ?? "")
    ) {
      const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
      findings.push(`laneWindow "${roleId}" plane provenance diverges from sharedWorld.plane`);
      break;
    }
  }

  // The lobby-convergence proof (optional-but-strong): if present it must be a sha256-16 digest of the
  // shared /lobby/CODE path all seats converged on (digest-only; the raw CODE never lands).
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

  // The RELAXED concurrency-on-pass gate: a PASSED external-public run MUST show genuine temporal
  // co-occupancy (≥2 laneWindows overlapping in time). There is NO state-delta requirement — the
  // observed co-occupancy of one declared origin (plus the optional lobby convergence) carries the
  // "they shared a world" claim, disclosed as concurrency-by-temporal-co-occupancy-only.
  if (bundle.review.verdict === "pass") {
    let overlap = false;
    for (let i = 0; i < laneWindows.length && !overlap; i += 1) {
      for (let j = i + 1; j < laneWindows.length; j += 1) {
        const a = laneWindows[i]!;
        const b = laneWindows[j]!;
        const aStart = a.startedAt as number;
        const aEnd = a.endedAt as number;
        const bStart = b.startedAt as number;
        const bEnd = b.endedAt as number;
        if (
          typeof aStart === "number" &&
          typeof aEnd === "number" &&
          typeof bStart === "number" &&
          typeof bEnd === "number" &&
          aStart < bEnd &&
          bStart < aEnd
        ) {
          overlap = true;
          break;
        }
      }
    }
    if (!overlap) {
      findings.push(
        "review verdict is pass but no two laneWindows overlap in time — the external-public run was not actually concurrent (concurrency is proven by temporal co-occupancy on this class)",
      );
    }
  }

  return findings;
}
