import type { RunBundle } from "./bundle.js";
import type { SharedWorldEvidence } from "./shared-world-evidence.js";
import {
  COMMAND_DIGEST_PATTERN,
  MANDATORY_ATTRIBUTION_LIMITS,
  SHARED_WORLD_CHECKPOINT_KEYS,
  sharedWorldCommonFindings,
} from "./guards-shared-world.js";
import { isRecord } from "./primitives.js";
import { concurrentSharedWorldFindings } from "./verify-shared-world-concurrent.js";

/**
 * The `shared-world evidence` check (invariant 4 + invariant 6): a LIVE shared-world bundle's
 * interaction CLAIM must match its recorded timeline + plane provenance, and its attribution
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
    // A live bundle that DECLARES shared-world attribution but carries no evidence block is a
    // hollow claim — fail closed. (Absent attributionClass + absent block == an ordinary bundle.)
    return bundle.attributionClass === "shared-world"
      ? ["attributionClass is shared-world but the sharedWorld evidence block is missing"]
      : [];
  }
  // Dispatch on topologyMode FIRST; unknown/missing → fail closed.
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

/** Validate the declared suffix against the executed prefix and existing participant evidence. */
function sequentialSkippedTailFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
  sequence: string[],
  turns: Record<string, unknown>[],
): string[] {
  const failures: string[] = [];
  const reject = (message: string): void => {
    failures.push(`skippedTail: ${message}`);
  };
  const tail: unknown = sw.skippedTail;
  if (
    !isRecord(tail) ||
    !Array.isArray(tail.roles) ||
    tail.roles.length === 0 ||
    !tail.roles.every(isRecord)
  ) {
    return ["skippedTail: a nonempty declared role suffix is required"];
  }
  const roster = [...turns, ...tail.roles];
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
    reject(
      "executed prefix and blocked suffix must account for every declared simulation and stream",
    );
  }
  for (const key of ["roleId", "simId", "streamId"] as const) {
    const ids = roster.map((role) => role[key]);
    if (
      ids.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(ids).size !== ids.length
    ) {
      reject(`declared ${key} values must be nonempty and unique`);
    }
  }
  if (tail.afterRoleId !== sequence.at(-1) || tail.afterRoleId !== turns.at(-1)?.roleId) {
    reject("blocker must be the immediately preceding executed role");
  }
  if (bundle.review.verdict === "pass")
    reject("blocked participants cannot accompany a passed run review");
  roster.forEach((role, index) => {
    const sim = bundle.simulations[index],
      stream = bundle.streams[index];
    if (
      !sim ||
      !stream ||
      sim.index !== index + 1 ||
      role.simId !== sim.id ||
      role.streamId !== stream.id ||
      stream.simId !== sim.id ||
      sim.streamIds.length !== 1 ||
      sim.streamIds[0] !== stream.id
    ) {
      reject("ordered role, simulation and stream identities must agree");
      return;
    }
    const roleEvents = bundle.events.filter(
      (event) => event.simId === sim.id && event.streamId === stream.id,
    );
    if (index < turns.length) {
      if (
        !stream.actor &&
        !roleEvents.some((event) => event.type === "shared-world.session.error")
      ) {
        reject("an executed role needs an actor or an explicit attempted-session error");
      }
      return;
    }
    if (
      sim.status !== "blocked" ||
      stream.status !== "blocked" ||
      stream.actor !== undefined ||
      stream.liveActor !== undefined ||
      stream.embed?.kind !== "placeholder" ||
      stream.ui?.actorStatus !== undefined ||
      stream.ui?.screenshotUrl !== undefined ||
      stream.artifacts.some(
        (artifact) => artifact.kind === "trace" || artifact.kind === "screenshot",
      ) ||
      typeof sim.currentStep !== "string" ||
      sim.currentStep.length === 0 ||
      stream.ui?.state !== sim.currentStep
    ) {
      reject("an unstarted role must be blocked with a reason and no actor, trace or screenshot");
    }
    const sessionEvents = roleEvents.filter((event) =>
      event.type.startsWith("shared-world.session."),
    );
    if (sessionEvents.length !== 1 || sessionEvents[0]?.type !== "shared-world.session.blocked") {
      reject("each unstarted role needs exactly one blocked session event");
    }
  });
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
      reject("session_error requires the predecessor's explicit orchestration error");
    }
  } else if (tail.cause === "harness_error") {
    if (actor?.completionReason !== "harness_error")
      reject("harness_error must match the predecessor actor");
  } else if (tail.cause === "usage_unreported") {
    if (
      !actor ||
      !(
        actor.interactionUsageIncomplete === true ||
        actor.debrief?.usageReported === false ||
        actor.estimatedCost?.estimatedCostUsd === null
      )
    )
      reject("usage_unreported requires recorded unavailable usage");
  } else if (tail.cause === "study_spend_limit") {
    const estimates = bundle.streams
      .slice(0, turns.length)
      .map((stream) => stream.actor?.estimatedCost?.estimatedCostUsd);
    const allKnown =
      estimates.every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      ) &&
      bundle.streams
        .slice(0, turns.length)
        .every(
          (stream) =>
            stream.actor?.interactionUsageIncomplete !== true &&
            stream.actor?.debrief?.usageReported !== false,
        );
    const sum = estimates.reduce<number>((total, value) => total + (value ?? 0), 0);
    if (
      !allKnown ||
      typeof tail.maxTotalUsd !== "number" ||
      !Number.isFinite(tail.maxTotalUsd) ||
      tail.maxTotalUsd < 0 ||
      typeof tail.estimatedTotalUsd !== "number" ||
      !Number.isFinite(tail.estimatedTotalUsd) ||
      tail.estimatedTotalUsd !== sum ||
      !(sum > tail.maxTotalUsd)
    ) {
      reject(
        "study_spend_limit requires known prefix estimates exceeding the recorded finite threshold",
      );
    }
  } else {
    reject("a supported typed interruption cause is required");
  }
  if (
    tail.cause !== "study_spend_limit" &&
    (tail.maxTotalUsd !== undefined || tail.estimatedTotalUsd !== undefined)
  ) {
    reject("budget figures require a measured study_spend_limit cause");
  }
  return failures;
}

/**
 * SEQUENTIAL branch: the alternating timeline must be well-formed, single-plane, digest-only, and
 * carry the sequential attributionLimits. A sequential bundle must NOT carry concurrent fields
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

  // Attribution ceiling: every mandatory limit MUST be present (omission overclaims → fail).
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
          "skippedTail: each after-checkpoint must belong to its executed role, never an unstarted seat",
        );
      }
    }
  });

  // Checkpoints: digest is sha256-16 and the record carries NO value-shaped field (digest-only).
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
    const roleId = typeof turn.roleId === "string" ? turn.roleId : "(unnamed)";
    if (!bundle.simulations.some((sim) => sim.id === turn.simId)) {
      findings.push(`turn "${roleId}" references unknown simId "${String(turn.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === turn.streamId)) {
      findings.push(`turn "${roleId}" references unknown streamId "${String(turn.streamId)}"`);
    }
  }

  // Single-plane provenance: every turn shares ONE (commit, seedDigest), matching sharedWorld.plane.
  // (plane.seedDigest + plane.envNames shape are checked in sharedWorldCommonFindings.)
  const plane = sw.plane;
  const planeKeys = new Set(
    turns.map((turn) => `${String(turn.commit ?? "")}::${String(turn.seedDigest ?? "")}`),
  );
  if (planeKeys.size > 1) {
    findings.push(
      "turns reference divergent plane provenance (commit/seedDigest) — a shared-world run drives ONE plane",
    );
  }
  if (isRecord(plane)) {
    for (const turn of turns) {
      if (
        String(turn.seedDigest ?? "") !== String(plane.seedDigest ?? "") ||
        String(turn.commit ?? "") !== String(plane.commit ?? "")
      ) {
        const roleId = typeof turn.roleId === "string" ? turn.roleId : "(unnamed)";
        findings.push(`turn "${roleId}" plane provenance diverges from sharedWorld.plane`);
        break;
      }
    }
  }

  // The delta-on-pass gate: a PASSED shared-world run MUST show at least one checkpoint delta —
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

/**
 * Advisory (never flips ok): a LIVE clone bundle whose subject env is provisioned while its
 * state story is undeclared probably points at state the lab does not control. Emitted at
 * most ONCE per bundle (the subject block is bundle-level, never per stream). GITHUB_TOKEN
 * is mechanically excluded: the harness consumes that name for clone auth — it carries no
 * state implication.
 */
export function undeclaredSubjectStateWarnings(bundle: RunBundle): string[] {
  const subject = bundle.subject;
  if (subject === undefined || bundle.mode !== "live" || subject.source !== "clone") {
    return [];
  }
  if (subject.state.provenance !== "undeclared") {
    return [];
  }
  const stateRelevantEnvNames = (subject.envNames ?? []).filter((name) => name !== "GITHUB_TOKEN");
  if (stateRelevantEnvNames.length === 0) {
    return [];
  }
  return [
    `Subject env is provisioned (${stateRelevantEnvNames.join(", ")}) but no state story is declared; if any name points at external state, declare subject.state.external (recorded UNPINNED) or seed in-sandbox state with subject.state.seed.`,
  ];
}
