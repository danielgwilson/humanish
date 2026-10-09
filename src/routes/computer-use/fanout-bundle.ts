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
  formatRunTaskFunnel,
  gapsListClause,
  withCuaReviewProvenance,
} from "../../run/outcomes.js";
import type { TaskFunnel } from "../../study/tasks.js";
import { providerResourcesForOutcome, publicSafeAppUrlLabel } from "./bundle-parts.js";
import { subjectName } from "../../run/subject-name.js";
import { participantFeedbackCandidates } from "./participant-feedback.js";
import { participantFactsOf } from "./participant-facts.js";
import { judgeParticipantRecords } from "../../run/judge.js";
import { buildRunCostSummary, desktopSpanToMinutes } from "../../run/cost-summary.js";
import { formatParticipantPlanEntry } from "./participant-runs.js";
import type { CuaFanoutBundleArgs, ParticipantRunOutcome } from "./types.js";
import { fanoutParticipantRecords } from "./fanout-records.js";
import { plural } from "../../run/text.js";

/** The run's first two events: its creation and the fan-out plan. */
function fanoutPlanEvents(args: CuaFanoutBundleArgs): RunEvent[] {
  const { specs, plan } = args;
  const events: RunEvent[] = [];
  events.push({
    id: "event-000-created",
    at: args.run.createdAt,
    level: "info",
    type: "cua-lab.run.created",
    message: `Created computer-use fan-out run for ${plan.studyId} (actor ${args.descriptor.id}, ${specs.length} participants, one world each).`,
  });
  events.push({
    id: "event-001-fanout-plan",
    at: args.run.createdAt,
    level: "info",
    type: "cua-lab.fanout.plan",
    message: `Fan-out plan: ${plural(args.participantPlan.laneCount, "participant")} (${args.participantPlan.strategy}), concurrency ${args.participantPlan.concurrency}, ${plural(args.participantPlan.waves, "wave")}; session budget ${Math.round(args.participantPlan.perLaneSessionBudgetMs / 1000)}s per participant; worst-case ~${args.participantPlan.worstCaseSandboxMinutes} sandbox-minutes${args.dryRun ? " (dry-run: $0)" : ""}. Participants: ${args.participantPlan.lanes.map(formatParticipantPlanEntry).join(", ")}.`,
  });
  return events;
}

/**
 * The run's summary in plain sentences: who took part, what happened to them with the denominator
 * attached, and that the gaps list the participants who did not pass.
 */
function fanoutSummary(
  args: CuaFanoutBundleArgs,
  facts: { passed: number; outcomes: string; tasks?: string },
): string {
  const count = args.specs.length;
  const people = plural(count, "participant");
  const rerun = args.rerun === undefined ? "" : `Rerun from ${args.rerun.sourceRunId}: `;
  if (args.inProgress === true) {
    return `${people} ${count === 1 ? "is" : "are"} each using their own copy of the app. The run is still going, so nothing here is final.`;
  }
  if (args.dryRun) {
    return `${rerun}Dry run: ${people} would each use their own copy of ${subjectName(publicSafeAppUrlLabel(args.appUrl), args.aggregateSubject)}. No desktops were launched and $0 was spent.`;
  }
  const tasks = facts.tasks === undefined ? "" : ` Tasks: ${facts.tasks}.`;
  return `${rerun}${people} took part, each in their own copy of the app: ${facts.outcomes}${gapsListClause(count - facts.passed, count)}.${tasks}`;
}

function fanoutReview(
  args: CuaFanoutBundleArgs,
  streams: RunStream[],
  judgment: ReturnType<typeof judgeParticipantRecords>,
): ReviewSummary {
  const { outcomes } = args;
  // The judge's verdict: live fan-out must prove every participant (judgeParticipants).
  const verdict = args.verdict;

  const passedParticipants = judgment.participants.filter(
    (participant) => participant.judgedStatus === "passed",
  ).length;
  // What happened to the participants, with the denominator attached. The verdict above has to
  // collapse the run to one word; this does not (docs/principles/three-roles.md).
  const terminalOutcomes = (outcomes ?? []).filter(
    (outcome): outcome is NonNullable<typeof outcome> & { session: { status: ActorStatus } } =>
      outcome?.session?.status !== undefined,
  );
  const participants = judgment.tally.total > 0 ? judgment.tally : undefined;
  // The study funnel: per-task completion rates across every session that measured one. This is
  // "where did people get stuck" as data, next to who got stuck (participants) above.
  const participantFunnels = (outcomes ?? [])
    .map((outcome) => outcome?.session?.trace.taskFunnel)
    .filter((funnel): funnel is TaskFunnel => funnel !== undefined);
  const runTasks = args.inProgress === true ? undefined : aggregateTaskFunnels(participantFunnels);
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
      ...(runTasks === undefined ? {} : { tasks: runTasks }),
      // The app URL is named as the participant records name it: one on an E2B host names a
      // sandbox, so the summary carries its digest, which verify accepts in a shared run.
      summary: fanoutSummary(args, {
        passed: passedParticipants,
        outcomes:
          participants === undefined
            ? `0/${args.specs.length} finished a session`
            : formatParticipantOutcomes(participants, participantEndings),
        ...(runTasks === undefined ? {} : { tasks: formatRunTaskFunnel(runTasks) }),
      }),
      gaps:
        args.inProgress === true
          ? ["Live fan-out session is still running."]
          : args.dryRun
            ? ["Live fan-out session not yet run (dry run only)."]
            : judgment.participants.flatMap((participant) =>
                participant.gapLine === undefined ? [] : [participant.gapLine],
              ),
    },
    streams,
  );
  return review;
}

/** The configured browser and, when every participant resolved the same one, that browser. */
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
  // Run-level cost estimate: one model-token line per participant that ran a session (from its persisted
  // trace.estimatedCost) + a desktop line per owned allocation, priced at its observed resources.
  // `per-lane-worlds` participants have no shared provisioning to double-count. Omitted on a pure dry-run.
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
        scenarioId: `cua-${plan.studyId}`,
        adapterId: plan.studyId,
        substrate: plan.residual.execution?.target === "local" ? "local-desktop" : "e2b-desktop",
        participants: specs.map((spec, index) => {
          const outcome = outcomes?.[index];
          return {
            participantId: spec.planned.id,
            streamId: spec.streamId,
            personaId: spec.persona.id,
            goal: redactText(spec.evidenceInstructions ?? spec.instructions),
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
 * Project N>1 fan-out participants into a humanish.run-bundle.v1 (the evidence schema is unchanged; this
 * is a new producer for the multi-stream shape). One sim + one stream per participant; per-participant
 * provenance/session events; a recorded `cua-lab.fanout.plan` event (and a `cua-lab.fanout.fail-fast`
 * event when a harness error skipped queued participants). N-ary verify/Observer already handle multiple
 * streams. A single-participant run without a rerun never reaches here: buildCuaRunBundle
 * (bundle.ts) sends it to buildSingleParticipantBundle (single-bundle.ts).
 */
export function buildCuaFanoutBundle(args: CuaFanoutBundleArgs): RunBundle {
  const { specs, outcomes, plan } = args;
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events = fanoutPlanEvents(args);
  const judgment = judgeParticipantRecords(
    specs.map((spec, index) => ({
      ...participantFactsOf(outcomes?.[index]),
      id: spec.planned.id,
      inProgress: args.inProgress === true && outcomes?.[index] === undefined,
    })),
    {
      runningReason:
        "Live computer-use participant is running; stream auth URL is available only through the attached Observer server.",
    },
  );

  let eventSeq = 2;
  const nextEventId = (suffix: string): string =>
    `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  if (args.rerun) {
    events.push({
      id: nextEventId("fanout-rerun"),
      at: args.run.createdAt,
      level: "info",
      type: "cua-lab.fanout.rerun",
      message: `Rerun selected ${plural(args.rerun.selectedLaneIds.length, "participant")} from ${args.rerun.sourceRunId}: ${args.rerun.previous.map((prior) => `${prior.laneId} was ${prior.status}${prior.completionReason ? `/${prior.completionReason}` : ""}`).join(", ")}. This is a new linked run; the source run verdict is unchanged.`,
    });
  }

  specs.forEach((spec, index) => {
    const records = fanoutParticipantRecords(
      { args, nextEventId, participants: judgment.participants },
      spec,
      index,
    );
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

  const review = fanoutReview(args, streams, judgment);

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
      source: `study:${plan.studyId}`,
      sourceDigest: specs[0]!.persona.promptDigest,
    },
    scenario: {
      id: `cua-${plan.studyId}`,
      title: plan.title ?? `Computer-use fan-out: ${plan.studyId}`,
      // Redacted at write time, like every other raw-text surface in the bundle. Participant records are
      // digest-only by design, but scenario.goal keeps one participant's composed instructions verbatim,
      // and an adopter whose authored participant text must name a runtime world URL (an inbox on a route
      // where the harness does not inject one) put an *.e2b.app address in it. That landed raw here
      // and in observer-data.json, the sensitive-text scanner matched it, and verify failed a bundle
      // this writer produced. The only adopter-side workaround was scanner evasion.
      //
      // The instructions the model actually receives are untouched; only the persisted copy changes.
      goal: redactText(specs[0]!.evidenceInstructions ?? specs[0]!.instructions),
      source: `study:${plan.studyId}`,
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
          ? "Typed text is recorded as its length only, and reasoning and messages pass through text redaction. Some participants captured unblurred screenshots, kept for local use and not redacted for publishing. Set policies.redactScreenshots: true to blur screenshots in a bundle you plan to share."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle."
        : "Dry-run fan-out bundle: no desktops launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs.",
    },
    artifacts: bundleArtifacts(),
    review,
    // What the participants reported, when any reported anything. Dry-run and in-progress
    // bundles carry none: there is no participant yet to quote.
    feedbackCandidates: fanoutFeedbackCandidates(args),
    // Selected hosted image, including the optional speech default; omitted on the stock desktop.
    ...(desktopTemplate === undefined ? {} : { desktopTemplate }),
    ...(desktopBrowser === undefined ? {} : { desktopBrowser }),
    ...(providerResources.length === 0 ? {} : { providerResources }),
    subject: args.aggregateSubject,
    ...(cost === undefined ? {} : { cost }),
  };
}
