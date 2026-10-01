// Translation module: legacy lane spellings stay only in modules like this one, so the rest of the
// route reads participants. CuaActorLabHooks is public API in the deprecated compatibility section, and two of its hooks,
// buildProvider and createDesktopLane, receive a lane. They keep receiving this flat record until
// the next minor removes the section. Internally a lane is a DesktopParticipantRun.

import type { ActorPersonaRef } from "../../actors/contract.js";
import type { ReasoningEffort } from "../../actors/reasoning-effort.js";
import type { DwellWindow, StopWhen } from "../../actors/stop-conditions.js";
import type { DevicePreset } from "../../lab/device-presets.js";
import type { LabTask } from "../../lab/tasks.js";
import type { RunStream } from "../../run/streams.js";
import type { DesktopParticipantRun } from "./types.js";

/**
 * A lane as the deprecated cuaHooks.buildProvider and cuaHooks.createDesktopLane receive it: a flat
 * copy of a DesktopParticipantRun.
 * @deprecated Use RunLabOptions.createProvider, which receives a ParticipantRef. Removed with the
 * compatibility section in the next minor.
 */
export interface CuaLaneSpec {
  laneId: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  /** 0-based. */
  laneIndex: number;
  simId: string;
  streamId: string;
  persona: ActorPersonaRef;
  instructions: string;
  /** Redacted original composed prompt for legacy study context; execution uses instructions. */
  evidenceInstructions?: string;
  /** Original declarative assignment, separate from runtime-composed instructions. */
  assignment?: RunStream["assignment"];
  /** App-url fan-out only: this lane's explicit browser target; absent falls back to deps.appUrl. */
  targetUrl?: string;
  /** Deterministic harness-owned completion guard. Lane-level override, else actor default. */
  stopWhen?: StopWhen;
  /** A declared observation window (#510). Lane-level override, else actor default. */
  dwell?: DwellWindow;
  /**
   * How hard this lane's model is asked to think. Lane-level override, else the actor default,
   * else absent — and absent means the provider's own default, which the trace records as the
   * resolved value rather than as nothing (#497).
   */
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** The lab's declared protocol (#414). Every lane runs the SAME protocol — that is what makes the
   *  per-task rates comparable across participants. Goals are already composed into `instructions`;
   *  this carries the full tasks so the loop can corroborate completion, and the criteria never
   *  reach the prompt. */
  tasks?: readonly LabTask[];
  /** Per-lane override of the CUA idle backstop (consecutive screenshot/wait turns before gave_up).
   *  Absent falls back to the loop default. Raised for a lane whose job includes a long LEGITIMATE
   *  wait (e.g. a shared-world HOST idling in the waiting room while followers provision + join). */
  idleSteps?: number;
  /** Per-lane override of the non-idle no-progress backstop; see idleSteps. */
  noProgressSteps?: number;
  deviceName: string;
  devicePreset: DevicePreset;
  resolution: [number, number];
  /** "" for N=1 (screenshots/<name>); the laneId for N>1 (screenshots/<laneId>/<name>). */
  screenshotDir: string;
  /** "actor.json" for N=1; "actors/<streamId>.json" for N>1. */
  traceArtifactPath: string;
}

/** The flat hook view of one participant run. Called only where a caller's hook receives a lane. */
export function legacyHookSpecOf(run: DesktopParticipantRun): CuaLaneSpec {
  const { planned } = run;
  const { labels, limits, device } = planned;
  return {
    laneId: planned.id,
    ...(labels.actorType === undefined ? {} : { actorType: labels.actorType }),
    ...(labels.surface === undefined ? {} : { surface: labels.surface }),
    ...(labels.caseGroup === undefined ? {} : { caseGroup: labels.caseGroup }),
    laneIndex: planned.index,
    simId: run.simId,
    streamId: run.streamId,
    persona: run.persona,
    instructions: run.instructions,
    ...(run.evidenceInstructions === undefined
      ? {}
      : { evidenceInstructions: run.evidenceInstructions }),
    ...(run.evidenceAssignment === undefined ? {} : { assignment: run.evidenceAssignment }),
    ...(planned.targetUrl === undefined ? {} : { targetUrl: planned.targetUrl }),
    ...(limits.stopWhen === undefined ? {} : { stopWhen: limits.stopWhen }),
    ...(limits.dwell === undefined ? {} : { dwell: limits.dwell }),
    ...(limits.reasoningEffort === undefined ? {} : { reasoningEffort: limits.reasoningEffort }),
    ...(limits.maxOutputTokens === undefined ? {} : { maxOutputTokens: limits.maxOutputTokens }),
    ...(planned.tasks === undefined ? {} : { tasks: planned.tasks }),
    ...(run.backstop?.idleSteps === undefined ? {} : { idleSteps: run.backstop.idleSteps }),
    ...(run.backstop?.noProgressSteps === undefined
      ? {}
      : { noProgressSteps: run.backstop.noProgressSteps }),
    deviceName: device.name,
    devicePreset: device.preset,
    resolution: device.resolution,
    screenshotDir: run.screenshotDir,
    traceArtifactPath: run.traceArtifactPath,
  };
}
