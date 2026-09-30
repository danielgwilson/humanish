// Each lane's records in a computer-use fan-out bundle: its simulation, its stream, its subject
// provenance event and the events of its outcome (session, geometry warnings, phase trail).

import { participantAssignment } from "../../lab/participant-assignment.js";
import type { RunEvent, RunSimulation } from "../../run/bundle.js";
import type { RunDesktopGeometry, RunSimulationStatus, RunStream } from "../../run/streams.js";
import { declaredScreenForRender } from "../../substrates/e2b/desktop-geometry.js";
import { describeSubjectState, publicSafeAppUrlLabel } from "./bundle.js";
import { phaseEventIdSuffix } from "./lane-plan.js";
import type { CuaFanoutBundleArgs, DesktopParticipantRun } from "./types.js";

/** What every lane's records share. */
export interface FanoutLaneContext {
  args: CuaFanoutBundleArgs;
  /** Numbers events in the order they are pushed. */
  nextEventId: (suffix: string) => string;
}

function fanoutLaneView(args: CuaFanoutBundleArgs, spec: DesktopParticipantRun, index: number) {
  const { outcomes, config } = args;
  const outcome = outcomes?.[index];
  const laneAppUrl = spec.planned.targetUrl ?? args.appUrl;
  const publicLaneAppUrl = publicSafeAppUrlLabel(laneAppUrl);
  const subject = args.laneSubjects[index]!;
  const session = outcome?.session;
  const fallbackDeclared = declaredScreenForRender(
    spec.planned.device.preset,
    spec.planned.device.name,
    spec.planned.device.resolution,
  );
  const desktopGeometry: RunDesktopGeometry = outcome?.desktopGeometry ?? {
    screen: {
      requested: {
        width: spec.planned.device.resolution[0],
        height: spec.planned.device.resolution[1],
      },
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
  return {
    outcome,
    publicLaneAppUrl,
    subject,
    session,
    desktopGeometry,
    screenshots,
    lastScreenshot,
    status,
    reason,
    screenshotMode,
  };
}

type FanoutLaneView = ReturnType<typeof fanoutLaneView>;

function fanoutLaneSimulation(
  args: CuaFanoutBundleArgs,
  spec: DesktopParticipantRun,
  index: number,
  view: FanoutLaneView,
): RunSimulation {
  const { config } = args;
  const { outcome, publicLaneAppUrl, session, status, reason } = view;
  return {
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
      ? `Lane ${spec.planned.id} (${spec.persona.id}/${spec.planned.device.name}): computer-use actor (${args.descriptor.id}) drove the subject app; ${session.completionReason}.`
      : args.inProgress === true && outcome === undefined
        ? `Lane ${spec.planned.id} (${spec.persona.id}/${spec.planned.device.name}): computer-use actor (${args.descriptor.id}) is driving the subject app.`
        : outcome?.skippedReason !== undefined
          ? `Lane ${spec.planned.id} ${outcome.skippedReason}.`
          : outcome?.sessionError
            ? `Lane ${spec.planned.id} failed before a terminal session verdict: ${outcome.sessionError}`
            : `Contract lane ${spec.planned.id} (${spec.persona.id}/${spec.planned.device.name}) for ${args.descriptor.id} against ${publicLaneAppUrl}.`,
    streamIds: [spec.streamId],
    startedAt: args.createdAt,
    updatedAt: args.createdAt,
  };
}

function fanoutLaneStream(
  args: CuaFanoutBundleArgs,
  spec: DesktopParticipantRun,
  view: FanoutLaneView,
): RunStream {
  const { config } = args;
  const { outcome, publicLaneAppUrl, session, desktopGeometry, screenshots } = view;
  const { lastScreenshot, status, reason, screenshotMode } = view;
  return {
    id: spec.streamId,
    simId: spec.simId,
    laneId: spec.planned.id,
    ...(spec.evidenceAssignment === undefined
      ? {}
      : { assignment: participantAssignment(spec.evidenceAssignment) }),
    ...(spec.planned.labels.actorType === undefined
      ? {}
      : { actorType: spec.planned.labels.actorType }),
    ...(spec.planned.labels.surface === undefined ? {} : { surface: spec.planned.labels.surface }),
    ...(spec.planned.labels.caseGroup === undefined
      ? {}
      : { caseGroup: spec.planned.labels.caseGroup }),
    kind: "browser",
    label: `CUA lane ${spec.planned.id} — ${config.id}`,
    status,
    transport: "snapshot",
    updatedAt: args.createdAt,
    embed: lastScreenshot
      ? {
          kind: "screenshot",
          url: lastScreenshot,
          title: `CUA desktop ${spec.planned.id} (${screenshotMode})`,
        }
      : { kind: "placeholder", title: `CUA desktop ${spec.planned.id}` },
    ...(desktopGeometry.viewport === undefined
      ? {}
      : {
          viewport: {
            width: desktopGeometry.viewport.width,
            height: desktopGeometry.viewport.height,
            deviceScaleFactor: desktopGeometry.viewport.deviceScaleFactor,
            isMobile: spec.planned.device.preset.isMobile,
          },
        }),
    desktopGeometry,
    ...(outcome?.recording === undefined ? {} : { recording: outcome.recording }),
    ui: {
      route: publicLaneAppUrl,
      intent: `Watch lane ${spec.planned.id} (${spec.persona.id}/${spec.planned.device.name}) drive the subject app in its own hosted desktop.`,
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
              label: `lane ${spec.planned.id} actor trace`,
              path: spec.traceArtifactPath,
              kind: "trace" as const,
            },
          ]
        : []),
      ...(outcome?.commsArtifactPath
        ? [
            {
              label: `lane ${spec.planned.id} comms thread`,
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
        label: `lane ${spec.planned.id} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
        path: screenshot,
        kind: "screenshot" as const,
      })),
    ],
  };
}

function fanoutLaneSubjectEvent(
  ctx: FanoutLaneContext,
  spec: DesktopParticipantRun,
  view: FanoutLaneView,
): RunEvent[] {
  const { args, nextEventId } = ctx;
  const { publicLaneAppUrl, subject, session } = view;
  const events: RunEvent[] = [];
  // Per-lane subject provenance (invariant 5).
  if (args.cloneRoute && args.publicRepo) {
    events.push({
      id: nextEventId(`subject-${spec.planned.id}`),
      at: args.createdAt,
      level: "info",
      type: "cua-lab.subject.provenance",
      message: `Lane ${spec.planned.id}: ${
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
      id: nextEventId(`subject-${spec.planned.id}`),
      at: args.createdAt,
      level: "info",
      type: "cua-lab.subject.provenance",
      message: `Lane ${spec.planned.id}: ${
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
      id: nextEventId(`subject-${spec.planned.id}`),
      at: args.createdAt,
      level: "info",
      type: "cua-lab.subject.declared",
      message: `Lane ${spec.planned.id}: subject app declared at ${publicLaneAppUrl} (loopback inside the lane's own desktop sandbox).`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  }
  return events;
}

function fanoutLaneOutcomeEvents(
  ctx: FanoutLaneContext,
  spec: DesktopParticipantRun,
  view: FanoutLaneView,
): RunEvent[] {
  const { args, nextEventId } = ctx;
  const { outcome, session, desktopGeometry } = view;
  const events: RunEvent[] = [];
  // Per-lane session event.
  if (session) {
    events.push({
      id: nextEventId(`session-${spec.planned.id}`),
      at: args.createdAt,
      level: session.status === "passed" ? "info" : "warn",
      type: `cua-lab.session.${session.completionReason}`,
      message: `Lane ${spec.planned.id}: ${session.status} — ${session.reason}`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  } else if (args.inProgress === true && outcome === undefined) {
    events.push({
      id: nextEventId(`running-${spec.planned.id}`),
      at: args.createdAt,
      level: "info",
      type: "cua-lab.session.running",
      message: `Lane ${spec.planned.id}: live computer-use session is running; terminal evidence has not been written yet.`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  } else if (outcome?.skippedReason !== undefined) {
    events.push({
      id: nextEventId(`blocked-${spec.planned.id}`),
      at: args.createdAt,
      level: "warn",
      type: "cua-lab.session.blocked",
      message: `Lane ${spec.planned.id} ${outcome.skippedReason}.`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  } else if (outcome?.sessionError) {
    events.push({
      id: nextEventId(`session-error-${spec.planned.id}`),
      at: args.createdAt,
      level: "error",
      type: "cua-lab.session.error",
      message: `Lane ${spec.planned.id}: ${outcome.sessionError}`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  } else {
    events.push({
      id: nextEventId(`contract-${spec.planned.id}`),
      at: args.createdAt,
      level: "info",
      type: "cua-lab.contract.ready",
      message: `Lane ${spec.planned.id}: dry-run contract lane ready; switch scenario.mode to live for a real desktop session.`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  }

  for (const warning of desktopGeometry.warnings ?? []) {
    events.push({
      id: nextEventId(`geometry-warning-${spec.planned.id}`),
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
      id: nextEventId(`phase-${spec.planned.id}-${phaseEventIdSuffix(phase.type)}`),
      at: phase.at,
      level: phase.ok === false ? "warn" : "info",
      type: phase.type,
      message:
        phase.durationMs === undefined
          ? `Lane ${spec.planned.id}: ${phase.message}`
          : `Lane ${spec.planned.id}: ${phase.message} (${phase.durationMs}ms)`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  }
  return events;
}

/** One lane's simulation, stream and events, in the order the bundle records them. */
export function fanoutLaneRecords(
  ctx: FanoutLaneContext,
  spec: DesktopParticipantRun,
  index: number,
): { simulation: RunSimulation; stream: RunStream; events: RunEvent[] } {
  const view = fanoutLaneView(ctx.args, spec, index);
  return {
    simulation: fanoutLaneSimulation(ctx.args, spec, index, view),
    stream: fanoutLaneStream(ctx.args, spec, view),
    events: [
      ...fanoutLaneSubjectEvent(ctx, spec, view),
      ...fanoutLaneOutcomeEvents(ctx, spec, view),
    ],
  };
}
