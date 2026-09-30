// Each seat's records in a concurrent shared-world bundle: its simulation, its stream and its
// events, projected from the lane result (or from the declaration on a dry run or while running).

import { participantAssignment } from "../../lab/participant-assignment.js";
import type { RunEvent, RunSimulation } from "../../run/bundle.js";
import type { RunSimulationStatus, RunStream } from "../../run/streams.js";
import { declaredScreenForRender } from "../../substrates/e2b/desktop-geometry.js";
import type { CuaLaneSpec, LaneRunOutcome } from "../computer-use/types.js";
import { publicSafeRouteLabel } from "./provenance.js";
import { laneTaxonomyLabel } from "./seats.js";
import type { ConcurrentBundleArgs } from "./types.js";

/** What every seat's records share. */
export interface SeatRecordContext {
  args: ConcurrentBundleArgs;
  external: boolean;
  inProgress: boolean;
  /** The public-safe plane label: never the raw getHost URL or public origin. */
  appUrl: string;
  /** Numbers events in the order they are pushed. */
  nextEventId: (suffix: string) => string;
}

interface SeatView {
  taxonomy: string;
  outcome: LaneRunOutcome | undefined;
  session: LaneRunOutcome["session"];
  screenshots: string[];
  lastScreenshot: string | undefined;
  route: string;
  status: RunSimulationStatus;
  reason: string;
  desktopGeometry: NonNullable<LaneRunOutcome["desktopGeometry"]>;
  screenshotMode: "raw" | "blurred";
}

function seatView(ctx: SeatRecordContext, spec: CuaLaneSpec, index: number): SeatView {
  const { args, external, inProgress } = ctx;
  const taxonomy = laneTaxonomyLabel(spec);
  const result = args.actorResults[index];
  const outcome = result?.outcome;
  const session = outcome?.session;
  const screenshots = outcome?.screenshots ?? [];
  const lastScreenshot = screenshots[screenshots.length - 1];
  // public-safe (origin redacted): external-public seats open the public plane; getHost seats a seat path.
  const route = external
    ? "[external-public-plane]"
    : publicSafeRouteLabel(args.roles[index]?.entry);
  const status: RunSimulationStatus = session
    ? session.status
    : outcome?.sessionError
      ? "failed"
      : inProgress
        ? "running"
        : "contract_proof_only";
  const reason =
    session?.reason ??
    outcome?.sessionError ??
    (inProgress
      ? "Actor desktop is running; the attached Observer hydrates the runtime stream URL without persisting it."
      : "Contract actor only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.");
  const traceScreenshotMode = session?.trace.redaction.screenshots;
  // Include `declared` on the no-outcome fallback too (dry-run, skipped lane): otherwise an
  // ABSENT declared means either "the preset rendered faithfully" or "there was no live
  // outcome", and a dry-run bundle keeps the self-confirming shape this field exists to kill.
  const fallbackDeclared = declaredScreenForRender(
    spec.devicePreset,
    spec.deviceName,
    spec.resolution,
  );
  const desktopGeometry = outcome?.desktopGeometry ?? {
    screen: {
      requested: { width: spec.resolution[0], height: spec.resolution[1] },
      ...(fallbackDeclared ? { declared: fallbackDeclared } : {}),
    },
  };
  const screenshotMode: "raw" | "blurred" =
    traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
      ? traceScreenshotMode
      : args.config.policies?.redactScreenshots === true
        ? "blurred"
        : "raw";
  return {
    taxonomy,
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

function seatSimulation(
  ctx: SeatRecordContext,
  spec: CuaLaneSpec,
  index: number,
  view: SeatView,
): RunSimulation {
  const { args, inProgress } = ctx;
  const { taxonomy, outcome, session } = view;
  return {
    id: spec.simId,
    index: index + 1,
    personaId: spec.persona.id,
    scenarioId: `concurrent-shared-world-${args.config.id}`,
    status: view.status,
    streamKind: "browser",
    mode: "browser-sim",
    progress: inProgress ? 35 : 100,
    currentStep: view.reason,
    summary: session
      ? `Persona ${spec.laneId}${taxonomy} (${spec.persona.id}): drove the shared plane concurrently; ${session.completionReason}.`
      : outcome?.sessionError
        ? `Persona ${spec.laneId}${taxonomy} failed before a terminal session verdict: ${outcome.sessionError}`
        : inProgress
          ? `Persona ${spec.laneId}${taxonomy} (${spec.persona.id}) is running against the shared plane.`
          : `Contract persona ${spec.laneId}${taxonomy} (${spec.persona.id}) for ${args.descriptor.id} against the shared plane at ${ctx.appUrl}.`,
    streamIds: [spec.streamId],
    startedAt: args.createdAt,
    updatedAt: args.createdAt,
  };
}

function seatStream(
  ctx: SeatRecordContext,
  spec: CuaLaneSpec,
  index: number,
  view: SeatView,
): RunStream {
  const { args } = ctx;
  const { taxonomy, session, screenshots, lastScreenshot, desktopGeometry, screenshotMode } = view;
  return {
    id: spec.streamId,
    simId: spec.simId,
    ...(spec.assignment === undefined
      ? {}
      : { assignment: participantAssignment(spec.assignment) }),
    kind: "browser",
    label: `Concurrent persona ${spec.laneId}${taxonomy} — ${args.config.id}`,
    status: view.status,
    transport: "snapshot",
    updatedAt: args.createdAt,
    embed: lastScreenshot
      ? {
          kind: "screenshot",
          url: lastScreenshot,
          title: `Shared plane, persona ${spec.laneId} (${screenshotMode})`,
        }
      : { kind: "placeholder", title: `Shared plane, persona ${spec.laneId}` },
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
    ui: {
      route: view.route,
      intent: `Watch persona ${spec.laneId}${taxonomy} (${spec.persona.id}) drive the SHARED plane concurrently with the other personas.`,
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
              label: `persona ${spec.laneId} actor trace`,
              path: spec.traceArtifactPath,
              kind: "trace" as const,
            },
          ]
        : []),
      // Run-level comms evidence belongs to the ONE shared app, not a persona — register it once, on
      // the first stream, so the bundle's existence-verify + public-safety scan cover it without
      // double-counting across seats.
      ...(index === 0 && args.commsArtifactPath
        ? [{ label: "comms thread", path: args.commsArtifactPath, kind: "log" as const }]
        : []),
      ...screenshots.map((screenshot, screenshotIndex) => ({
        label: `persona ${spec.laneId} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
        path: screenshot,
        kind: "screenshot" as const,
      })),
    ],
  };
}

function seatEvents(ctx: SeatRecordContext, spec: CuaLaneSpec, view: SeatView): RunEvent[] {
  const { args, inProgress, nextEventId } = ctx;
  const createdAt = args.createdAt;
  const { outcome, session } = view;
  const events: RunEvent[] = [];
  for (const warning of outcome?.warnings ?? []) {
    events.push({
      id: nextEventId(`warning-${spec.laneId}`),
      at: createdAt,
      level: "warn",
      type: "concurrent-shared-world.actor.warning",
      message: `Persona ${spec.laneId}: ${warning}`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  }

  if (session) {
    events.push({
      id: nextEventId(`session-${spec.laneId}`),
      at: createdAt,
      level: session.status === "passed" ? "info" : "warn",
      type: `concurrent-shared-world.session.${session.completionReason}`,
      message: `Persona ${spec.laneId}: ${session.status} — ${session.reason}`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  } else if (outcome?.sessionError) {
    events.push({
      id: nextEventId(`session-error-${spec.laneId}`),
      at: createdAt,
      level: "error",
      type: "concurrent-shared-world.session.error",
      message: `Persona ${spec.laneId}: ${outcome.sessionError}`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  } else if (inProgress) {
    events.push({
      id: nextEventId(`running-${spec.laneId}`),
      at: createdAt,
      level: "info",
      type: "actor.running",
      message: `Persona ${spec.laneId}: desktop actor is running; live stream URL is runtime-only and not persisted.`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  } else {
    events.push({
      id: nextEventId(`contract-${spec.laneId}`),
      at: createdAt,
      level: "info",
      type: "concurrent-shared-world.contract.ready",
      message: `Persona ${spec.laneId}: dry-run contract actor ready; switch scenario.mode to live for a real concurrent session.`,
      simId: spec.simId,
      streamId: spec.streamId,
    });
  }
  return events;
}

/** One seat's simulation, stream and events. */
export function seatRecords(
  ctx: SeatRecordContext,
  spec: CuaLaneSpec,
  index: number,
): { simulation: RunSimulation; stream: RunStream; events: RunEvent[] } {
  const view = seatView(ctx, spec, index);
  return {
    simulation: seatSimulation(ctx, spec, index, view),
    stream: seatStream(ctx, spec, index, view),
    events: seatEvents(ctx, spec, view),
  };
}
