import { type RunBundle } from "./bundle.js";
import { SHARED_WORLD_SCHEMA, type SharedWorldEvidence } from "./shared-world-evidence.js";
import { isNonNegativeSafeInteger, isRecord } from "./primitives.js";

// The promptDigest convention: sha256 hex, first 16 chars. A "seeded" record without a real
// digest cannot pin "same recipe" across bundles, so verify treats it as a hollow claim.
export const COMMAND_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

// Env var NAME shape (mirrors ENV_NAME_PATTERN in src/lab/parse-values.ts). externalEnvNames
// must hold NAMES only — a value sneaking into the list trips this check (a free secret tripwire).
export const SUBJECT_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// SEQUENTIAL: the three disclosures a sequential shared-world bundle MUST pin (verify fails closed
// if any is absent — omission overclaims): sequential turns only, no concurrency/races handled, and
// a checkpoint delta is attributed to the TURN it followed, not a specific action (correlation).
export const MANDATORY_ATTRIBUTION_LIMITS = [
  "sequential-only",
  "no-concurrent-races",
  "delta-attributed-to-turn-not-action",
] as const;

// A shared-world checkpoint record persists DIGEST-ONLY: exactly these keys, nothing value-shaped.
export const SHARED_WORLD_CHECKPOINT_KEYS = new Set(["kind", "name", "digest", "deltaFromPrev"]);

// CONCURRENT stateSeries record is DIGEST-ONLY too (FIX-7): permit ONLY a numeric timestamp + the
// sha256-16 digest; any other key is a value-shaped leak / a smuggled per-delta→actor field.
export const SHARED_WORLD_STATESERIES_KEYS = new Set(["timestamp", "digest"]);

/**
 * Single-plane provenance: every item shares ONE (commit, seedDigest), and that pair matches
 * sharedWorld.plane. Only the first item that diverges from the plane is reported. The shape guard
 * has already typed both fields as strings (commit may be absent).
 */
export function planeProvenanceFindings(
  items: readonly Record<string, unknown>[],
  plane: unknown,
  labels: { items: string; item: string; run: string },
): string[] {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const findings: string[] = [];
  const keys = new Set(items.map((item) => `${text(item.commit)}::${text(item.seedDigest)}`));
  if (keys.size > 1) {
    findings.push(
      `${labels.items} reference divergent plane provenance (commit/seedDigest) — a ${labels.run} run drives ONE plane`,
    );
  }
  if (!isRecord(plane)) return findings;
  for (const item of items) {
    if (
      text(item.seedDigest) !== text(plane.seedDigest) ||
      text(item.commit) !== text(plane.commit)
    ) {
      const roleId = typeof item.roleId === "string" ? item.roleId : "(unnamed)";
      findings.push(`${labels.item} "${roleId}" plane provenance diverges from sharedWorld.plane`);
      break;
    }
  }
  return findings;
}

/** Common shape findings shared by both topologyMode branches. */
export function sharedWorldCommonFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = [];
  if (sw.schema !== SHARED_WORLD_SCHEMA) {
    findings.push(`sharedWorld.schema must be ${String(SHARED_WORLD_SCHEMA)}`);
  }
  if (bundle.attributionClass !== "shared-world") {
    findings.push("a sharedWorld evidence block requires attributionClass: shared-world");
  }
  const plane = sw.plane;
  if (
    !isRecord(plane) ||
    typeof plane.seedDigest !== "string" ||
    !COMMAND_DIGEST_PATTERN.test(plane.seedDigest)
  ) {
    findings.push("sharedWorld.plane.seedDigest must be a sha256-16 value");
  }
  if (isRecord(plane) && Array.isArray(plane.envNames)) {
    for (const name of plane.envNames) {
      if (typeof name !== "string" || !SUBJECT_ENV_NAME_PATTERN.test(name)) {
        // Does NOT echo the entry: a malformed entry may BE a value.
        findings.push(
          "sharedWorld.plane.envNames carries an entry that is not an env var NAME shape (values must never appear in evidence)",
        );
      }
    }
  }
  return findings;
}

/**
 * Tolerant SHAPE guard for the shared-world evidence block (#164). Validates required fields +
 * types but TOLERATES extra keys (additive): the strict value-shape/timeline checks are
 * sharedWorldEvidenceFindings' job (an injected value-shaped checkpoint field must pass the shape
 * guard so verify can catch it fail-closed, not silently bounce off isRunBundle).
 */
export function isSharedWorldEvidence(value: unknown): value is SharedWorldEvidence {
  if (!isRecord(value)) return false;
  if (value.schema !== SHARED_WORLD_SCHEMA) return false;
  if (value.topology !== "shared-world") return false;
  if (!isNonNegativeSafeInteger(value.roleCount)) return false;
  const plane = value.plane;
  if (!isRecord(plane)) return false;
  if (plane.commit !== undefined && typeof plane.commit !== "string") return false;
  if (typeof plane.seedDigest !== "string") return false;
  if (!(Array.isArray(plane.envNames) && plane.envNames.every((name) => typeof name === "string")))
    return false;
  if (plane.hostDigest !== undefined && typeof plane.hostDigest !== "string") return false;
  if (plane.exposure !== undefined && typeof plane.exposure !== "string") return false;
  if (plane.publicOriginDigest !== undefined && typeof plane.publicOriginDigest !== "string")
    return false;
  if (plane.declaredOriginDigest !== undefined && typeof plane.declaredOriginDigest !== "string")
    return false;
  if (value.planeClass !== undefined && typeof value.planeClass !== "string") return false;
  if (
    value.lobbyConvergenceDigest !== undefined &&
    typeof value.lobbyConvergenceDigest !== "string"
  )
    return false;
  if (
    !(
      Array.isArray(value.attributionLimits) &&
      value.attributionLimits.every((limit) => typeof limit === "string")
    )
  )
    return false;
  // Tolerant: validate the TYPE of each present field only (the coherence + topologyMode dispatch
  // are validateSharedWorldEvidence's job — an injected value-shaped field must pass this guard so
  // verify catches it fail-closed). A bundle must carry at least one of the two shapes.
  if (
    value.sequence !== undefined &&
    !(Array.isArray(value.sequence) && value.sequence.every((id) => typeof id === "string"))
  )
    return false;
  if (
    value.timeline !== undefined &&
    !(Array.isArray(value.timeline) && value.timeline.every(isSharedWorldTimelineEntry))
  )
    return false;
  if (
    value.laneWindows !== undefined &&
    !(Array.isArray(value.laneWindows) && value.laneWindows.every(isSharedWorldLaneWindow))
  )
    return false;
  if (
    value.stateSeries !== undefined &&
    !(Array.isArray(value.stateSeries) && value.stateSeries.every(isSharedWorldStateSnapshot))
  )
    return false;
  if (
    value.outcomes !== undefined &&
    !(Array.isArray(value.outcomes) && value.outcomes.every(isSharedWorldOutcome))
  )
    return false;
  if (value.timeline === undefined && value.laneWindows === undefined) return false;
  return true;
}

function isSharedWorldTimelineEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "checkpoint") {
    return (
      typeof value.name === "string" &&
      typeof value.digest === "string" &&
      typeof value.deltaFromPrev === "boolean"
    );
  }
  if (value.kind === "turn") {
    return (
      typeof value.roleId === "string" &&
      typeof value.simId === "string" &&
      typeof value.streamId === "string" &&
      typeof value.seedDigest === "string" &&
      (value.commit === undefined || typeof value.commit === "string")
    );
  }
  return false;
}

// Tolerant shape guards for the CONCURRENT series (extra keys tolerated — the digest-only /
// allowed-keys tripwires are validateSharedWorldEvidence's strict job).
function isSharedWorldLaneWindow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.roleId === "string" &&
    (value.actorType === undefined || typeof value.actorType === "string") &&
    (value.surface === undefined || typeof value.surface === "string") &&
    (value.caseGroup === undefined || typeof value.caseGroup === "string") &&
    typeof value.simId === "string" &&
    typeof value.streamId === "string" &&
    typeof value.startedAt === "number" &&
    typeof value.endedAt === "number" &&
    typeof value.verdict === "string" &&
    typeof value.routeHostDigest === "string" &&
    typeof value.seedDigest === "string" &&
    (value.commit === undefined || typeof value.commit === "string")
  );
}

function isSharedWorldStateSnapshot(value: unknown): boolean {
  return isRecord(value) && typeof value.timestamp === "number" && typeof value.digest === "string";
}

function isSharedWorldOutcome(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.roleId === "string" &&
    (value.actorType === undefined || typeof value.actorType === "string") &&
    (value.surface === undefined || typeof value.surface === "string") &&
    (value.caseGroup === undefined || typeof value.caseGroup === "string") &&
    typeof value.simId === "string" &&
    typeof value.streamId === "string" &&
    typeof value.status === "string" &&
    typeof value.ok === "boolean"
  );
}
