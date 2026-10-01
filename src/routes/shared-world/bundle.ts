// Builds the run bundle for a concurrent shared-world run: per-seat simulations, streams and
// events, the sharedWorld evidence block and the review summary.

import path from "node:path";
import { receivingPublication } from "../../comms/receiving-runtime.js";
import { redactText } from "../../evidence/redaction.js";
import type { LabSubjectState } from "../../lab/types.js";
import { planeStateOf } from "./plan.js";
import {
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunCostSummary,
  type RunEvent,
  type RunSimulation,
} from "../../run/bundle.js";
import {
  SHARED_WORLD_SCHEMA,
  concurrencyFacts,
  type SharedWorldEvidence,
  type SharedWorldLaneWindow,
  type SharedWorldOutcome,
  type SharedWorldPlane,
  type SharedWorldStateSnapshot,
} from "../../run/shared-world-evidence.js";
import type { RunStream } from "../../run/streams.js";
import { commandDigestOf } from "../../subject/state.js";
import { buildRunCostSummary, desktopSpanToMinutes } from "../../run/cost-summary.js";
import { participantFactsOf } from "../computer-use/bundle.js";
import { judgeSharedWorld, participantPassed, type SharedWorldJudgment } from "../../run/judge.js";
import { combineCheckpointDigest } from "./checkpoints.js";
import { hostOriginDigest } from "./provenance.js";
import { seatRecords } from "./seat-records.js";
import {
  CONCURRENT_ATTRIBUTION_LIMITS,
  EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS,
  type ActorLaneResult,
  type ConcurrentBundleArgs,
} from "./types.js";

/** Max windows live at the same instant (sweep over start/end points). The honest simultaneity
 *  count: lane COUNT says how many seats existed; this says how many ever ran at once. */
export function maxSimultaneousWindows(
  windows: Array<{ startedAt: number; endedAt: number }>,
): number {
  const points = windows
    .filter((w) => w.endedAt > w.startedAt)
    .flatMap((w) => [
      { at: w.startedAt, delta: 1 },
      { at: w.endedAt, delta: -1 },
    ]);
  points.sort((a, b) => a.at - b.at || a.delta - b.delta); // end before start at the same instant
  let live = 0;
  let max = 0;
  for (const point of points) {
    live += point.delta;
    if (live > max) max = live;
  }
  return max;
}

/**
 * The judgment for a shared-world bundle's inputs: how each seat ended, plus what the run observed
 * about its world: overlap, a state change under overlap on the provisioned plane, and lobby
 * convergence on the external-public plane. The bundle's verdict and the lab result's ok both read
 * it.
 */
export function judgeSharedWorldRun(
  args: Omit<ConcurrentBundleArgs, "judgment">,
): SharedWorldJudgment {
  const external = (args.planeClass ?? "provisioned-getHost") === "external-public";
  return judgeSharedWorld({
    dryRun: args.dryRun,
    inProgress: args.inProgress === true,
    expected: args.actorSpecs.length,
    participants: args.actorResults.map((result) => participantFactsOf(result.outcome)),
    world: {
      // The same windows and state series the bundle writes, read by verify's pass gate too.
      ...concurrencyFacts(
        args.actorSpecs.map((_spec, index) => ({
          startedAt: args.actorResults[index]?.startedAt ?? 0,
          endedAt: args.actorResults[index]?.endedAt ?? 0,
        })),
        external ? undefined : args.stateSnapshots,
      ),
      ...(external ? { lobbyConvergence: args.lobbyConvergenceDigest !== undefined } : {}),
    },
  });
}

export function actorLanePassed(result: ActorLaneResult | undefined): boolean {
  return result !== undefined && participantPassed(participantFactsOf(result.outcome));
}

/**
 * Keep three different claims separate in the stakeholder roll-up:
 *
 * - `outcome.ok` says the actor session passed the harness's credibility checks;
 * - `completionReason` says how the participant session ended;
 * - shared-world convergence is reported by the plane-specific summary alongside this line.
 *
 * None of those is adopter-scored proof that the mission text was completed. In particular, a
 * productive `budget_reached` session can coexist with lobby convergence without becoming a
 * `goal_satisfied` result (#364).
 */
function formatSharedWorldActorOutcomes(
  outcomes: SharedWorldOutcome[],
  expectedCount: number,
): string {
  const passedSessions = outcomes.filter((outcome) => outcome.ok).length;
  const goalSatisfiedSessions = outcomes.filter(
    (outcome) => outcome.ok && outcome.completionReason === "goal_satisfied",
  ).length;
  const completionReasonCounts = new Map<string, number>();
  for (const outcome of outcomes) {
    const reason = outcome.completionReason ?? "not_recorded";
    completionReasonCounts.set(reason, (completionReasonCounts.get(reason) ?? 0) + 1);
  }
  for (let missing = outcomes.length; missing < expectedCount; missing += 1) {
    completionReasonCounts.set(
      "not_recorded",
      (completionReasonCounts.get("not_recorded") ?? 0) + 1,
    );
  }
  const completionReasons = [...completionReasonCounts.entries()]
    // ASCII contract tokens: compare directly so bundle text is byte-stable across host locales.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([reason, count]) => `${reason} ${count}/${expectedCount}`)
    .join(", ");

  return `${passedSessions}/${expectedCount} actor session(s) passed credibility checks; mission endpoint: ${goalSatisfiedSessions}/${expectedCount} ended goal_satisfied; completion reasons: ${completionReasons}`;
}

/** The run's first two events: its creation and the shared plane's provenance. */
function planeEvents(args: ConcurrentBundleArgs, external: boolean): RunEvent[] {
  const { plan, descriptor, createdAt, dryRun, actorSpecs } = args;
  const events: RunEvent[] = [];
  events.push({
    id: "event-000-created",
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.run.created",
    message: `Created CONCURRENT shared-world run for ${plan.labId} (actor ${descriptor.id}, ${actorSpecs.length} persona(s) vs ONE shared plane, max ${plan.concurrency} concurrent).`,
  });
  // Human-readable plane label, byte-stable for the clone route. local-tree has no repo slug: it
  // labels the packed archive instead (archiveSha256 + dirty/clean when the packed root was a git
  // work tree).
  const dryRunPlaneLabel =
    args.subject.source === "local-tree" ? "packed working tree" : `clone of ${args.subject.repo}`;
  const livePlaneLabel =
    args.subject.source === "local-tree"
      ? args.subject.archiveSha256
        ? `packed working tree (archiveSha256 ${args.subject.archiveSha256}${args.subject.dirty === true ? ", dirty working tree" : args.subject.dirty === false ? ", clean working tree" : ""})`
        : "packed working tree (archive digest unresolved; provisioning failed before resolution)"
      : `clone of ${args.subject.repo}${args.subjectCommit ? `@${args.subjectCommit}` : ""}`;
  // External-public plane provenance is HONESTLY different: an operator-declared, operator-OWNED
  // public deployment humanish neither provisioned nor seeded — NO getHost, NO clone, NO synthetic
  // attestation (claiming synthetic on a real site is a lie). The origin persists digest-only.
  // planSharedWorldLab refuses an external-public plane without a declared owner; the fallback
  // says so rather than naming one.
  const externalPlaneOwner =
    plan.plane.kind === "external-public" ? plan.plane.owner : "(undeclared)";
  events.push({
    id: "event-001-plane",
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.plane.provenance",
    message: external
      ? `Shared plane: an EXTERNAL-PUBLIC deployment (operator-attested owner ${externalPlaneOwner}, authorized) used DIRECTLY as the shared plane — NO getHost, clone, subject sandbox, or seed. The harness OBSERVES that each seat reached the operator-declared origin (publicOriginDigest); it did NOT mint or control the plane. Author-trust ownership attestation, NOT a synthetic-data claim.`
      : dryRun
        ? `Shared plane declared: ${dryRunPlaneLabel}, served + getHost-exposed in-sandbox (dry-run contract; nothing ${args.subject.source === "local-tree" ? "packed" : "cloned"}). Seed recipe ${args.seedDigest}; SYNTHETIC subject (author-attested); env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`
        : `Shared plane: ${livePlaneLabel}, served + exposed at the harness-minted getHost URL; seed recipe ${args.seedDigest}; SYNTHETIC subject (author-attested); env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`,
    simId: actorSpecs[0]?.simId ?? "sim-001",
    streamId: actorSpecs[0]?.streamId ?? "stream-001",
  });
  return events;
}

/** The sharedWorld block: seat windows, the state series, seat outcomes and the plane. */
function sharedWorldEvidence(
  args: ConcurrentBundleArgs,
  external: boolean,
  inProgress: boolean,
  planeCommit: string | undefined,
): {
  sharedWorld: SharedWorldEvidence;
  laneWindows: SharedWorldLaneWindow[];
  stateSeries: SharedWorldStateSnapshot[] | undefined;
  outcomes: SharedWorldOutcome[];
} {
  const { plan, dryRun, actorSpecs, actorResults } = args;
  // Build the concurrent shared-world evidence block. routeHostDigest is sha256-16 of the ORIGIN each
  // seat reached: on getHost the seat URL the actor drove (verify confirms == plane.hostDigest); on
  // external-public the seat's CDP-OBSERVED URL origin (verify confirms == plane.publicOriginDigest).
  const fallbackHostDigest = external
    ? (args.publicOriginDigest ?? commandDigestOf("[external-public-plane]"))
    : (args.hostDigest ?? commandDigestOf("[provisioned-subject]"));
  const laneWindows: SharedWorldLaneWindow[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const session = result?.outcome.session;
    const routeHostDigest = result ? hostOriginDigest(result.route) : fallbackHostDigest;
    return {
      roleId: spec.planned.id,
      ...(spec.planned.labels.actorType === undefined
        ? {}
        : { actorType: spec.planned.labels.actorType }),
      ...(spec.planned.labels.surface === undefined
        ? {}
        : { surface: spec.planned.labels.surface }),
      ...(spec.planned.labels.caseGroup === undefined
        ? {}
        : { caseGroup: spec.planned.labels.caseGroup }),
      simId: spec.simId,
      streamId: spec.streamId,
      startedAt: result?.startedAt ?? 0,
      endedAt: result?.endedAt ?? 0,
      verdict: session
        ? session.status
        : result?.outcome.sessionError
          ? "failed"
          : inProgress
            ? "running"
            : "contract_proof_only",
      routeHostDigest,
      ...(planeCommit === undefined ? {} : { commit: planeCommit }),
      seedDigest: args.seedDigest,
    };
  });

  // Option A (external-public): NO authoritative shared-state proof — OMIT stateSeries entirely (there
  // is no in-sandbox filesystem to digest; concurrency is proven by temporal co-occupancy + lobby
  // convergence). The provisioned-getHost plane keeps its authoritative in-sandbox checkpoint series.
  const stateSeries: SharedWorldStateSnapshot[] | undefined = external
    ? undefined
    : dryRun
      ? [{ timestamp: 0, digest: declaredStateDigest(planeStateOf(plan)) }]
      : [...args.stateSnapshots].sort((a, b) => a.timestamp - b.timestamp);

  const outcomes: SharedWorldOutcome[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const session = result?.outcome.session;
    const ok = !dryRun && actorLanePassed(result);
    return {
      roleId: spec.planned.id,
      ...(spec.planned.labels.actorType === undefined
        ? {}
        : { actorType: spec.planned.labels.actorType }),
      ...(spec.planned.labels.surface === undefined
        ? {}
        : { surface: spec.planned.labels.surface }),
      ...(spec.planned.labels.caseGroup === undefined
        ? {}
        : { caseGroup: spec.planned.labels.caseGroup }),
      simId: spec.simId,
      streamId: spec.streamId,
      status: session
        ? session.status
        : result?.outcome.sessionError
          ? "failed"
          : inProgress
            ? "running"
            : "contract_proof_only",
      ...(session ? { completionReason: session.completionReason } : {}),
      ok,
    };
  });

  // The plane block is plane-class-specific. getHost: harness-minted hostDigest + synthetic
  // attestation. external-public: operator-declared publicOriginDigest, NO hostDigest, NO exposure
  // (claiming synthetic on a real site would be a lie — verify asserts both ABSENT there).
  const plane: SharedWorldPlane = external
    ? {
        seedDigest: args.seedDigest,
        envNames: [],
        // publicOriginDigest is the OBSERVED convergence origin; declaredOriginDigest records the
        // operator-declared origin for reference (a redirect makes them differ — not a failure).
        ...(args.publicOriginDigest === undefined
          ? {}
          : { publicOriginDigest: args.publicOriginDigest }),
        ...(args.declaredOriginDigest === undefined
          ? {}
          : { declaredOriginDigest: args.declaredOriginDigest }),
      }
    : {
        ...(planeCommit === undefined ? {} : { commit: planeCommit }),
        seedDigest: args.seedDigest,
        envNames: args.subject.envNames ?? [],
        ...(args.hostDigest === undefined ? {} : { hostDigest: args.hostDigest }),
        exposure: "synthetic",
      };

  const sharedWorld: SharedWorldEvidence = {
    schema: SHARED_WORLD_SCHEMA,
    topology: "shared-world",
    topologyMode: "concurrent",
    // Byte-stable: the provisioned-getHost plane omits planeClass (absent == provisioned-getHost).
    ...(external ? { planeClass: "external-public" as const } : {}),
    roleCount: actorSpecs.length,
    plane,
    attributionLimits: external
      ? [...EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS]
      : [...CONCURRENT_ATTRIBUTION_LIMITS],
    laneWindows,
    // Option A: external-public carries NO stateSeries.
    ...(stateSeries === undefined ? {} : { stateSeries }),
    outcomes,
    ...(args.lobbyConvergenceDigest === undefined
      ? {}
      : { lobbyConvergenceDigest: args.lobbyConvergenceDigest }),
  };

  return { sharedWorld, laneWindows, stateSeries, outcomes };
}

/** Records the concurrency event and returns the review. */
function concurrencyReview(
  args: ConcurrentBundleArgs,
  external: boolean,
  inProgress: boolean,
  evidence: ReturnType<typeof sharedWorldEvidence>,
  events: RunEvent[],
  nextEventId: (suffix: string) => string,
): ReviewSummary {
  const { plan, descriptor, createdAt, dryRun, actorSpecs, actorResults } = args;
  const { sharedWorld, laneWindows, stateSeries, outcomes } = evidence;
  const overlaps = args.judgment.world.overlap;
  const deltas = (stateSeries ?? []).filter(
    (snapshot, i) => i > 0 && snapshot.digest !== (stateSeries ?? [])[i - 1]!.digest,
  ).length;
  const stateSeriesLabel = external
    ? "stateSeries omitted (no authoritative shared-state proof on the external-public plane)"
    : `stateSeries ${(stateSeries ?? []).length} snapshot(s), ${deltas} delta(s)`;
  const convergenceLabel = external
    ? `; lobby convergence ${args.lobbyConvergenceDigest ? "PROVEN (all seats reached one /lobby/CODE)" : "not observed"}`
    : "";
  // The count that matters is how many lanes were LIVE AT ONCE, not how many lanes exist — a
  // 6-lane run capped at 3 must never read as 6-wide concurrency (#350, the field failure).
  const capForReport = plan.concurrency;
  const maxLive = maxSimultaneousWindows(laneWindows);
  events.push({
    id: nextEventId("concurrency"),
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.concurrency",
    message: `Concurrency: ${laneWindows.length} lane(s)${dryRun ? " (dry-run contract; $0)" : `, up to ${maxLive} live at once (cap ${capForReport}), overlap ${overlaps ? "PROVEN" : "not observed"}`}; ${stateSeriesLabel}${convergenceLabel}. Attribution ceiling: ${sharedWorld.attributionLimits.join(", ")}. ${dryRun ? "This contract-only run proves no live concurrency, scale, or adoption." : "This run reports only its own observed overlap and state changes; it does not prove scale, repeatability, or adopter-harness replacement."}`,
  });

  // The judge's verdict (judgeSharedWorld): every seat produced a terminal, engaged PASSED session.
  // Mission endpoint and completion reasons are reported separately below; `outcomes[].ok` is not
  // renamed into mission success (#364).
  const verdict = args.judgment.verdict;
  const actorOutcomeSummary = formatSharedWorldActorOutcomes(outcomes, actorSpecs.length);

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    // Plane-class-aware: the external-public plane has NO getHost/clone/seed and carries NO
    // authoritative state series, so its summary must not claim a getHost-exposed plane (dry-run) nor
    // report "state delta(s) under load" (live) — it reports lobby convergence instead.
    summary: dryRun
      ? external
        ? `Dry-run concurrent shared-world contract: ${actorSpecs.length} persona(s) declared against ONE external-public shared plane (a real public deployment used directly; no getHost/clone/seed); no sandboxes launched, $0 spend.`
        : `Dry-run concurrent shared-world contract: ${actorSpecs.length} persona(s) declared against ONE getHost-exposed plane (${descriptor.id}); no sandboxes launched, $0 spend.`
      : inProgress
        ? `In-progress concurrent shared-world Observer snapshot: ${actorSpecs.length} persona(s) running against ONE shared plane; final verification is pending.`
        : external
          ? `Concurrent shared-world (ONE external-public plane, ${actorSpecs.length} simultaneous personas): swarm ${verdict === "pass" ? "ran coherently" : "did not run coherently"}; ${actorOutcomeSummary}; overlap ${overlaps ? "proven" : "not observed"}; ${args.lobbyConvergenceDigest ? `${actorSpecs.length} seats converged on one lobby` : "lobby convergence not observed"}.`
          : `Concurrent shared-world (ONE plane, ${actorSpecs.length} simultaneous personas): swarm ${verdict === "pass" ? "ran coherently" : "did not run coherently"}; ${actorOutcomeSummary}; overlap ${overlaps ? "proven" : "not observed"}; ${deltas} state delta(s) under load.`,
    gaps: dryRun
      ? [
          "This dry-run launched no concurrent shared-world session; it proves contract shape only, not live behavior, scale, or adopter-harness replacement.",
        ]
      : inProgress
        ? [
            "Final actor traces, screenshots, state deltas, and verification are pending; this Observer is for live watch only.",
          ]
        : actorResults
            .filter(
              (result) =>
                result.outcome.sessionError !== undefined ||
                result.outcome.noEngagement ||
                result.outcome.selfReportedBlocker ||
                result.outcome.session === undefined ||
                result.outcome.session.status !== "passed",
            )
            .map(
              (result) =>
                `${result.spec.planned.id}: ${result.outcome.sessionError ?? result.outcome.session?.reason ?? "did not pass"}`,
            ),
  };
  return review;
}

/** Project the concurrent run into a humanish.run-bundle.v1 with the CONCURRENT shared-world block. */
export function buildConcurrentSharedWorldBundle(args: ConcurrentBundleArgs): RunBundle {
  const { plan, descriptor, createdAt, dryRun, actorSpecs, actorResults } = args;
  const inProgress = args.inProgress === true;
  const external = (args.planeClass ?? "provisioned-getHost") === "external-public";
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  // Public-safe label only — neither the raw getHost URL (provisioned) nor the raw public origin
  // (external-public) lands in the bundle. The plane identity is a DIGEST (plane.hostDigest on
  // getHost; plane.publicOriginDigest on external-public).
  const appUrl = external ? "[external-public-plane]" : "[provisioned-subject]";
  const planeCommit = external ? undefined : dryRun ? undefined : args.subjectCommit;
  const events = planeEvents(args, external);

  let eventSeq = 2;
  const nextEventId = (suffix: string): string =>
    `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  const seatContext = { args, external, inProgress, appUrl, nextEventId };
  actorSpecs.forEach((spec, index) => {
    const records = seatRecords(seatContext, spec, index);
    simulations.push(records.simulation);
    streams.push(records.stream);
    events.push(...records.events);
  });

  const evidence = sharedWorldEvidence(args, external, inProgress, planeCommit);
  const { sharedWorld } = evidence;
  const review = concurrencyReview(args, external, inProgress, evidence, events, nextEventId);

  const anyRaw = actorResults.some(
    (result) => result.outcome.session?.trace.redaction.screenshots === "raw",
  );
  const ranLive = actorResults.some(
    (result) => result.outcome.session !== undefined || result.outcome.sessionError !== undefined,
  );

  const cost = concurrentCostSummary(args, inProgress);
  return {
    schema: RUN_BUNDLE_SCHEMA,
    ...receivingPublication(plan.residual, args.dryRun),
    runId: args.runId,
    mode: dryRun ? "dry-run" : "live",
    simCount: actorSpecs.length,
    createdAt,
    cwd: PUBLIC_TARGET_CWD,
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    artifactRoot: path.join(".humanish", "runs", args.runId),
    source: args.source,
    persona: {
      id: actorSpecs[0]?.persona.id ?? "concurrent-persona",
      name: `Concurrent shared-world swarm (${actorSpecs.length} personas)`,
      source: `lab:${plan.labId}`,
      sourceDigest: actorSpecs[0]?.persona.promptDigest ?? args.seedDigest,
    },
    scenario: {
      id: `concurrent-shared-world-${plan.labId}`,
      title: plan.title ?? `Concurrent shared-world: ${plan.labId}`,
      goal: redactText(
        actorSpecs[0]?.evidenceInstructions ??
          actorSpecs[0]?.instructions ??
          "Concurrent shared-world interaction.",
      ),
      source: `lab:${plan.labId}`,
      sourceDigest: actorSpecs[0]?.persona.promptDigest ?? args.seedDigest,
    },
    lifecycle: [
      {
        at: createdAt,
        event: "concurrent-shared-world.run.created",
        message: `Created concurrent shared-world run with ONE shared plane and ${actorSpecs.length} simultaneous actor seats (actor ${descriptor.id}).`,
      },
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: ranLive
        ? anyRaw
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Some personas captured FULL-FIDELITY (raw) screenshots, retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle. stateSeries persists digest-only."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle. stateSeries persists digest-only."
        : inProgress
          ? "In-progress live Observer snapshot: runtime stream auth URLs are process-local only and are not persisted. Final typed text, traces, and screenshots are pending. stateSeries persists digest-only."
          : "Dry-run concurrent shared-world contract bundle: no sandboxes launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs. stateSeries persists digest-only.",
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson",
    },
    review,
    feedbackCandidates: [],
    // Custom desktop image provenance (subject + every actor sandbox launched on it); omitted on the default.
    ...(plan.residual.execution?.desktop?.template === undefined
      ? {}
      : { desktopTemplate: plan.residual.execution.desktop.template }),
    subject: args.subject,
    attributionClass: "shared-world",
    sharedWorld,
    ...(cost === undefined ? {} : { cost }),
  };
}

/**
 * Priced like per-lane worlds: each seat's model tokens and desktop, plus the provisioned plane's
 * desktop. Absent when nothing ran, so dry runs and in-progress snapshots stay byte-stable.
 */
function concurrentCostSummary(
  args: ConcurrentBundleArgs,
  inProgress: boolean,
): RunCostSummary | undefined {
  if (inProgress) return undefined;
  const subject = args.subjectDesktop;
  return buildRunCostSummary({
    lanes: args.actorResults.flatMap((result) =>
      result.outcome.session === undefined
        ? []
        : [{ laneId: result.spec.planned.id, trace: result.outcome.session.trace }],
    ),
    desktops: [
      ...(subject === undefined
        ? []
        : [
            {
              laneId: "subject",
              minutes: desktopSpanToMinutes(subject.durationMs),
              observation: subject.observation,
              lifetimeComplete: subject.killed,
            },
          ]),
      ...args.actorResults.flatMap((result) =>
        result.outcome.sandboxId === undefined
          ? []
          : [
              {
                laneId: result.spec.planned.id,
                minutes: desktopSpanToMinutes(result.outcome.desktopDurationMs),
                observation: result.outcome.desktopResources,
                lifetimeComplete: result.outcome.killed,
              },
            ],
      ),
    ],
  });
}

/** The declared (dry-run) state digest: the probe RECIPE (command digests), no run. */
function declaredStateDigest(state: LabSubjectState | undefined): string {
  const probes = state?.checkpoint ?? [];
  return combineCheckpointDigest(
    probes.map((probe) => `${probe.name}=${commandDigestOf(probe.command)}`),
  );
}

export function renderConcurrentReviewMarkdown(bundle: RunBundle): string {
  const plane = bundle.events.find(
    (event) => event.type === "concurrent-shared-world.plane.provenance",
  );
  const concurrency = bundle.events.find(
    (event) => event.type === "concurrent-shared-world.concurrency",
  );
  const sw = bundle.sharedWorld;
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- attribution class: ${bundle.attributionClass ?? "isolated"}`,
    `- topology: ${sw?.topology ?? "(none)"} / ${sw?.topologyMode ?? "(none)"}`,
    `- personas: ${sw?.roleCount ?? 0}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(plane ? [`- plane: ${plane.message}`] : []),
    ...(concurrency ? [`- concurrency: ${concurrency.message}`] : []),
    ...(sw ? [`- attribution limits: ${sw.attributionLimits.join(", ")}`] : []),
    ...(bundle.review.gaps.length > 0
      ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)]
      : []),
    "",
  ].join("\n");
}
