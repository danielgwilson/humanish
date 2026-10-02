import type { RunBundle } from "../run/bundle.js";
import type { SharedWorldEvidence } from "../run/shared-world-evidence.js";
import {
  COMMAND_DIGEST_PATTERN,
  MANDATORY_ATTRIBUTION_LIMITS,
  SHARED_WORLD_CHECKPOINT_KEYS,
  planeProvenanceFindings,
  sharedWorldCommonFindings,
} from "../run/shared-world-shape.js";
import { isRecord } from "../run/type-guards.js";
import { concurrentSharedWorldFindings } from "./shared-world-concurrent.js";

/**
 * The `shared-world evidence` check (invariant 4 + invariant 6): a live shared-world bundle's
 * interaction claim must match its recorded timeline + plane provenance, and its attribution
 * ceiling must be pinned. Mirrors validateTerminalProductEvidence: live-only (dry-run contract
 * bundles are skipped, exactly like the other live-only checks). Fail-closed on every overclaim.
 */
export function sharedWorldEvidenceFindings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live") {
    return bundle.sharedWorld?.skippedTail === undefined
      ? []
      : ["skippedTail requires a live executed interruption"];
  }
  const sw = bundle.sharedWorld;
  if (!sw) {
    // A live bundle that declares shared-world attribution but carries no evidence block is a
    // hollow claim — fail closed. (Absent attributionClass + absent block == an ordinary bundle.)
    return bundle.attributionClass === "shared-world"
      ? ["attributionClass is shared-world but the sharedWorld evidence block is missing"]
      : [];
  }
  // Dispatch on topologyMode first; unknown/missing → fail closed.
  const topologyMode = (sw as { topologyMode?: unknown }).topologyMode;
  if (topologyMode !== "sequential" && sw.skippedTail !== undefined) {
    return ["skippedTail is only valid on sequential shared-world evidence"];
  }
  if (topologyMode === "sequential") {
    return sequentialSharedWorldFindings(bundle, sw);
  }
  if (topologyMode === "concurrent") {
    return concurrentSharedWorldFindings(bundle, sw);
  }
  return [
    'sharedWorld.topologyMode must be "sequential" or "concurrent" (missing/unknown → fail closed)',
  ];
}

type Row = Record<string, unknown>;
type SkippedTail = Row & { roles: Row[] };

/** Validate the declared suffix against the executed prefix and existing participant evidence. */
function sequentialSkippedTailFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
  sequence: string[],
  turns: Row[],
): string[] {
  const tail: unknown = sw.skippedTail;
  if (
    !isRecord(tail) ||
    !Array.isArray(tail.roles) ||
    tail.roles.length === 0 ||
    !tail.roles.every(isRecord)
  ) {
    return ["skippedTail: a nonempty declared role suffix is required"];
  }
  const declared = tail as SkippedTail;
  const roster = [...turns, ...declared.roles];
  return [
    ...skippedTailRosterFailures(bundle, sw, sequence, turns, declared, roster),
    ...skippedTailParticipantFailures(bundle, turns, roster),
    ...skippedTailCauseFailures(bundle, turns, declared),
  ].map((message) => `skippedTail: ${message}`);
}

/** The executed prefix and blocked suffix account for every simulation and stream, once each. */
function skippedTailRosterFailures(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
  sequence: string[],
  turns: Row[],
  tail: SkippedTail,
  roster: Row[],
): string[] {
  const failures: string[] = [];
  if (
    !Number.isSafeInteger(sw.roleCount) ||
    sw.roleCount < 1 ||
    roster.length !== sw.roleCount ||
    bundle.simCount !== sw.roleCount ||
    bundle.simulations.length !== sw.roleCount ||
    bundle.streams.length !== sw.roleCount ||
    sequence.length !== turns.length ||
    turns.length === 0
  ) {
    failures.push(
      "executed prefix and blocked suffix must account for every declared simulation and stream",
    );
  }
  for (const key of ["roleId", "simId", "streamId"] as const) {
    const ids = roster.map((participant) => participant[key]);
    if (
      ids.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(ids).size !== ids.length
    ) {
      failures.push(`declared ${key} values must be nonempty and unique`);
    }
  }
  if (tail.afterRoleId !== sequence.at(-1) || tail.afterRoleId !== turns.at(-1)?.roleId) {
    failures.push("blocker must be the immediately preceding executed role");
  }
  if (bundle.review.verdict === "pass")
    failures.push("blocked participants cannot accompany a passed run review");
  return failures;
}

/**
 * Each role's simulation and stream agree in order. An executed role has an actor or an attempted
 * session error; an unstarted one is blocked with a reason, no evidence and one blocked event.
 */
function skippedTailParticipantFailures(bundle: RunBundle, turns: Row[], roster: Row[]): string[] {
  const failures: string[] = [];
  roster.forEach((participant, index) => {
    const simulation = bundle.simulations[index],
      stream = bundle.streams[index];
    if (
      !simulation ||
      !stream ||
      simulation.index !== index + 1 ||
      participant.simId !== simulation.id ||
      participant.streamId !== stream.id ||
      stream.simId !== simulation.id ||
      simulation.streamIds.length !== 1 ||
      simulation.streamIds[0] !== stream.id
    ) {
      failures.push("ordered role, simulation and stream identities must agree");
      return;
    }
    const participantEvents = bundle.events.filter(
      (event) => event.simId === simulation.id && event.streamId === stream.id,
    );
    if (index < turns.length) {
      if (
        !stream.actor &&
        !participantEvents.some((event) => event.type === "shared-world.session.error")
      ) {
        failures.push("an executed role needs an actor or an explicit attempted-session error");
      }
      return;
    }
    if (
      simulation.status !== "blocked" ||
      stream.status !== "blocked" ||
      stream.actor !== undefined ||
      stream.liveActor !== undefined ||
      stream.embed?.kind !== "placeholder" ||
      stream.ui?.actorStatus !== undefined ||
      stream.ui?.screenshotUrl !== undefined ||
      stream.artifacts.some(
        (artifact) => artifact.kind === "trace" || artifact.kind === "screenshot",
      ) ||
      typeof simulation.currentStep !== "string" ||
      simulation.currentStep.length === 0 ||
      stream.ui?.state !== simulation.currentStep
    ) {
      failures.push(
        "an unstarted role must be blocked with a reason and no actor, trace or screenshot",
      );
    }
    const sessionEvents = participantEvents.filter((event) =>
      event.type.startsWith("shared-world.session."),
    );
    if (sessionEvents.length !== 1 || sessionEvents[0]?.type !== "shared-world.session.blocked") {
      failures.push("each unstarted role needs exactly one blocked session event");
    }
  });
  return failures;
}

/** The typed interruption cause matches what the executed predecessor recorded. */
function skippedTailCauseFailures(bundle: RunBundle, turns: Row[], tail: SkippedTail): string[] {
  const failures: string[] = [];
  const predecessor = bundle.streams[turns.length - 1];
  const actor = predecessor?.actor;
  if (tail.cause === "session_error") {
    if (
      !predecessor ||
      !bundle.events.some(
        (event) =>
          event.type === "shared-world.session.error" &&
          event.simId === predecessor.simId &&
          event.streamId === predecessor.id,
      )
    ) {
      failures.push("session_error requires the predecessor's explicit orchestration error");
    }
  } else if (tail.cause === "harness_error") {
    if (actor?.completionReason !== "harness_error")
      failures.push("harness_error must match the predecessor actor");
  } else if (tail.cause === "usage_unreported") {
    if (
      !actor ||
      !(
        actor.interactionUsageIncomplete === true ||
        actor.debrief?.usageReported === false ||
        actor.estimatedCost?.estimatedCostUsd === null
      )
    )
      failures.push("usage_unreported requires recorded unavailable usage");
  } else if (tail.cause === "study_spend_limit") {
    if (!runSpendLimitRecorded(bundle, turns, tail)) {
      failures.push(
        "study_spend_limit requires known prefix estimates exceeding the recorded finite threshold",
      );
    }
  } else {
    failures.push("a supported typed interruption cause is required");
  }
  if (
    tail.cause !== "study_spend_limit" &&
    (tail.maxTotalUsd !== undefined || tail.estimatedTotalUsd !== undefined)
  ) {
    failures.push("budget figures require a measured study_spend_limit cause");
  }
  return failures;
}

/** Every executed participant's estimate is known, and their sum exceeds the recorded threshold. */
function runSpendLimitRecorded(bundle: RunBundle, turns: Row[], tail: SkippedTail): boolean {
  const estimates = bundle.streams
    .slice(0, turns.length)
    .map((stream) => stream.actor?.estimatedCost?.estimatedCostUsd);
  const allKnown =
    estimates.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) &&
    bundle.streams
      .slice(0, turns.length)
      .every(
        (stream) =>
          stream.actor?.interactionUsageIncomplete !== true &&
          stream.actor?.debrief?.usageReported !== false,
      );
  const sum = estimates.reduce<number>((total, value) => total + (value ?? 0), 0);
  return (
    allKnown &&
    typeof tail.maxTotalUsd === "number" &&
    Number.isFinite(tail.maxTotalUsd) &&
    tail.maxTotalUsd >= 0 &&
    typeof tail.estimatedTotalUsd === "number" &&
    Number.isFinite(tail.estimatedTotalUsd) &&
    tail.estimatedTotalUsd === sum &&
    sum > tail.maxTotalUsd
  );
}

/**
 * Sequential branch: the alternating timeline must be well-formed, single-plane, digest-only, and
 * carry the sequential attributionLimits. A sequential bundle must not carry concurrent fields
 * (laneWindows).
 */
function sequentialSharedWorldFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);
  // Read the raw record so an injected value-shaped field on a checkpoint is visible (the typed
  // view would hide unexpected keys).
  const rawTimeline: unknown[] = Array.isArray((sw as { timeline?: unknown }).timeline)
    ? (sw as { timeline: unknown[] }).timeline
    : [];
  if (!Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push("a sequential shared-world bundle must carry a timeline");
  }
  if (Array.isArray((sw as { laneWindows?: unknown }).laneWindows)) {
    findings.push(
      "a sequential shared-world bundle must NOT carry concurrent laneWindows (topologyMode mismatch)",
    );
  }
  const sequence = Array.isArray(sw.sequence) ? sw.sequence : [];

  // Attribution ceiling: every mandatory limit must be present (omission overclaims → fail).
  const limits = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  for (const required of MANDATORY_ATTRIBUTION_LIMITS) {
    if (!limits.includes(required)) {
      findings.push(
        `attributionLimits is missing the mandatory disclosure "${required}" — an absent ceiling overclaims`,
      );
    }
  }

  const checkpoints = rawTimeline.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.kind === "checkpoint",
  );
  const turns = rawTimeline.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.kind === "turn",
  );

  // Historical full-execution bundles keep the original equality rule. A shorter executed
  // prefix requires explicit blocked-tail evidence, never an inference from absent actors.
  if (sw.skippedTail !== undefined) {
    findings.push(...sequentialSkippedTailFindings(bundle, sw, sequence, turns));
  } else if (!(sequence.length === sw.roleCount && turns.length === sw.roleCount)) {
    findings.push(
      `phantom/dropped role: sequence length (${sequence.length}), roleCount (${sw.roleCount}), and timeline turn count (${turns.length}) must all match`,
    );
  }

  // Timeline well-formed: starts with cp-baseline, strictly alternates checkpoint → turn →
  // checkpoint, ends on a checkpoint, and turn order == sequence.
  if (rawTimeline.length === 0) {
    findings.push("timeline is empty");
  } else {
    const first = rawTimeline[0];
    if (!isRecord(first) || first.kind !== "checkpoint" || first.name !== "cp-baseline") {
      findings.push('timeline must start with the "cp-baseline" checkpoint');
    }
    const last = rawTimeline[rawTimeline.length - 1];
    if (!isRecord(last) || last.kind !== "checkpoint") {
      findings.push("timeline must end on a checkpoint");
    }
    rawTimeline.forEach((entry, index) => {
      const expected = index % 2 === 0 ? "checkpoint" : "turn";
      if (!isRecord(entry) || entry.kind !== expected) {
        findings.push(
          `timeline must strictly alternate checkpoint → turn → checkpoint (index ${index} is not a ${expected})`,
        );
      }
    });
    if (rawTimeline.length !== 1 + 2 * turns.length) {
      findings.push(
        "timeline length must be 1 baseline checkpoint + 2 entries (turn + checkpoint) per role",
      );
    }
  }
  turns.forEach((turn, index) => {
    if (turn.roleId !== sequence[index]) {
      findings.push(
        `turn order does not match the declared sequence at position ${index} (turn "${String(turn.roleId)}" vs sequence "${String(sequence[index])}")`,
      );
    }
    if (sw.skippedTail !== undefined) {
      const checkpoint = rawTimeline[index * 2 + 2];
      if (!isRecord(checkpoint) || checkpoint.name !== `cp-after-${String(turn.roleId)}`) {
        findings.push(
          "skippedTail: each after-checkpoint must belong to its executed role, never an unstarted participant",
        );
      }
    }
  });

  // Checkpoints: digest is sha256-16 and the record carries no value-shaped field (digest-only).
  for (const checkpoint of checkpoints) {
    const name = typeof checkpoint.name === "string" ? checkpoint.name : "(unnamed)";
    if (typeof checkpoint.digest !== "string" || !COMMAND_DIGEST_PATTERN.test(checkpoint.digest)) {
      findings.push(
        `checkpoint "${name}" digest is not a sha256-16 value (a value-shaped checkpoint field is rejected)`,
      );
    }
    for (const key of Object.keys(checkpoint)) {
      if (!SHARED_WORLD_CHECKPOINT_KEYS.has(key)) {
        findings.push(
          `checkpoint "${name}" carries an unexpected field "${key}" — checkpoints persist digest-only`,
        );
      }
    }
  }

  // Turns: simId/streamId resolve to a real sim/stream.
  for (const turn of turns) {
    const participantId = typeof turn.roleId === "string" ? turn.roleId : "(unnamed)";
    if (!bundle.simulations.some((simulation) => simulation.id === turn.simId)) {
      findings.push(`turn "${participantId}" references unknown simId "${String(turn.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === turn.streamId)) {
      findings.push(
        `turn "${participantId}" references unknown streamId "${String(turn.streamId)}"`,
      );
    }
  }

  // Single-plane provenance: every turn shares one (commit, seedDigest), matching sharedWorld.plane.
  // (plane.seedDigest + plane.envNames shape are checked in sharedWorldCommonFindings.)
  findings.push(
    ...planeProvenanceFindings(turns, sw.plane, {
      items: "turns",
      item: "turn",
      run: "shared-world",
    }),
  );

  // The delta-on-pass gate: a passed shared-world run must show at least one checkpoint delta;
  // otherwise the roles never interacted through shared state and the claim is hollow.
  if (
    bundle.review.verdict === "pass" &&
    !checkpoints.some((checkpoint) => checkpoint.deltaFromPrev === true)
  ) {
    findings.push(
      "review verdict is pass but no checkpoint shows deltaFromPrev — the interaction is hollow (no observed shared-state change)",
    );
  }

  return findings;
}
