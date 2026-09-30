import { e2bDesktopTemplate } from "../../substrates/e2b/desktop-media.js";
import { receivingPublication } from "../../comms/receiving-runtime.js";
import { declaredScreenForRender } from "../../substrates/e2b/desktop-geometry.js";
import path from "node:path";
import type { ActorStatus } from "../../actors/contract.js";
import { type CuaActorDescriptor } from "../../actors/registry.js";
import { actorEnding } from "../../actors/stop-cause.js";
import { type LabConfig } from "../../lab/types.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { redactText } from "../../evidence/redaction.js";
import { type RunLabProvenance } from "../../run/status.js";
import {
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunDesktopGeometry,
  type RunEvent,
  type RunRerunLineage,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream,
} from "../../run/bundle.js";
import {
  aggregateTaskFunnels,
  formatParticipantOutcomes,
  formatStudyTaskFunnel,
  tallyParticipantOutcomes,
  withCuaReviewProvenance,
} from "../../run/outcomes.js";
import { type TaskFunnel } from "../../lab/tasks.js";
import {
  describeSubjectState,
  fanoutReviewVerdict,
  participantFeedbackCandidates,
  participantStatusForCredibility,
  providerResourcesForOutcome,
  publicSafeAppUrlLabel,
} from "./bundle.js";
import { buildCuaCostSummary, desktopSpanToMinutes } from "./costs.js";
import { formatLanePlanEntry, phaseEventIdSuffix } from "./lane-plan.js";
import type { CuaLanePlan, CuaLaneSpec, CuaSubjectProjection, LaneRunOutcome } from "./types.js";

/**
 * Project N>1 fan-out lanes into a humanish.run-bundle.v1 (the evidence schema is unchanged; this
 * is a new producer for the multi-stream shape). One sim + one stream per lane; per-lane
 * provenance/session events; a recorded `cua-lab.fanout.plan` event (and a `cua-lab.fanout.fail-fast`
 * event when a harness error skipped queued lanes). N-ary verify/Observer already handle multiple
 * streams. The N=1 path NEVER reaches here (buildCuaBundle owns it, byte-stable).
 */
export function buildCuaFanoutBundle(args: {
  /** Lab provenance for the bundle's own `lab` field (#455). */
  lab?: RunLabProvenance;
  specs: CuaLaneSpec[];
  outcomes?: LaneRunOutcome[];
  laneSubjects: CuaSubjectProjection[];
  aggregateSubject: CuaSubjectProjection;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  createdAt: string;
  dryRun: boolean;
  config: LabConfig;
  runId: string;
  source: RunBundle["source"];
  plan: CuaLanePlan;
  rerun?: RunRerunLineage;
  failFastReason?: string;
  cloneRoute: boolean;
  localTreeRoute?: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
  inProgress?: boolean;
}): RunBundle {
  const { specs, outcomes, config } = args;
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [];

  events.push({
    id: "event-000-created",
    at: args.createdAt,
    level: "info",
    type: "cua-lab.run.created",
    message: `Created computer-use fan-out run for ${config.id} (actor ${args.descriptor.id}, ${specs.length} lanes, per-lane worlds).`,
  });
  events.push({
    id: "event-001-fanout-plan",
    at: args.createdAt,
    level: "info",
    type: "cua-lab.fanout.plan",
    message: `Fan-out plan: ${args.plan.laneCount} lane(s) (${args.plan.strategy}), concurrency ${args.plan.concurrency}, ${args.plan.waves} wave(s); per-lane session budget ${Math.round(args.plan.perLaneSessionBudgetMs / 1000)}s; worst-case ~${args.plan.worstCaseSandboxMinutes} sandbox-minutes${args.dryRun ? " (dry-run: $0)" : ""}. Lanes: ${args.plan.lanes.map(formatLanePlanEntry).join(", ")}.`,
  });

  let eventSeq = 2;
  const nextEventId = (suffix: string): string =>
    `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  if (args.rerun) {
    events.push({
      id: nextEventId("fanout-rerun"),
      at: args.createdAt,
      level: "info",
      type: "cua-lab.fanout.rerun",
      message: `Rerun selected ${args.rerun.selectedLaneIds.length} lane(s) from ${args.rerun.sourceRunId}: ${args.rerun.previous.map((lane) => `${lane.laneId} was ${lane.status}${lane.completionReason ? `/${lane.completionReason}` : ""}`).join(", ")}. This is a new linked run; the source run verdict is unchanged.`,
    });
  }

  specs.forEach((spec, index) => {
    const outcome = outcomes?.[index];
    const laneAppUrl = spec.targetUrl ?? args.appUrl;
    const publicLaneAppUrl = publicSafeAppUrlLabel(laneAppUrl);
    const subject = args.laneSubjects[index]!;
    const session = outcome?.session;
    const fallbackDeclared = declaredScreenForRender(
      spec.devicePreset,
      spec.deviceName,
      spec.resolution,
    );
    const desktopGeometry: RunDesktopGeometry = outcome?.desktopGeometry ?? {
      screen: {
        requested: { width: spec.resolution[0], height: spec.resolution[1] },
        ...(fallbackDeclared ? { declared: fallbackDeclared } : {}),
      },
    };
    const screenshots = outcome?.screenshots ?? [];
    const lastScreenshot = screenshots[screenshots.length - 1];
    const status: RunSimulationStatus =
      args.inProgress === true && outcome === undefined
        ? "running"
        : outcome?.skippedReason !== undefined
          ? "blocked"
          : session
            ? session.status
            : outcome?.sessionError
              ? "failed"
              : "contract_proof_only";
    const reason =
      args.inProgress === true && outcome === undefined
        ? "Live computer-use lane is running; stream auth URL is available only through the attached Observer server."
        : (outcome?.skippedReason ??
          session?.reason ??
          outcome?.sessionError ??
          "Contract bundle only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.");

    const traceScreenshotMode = session?.trace.redaction.screenshots;
    const screenshotMode: "raw" | "blurred" =
      traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
        ? traceScreenshotMode
        : config.policies?.redactScreenshots === true
          ? "blurred"
          : "raw";

    simulations.push({
      id: spec.simId,
      index: index + 1,
      personaId: spec.persona.id,
      scenarioId: `cua-${config.id}`,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: args.inProgress === true && outcome === undefined ? 20 : 100,
      currentStep: reason,
      summary: session
        ? `Lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}): computer-use actor (${args.descriptor.id}) drove the subject app; ${session.completionReason}.`
        : args.inProgress === true && outcome === undefined
          ? `Lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}): computer-use actor (${args.descriptor.id}) is driving the subject app.`
          : outcome?.skippedReason !== undefined
            ? `Lane ${spec.laneId} ${outcome.skippedReason}.`
            : outcome?.sessionError
              ? `Lane ${spec.laneId} failed before a terminal session verdict: ${outcome.sessionError}`
              : `Contract lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}) for ${args.descriptor.id} against ${publicLaneAppUrl}.`,
      streamIds: [spec.streamId],
      startedAt: args.createdAt,
      updatedAt: args.createdAt,
    });

    streams.push({
      id: spec.streamId,
      simId: spec.simId,
      laneId: spec.laneId,
      ...(spec.assignment === undefined
        ? {}
        : { assignment: participantAssignment(spec.assignment) }),
      ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
      ...(spec.surface === undefined ? {} : { surface: spec.surface }),
      ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
      kind: "browser",
      label: `CUA lane ${spec.laneId} — ${config.id}`,
      status,
      transport: "snapshot",
      updatedAt: args.createdAt,
      embed: lastScreenshot
        ? {
            kind: "screenshot",
            url: lastScreenshot,
            title: `CUA desktop ${spec.laneId} (${screenshotMode})`,
          }
        : { kind: "placeholder", title: `CUA desktop ${spec.laneId}` },
      ...(desktopGeometry.viewport === undefined
        ? {}
        : {
            viewport: {
              width: desktopGeometry.viewport.width,
              height: desktopGeometry.viewport.height,
              deviceScaleFactor: desktopGeometry.viewport.deviceScaleFactor,
              isMobile: spec.devicePreset.isMobile,
            },
          }),
      desktopGeometry,
      ...(outcome?.recording === undefined ? {} : { recording: outcome.recording }),
      ui: {
        route: publicLaneAppUrl,
        intent: `Watch lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}) drive the subject app in its own hosted desktop.`,
        state: reason,
        ...(session ? { actorStatus: session.status } : {}),
        ...(lastScreenshot ? { screenshotUrl: lastScreenshot } : {}),
      },
      ...(session ? { actor: session.trace } : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" as const },
        { label: "review", path: "review.md", kind: "review" as const },
        { label: "events", path: "events.ndjson", kind: "events" as const },
        ...(session
          ? [
              {
                label: `lane ${spec.laneId} actor trace`,
                path: spec.traceArtifactPath,
                kind: "trace" as const,
              },
            ]
          : []),
        ...(outcome?.commsArtifactPath
          ? [
              {
                label: `lane ${spec.laneId} comms thread`,
                path: outcome.commsArtifactPath,
                kind: "log" as const,
              },
            ]
          : []),
        ...(outcome?.recording
          ? [
              {
                label: "desktop recording",
                path: outcome.recording.path,
                kind: "recording" as const,
              },
            ]
          : []),
        ...screenshots.map((screenshot, screenshotIndex) => ({
          label: `lane ${spec.laneId} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
          path: screenshot,
          kind: "screenshot" as const,
        })),
      ],
    });

    // Per-lane subject provenance (invariant 5).
    if (args.cloneRoute && args.publicRepo) {
      events.push({
        id: nextEventId(`subject-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.subject.provenance",
        message: `Lane ${spec.laneId}: ${
          args.dryRun
            ? `subject declared — clone of ${args.publicRepo}, served at ${publicLaneAppUrl} in-sandbox (dry-run contract; nothing cloned)`
            : subject.commit
              ? session
                ? `subject cloned from ${args.publicRepo}@${subject.commit} and served at ${publicLaneAppUrl} in-sandbox`
                : `subject cloned from ${args.publicRepo}@${subject.commit}; serving did not complete (see session error)`
              : `subject clone attempted from ${args.publicRepo}; commit unresolved`
        } (subject env names: ${args.subjectEnvNames.length > 0 ? args.subjectEnvNames.join(", ") : "none"}; values never persisted); state: ${describeSubjectState(subject.state, args.dryRun)}.`,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    } else if (subject.source === "local-tree") {
      events.push({
        id: nextEventId(`subject-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.subject.provenance",
        message: `Lane ${spec.laneId}: ${
          args.dryRun
            ? `subject declared: local working tree, to be packed and served at ${publicLaneAppUrl} in-sandbox (dry-run contract; nothing packed)`
            : subject.archiveSha256
              ? session
                ? `subject packed (archiveSha256 ${subject.archiveSha256}${subject.dirty === true ? ", dirty working tree" : subject.dirty === false ? ", clean working tree" : ""}) and served at ${publicLaneAppUrl} in-sandbox`
                : `subject packed (archiveSha256 ${subject.archiveSha256}); serving did not complete (see session error)`
              : "subject local-tree packing attempted; archive digest unresolved"
        } (subject env names: ${args.subjectEnvNames.length > 0 ? args.subjectEnvNames.join(", ") : "none"}; values never persisted); state: ${describeSubjectState(subject.state, args.dryRun)}.`,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    } else {
      events.push({
        id: nextEventId(`subject-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.subject.declared",
        message: `Lane ${spec.laneId}: subject app declared at ${publicLaneAppUrl} (loopback inside the lane's own desktop sandbox).`,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    }

    // Per-lane session event.
    if (session) {
      events.push({
        id: nextEventId(`session-${spec.laneId}`),
        at: args.createdAt,
        level: session.status === "passed" ? "info" : "warn",
        type: `cua-lab.session.${session.completionReason}`,
        message: `Lane ${spec.laneId}: ${session.status} — ${session.reason}`,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    } else if (args.inProgress === true && outcome === undefined) {
      events.push({
        id: nextEventId(`running-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.session.running",
        message: `Lane ${spec.laneId}: live computer-use session is running; terminal evidence has not been written yet.`,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    } else if (outcome?.skippedReason !== undefined) {
      events.push({
        id: nextEventId(`blocked-${spec.laneId}`),
        at: args.createdAt,
        level: "warn",
        type: "cua-lab.session.blocked",
        message: `Lane ${spec.laneId} ${outcome.skippedReason}.`,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    } else if (outcome?.sessionError) {
      events.push({
        id: nextEventId(`session-error-${spec.laneId}`),
        at: args.createdAt,
        level: "error",
        type: "cua-lab.session.error",
        message: `Lane ${spec.laneId}: ${outcome.sessionError}`,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    } else {
      events.push({
        id: nextEventId(`contract-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.contract.ready",
        message: `Lane ${spec.laneId}: dry-run contract lane ready; switch scenario.mode to live for a real desktop session.`,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    }

    for (const warning of desktopGeometry.warnings ?? []) {
      events.push({
        id: nextEventId(`geometry-warning-${spec.laneId}`),
        at: args.createdAt,
        level: "warn",
        type: "cua-lab.geometry.warning",
        message: warning,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    }

    // Persisted per-lane phase trail (real boot timing): one RunEvent per COMPLETED phase
    // boundary this lane recorded (started events never persist here; they carry no durationMs).
    for (const phase of outcome?.phaseRecords ?? []) {
      events.push({
        id: nextEventId(`phase-${spec.laneId}-${phaseEventIdSuffix(phase.type)}`),
        at: phase.at,
        level: phase.ok === false ? "warn" : "info",
        type: phase.type,
        message:
          phase.durationMs === undefined
            ? `Lane ${spec.laneId}: ${phase.message}`
            : `Lane ${spec.laneId}: ${phase.message} (${phase.durationMs}ms)`,
        simId: spec.simId,
        streamId: spec.streamId,
      });
    }
  });

  if (args.failFastReason) {
    events.push({
      id: nextEventId("fanout-fail-fast"),
      at: args.createdAt,
      level: "warn",
      type: "cua-lab.fanout.fail-fast",
      message: `Fan-out fail-fast: ${args.failFastReason}. In-flight lanes finished; queued lanes were skipped (blocked) — completed evidence is retained.`,
    });
  }

  // Worst-of review verdict across lanes; live fan-out must prove every lane.
  const verdict =
    args.inProgress === true
      ? "contract_proof_only"
      : fanoutReviewVerdict({
          dryRun: args.dryRun,
          expectedLaneCount: specs.length,
          outcomes,
        });

  const passedLanes = (outcomes ?? []).filter(
    (outcome) =>
      outcome.skippedReason === undefined &&
      outcome.session !== undefined &&
      outcome.session.status === "passed" &&
      outcome.session.completionReason !== "harness_error" &&
      outcome.sessionError === undefined &&
      !outcome.noEngagement &&
      !outcome.selfReportedBlocker,
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
          // taken zero actions and said nothing, and `passedLanes` below already refuses to count
          // it — but `reachedGoal` was reading the trace status directly, so one run could be both
          // "not a passed lane" AND "1/1 reached the goal". The headline number a researcher reads
          // first was the dishonest one. Found by a provider bug that ended a study on turn one.
          terminalOutcomes.map((outcome) =>
            participantStatusForCredibility(outcome.session.status, {
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
          ? `Live computer-use fan-out is running (${specs.length} per-lane worlds); terminal lane evidence has not been written yet.`
          : args.dryRun
            ? `${args.rerun ? `Rerun contract from ${args.rerun.sourceRunId}: ` : ""}Dry-run fan-out contract: ${specs.length} per-lane-world lanes composed for ${args.descriptor.id} against ${args.appUrl}; no desktops launched, $0 spend.`
            : `${args.rerun ? `Rerun from ${args.rerun.sourceRunId}: ` : ""}Computer-use fan-out (${specs.length} per-lane worlds): ${passedLanes}/${specs.length} lane(s) reached a terminal, engaged verdict${participants ? ` — ${formatParticipantOutcomes(participants, participantEndings)}` : ""}${studyTasks ? `; tasks: ${formatStudyTaskFunnel(studyTasks)}` : ""}.`,
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
                    `${spec.laneId}: ${outcome?.skippedReason ?? outcome?.sessionError ?? outcome?.session?.reason ?? "did not pass"}`,
                ),
    },
    streams,
  );

  const anyRaw = (outcomes ?? []).some(
    (outcome) => outcome.session?.trace.redaction.screenshots === "raw",
  );
  const ranLive = (outcomes ?? []).some(
    (outcome) => outcome.session !== undefined || outcome.sessionError !== undefined,
  );
  const configuredBrowser = config.execution?.desktop?.browser;
  const desktopTemplate = e2bDesktopTemplate(config);
  const resolvedBrowsers = (outcomes ?? [])
    .map((outcome) => outcome.desktopBrowser?.resolved)
    .filter((value): value is string => value !== undefined);
  const unanimousResolvedBrowser =
    resolvedBrowsers.length > 0 && new Set(resolvedBrowsers).size === 1
      ? resolvedBrowsers[0]
      : undefined;
  const providerResources = (outcomes ?? []).flatMap((outcome) =>
    providerResourcesForOutcome({
      outcome,
      createdAt: args.createdAt,
      simId: outcome.spec.simId,
      streamId: outcome.spec.streamId,
      laneId: outcome.spec.laneId,
    }),
  );

  // Run-level cost ESTIMATE: one model-token line per lane that ran a session (from its persisted
  // trace.estimatedCost) + a desktop line per owned allocation, priced at its observed resources.
  // Per-lane worlds have no shared provisioning to double-count. Omitted on a pure dry-run.
  const costLanes = specs
    .map((spec, index) => ({ laneId: spec.laneId, outcome: outcomes?.[index] }))
    .filter(
      (entry): entry is { laneId: string; outcome: LaneRunOutcome } =>
        entry.outcome?.session !== undefined,
    )
    .map((entry) => ({ laneId: entry.laneId, trace: entry.outcome.session!.trace }));
  const desktops = (outcomes ?? [])
    .filter((outcome) => outcome.sandboxId !== undefined)
    .map((outcome) => ({
      laneId: outcome.spec.laneId,
      minutes: desktopSpanToMinutes(outcome.desktopDurationMs),
      observation: outcome.desktopResources,
      lifetimeComplete: outcome.killed,
    }));
  const cost = buildCuaCostSummary({ lanes: costLanes, desktops });

  return {
    schema: RUN_BUNDLE_SCHEMA,
    ...receivingPublication(args.config, args.dryRun),
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: specs.length,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".humanish", "runs", args.runId),
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    source: args.source,
    persona: {
      id: specs[0]!.persona.id,
      name: `Computer-use fan-out (${specs.length} lanes)`,
      source: `lab:${config.id}`,
      sourceDigest: specs[0]!.persona.promptDigest,
    },
    scenario: {
      id: `cua-${config.id}`,
      title: config.title ?? `Computer-use fan-out: ${config.id}`,
      // Redacted at WRITE time, like every other raw-text surface in the bundle. Lane records are
      // digest-only by design, but scenario.goal keeps one lane's composed instructions verbatim —
      // and an adopter whose authored lane text must name a runtime world URL (an inbox on a route
      // where the harness does not inject one) put an *.e2b.app address in it. That landed raw here
      // and in observer-data.json, the sensitive-text scanner matched it, and verify failed a bundle
      // this writer produced. The only adopter-side workaround was scanner evasion (#412).
      //
      // The instructions the model actually receives are untouched; only the persisted copy changes.
      goal: redactText(specs[0]!.evidenceInstructions ?? specs[0]!.instructions),
      source: `lab:${config.id}`,
      sourceDigest: specs[0]!.persona.promptDigest,
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "cua-lab.run.created",
        message: `Created computer-use fan-out run with ${specs.length} per-lane desktop browser lanes (actor ${args.descriptor.id}).`,
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
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Some lanes captured FULL-FIDELITY (raw) screenshots, retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle."
        : "Dry-run fan-out contract bundle: no desktops launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs.",
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson",
    },
    review,
    // What the participants reported, when any reported anything (#392). Dry-run and in-progress
    // bundles carry none — there is no participant yet to quote.
    feedbackCandidates:
      args.dryRun || args.inProgress === true
        ? []
        : participantFeedbackCandidates({
            runId: args.runId,
            scenarioId: `cua-${config.id}`,
            adapterId: config.id,
            goal: redactText(specs[0]!.evidenceInstructions ?? specs[0]!.instructions),
            substrate: config.execution?.target === "local" ? "local-desktop" : "e2b-desktop",
            lanes: specs.map((spec, index) => {
              const outcome = outcomes?.[index];
              return {
                laneId: spec.laneId,
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
          }),
    // Selected hosted image, including the optional speech default; omitted on the stock desktop.
    ...(desktopTemplate === undefined ? {} : { desktopTemplate }),
    ...(configuredBrowser === undefined
      ? {}
      : {
          desktopBrowser: {
            requested: configuredBrowser,
            ...(unanimousResolvedBrowser === undefined
              ? {}
              : { resolved: unanimousResolvedBrowser }),
          },
        }),
    ...(providerResources.length === 0 ? {} : { providerResources }),
    subject: args.aggregateSubject,
    ...(cost === undefined ? {} : { cost }),
  };
}
