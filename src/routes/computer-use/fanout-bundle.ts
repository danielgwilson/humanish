import { e2bDesktopTemplate } from "../../substrates/e2b/sandbox.js";
import { receivingPublication } from "../../comms/receiving-runtime.js";
import type { ActorStatus } from "../../actors/contract.js";
import { actorEnding } from "../../actors/stop-cause.js";
import { redactText } from "../../evidence/redaction.js";
import {
  REVIEW_SCHEMA,
  bundleArtifacts,
  bundleHead,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSimulation,
} from "../../run/bundle.js";
import type { RunStream } from "../../run/streams.js";
import {
  aggregateTaskFunnels,
  formatParticipantOutcomes,
  formatStudyTaskFunnel,
  tallyParticipantOutcomes,
  withCuaReviewProvenance,
} from "../../run/outcomes.js";
import type { TaskFunnel } from "../../lab/tasks.js";
import { participantFeedbackCandidates, providerResourcesForOutcome } from "./bundle-parts.js";
import { participantFactsOf } from "./participant-facts.js";
import { participantPassed, participantStatus } from "../../run/judge.js";
import { buildRunCostSummary, desktopSpanToMinutes } from "../../run/cost-summary.js";
import { formatParticipantPlanEntry } from "./participant-runs.js";
import type { CuaFanoutBundleArgs, ParticipantRunOutcome } from "./types.js";
import { fanoutParticipantRecords } from "./fanout-lanes.js";

/** The run's first two events: its creation and the fan-out plan. */
function fanoutPlanEvents(args: CuaFanoutBundleArgs): RunEvent[] {
  const { specs, plan } = args;
  const events: RunEvent[] = [];
  events.push({
    id: "event-000-created",
    at: args.run.createdAt,
    level: "info",
    type: "cua-lab.run.created",
    message: `Created computer-use fan-out run for ${plan.labId} (actor ${args.descriptor.id}, ${specs.length} participants, one world each).`,
  });
  events.push({
    id: "event-001-fanout-plan",
    at: args.run.createdAt,
    level: "info",
    type: "cua-lab.fanout.plan",
    message: `Fan-out plan: ${args.participantPlan.laneCount} participant(s) (${args.participantPlan.strategy}), concurrency ${args.participantPlan.concurrency}, ${args.participantPlan.waves} wave(s); session budget ${Math.round(args.participantPlan.perLaneSessionBudgetMs / 1000)}s per participant; worst-case ~${args.participantPlan.worstCaseSandboxMinutes} sandbox-minutes${args.dryRun ? " (dry-run: $0)" : ""}. Participants: ${args.participantPlan.lanes.map(formatParticipantPlanEntry).join(", ")}.`,
  });
  return events;
}

function fanoutReview(args: CuaFanoutBundleArgs, streams: RunStream[]): ReviewSummary {
  const { specs, outcomes } = args;
  // The judge's verdict: live fan-out must prove every lane (judgeParticipants).
  const verdict = args.verdict;

  const passedParticipants = (outcomes ?? []).filter((outcome) =>
    participantPassed(participantFactsOf(outcome)),
  ).length;
  // What happened to the PARTICIPANTS, with the denominator attached. The verdict above has to
  // collapse the run to one word; this does not (docs/principles/three-roles.md).
  const terminalOutcomes = (outcomes ?? []).filter(
    (outcome): outcome is NonNullable<typeof outcome> & { session: { status: ActorStatus } } =>
      outcome?.session?.status !== undefined,
  );
  const participants =
    terminalOutcomes.length > 0
      ? tallyParticipantOutcomes(
          // A NO-ENGAGEMENT lane is not a participant who reached the goal. It said "done" having
          // taken zero actions and said nothing, and `passedParticipants` above already refuses to
          // count it — but `reachedGoal` was reading the trace status directly, so one run could be both
          // "not a passed lane" AND "1/1 reached the goal". The headline number a researcher reads
          // first was the dishonest one. Found by a provider bug that ended a study on turn one.
          terminalOutcomes.map((outcome) =>
            participantStatus(outcome.session.status, {
              noEngagement: outcome.noEngagement === true,
              selfReportedBlocker: outcome.selfReportedBlocker === true,
            }),
          ),
          // A participant who reached the goal AND told you the road there was broken is the most
          // useful result a study produces; reporting only the outcome would bury it.
          terminalOutcomes.map((outcome) => outcome.reportedFriction === true),
        )
      : undefined;
  // The study funnel: per-task completion rates across every session that measured one. This is
  // "where did people get stuck" as data, next to WHO got stuck (participants) above.
  const participantFunnels = (outcomes ?? [])
    .map((outcome) => outcome?.session?.trace.taskFunnel)
    .filter((funnel): funnel is TaskFunnel => funnel !== undefined);
  const studyTasks =
    args.inProgress === true ? undefined : aggregateTaskFunnels(participantFunnels);
  const participantEndings = terminalOutcomes.map((outcome) => {
    const ending = actorEnding(outcome.session.trace);
    return {
      status: outcome.session.status,
      ...(ending === undefined ? {} : { label: ending.label }),
    };
  });
  const review: ReviewSummary = withCuaReviewProvenance(
    {
      schema: REVIEW_SCHEMA,
      verdict,
      ...(participants === undefined ? {} : { participants }),
      ...(studyTasks === undefined ? {} : { tasks: studyTasks }),
      summary:
        args.inProgress === true
          ? `Live computer-use fan-out is running (${specs.length} participants, one world each); terminal participant evidence has not been written yet.`
          : args.dryRun
            ? `${args.rerun ? `Rerun contract from ${args.rerun.sourceRunId}: ` : ""}Dry-run fan-out contract: ${specs.length} participants composed for ${args.descriptor.id} against ${args.appUrl}, one world each; no desktops launched, $0 spend.`
            : `${args.rerun ? `Rerun from ${args.rerun.sourceRunId}: ` : ""}Computer-use fan-out (${specs.length} participants, one world each): ${passedParticipants}/${specs.length} participant(s) reached a terminal, engaged verdict${participants ? `: ${formatParticipantOutcomes(participants, participantEndings)}` : ""}${studyTasks ? `; tasks: ${formatStudyTaskFunnel(studyTasks)}` : ""}.`,
      gaps:
        args.inProgress === true
          ? ["Live fan-out session is still running."]
          : args.dryRun
            ? ["Live fan-out session not yet run (dry-run contract only)."]
            : specs
                .map((spec, index) => ({ spec, outcome: outcomes?.[index] }))
                .filter(
                  ({ outcome }) =>
                    outcome === undefined ||
                    outcome.skippedReason !== undefined ||
                    outcome.sessionError !== undefined ||
                    outcome.noEngagement ||
                    outcome.selfReportedBlocker ||
                    outcome.session === undefined ||
                    outcome.session.status !== "passed",
                )
                .map(
                  ({ spec, outcome }) =>
                    `${spec.planned.id}: ${outcome?.skippedReason ?? outcome?.sessionError ?? outcome?.session?.reason ?? "did not pass"}`,
                ),
    },
    streams,
  );
  return review;
}

/** The configured browser and, when every lane resolved the same one, that browser. */
function fanoutDesktopBrowser(args: CuaFanoutBundleArgs) {
  const { outcomes, plan } = args;
  const configuredBrowser = plan.residual.execution?.desktop?.browser;
  const resolvedBrowsers = (outcomes ?? [])
    .map((outcome) => outcome.desktopBrowser?.resolved)
    .filter((value): value is string => value !== undefined);
  const unanimousResolvedBrowser =
    resolvedBrowsers.length > 0 && new Set(resolvedBrowsers).size === 1
      ? resolvedBrowsers[0]
      : undefined;
  return configuredBrowser === undefined
    ? undefined
    : {
        requested: configuredBrowser,
        ...(unanimousResolvedBrowser === undefined ? {} : { resolved: unanimousResolvedBrowser }),
      };
}

function fanoutCost(args: CuaFanoutBundleArgs) {
  const { specs, outcomes } = args;
  // Run-level cost ESTIMATE: one model-token line per lane that ran a session (from its persisted
  // trace.estimatedCost) + a desktop line per owned allocation, priced at its observed resources.
  // Per-lane worlds have no shared provisioning to double-count. Omitted on a pure dry-run.
  const costTraces = specs
    .map((spec, index) => ({ participantId: spec.planned.id, outcome: outcomes?.[index] }))
    .filter(
      (entry): entry is { participantId: string; outcome: ParticipantRunOutcome } =>
        entry.outcome?.session !== undefined,
    )
    .map((entry) => ({ participantId: entry.participantId, trace: entry.outcome.session!.trace }));
  const desktops = (outcomes ?? [])
    .filter((outcome) => outcome.sandboxId !== undefined)
    .map((outcome) => ({
      participantId: outcome.spec.planned.id,
      minutes: desktopSpanToMinutes(outcome.desktopDurationMs),
      observation: outcome.desktopResources,
      lifetimeComplete: outcome.killed,
    }));
  const cost = buildRunCostSummary({ participants: costTraces, desktops });
  return cost;
}

function fanoutFeedbackCandidates(args: CuaFanoutBundleArgs) {
  const { specs, outcomes, plan } = args;
  return args.dryRun || args.inProgress === true
    ? []
    : participantFeedbackCandidates({
        runId: args.run.runId,
        scenarioId: `cua-${plan.labId}`,
        adapterId: plan.labId,
        goal: redactText(specs[0]!.evidenceInstructions ?? specs[0]!.instructions),
        substrate: plan.residual.execution?.target === "local" ? "local-desktop" : "e2b-desktop",
        participants: specs.map((spec, index) => {
          const outcome = outcomes?.[index];
          return {
            participantId: spec.planned.id,
            streamId: spec.streamId,
            personaId: spec.persona.id,
            ...(outcome?.session === undefined ? {} : { session: outcome.session }),
            ...(outcome?.session === undefined
              ? {}
              : { traceArtifactPath: spec.traceArtifactPath }),
            screenshots: outcome?.screenshots ?? [],
            ...(outcome?.commsArtifactPath === undefined
              ? {}
              : { commsArtifactPath: outcome.commsArtifactPath }),
          };
        }),
      });
}

/**
 * Project N>1 fan-out lanes into a humanish.run-bundle.v1 (the evidence schema is unchanged; this
 * is a new producer for the multi-stream shape). One sim + one stream per lane; per-lane
 * provenance/session events; a recorded `cua-lab.fanout.plan` event (and a `cua-lab.fanout.fail-fast`
 * event when a harness error skipped queued lanes). N-ary verify/Observer already handle multiple
 * streams. A single-participant run without a rerun never reaches here: buildCuaRunBundle
 * (bundle.ts) sends it to buildSingleParticipantBundle (single-bundle.ts).
 */
export function buildCuaFanoutBundle(args: CuaFanoutBundleArgs): RunBundle {
  const { specs, outcomes, plan } = args;
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events = fanoutPlanEvents(args);

  let eventSeq = 2;
  const nextEventId = (suffix: string): string =>
    `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  if (args.rerun) {
    events.push({
      id: nextEventId("fanout-rerun"),
      at: args.run.createdAt,
      level: "info",
      type: "cua-lab.fanout.rerun",
      message: `Rerun selected ${args.rerun.selectedLaneIds.length} participant(s) from ${args.rerun.sourceRunId}: ${args.rerun.previous.map((prior) => `${prior.laneId} was ${prior.status}${prior.completionReason ? `/${prior.completionReason}` : ""}`).join(", ")}. This is a new linked run; the source run verdict is unchanged.`,
    });
  }

  specs.forEach((spec, index) => {
    const records = fanoutParticipantRecords({ args, nextEventId }, spec, index);
    simulations.push(records.simulation);
    streams.push(records.stream);
    events.push(...records.events);
  });

  if (args.failFastReason) {
    events.push({
      id: nextEventId("fanout-fail-fast"),
      at: args.run.createdAt,
      level: "warn",
      type: "cua-lab.fanout.fail-fast",
      message: `Fan-out fail-fast: ${args.failFastReason}. In-flight participants finished; queued participants were skipped (blocked); completed evidence is retained.`,
    });
  }

  const review = fanoutReview(args, streams);

  const anyRaw = (outcomes ?? []).some(
    (outcome) => outcome.session?.trace.redaction.screenshots === "raw",
  );
  const ranLive = (outcomes ?? []).some(
    (outcome) => outcome.session !== undefined || outcome.sessionError !== undefined,
  );
  const desktopTemplate = e2bDesktopTemplate(plan.residual);
  const desktopBrowser = fanoutDesktopBrowser(args);
  const providerResources = (outcomes ?? []).flatMap((outcome) =>
    providerResourcesForOutcome({
      outcome,
      createdAt: args.run.createdAt,
      ids: outcome.spec,
      participantId: outcome.spec.planned.id,
    }),
  );

  const cost = fanoutCost(args);

  return {
    ...bundleHead(args.run, {
      ...receivingPublication(args.plan.residual, args.dryRun),
      participants: specs.length,
      source: args.source,
    }),
    persona: {
      id: specs[0]!.persona.id,
      name: `Computer-use fan-out (${specs.length} participants)`,
      source: `lab:${plan.labId}`,
      sourceDigest: specs[0]!.persona.promptDigest,
    },
    scenario: {
      id: `cua-${plan.labId}`,
      title: plan.title ?? `Computer-use fan-out: ${plan.labId}`,
      // Redacted at WRITE time, like every other raw-text surface in the bundle. Lane records are
      // digest-only by design, but scenario.goal keeps one lane's composed instructions verbatim —
      // and an adopter whose authored lane text must name a runtime world URL (an inbox on a route
      // where the harness does not inject one) put an *.e2b.app address in it. That landed raw here
      // and in observer-data.json, the sensitive-text scanner matched it, and verify failed a bundle
      // this writer produced. The only adopter-side workaround was scanner evasion (#412).
      //
      // The instructions the model actually receives are untouched; only the persisted copy changes.
      goal: redactText(specs[0]!.evidenceInstructions ?? specs[0]!.instructions),
      source: `lab:${plan.labId}`,
      sourceDigest: specs[0]!.persona.promptDigest,
    },
    lifecycle: [
      {
        at: args.run.createdAt,
        event: "cua-lab.run.created",
        message: `Created computer-use fan-out run with ${specs.length} participants, each in its own desktop browser (actor ${args.descriptor.id}).`,
      },
    ],
    simulations,
    streams,
    events,
    ...(args.rerun === undefined ? {} : { rerun: args.rerun }),
    redaction: {
      status: "passed",
      notes: ranLive
        ? anyRaw
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Some participants captured FULL-FIDELITY (raw) screenshots, retained for local use and NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle."
        : "Dry-run fan-out contract bundle: no desktops launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs.",
    },
    artifacts: bundleArtifacts(),
    review,
    // What the participants reported, when any reported anything (#392). Dry-run and in-progress
    // bundles carry none — there is no participant yet to quote.
    feedbackCandidates: fanoutFeedbackCandidates(args),
    // Selected hosted image, including the optional speech default; omitted on the stock desktop.
    ...(desktopTemplate === undefined ? {} : { desktopTemplate }),
    ...(desktopBrowser === undefined ? {} : { desktopBrowser }),
    ...(providerResources.length === 0 ? {} : { providerResources }),
    subject: args.aggregateSubject,
    ...(cost === undefined ? {} : { cost }),
  };
}
