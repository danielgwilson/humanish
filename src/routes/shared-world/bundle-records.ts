// Each participant's records in a concurrent shared-world bundle: its simulation, its stream and
// its events, projected from the actor's run result (or from the declaration on a dry run or while
// running).

import { participantAssignment } from "../../study/participant-assignment.js";
import type { RunEvent, RunSimulation } from "../../run/bundle.js";
import {
  participantEvent,
  participantRecord,
  participantStream,
} from "../../run/participant-records.js";
import type { judgeParticipantRecords } from "../../run/judge.js";
import type { RunSimulationStatus, RunStream } from "../../run/streams.js";
import { declaredScreenForRender } from "../../substrates/e2b/desktop-geometry.js";
import type { DesktopParticipantRun, ParticipantRunOutcome } from "../computer-use/types.js";
import { publicSafeRouteLabel } from "./provenance.js";
import { participantCaption } from "../../run/participant-caption.js";
import { participantSummary } from "../../run/outcomes.js";
import type { ActorRunResult, ConcurrentBundleArgs } from "./types.js";
import { arrivalRecord, type ParticipantArrival } from "../../study/arrivals.js";

/** What every participant's records share. */
export interface SharedWorldRecordContext {
  args: ConcurrentBundleArgs;
  participants: ReturnType<typeof judgeParticipantRecords>["participants"];
  external: boolean;
  inProgress: boolean;
  /** Numbers events in the order they are pushed. */
  nextEventId: (suffix: string) => string;
}

interface ParticipantView {
  /** The participant's name in words, without the device the caption adds. */
  name: string;
  judgment: SharedWorldRecordContext["participants"][number];
  outcome: ParticipantRunOutcome | undefined;
  session: ParticipantRunOutcome["session"];
  screenshots: string[];
  lastScreenshot: string | undefined;
  route: string;
  status: RunSimulationStatus;
  reason: string;
  desktopGeometry: NonNullable<ParticipantRunOutcome["desktopGeometry"]>;
  screenshotMode: "raw" | "blurred";
}

function participantView(
  ctx: SharedWorldRecordContext,
  spec: DesktopParticipantRun,
  index: number,
): ParticipantView {
  const { args, external } = ctx;
  const name = participantCaption({ id: spec.planned.id, personaId: spec.persona.id });
  const result = args.actorResults[index];
  const outcome = result?.outcome;
  const session = outcome?.session;
  const screenshots = outcome?.screenshots ?? [];
  const lastScreenshot = screenshots[screenshots.length - 1];
  // public-safe (origin redacted): external-public participants open the public plane; getHost
  // participants open their own path.
  const route = external
    ? "[external-public-plane]"
    : publicSafeRouteLabel(args.plan.plane.participants[index]?.entry);
  const judgment = ctx.participants[index]!;
  const { status, reason } = judgment;
  const traceScreenshotMode = session?.trace.redaction.screenshots;
  // Include `declared` on the no-outcome fallback too (dry-run, skipped participant): otherwise an
  // absent `declared` means either "the preset rendered faithfully" or "there was no live
  // outcome", and a dry-run bundle keeps the self-confirming shape this field exists to kill.
  const fallbackDeclared = declaredScreenForRender(
    spec.planned.device.preset,
    spec.planned.device.name,
    spec.planned.device.resolution,
  );
  const desktopGeometry = outcome?.desktopGeometry ?? {
    screen: {
      requested: {
        width: spec.planned.device.resolution[0],
        height: spec.planned.device.resolution[1],
      },
      ...(fallbackDeclared ? { declared: fallbackDeclared } : {}),
    },
  };
  const screenshotMode: "raw" | "blurred" =
    traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
      ? traceScreenshotMode
      : args.plan.residual.policies?.redactScreenshots === true
        ? "blurred"
        : "raw";
  return {
    name,
    judgment,
    outcome,
    session,
    screenshots,
    lastScreenshot,
    route,
    status,
    reason,
    desktopGeometry,
    screenshotMode,
  };
}

function sharedWorldSimulation(
  ctx: SharedWorldRecordContext,
  spec: DesktopParticipantRun,
  index: number,
  view: ParticipantView,
): RunSimulation {
  const { args, inProgress } = ctx;
  const { name, outcome, session } = view;
  return participantRecord(spec, index + 1, {
    personaId: spec.persona.id,
    scenarioId: `concurrent-shared-world-${args.plan.studyId}`,
    status: view.status,
    streamKind: "browser",
    mode: "browser-sim",
    progress: inProgress ? 35 : 100,
    currentStep: view.reason,
    summary: participantSummary(
      name,
      { name: "the shared app" },
      { trace: session?.trace, sessionError: outcome?.sessionError, inProgress },
    ),
    startedAt: args.run.createdAt,
    updatedAt: args.run.createdAt,
    ...(args.plan.arrivals.declared
      ? {
          arrival: arrivalRecord(spec.planned.startAfterMs, actorArrival(args.actorResults[index])),
        }
      : {}),
  });
}

// A follower the handoff stopped before it opened the app never started its desktop.
function actorArrival(result: ActorRunResult | undefined): ParticipantArrival | undefined {
  if (result === undefined) return undefined;
  return result.outcome.skippedReason === undefined
    ? { scheduledAt: result.scheduledAt, startedAt: result.startedAt }
    : { scheduledAt: result.scheduledAt };
}

function sharedWorldStream(
  ctx: SharedWorldRecordContext,
  spec: DesktopParticipantRun,
  index: number,
  view: ParticipantView,
): RunStream {
  const { args } = ctx;
  const { name, session, screenshots, lastScreenshot, desktopGeometry, screenshotMode } = view;
  const judged = view.judgment.judgedStatus;
  const caption = participantCaption({
    id: spec.planned.id,
    personaId: spec.persona.id,
    device: spec.planned.device,
  });
  return participantStream(spec, {
    ...(spec.evidenceAssignment === undefined
      ? {}
      : { assignment: participantAssignment(spec.evidenceAssignment) }),
    kind: "browser",
    label: caption,
    status: view.status,
    ...(judged === undefined ? {} : { judgedStatus: judged }),
    transport: "snapshot",
    updatedAt: args.run.createdAt,
    embed: lastScreenshot
      ? {
          kind: "screenshot",
          url: lastScreenshot,
          title: `${caption} (${screenshotMode})`,
        }
      : { kind: "placeholder", title: caption },
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
    ui: {
      route: view.route,
      intent: `Watch ${name} use the shared app at the same time as the others.`,
      state: view.reason,
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
              label: `persona ${spec.planned.id} actor trace`,
              path: spec.traceArtifactPath,
              kind: "trace" as const,
            },
          ]
        : []),
      // Run-level comms evidence belongs to the one shared app, and to no persona: register it once, on
      // the first stream, so the bundle's existence-verify + public-safety scan cover it without
      // double-counting across participants.
      ...(index === 0 && args.commsArtifactPath
        ? [{ label: "comms thread", path: args.commsArtifactPath, kind: "log" as const }]
        : []),
      ...screenshots.map((screenshot, screenshotIndex) => ({
        label: `persona ${spec.planned.id} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
        path: screenshot,
        kind: "screenshot" as const,
      })),
    ],
  });
}

function sharedWorldEvents(
  ctx: SharedWorldRecordContext,
  spec: DesktopParticipantRun,
  view: ParticipantView,
): RunEvent[] {
  const { args, inProgress, nextEventId } = ctx;
  const createdAt = args.run.createdAt;
  const { outcome, session } = view;
  const events: RunEvent[] = [];
  const record = (event: Omit<RunEvent, "simId" | "streamId">) =>
    events.push(participantEvent(spec, event));
  for (const warning of outcome?.warnings ?? []) {
    record({
      id: nextEventId(`warning-${spec.planned.id}`),
      at: createdAt,
      level: "warn",
      type: "concurrent-shared-world.actor.warning",
      message: `Persona ${spec.planned.id}: ${warning}`,
    });
  }

  if (session) {
    record({
      id: nextEventId(`session-${spec.planned.id}`),
      at: createdAt,
      level: session.status === "passed" ? "info" : "warn",
      type: `concurrent-shared-world.session.${session.completionReason}`,
      message: `Persona ${spec.planned.id}: ${session.status} (${session.reason})`,
    });
  } else if (outcome?.sessionError !== undefined) {
    record({
      id: nextEventId(`session-error-${spec.planned.id}`),
      at: createdAt,
      level: "error",
      type: "concurrent-shared-world.session.error",
      message: `Persona ${spec.planned.id}: ${outcome.sessionError}`,
    });
  } else if (inProgress) {
    record({
      id: nextEventId(`running-${spec.planned.id}`),
      at: createdAt,
      level: "info",
      type: "actor.running",
      message: `Persona ${spec.planned.id}: desktop actor is running; live stream URL is runtime-only and not persisted.`,
    });
  } else {
    record({
      id: nextEventId(`contract-${spec.planned.id}`),
      at: createdAt,
      level: "info",
      type: "concurrent-shared-world.contract.ready",
      message: `Persona ${spec.planned.id}: dry-run actor ready; switch mode to live for a real concurrent session.`,
    });
  }
  return events;
}

/** One participant's simulation, stream and events. */
export function sharedWorldParticipantRecords(
  ctx: SharedWorldRecordContext,
  spec: DesktopParticipantRun,
  index: number,
): { simulation: RunSimulation; stream: RunStream; events: RunEvent[] } {
  const view = participantView(ctx, spec, index);
  return {
    simulation: sharedWorldSimulation(ctx, spec, index, view),
    stream: sharedWorldStream(ctx, spec, index, view),
    events: sharedWorldEvents(ctx, spec, view),
  };
}
