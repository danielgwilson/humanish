// Builds the run bundle for a concurrent shared-world run: per-participant simulations, streams and
// events, the sharedWorld evidence block and the review summary.

import { receivingPublication } from "../../comms/receiving-runtime.js";
import { redactText } from "../../evidence/redaction.js";
import type { StudySubjectState } from "../../study/types.js";
import { planeStateOf } from "./plan.js";
import {
  REVIEW_SCHEMA,
  bundleArtifacts,
  bundleHead,
  type ReviewSummary,
  type RunBundle,
  type RunCostSummary,
  type RunEvent,
  type RunFeedbackCandidate,
  type RunSimulation,
} from "../../run/bundle.js";
import {
  SHARED_WORLD_SCHEMA,
  concurrencyFacts,
  sharedWorldParticipantKeys,
  type SharedWorldEvidence,
  type SharedWorldParticipantWindow,
  type SharedWorldOutcome,
  type SharedWorldPlane,
  type SharedWorldStateSnapshot,
} from "../../run/shared-world-evidence.js";
import type { RunStream } from "../../run/streams.js";
import { commandDigestOf } from "../../subject/state.js";
import { buildRunCostSummary, desktopSpanToMinutes } from "../../run/cost-summary.js";
import { participantFactsOf } from "../computer-use/participant-facts.js";
import { participantFeedbackCandidates } from "../computer-use/participant-feedback.js";
import {
  judgeSharedWorld,
  participantPassed,
  type SharedWorldJudgment,
  sharedWorldShortfall,
  verdictText,
} from "../../run/judge.js";
import { reviewOutcome } from "../../run/display.js";
import { combineCheckpointDigest } from "./checkpoints.js";
import { hostOriginDigest } from "./provenance.js";
import { participantEvent, participantIds } from "../../run/participant-records.js";
import { sharedWorldParticipantRecords } from "./bundle-records.js";
import {
  CONCURRENT_ATTRIBUTION_LIMITS,
  EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS,
  type ActorRunResult,
  type ConcurrentBundleArgs,
} from "./types.js";
import { plural } from "../../run/text.js";

/** Max windows live at the same instant (sweep over start/end points). The simultaneity
 *  count: the participant count says how many existed; this says how many ever ran at once. */
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
 * The judgment for a shared-world bundle's inputs: how each participant ended, plus what the run
 * observed about its world: overlap, a state change under overlap on the provisioned plane, and
 * lobby convergence on the external-public plane. The bundle's verdict and the study result's ok
 * both read it.
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

export function actorRunPassed(result: ActorRunResult | undefined): boolean {
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
 * `goal_satisfied` result.
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

  return `${passedSessions}/${plural(expectedCount, "actor session")} passed credibility checks; mission endpoint: ${goalSatisfiedSessions}/${expectedCount} ended goal_satisfied; completion reasons: ${completionReasons}`;
}

/** The run's first two events: its creation and the shared plane's provenance. */
function planeEvents(args: ConcurrentBundleArgs, external: boolean): RunEvent[] {
  const {
    plan,
    descriptor,
    run: { createdAt },
    dryRun,
    actorSpecs,
  } = args;
  const events: RunEvent[] = [];
  events.push({
    id: "event-000-created",
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.run.created",
    message: `Created a concurrent shared-world run for ${plan.studyId} (actor ${descriptor.id}, ${plural(actorSpecs.length, "persona")} on one shared app, at most ${plan.concurrency} at once).`,
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
  // External-public plane provenance differs: an operator-declared, operator-owned public
  // deployment humanish neither provisioned nor seeded, with no getHost, no clone and no synthetic
  // attestation (claiming synthetic on a real site is a lie). The origin persists digest-only.
  // planSharedWorldStudy refuses an external-public plane without a declared owner; the fallback
  // says so rather than naming one.
  const externalPlaneOwner =
    plan.plane.kind === "external-public" ? plan.plane.owner : "(undeclared)";
  events.push(
    participantEvent(actorSpecs[0] ?? participantIds(0), {
      id: "event-001-plane",
      at: createdAt,
      level: "info",
      type: "concurrent-shared-world.plane.provenance",
      message: external
        ? `Shared app: a public deployment the operator declares they own (${externalPlaneOwner}, authorized), used as it is, with no sandbox, clone or seed. humanish observed that each participant reached the declared origin (publicOriginDigest); it did not create or control the app. Ownership is the study's declaration, and the data is not claimed to be synthetic.`
        : dryRun
          ? `Shared app declared: ${dryRunPlaneLabel}, to be served in the sandbox at a public sandbox URL (dry run: nothing ${args.subject.source === "local-tree" ? "packed" : "cloned"}). Seed recipe ${args.seedDigest}; synthetic subject, as the study declares; env names: ${args.subject.envNames?.join(", ") || "none"} (values never stored).`
          : `Shared app: ${livePlaneLabel}, served at a public sandbox URL humanish created; seed recipe ${args.seedDigest}; synthetic subject, as the study declares; env names: ${args.subject.envNames?.join(", ") || "none"} (values never stored).`,
    }),
  );
  return events;
}

/** The sharedWorld block: participant windows, the state series, participant outcomes and the
 *  plane. */
function sharedWorldEvidence(
  args: ConcurrentBundleArgs,
  external: boolean,
  inProgress: boolean,
  planeCommit: string | undefined,
): {
  sharedWorld: SharedWorldEvidence;
  windows: SharedWorldParticipantWindow[];
  stateSeries: SharedWorldStateSnapshot[] | undefined;
  outcomes: SharedWorldOutcome[];
} {
  const { plan, dryRun, actorSpecs, actorResults } = args;
  // Build the concurrent shared-world evidence block. routeHostDigest is sha256-16 of the origin each
  // participant reached: on getHost the participant URL the actor drove (verify confirms ==
  // plane.hostDigest); on external-public the participant's CDP-observed URL origin (verify
  // confirms == plane.publicOriginDigest).
  const fallbackHostDigest = external
    ? (args.publicOriginDigest ?? commandDigestOf("[external-public-plane]"))
    : (args.hostDigest ?? commandDigestOf("[provisioned-subject]"));
  const windows: SharedWorldParticipantWindow[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const session = result?.outcome.session;
    const routeHostDigest = result ? hostOriginDigest(result.route) : fallbackHostDigest;
    return {
      ...sharedWorldParticipantKeys(spec, spec.planned.id, spec.planned.labels),
      startedAt: result?.startedAt ?? 0,
      endedAt: result?.endedAt ?? 0,
      verdict: session
        ? session.status
        : result?.outcome.sessionError !== undefined
          ? "failed"
          : inProgress
            ? "running"
            : "contract_proof_only",
      routeHostDigest,
      ...(planeCommit === undefined ? {} : { commit: planeCommit }),
      seedDigest: args.seedDigest,
    };
  });

  // Option A (external-public): no authoritative shared-state proof, so stateSeries is omitted (there
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
    const ok = !dryRun && actorRunPassed(result);
    return {
      ...sharedWorldParticipantKeys(spec, spec.planned.id, spec.planned.labels),
      status: session
        ? session.status
        : result?.outcome.sessionError !== undefined
          ? "failed"
          : inProgress
            ? "running"
            : "contract_proof_only",
      ...(session ? { completionReason: session.completionReason } : {}),
      ok,
    };
  });

  // The plane block is plane-class-specific. getHost: harness-minted hostDigest + synthetic
  // attestation. external-public: operator-declared publicOriginDigest, no hostDigest, no exposure
  // (claiming synthetic on a real site would be false; verify asserts both are absent there).
  const plane: SharedWorldPlane = external
    ? {
        seedDigest: args.seedDigest,
        envNames: [],
        // publicOriginDigest is the observed convergence origin; declaredOriginDigest records the
        // operator-declared origin for reference (a redirect that makes them differ is no failure).
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
    laneWindows: windows,
    // Option A: external-public carries no stateSeries.
    ...(stateSeries === undefined ? {} : { stateSeries }),
    outcomes,
    ...(args.lobbyConvergenceDigest === undefined
      ? {}
      : { lobbyConvergenceDigest: args.lobbyConvergenceDigest }),
  };

  return { sharedWorld, windows, stateSeries, outcomes };
}

/**
 * A finished run's gaps: each participant that did not pass, or, when every participant passed, the
 * world shortfall that failed the run.
 */
function finishedGaps(
  actorResults: ConcurrentBundleArgs["actorResults"],
  shortfall: string | undefined,
): string[] {
  const participantGaps = actorResults
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
    );
  return participantGaps.length === 0 && shortfall !== undefined ? [shortfall] : participantGaps;
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
  const {
    plan,
    descriptor,
    run: { createdAt },
    dryRun,
    actorSpecs,
    actorResults,
  } = args;
  const { sharedWorld, windows, stateSeries, outcomes } = evidence;
  const overlaps = args.judgment.world.overlap;
  const deltas = (stateSeries ?? []).filter(
    (snapshot, i) => i > 0 && snapshot.digest !== (stateSeries ?? [])[i - 1]!.digest,
  ).length;
  const stateSeriesLabel = external
    ? "stateSeries omitted (no authoritative shared-state proof on the external-public plane)"
    : `stateSeries ${plural((stateSeries ?? []).length, "snapshot")}, ${plural(deltas, "delta")}`;
  const convergenceLabel = external
    ? `; lobby convergence ${args.lobbyConvergenceDigest ? "shown (all participants reached one /lobby/CODE)" : "not observed"}`
    : "";
  // The count that matters is how many participants were live at once, which can be fewer than exist:
  // a 6-participant run capped at 3 must never read as 6-wide concurrency.
  const capForReport = plan.concurrency;
  const maxLive = maxSimultaneousWindows(windows);
  events.push({
    id: nextEventId("concurrency"),
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.concurrency",
    message: `Concurrency: ${plural(windows.length, "participant")}${dryRun ? " (dry run; $0)" : `, up to ${maxLive} live at once (cap ${capForReport}), overlap ${overlaps ? "shown" : "not observed"}`}; ${stateSeriesLabel}${convergenceLabel}. Attribution ceiling: ${sharedWorld.attributionLimits.join(", ")}. ${dryRun ? "This dry run proves nothing about live concurrency, scale, or adoption." : "This run reports only its own observed overlap and state changes; it does not prove scale, repeatability, or adopter-harness replacement."}`,
  });

  // The judge's verdict (judgeSharedWorld): every participant produced a terminal, engaged, passed
  // session. Mission endpoint and completion reasons are reported separately below; `outcomes[].ok`
  // is not renamed into mission success.
  const verdict = args.judgment.verdict;
  const actorOutcomeSummary = formatSharedWorldActorOutcomes(outcomes, actorSpecs.length);

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    // Plane-class-aware: the external-public plane has no getHost/clone/seed and carries no
    // authoritative state series, so its summary must not claim a getHost-exposed plane (dry-run) nor
    // report "state delta(s) under load" (live). It reports lobby convergence instead.
    summary: dryRun
      ? external
        ? `Concurrent shared-world dry run: ${plural(actorSpecs.length, "persona")} declared against one public deployment, used as it is (no sandbox, clone or seed); no sandboxes launched, $0 spent.`
        : `Concurrent shared-world dry run: ${plural(actorSpecs.length, "persona")} declared against one app served at a public sandbox URL (${descriptor.id}); no sandboxes launched, $0 spent.`
      : inProgress
        ? `In-progress concurrent shared-world Observer snapshot: ${plural(actorSpecs.length, "persona")} running against one shared app; final verification is pending.`
        : external
          ? `Concurrent shared-world (one public deployment, ${actorSpecs.length} personas at once): swarm ${verdict === "pass" ? "ran coherently" : "did not run coherently"}; ${actorOutcomeSummary}; overlap ${overlaps ? "proven" : "not observed"}; ${args.lobbyConvergenceDigest ? `${actorSpecs.length} participants converged on one lobby` : "lobby convergence not observed"}.`
          : `Concurrent shared-world (one shared app, ${actorSpecs.length} personas at once): swarm ${verdict === "pass" ? "ran coherently" : "did not run coherently"}; ${actorOutcomeSummary}; overlap ${overlaps ? "proven" : "not observed"}; ${plural(deltas, "state delta")} under load.`,
    gaps: dryRun
      ? [
          "This dry run launched no concurrent shared-world session; it checks the evidence shape only, not live behavior, scale, or adopter-harness replacement.",
        ]
      : inProgress
        ? [
            "Final actor traces, screenshots, state deltas, and verification are pending; this Observer is for live watch only.",
          ]
        : finishedGaps(actorResults, sharedWorldShortfall(args.judgment.world)),
  };
  return review;
}

/** Project the concurrent run into a humanish.run-bundle.v1 with the concurrent shared-world block. */
export function buildConcurrentSharedWorldBundle(args: ConcurrentBundleArgs): RunBundle {
  const {
    plan,
    descriptor,
    run: { createdAt },
    dryRun,
    actorSpecs,
    actorResults,
  } = args;
  const inProgress = args.inProgress === true;
  const external = (args.planeClass ?? "provisioned-getHost") === "external-public";
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  // Public-safe label only: neither the raw getHost URL (provisioned) nor the raw public origin
  // (external-public) lands in the bundle. The plane identity is a digest (plane.hostDigest on
  // getHost; plane.publicOriginDigest on external-public).
  const appUrl = external ? "[external-public-plane]" : "[provisioned-subject]";
  const planeCommit = external ? undefined : dryRun ? undefined : args.subjectCommit;
  const events = planeEvents(args, external);

  let eventSeq = 2;
  const nextEventId = (suffix: string): string =>
    `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  const recordContext = { args, external, inProgress, appUrl, nextEventId };
  actorSpecs.forEach((spec, index) => {
    const records = sharedWorldParticipantRecords(recordContext, spec, index);
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
  const goal = redactText(
    actorSpecs[0]?.evidenceInstructions ??
      actorSpecs[0]?.instructions ??
      "Concurrent shared-world interaction.",
  );
  return {
    ...bundleHead(args.run, {
      ...receivingPublication(plan.residual, args.dryRun),
      participants: actorSpecs.length,
      source: args.source,
    }),
    persona: {
      id: actorSpecs[0]?.persona.id ?? "concurrent-persona",
      name: `Concurrent shared-world swarm (${actorSpecs.length} personas)`,
      source: `study:${plan.studyId}`,
      sourceDigest: actorSpecs[0]?.persona.promptDigest ?? args.seedDigest,
    },
    scenario: {
      id: `concurrent-shared-world-${plan.studyId}`,
      title: plan.title ?? `Concurrent shared-world: ${plan.studyId}`,
      goal,
      source: `study:${plan.studyId}`,
      sourceDigest: actorSpecs[0]?.persona.promptDigest ?? args.seedDigest,
    },
    lifecycle: [
      {
        at: createdAt,
        event: "concurrent-shared-world.run.created",
        message: `Created a concurrent shared-world run with one shared app and ${actorSpecs.length} participants at once (actor ${descriptor.id}).`,
      },
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: ranLive
        ? anyRaw
          ? "Typed text is recorded as its length only, and reasoning and messages pass through text redaction. Some personas captured unblurred screenshots, kept for local use and not redacted for publishing. Set policies.redactScreenshots: true to blur screenshots in a bundle you plan to share. stateSeries stores digests only."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle. stateSeries persists digest-only."
        : inProgress
          ? "In-progress live Observer snapshot: runtime stream auth URLs are process-local only and are not persisted. Final typed text, traces, and screenshots are pending. stateSeries persists digest-only."
          : "Concurrent shared-world dry-run bundle: no sandboxes launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs. stateSeries persists digest-only.",
    },
    artifacts: bundleArtifacts(),
    review,
    feedbackCandidates: sharedWorldFeedbackCandidates(args, goal),
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
 * What the participants reported, built by the same builder as a computer-use fan-out: one
 * candidate per participant who reported friction or abandoned the goal, named by its participant
 * id. Dry-run and in-progress bundles carry none: there is no participant yet to quote. The comms
 * thread belongs to the one shared app, so each candidate cites it.
 */
function sharedWorldFeedbackCandidates(
  args: ConcurrentBundleArgs,
  goal: string,
): RunFeedbackCandidate[] {
  if (args.dryRun || args.inProgress === true) return [];
  return participantFeedbackCandidates({
    runId: args.run.runId,
    scenarioId: `concurrent-shared-world-${args.plan.studyId}`,
    adapterId: args.plan.studyId,
    goal,
    // planSharedWorldStudy refuses any target other than e2b-desktop on both planes.
    substrate: "e2b-desktop",
    participants: args.actorSpecs.map((spec, index) => {
      const outcome = args.actorResults[index]?.outcome;
      return {
        participantId: spec.planned.id,
        streamId: spec.streamId,
        personaId: spec.persona.id,
        ...(outcome?.session === undefined
          ? {}
          : { session: outcome.session, traceArtifactPath: spec.traceArtifactPath }),
        screenshots: outcome?.screenshots ?? [],
        ...(args.commsArtifactPath === undefined
          ? {}
          : { commsArtifactPath: args.commsArtifactPath }),
      };
    }),
  });
}

/**
 * Priced like `per-lane-worlds`: each participant's model tokens and desktop, plus the provisioned plane's
 * desktop. Absent when nothing ran, so dry runs and in-progress snapshots stay byte-stable.
 */
function concurrentCostSummary(
  args: ConcurrentBundleArgs,
  inProgress: boolean,
): RunCostSummary | undefined {
  if (inProgress) return undefined;
  const subject = args.subjectDesktop;
  return buildRunCostSummary({
    participants: args.actorResults.flatMap((result) =>
      result.outcome.session === undefined
        ? []
        : [{ participantId: result.spec.planned.id, trace: result.outcome.session.trace }],
    ),
    desktops: [
      ...(subject === undefined
        ? []
        : [
            {
              participantId: "subject",
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
                participantId: result.spec.planned.id,
                minutes: desktopSpanToMinutes(result.outcome.desktopDurationMs),
                observation: result.outcome.desktopResources,
                lifetimeComplete: result.outcome.killed,
              },
            ],
      ),
    ],
  });
}

/** The declared (dry-run) state digest: the probe recipe (command digests), no run. */
function declaredStateDigest(state: StudySubjectState | undefined): string {
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
    `- verdict: ${verdictText(bundle.review.verdict, bundle.mode)}`,
    `- outcome: ${reviewOutcome(bundle)}`,
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
