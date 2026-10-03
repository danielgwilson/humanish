// One scripted-browser surface's simulation and stream in the run bundle.

import type { ActorPersonaRef } from "../../actors/contract.js";
import type { ScriptedBrowserSessionResult } from "../../actors/scripted-browser/actor.js";
import type { BrowserPersonaJourney, BrowserSurface } from "../../actors/scripted-browser/types.js";
import type { RunSimulation } from "../../run/bundle.js";
import {
  participantIdsOf,
  participantRecord,
  participantStream,
  type ParticipantIds,
} from "../../run/participant-records.js";
import type { RunStream } from "../../run/streams.js";

/** What each surface's records read from the bundle arguments. */
export interface ScriptedSurfaceContext {
  actorId: string;
  appUrl: string;
  createdAt: string;
  journey: BrowserPersonaJourney;
  studyId: string;
  persona: ActorPersonaRef;
  sessionError?: string;
}

/** A surface's saved ids: `scripted-<surface>` and its `-stream`. */
export function scriptedSurfaceIds(surfaceId: string): ParticipantIds {
  return participantIdsOf(`scripted-${surfaceId}`, `scripted-${surfaceId}-stream`);
}

/**
 * The simulation and stream for one surface. `result` is absent on a dry run, and on a live run
 * whose harness failed before the surface's session returned.
 */
export function scriptedSurfaceRecords(
  context: ScriptedSurfaceContext,
  surface: BrowserSurface,
  index: number,
  result: ScriptedBrowserSessionResult | undefined,
  screenshots: string[],
): { simulation: RunSimulation; stream: RunStream } {
  const ids = scriptedSurfaceIds(surface.id);
  const lastScreenshot = screenshots.at(-1);
  const status = result
    ? result.status
    : context.sessionError !== undefined
      ? ("failed" as const)
      : ("contract_proof_only" as const);
  const reason =
    result?.reason ??
    context.sessionError ??
    "Dry run: the scenario was pinned without launching a browser or touching the subject app.";

  const simulation = participantRecord(ids, index + 1, {
    personaId: context.persona.id,
    scenarioId: context.journey.scenarioId,
    status,
    streamKind: "browser",
    mode: "browser-sim",
    progress: 100,
    currentStep: reason,
    summary: result
      ? `Scripted-browser actor (${context.actorId}) replayed ${context.journey.scenarioId} on the ${surface.id} surface; ${result.completionReason}.`
      : context.sessionError !== undefined
        ? `The scripted run failed before a terminal session verdict: ${context.sessionError}`
        : `Scripted-browser actor (${context.actorId}) against ${context.appUrl}; no session ran.`,
    startedAt: context.createdAt,
    updatedAt: result?.capture.capturedAt ?? context.createdAt,
  });

  const stream = participantStream(ids, {
    kind: "browser",
    label: `${surface.label} · ${context.studyId}`,
    status,
    transport: "snapshot",
    updatedAt: result?.capture.capturedAt ?? context.createdAt,
    embed: lastScreenshot
      ? { kind: "screenshot", url: `../${lastScreenshot}`, title: `${surface.label} (raw)` }
      : { kind: "placeholder", title: surface.label },
    // Real emulated viewport: isMobile/deviceScaleFactor genuinely render on this route
    // (playwright emulation), unlike the e2b-desktop route's prompt-signal-only fidelity.
    viewport: surface.viewport,
    ui: {
      route: context.appUrl,
      intent: context.journey.goal,
      state: reason,
      ...(result ? { actorStatus: result.status } : {}),
      ...(lastScreenshot ? { screenshotUrl: `../${lastScreenshot}` } : {}),
    },
    // The seam this registration exists to fill: the provider-neutral actor evidence.
    ...(result ? { actor: result.trace } : {}),
    artifacts: surfaceArtifacts(surface, result, screenshots),
  });
  return { simulation, stream };
}

function surfaceArtifacts(
  surface: BrowserSurface,
  result: ScriptedBrowserSessionResult | undefined,
  screenshots: string[],
): RunStream["artifacts"] {
  return [
    { label: "run bundle", path: "run.json", kind: "bundle" as const },
    { label: "review", path: "review.md", kind: "review" as const },
    { label: "events", path: "events.ndjson", kind: "events" as const },
    ...(result
      ? [
          {
            label: `${surface.id} browser trace`,
            path: result.capture.tracePath,
            kind: "trace" as const,
          },
          {
            label: `${surface.id} actor trace`,
            path: `actor-${surface.id}.json`,
            kind: "trace" as const,
          },
        ]
      : []),
    ...screenshots.map((screenshot, screenshotIndex) => ({
      label: `${surface.id} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (raw)`,
      path: screenshot,
      kind: "screenshot" as const,
    })),
  ];
}
