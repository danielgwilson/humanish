// Builds each seat's lane spec and mission, resolves its entry URL, derives the session and
// sandbox time budgets, and records a follower that never received the host's lobby code.

import type { ResolvedPersona } from "../../lab/persona.js";
import { participantIdAt } from "../../lab/routing.js";
import type { LabActorLane, LabConfig } from "../../lab/types.js";
import { composeLaneInstructions, resolveLaneDevice } from "../computer-use/lane-plan.js";
import type { CuaLaneSpec, LaneRunOutcome } from "../computer-use/types.js";

// The DEFAULT per-seat session budget is DERIVED, not flat. On a provisioned route the binding
// constraint is the SUBJECT sandbox (it must outlive every seat: timeoutMs + provisioning +
// seeding + teardown buffer, and E2B refuses a sandbox over one hour), so the derivation hands
// each seat the most that cap allows — capped at 15 minutes, floored at the historical 300s so a
// seed-heavy lab never gets LESS room than it always had. App-url seats have no subject sandbox
// and default to 30 minutes (seat sandbox: 30m + 10m buffer stays well under the hour). An
// explicit execution.timeoutMs is never adjusted. The handoff latch scales off this (40%).
const MAX_SANDBOX_MS = 60 * 60_000;

const MAX_DERIVED_SEAT_SESSION_MS = 15 * 60_000;

const MIN_DERIVED_SEAT_SESSION_MS = 300_000;

const DEFAULT_APP_URL_SEAT_SESSION_MS = 30 * 60_000;

export function defaultSeatSessionTimeoutMs(config: LabConfig): number {
  const provisionedRoute =
    config.subject.source === "clone" || config.subject.source === "local-tree";
  if (!provisionedRoute) return DEFAULT_APP_URL_SEAT_SESSION_MS;
  const stateBudgetMs = (config.subject.state?.seed ?? []).reduce(
    (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
    0,
  );
  const room =
    MAX_SANDBOX_MS - SUBJECT_PROVISION_BUDGET_MS - stateBudgetMs - SANDBOX_TIMEOUT_BUFFER_MS;
  return Math.max(MIN_DERIVED_SEAT_SESSION_MS, Math.min(MAX_DERIVED_SEAT_SESSION_MS, room));
}

export const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;

export const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;

export const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_MISSION =
  "You are one of MANY users hitting a shared web application at the same time. The browser is already open at the app. Accomplish your role's task, then stop.";

/** Resolve an actor's seat URL against the harness-minted getHost base (entry is a same-origin
 *  relative path, validated at parse against serve.url). */
export function resolveActorSeatUrl(baseUrl: string, entry: string | undefined): string {
  if (!entry) return baseUrl;
  try {
    return new URL(entry, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

export function laneTaxonomyLabel(
  spec: Pick<CuaLaneSpec, "actorType" | "surface" | "caseGroup">,
): string {
  const parts = [
    spec.actorType ? `type:${spec.actorType}` : undefined,
    spec.surface ? `surface:${spec.surface}` : undefined,
    spec.caseGroup ? `case:${spec.caseGroup}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` (${parts.join(" / ")})` : "";
}

/** Build one actor lane's CuaLaneSpec from a roster role (per-actor device IS honored here — each
 *  actor has its OWN desktop). */
export function buildActorSpec(
  config: LabConfig,
  role: LabActorLane,
  index: number,
  personas: Map<string, ResolvedPersona>,
): CuaLaneSpec {
  const mission = config.actors[0]?.mission ?? DEFAULT_MISSION;
  const device = resolveLaneDevice(config, role);
  // A seat without its own persona takes actors[0].persona, as independent lanes do.
  const personaId = role.persona ?? config.actors[0]?.persona;
  const resolvedPersona = personaId === undefined ? undefined : personas.get(personaId);
  const composed = composeLaneInstructions({
    mission,
    ...(personaId === undefined ? {} : { persona: personaId }),
    ...(resolvedPersona === undefined ? {} : { resolvedPersona }),
    ...(role.instruction === undefined ? {} : { instruction: role.instruction }),
    device: { name: device.name, preset: device.preset },
  });
  const roleId = participantIdAt(index, role.id, "seat");
  const streamId = `stream-${String(index + 1).padStart(3, "0")}`;
  return {
    laneId: roleId,
    ...(role.actorType === undefined ? {} : { actorType: role.actorType }),
    ...(role.surface === undefined ? {} : { surface: role.surface }),
    ...(role.caseGroup === undefined ? {} : { caseGroup: role.caseGroup }),
    laneIndex: index,
    simId: `sim-${String(index + 1).padStart(3, "0")}`,
    streamId,
    persona: composed.persona,
    instructions: composed.instructions,
    assignment: { mission, ...(role.instruction === undefined ? {} : { focus: role.instruction }) },
    ...((role.reasoningEffort ?? config.actors[0]?.reasoningEffort) === undefined
      ? {}
      : { reasoningEffort: (role.reasoningEffort ?? config.actors[0]?.reasoningEffort)! }),
    ...(config.actors[0]?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: config.actors[0].maxOutputTokens }),
    ...((role.stopWhen ?? config.actors[0]?.stopWhen) === undefined
      ? {}
      : { stopWhen: (role.stopWhen ?? config.actors[0]?.stopWhen)! }),
    ...((role.dwell ?? config.actors[0]?.dwell) === undefined
      ? {}
      : { dwell: (role.dwell ?? config.actors[0]?.dwell)! }),
    deviceName: device.name,
    devicePreset: device.preset,
    resolution: device.resolution,
    screenshotDir: roleId,
    traceArtifactPath: `actors/${streamId}.json`,
  };
}

/** Thread the host-yielded lobby CODE into a follower's mission at runtime (external-public route).
 *  The CODE flows into the follower's join instruction; it is persisted only as the composed prompt
 *  the model reads (never a raw bundle field), and the lab scrubs the CODE from all narration. The
 *  follower joins through the real UI (a direct /lobby/CODE visit does not auto-join a non-member). */
export function withLobbyCodeMission(spec: CuaLaneSpec, code: string): CuaLaneSpec {
  return {
    ...spec,
    instructions: `${spec.instructions}\n\nThe multiplayer lobby code is ${code}. On the home screen choose Join, enter this lobby code, enter your name, and submit to join the shared game (do not open a lobby URL directly — go through the Join flow).`,
  };
}

/** A follower blocked by an expired deadline or an ended host. It never opened a browser;
 * keep the actual reason rather than turning every upstream failure into a timeout. */
export function makeBlockedFollowerOutcome(
  spec: CuaLaneSpec,
  reason: string,
  timedOut: boolean,
): LaneRunOutcome {
  return {
    spec,
    sessionError: `handoff barrier: ${reason}; this follower failed closed WITHOUT opening (no wasted turns).`,
    killed: false,
    streamUrlPresent: false,
    screenshots: [],
    stateStepRecords: [],
    phaseRecords: [],
    warnings: [],
    noEngagement: true,
    selfReportedBlocker: false,
    harnessError: false,
    skippedReason: timedOut ? "handoff-timeout" : "host-ended-before-handoff",
  };
}
