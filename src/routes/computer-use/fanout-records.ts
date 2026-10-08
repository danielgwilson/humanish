// Each participant's records in a computer-use fan-out bundle: its simulation, its stream, its
// subject provenance event and the events of its outcome (session, geometry warnings, phase trail).

import { participantAssignment } from "../../study/participant-assignment.js";
import type { RunEvent, RunSimulation } from "../../run/bundle.js";
import {
  participantEvent,
  participantRecord,
  participantStream,
} from "../../run/participant-records.js";
import type { RunDesktopGeometry, RunStream } from "../../run/streams.js";
import { participantCaption } from "../../run/participant-caption.js";
import { participantSummary } from "../../run/outcomes.js";
import { declaredScreenForRender } from "../../substrates/e2b/desktop-geometry.js";
import { describeSubjectState, phaseEventIdSuffix, publicSafeAppUrlLabel } from "./bundle-parts.js";
import type { judgeParticipantRecords } from "../../run/judge.js";
import type { CuaFanoutBundleArgs, DesktopParticipantRun } from "./types.js";
import { participantSubjectEnv } from "./types.js";

const describeEnvNames = (names: readonly string[]): string =>
  names.length > 0 ? names.join(", ") : "none";

/** What every participant's records share. */
export interface FanoutParticipantContext {
  args: CuaFanoutBundleArgs;
  participants: ReturnType<typeof judgeParticipantRecords>["participants"];
  /** Numbers events in the order they are pushed. */
  nextEventId: (suffix: string) => string;
}

function fanoutParticipantView(
  args: CuaFanoutBundleArgs,
  spec: DesktopParticipantRun,
  index: number,
  participant: FanoutParticipantContext["participants"][number],
) {
  const { outcomes, plan } = args;
  const outcome = outcomes?.[index];
  const targetUrl = spec.planned.targetUrl ?? args.appUrl;
  const publicTargetUrl = publicSafeAppUrlLabel(targetUrl);
  const subject = args.subjects[index]!;
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
  const { status, reason } = participant;

  const traceScreenshotMode = session?.trace.redaction.screenshots;
  const screenshotMode: "raw" | "blurred" =
    traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
      ? traceScreenshotMode
      : plan.residual.policies?.redactScreenshots === true
        ? "blurred"
        : "raw";
  return {
    outcome,
    participant,
    publicTargetUrl,
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

type FanoutParticipantView = ReturnType<typeof fanoutParticipantView>;

function fanoutParticipantRecord(
  args: CuaFanoutBundleArgs,
  spec: DesktopParticipantRun,
  index: number,
  view: FanoutParticipantView,
): RunSimulation {
  const { plan } = args;
  const { outcome, publicTargetUrl, session, status, reason } = view;
  const name = participantCaption({ id: spec.planned.id, personaId: spec.persona.id });
  return participantRecord(spec, index + 1, {
    personaId: spec.persona.id,
    scenarioId: `cua-${plan.studyId}`,
    status,
    streamKind: "browser",
    mode: "browser-sim",
    progress: args.inProgress === true && outcome === undefined ? 20 : 100,
    currentStep: reason,
    summary: participantSummary(
      name,
      { name: "the app", target: publicTargetUrl },
      {
        trace: session?.trace,
        skippedReason: outcome?.skippedReason,
        sessionError: outcome?.sessionError,
        inProgress: args.inProgress === true && outcome === undefined,
      },
    ),
    startedAt: args.run.createdAt,
    updatedAt: args.run.createdAt,
  });
}

function fanoutParticipantStream(
  args: CuaFanoutBundleArgs,
  spec: DesktopParticipantRun,
  view: FanoutParticipantView,
): RunStream {
  const { outcome, publicTargetUrl, session, desktopGeometry, screenshots } = view;
  const { lastScreenshot, status, reason, screenshotMode } = view;
  const judged = view.participant.judgedStatus;
  return participantStream(
    spec,
    {
      ...(spec.evidenceAssignment === undefined
        ? {}
        : { assignment: participantAssignment(spec.evidenceAssignment) }),
      ...(spec.planned.labels.actorType === undefined
        ? {}
        : { actorType: spec.planned.labels.actorType }),
      ...(spec.planned.labels.surface === undefined
        ? {}
        : { surface: spec.planned.labels.surface }),
      ...(spec.planned.labels.caseGroup === undefined
        ? {}
        : { caseGroup: spec.planned.labels.caseGroup }),
      kind: "browser",
      label: participantCaption({
        id: spec.planned.id,
        personaId: spec.persona.id,
        device: spec.planned.device,
      }),
      status,
      ...(judged === undefined ? {} : { judgedStatus: judged }),
      transport: "snapshot",
      updatedAt: args.run.createdAt,
      embed: lastScreenshot
        ? {
            kind: "screenshot",
            url: lastScreenshot,
            title: `Desktop (${screenshotMode})`,
          }
        : { kind: "placeholder", title: "Desktop" },
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
        route: publicTargetUrl,
        intent: `Watch participant ${spec.planned.id} (${spec.persona.id}/${spec.planned.device.name}) drive the subject app in its own hosted desktop.`,
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
                label: `participant ${spec.planned.id} actor trace`,
                path: spec.traceArtifactPath,
                kind: "trace" as const,
              },
            ]
          : []),
        ...(outcome?.commsArtifactPath
          ? [
              {
                label: `participant ${spec.planned.id} comms thread`,
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
          label: `participant ${spec.planned.id} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
          path: screenshot,
          kind: "screenshot" as const,
        })),
      ],
    },
    spec.planned.id,
  );
}

function fanoutSubjectEvents(
  ctx: FanoutParticipantContext,
  spec: DesktopParticipantRun,
  view: FanoutParticipantView,
): RunEvent[] {
  const { args, nextEventId } = ctx;
  const { publicTargetUrl, subject, session } = view;
  const events: RunEvent[] = [];
  const record = (event: Omit<RunEvent, "simId" | "streamId">) =>
    events.push(participantEvent(spec, event));
  // Per-participant subject provenance.
  if (args.plan.runner.subject.kind === "clone" && args.publicRepo) {
    record({
      id: nextEventId(`subject-${spec.planned.id}`),
      at: args.run.createdAt,
      level: "info",
      type: "cua-lab.subject.provenance",
      message: `Participant ${spec.planned.id}: ${
        args.dryRun
          ? `subject declared: clone of ${args.publicRepo}, served at ${publicTargetUrl} in-sandbox (dry run; nothing cloned)`
          : subject.commit
            ? session
              ? `subject cloned from ${args.publicRepo}@${subject.commit} and served at ${publicTargetUrl} in-sandbox`
              : `subject cloned from ${args.publicRepo}@${subject.commit}; serving did not complete (see session error)`
            : `subject clone attempted from ${args.publicRepo}; commit unresolved`
      } (subject env names: ${describeEnvNames(participantSubjectEnv(args.plan.runner.subject))}; values never persisted); state: ${describeSubjectState(subject.state, args.dryRun)}.`,
    });
  } else if (subject.source === "local-tree") {
    record({
      id: nextEventId(`subject-${spec.planned.id}`),
      at: args.run.createdAt,
      level: "info",
      type: "cua-lab.subject.provenance",
      message: `Participant ${spec.planned.id}: ${
        args.dryRun
          ? `subject declared: local working tree, to be packed and served at ${publicTargetUrl} in-sandbox (dry run; nothing packed)`
          : subject.archiveSha256
            ? session
              ? `subject packed (archiveSha256 ${subject.archiveSha256}${subject.dirty === true ? ", dirty working tree" : subject.dirty === false ? ", clean working tree" : ""}) and served at ${publicTargetUrl} in-sandbox`
              : `subject packed (archiveSha256 ${subject.archiveSha256}); serving did not complete (see session error)`
            : "subject local-tree packing attempted; archive digest unresolved"
      } (subject env names: ${describeEnvNames(participantSubjectEnv(args.plan.runner.subject))}; values never persisted); state: ${describeSubjectState(subject.state, args.dryRun)}.`,
    });
  } else {
    record({
      id: nextEventId(`subject-${spec.planned.id}`),
      at: args.run.createdAt,
      level: "info",
      type: "cua-lab.subject.declared",
      message:
        subject.source === "desktop-cli"
          ? `Participant ${spec.planned.id}: subject product declared: ${subject.product}, used from a terminal window inside the participant's own desktop sandbox.`
          : `Participant ${spec.planned.id}: subject app declared at ${publicTargetUrl} (loopback inside the participant's own desktop sandbox).`,
    });
  }
  return events;
}

function fanoutOutcomeEvents(
  ctx: FanoutParticipantContext,
  spec: DesktopParticipantRun,
  view: FanoutParticipantView,
): RunEvent[] {
  const { args, nextEventId } = ctx;
  const { outcome, session, desktopGeometry } = view;
  const events: RunEvent[] = [];
  const record = (event: Omit<RunEvent, "simId" | "streamId">) =>
    events.push(participantEvent(spec, event));
  // Per-participant session event.
  if (session) {
    record({
      id: nextEventId(`session-${spec.planned.id}`),
      at: args.run.createdAt,
      level: session.status === "passed" ? "info" : "warn",
      type: `cua-lab.session.${session.completionReason}`,
      message: `Participant ${spec.planned.id} ${session.status}: ${session.reason}`,
    });
  } else if (args.inProgress === true && outcome === undefined) {
    record({
      id: nextEventId(`running-${spec.planned.id}`),
      at: args.run.createdAt,
      level: "info",
      type: "cua-lab.session.running",
      message: `Participant ${spec.planned.id}: live computer-use session is running; terminal evidence has not been written yet.`,
    });
  } else if (outcome?.skippedReason !== undefined) {
    record({
      id: nextEventId(`blocked-${spec.planned.id}`),
      at: args.run.createdAt,
      level: "warn",
      type: "cua-lab.session.blocked",
      message: `Participant ${spec.planned.id} ${outcome.skippedReason}.`,
    });
  } else if (outcome?.sessionError !== undefined) {
    record({
      id: nextEventId(`session-error-${spec.planned.id}`),
      at: args.run.createdAt,
      level: "error",
      type: "cua-lab.session.error",
      message: `Participant ${spec.planned.id}: ${outcome.sessionError}`,
    });
  } else {
    record({
      id: nextEventId(`contract-${spec.planned.id}`),
      at: args.run.createdAt,
      level: "info",
      type: "cua-lab.contract.ready",
      message: `Participant ${spec.planned.id}: dry-run participant ready; switch mode to live for a real desktop session.`,
    });
  }

  for (const warning of desktopGeometry.warnings ?? []) {
    record({
      id: nextEventId(`geometry-warning-${spec.planned.id}`),
      at: args.run.createdAt,
      level: "warn",
      type: "cua-lab.geometry.warning",
      message: warning,
    });
  }

  // Persisted per-participant phase trail (real boot timing): one RunEvent per completed phase
  // boundary this participant recorded (started events never persist here; they carry no durationMs).
  for (const phase of outcome?.phaseRecords ?? []) {
    record({
      id: nextEventId(`phase-${spec.planned.id}-${phaseEventIdSuffix(phase.type)}`),
      at: phase.at,
      level: phase.ok === false ? "warn" : "info",
      type: phase.type,
      message:
        phase.durationMs === undefined
          ? `Participant ${spec.planned.id}: ${phase.message}`
          : `Participant ${spec.planned.id}: ${phase.message} (${phase.durationMs}ms)`,
    });
  }
  return events;
}

/** One participant's simulation, stream and events, in the order the bundle records them. */
export function fanoutParticipantRecords(
  ctx: FanoutParticipantContext,
  spec: DesktopParticipantRun,
  index: number,
): { simulation: RunSimulation; stream: RunStream; events: RunEvent[] } {
  const view = fanoutParticipantView(ctx.args, spec, index, ctx.participants[index]!);
  return {
    simulation: fanoutParticipantRecord(ctx.args, spec, index, view),
    stream: fanoutParticipantStream(ctx.args, spec, view),
    events: [...fanoutSubjectEvents(ctx, spec, view), ...fanoutOutcomeEvents(ctx, spec, view)],
  };
}
