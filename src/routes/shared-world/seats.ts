// Builds each seat's lane spec and mission, resolves its entry URL, derives the session and
// sandbox time budgets, and records a follower that never received the host's lobby code.

import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { scrubPersonaBrief, type ResolvedPersona } from "../../lab/persona.js";
import { participantIdAt } from "../../lab/routing.js";
import type { SharedWorldPlan } from "../../lab/plan-types.js";
import type { LabActorLane, LabConfig } from "../../lab/types.js";
import { attachObserverRuntimeStreamUrls } from "../../observer/render.js";
import type { RunBundle } from "../../run/bundle.js";
import type { E2BDesktopSandbox } from "../../substrates/e2b/sdk.js";
import { resolveLaneDevice } from "../../lab/device-presets.js";
import { composeLaneInstructions } from "../computer-use/lane-plan.js";
import { startLiveTraceFlush } from "../computer-use/live-flush.js";
import type {
  CuaActorLabHooks,
  CuaLaneDeps,
  CuaLaneSpec,
  LaneRunOutcome,
} from "../computer-use/types.js";
import type { LiveSeats, PlaneContext, SharedWorldLabHooks } from "./types.js";
import { labPersonaIds, resolveCommittedPersonasForCwd } from "../../lab/persona-resolve.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { redactText } from "../../evidence/redaction.js";

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

export function defaultSeatSessionTimeoutMs(plan: SharedWorldPlan): number {
  if (plan.plane.kind !== "provisioned") return DEFAULT_APP_URL_SEAT_SESSION_MS;
  const stateBudgetMs = (plan.plane.subject.state.seed ?? []).reduce(
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
function buildActorSpec(
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

/** The lane deps every seat shares, on either plane. */
export type SeatLaneDeps = Omit<CuaLaneDeps, "signalProvisioned" | "appUrl" | "onObservedUrl">;

/**
 * A live run publishes an in-progress bundle before its seats start, whether or not an Observer
 * is attached, and the seats' live traces rewrite it as they go, as on the computer-use route. A
 * run killed mid-way leaves that evidence on disk. The flush starts with the first snapshot.
 */
export function startSeatFlush(ctx: PlaneContext, live: LiveSeats, bundle: RunBundle): void {
  live.flush = startLiveTraceFlush({
    bundle,
    laneSpecs: ctx.actorSpecs,
    model: ctx.config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL,
    write: (snapshot) => ctx.run.writeSnapshot(snapshot),
  });
}

/**
 * The caller's desktop hooks, plus the runtime stream URLs each seat reports to the live Observer.
 * The Observer learns of a stream before the caller's stream hook runs.
 */
function runtimeStreamHooks(hooks: SharedWorldLabHooks, live: LiveSeats): CuaActorLabHooks {
  return {
    ...(hooks.loadDesktopModule ? { loadDesktopModule: hooks.loadDesktopModule } : {}),
    ...(hooks.detachedTimers ? { detachedTimers: hooks.detachedTimers } : {}),
    ...(hooks.env ? { env: hooks.env } : {}),
    ...(hooks.prepareDesktop
      ? {
          prepareDesktop: (desktop: E2BDesktopSandbox, lane) =>
            hooks.prepareDesktop!(desktop, lane),
        }
      : {}),
    onRuntimeStreamReady: (stream) => {
      live.streamUrls.push({ streamId: stream.streamId, url: stream.url });
      if (live.observer) {
        attachObserverRuntimeStreamUrls(live.observer, live.streamUrls);
      }
      return hooks.onRuntimeStreamReady?.(stream);
    },
    onRuntimeStreamEnded: (stream) => {
      // Mark, never remove (#357): the tile falls back to recorded evidence and says why.
      for (const entry of live.streamUrls) {
        if (entry.streamId === stream.streamId) entry.ended = true;
      }
      if (live.observer) {
        attachObserverRuntimeStreamUrls(live.observer, live.streamUrls);
      }
      return hooks.onRuntimeStreamEnded?.(stream);
    },
  };
}

/**
 * The lane deps both planes give every seat. cloneRoute=false + subjectEnvNames=[] keep subject
 * creds out of every actor sandbox (FIX-10). `scrubKnownValues` is the plane's scrub: the
 * external-public plane also scrubs the latched lobby code.
 */
export function seatLaneDeps(
  ctx: PlaneContext,
  live: LiveSeats,
  scrubKnownValues: (text: string) => string,
): SeatLaneDeps {
  const { config, descriptor, env, receiving, runBudget } = ctx;
  return {
    onTrace: (laneId, items, usage, metadata) => live.flush?.flush(laneId, items, usage, metadata),
    config,
    descriptor,
    cloneRoute: false,
    subjectEnvNames: [],
    hasGithubToken: false,
    env,
    openaiApiKey: ctx.openaiApiKey,
    e2bApiKey: ctx.e2bApiKey,
    requestTimeoutMs: ctx.requestTimeoutMs,
    perLaneSandboxMs: ctx.timeoutMs + SANDBOX_TIMEOUT_BUFFER_MS,
    timeoutMs: ctx.timeoutMs,
    laneCount: ctx.roles.length,
    artifactRoot: ctx.runPaths,
    labCwd: ctx.cwd,
    redactScreenshots: ctx.redactScreenshots,
    scrubKnownValues,
    runSession: ctx.runSession,
    ...(receiving ? { receiving } : {}),
    now: ctx.now,
    hooks: runtimeStreamHooks(ctx.hooks, live),
    ...(runBudget === undefined ? {} : { runBudget }),
    // Concurrent lanes are independent evidence seats: a requested-vs-verified screen
    // mismatch is recorded as separate facts + a warning instead of failing the lane's
    // device claim closed, so one seat's window-manager drift cannot abort the whole
    // live multi-actor world (the single-lane/fan-out routes keep fail-closed).
    screenMismatchPolicy: "record-evidence",
  };
}

/**
 * Each seat's lane spec, with committed personas compiled in so each seat's prompt carries real
 * behavioral directives (#381). Evidence copies of the assignment, instructions and persona are
 * scrubbed of the run's known secret values.
 */
export async function buildSeatSpecs(
  config: LabConfig,
  roles: LabActorLane[],
  cwd: string,
  scrubKnownValues: (text: string) => string,
): Promise<CuaLaneSpec[]> {
  const personaResolution = await resolveCommittedPersonasForCwd(cwd, labPersonaIds(config));
  const actorSpecs = roles.map((role, i) =>
    buildActorSpec(config, role, i, personaResolution.personas),
  );
  for (const spec of actorSpecs) {
    if (spec.assignment) spec.assignment = participantAssignment(spec.assignment, scrubKnownValues);
    spec.evidenceInstructions = redactText(scrubKnownValues(spec.instructions));
    spec.persona = scrubPersonaBrief(spec.persona, scrubKnownValues);
  }
  return actorSpecs;
}
