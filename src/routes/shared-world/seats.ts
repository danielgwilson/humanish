// Builds each participant's actor spec and mission, resolves its entry URL, derives the session
// and sandbox time budgets, and records a follower that never received the host's lobby code.

import { pricedModel } from "../../lab/plan-base.js";
import { scrubPersonaBrief, type ResolvedPersona } from "../../lab/persona.js";
import type { SharedWorldPlan } from "../../lab/plan-types.js";
import type { Participant, SharedWorldParticipant } from "../../lab/plan-participants.js";
import { resolveParticipant } from "../../run/participant.js";
import { attachObserverRuntimeStreamUrls } from "../../observer/render.js";
import type { RunBundle } from "../../run/bundle.js";
import type { E2BDesktopSandbox } from "../../substrates/e2b/sdk.js";
import { composeParticipantInstructions } from "../computer-use/participant-prompt.js";
import { startLiveTraceFlush } from "../computer-use/live-flush.js";
import type {
  CuaActorLabHooks,
  CuaParticipantDeps,
  DesktopParticipantRun,
  ParticipantRunOutcome,
} from "../computer-use/types.js";
import type { LiveParticipants, PlaneContext, SharedWorldLabHooks } from "./types.js";
import { resolveCommittedPersonasForCwd } from "../../lab/persona-resolve.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { redactText } from "../../evidence/redaction.js";
import {
  MAX_SANDBOX_MS,
  SANDBOX_TIMEOUT_BUFFER_MS,
  SUBJECT_PROVISION_BUDGET_MS,
} from "../../substrates/e2b/lifetime.js";
import { DEFAULT_STATE_STEP_TIMEOUT_MS } from "../../subject/state.js";

// The DEFAULT per-seat session budget is DERIVED, not flat. On a provisioned route the binding
// constraint is the SUBJECT sandbox (it must outlive every seat: timeoutMs + provisioning +
// seeding + teardown buffer, and E2B refuses a sandbox over one hour), so the derivation hands
// each seat the most that cap allows — capped at 15 minutes, floored at the historical 300s so a
// seed-heavy lab never gets LESS room than it always had. App-url seats have no subject sandbox
// and default to 30 minutes (seat sandbox: 30m + 10m buffer stays well under the hour). An
// explicit execution.timeoutMs is never adjusted. The handoff latch scales off this (40%).
const MAX_DERIVED_SESSION_MS = 15 * 60_000;

const MIN_DERIVED_SESSION_MS = 300_000;

const DEFAULT_APP_URL_SESSION_MS = 30 * 60_000;

export function defaultSessionTimeoutMs(plan: SharedWorldPlan): number {
  if (plan.plane.kind !== "provisioned") return DEFAULT_APP_URL_SESSION_MS;
  const stateBudgetMs = (plan.plane.subject.state.seed ?? []).reduce(
    (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
    0,
  );
  const room =
    MAX_SANDBOX_MS - SUBJECT_PROVISION_BUDGET_MS - stateBudgetMs - SANDBOX_TIMEOUT_BUFFER_MS;
  return Math.max(MIN_DERIVED_SESSION_MS, Math.min(MAX_DERIVED_SESSION_MS, room));
}

const DEFAULT_MISSION =
  "You are one of MANY users hitting a shared web application at the same time. The browser is already open at the app. Accomplish your role's task, then stop.";

/** Resolve an actor's seat URL against the harness-minted getHost base (entry is a same-origin
 *  relative path, validated at parse against serve.url). */
export function resolveActorEntryUrl(baseUrl: string, entry: string | undefined): string {
  if (!entry) return baseUrl;
  try {
    return new URL(entry, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

export function participantTaxonomyLabel(labels: Participant["labels"]): string {
  const parts = [
    labels.actorType ? `type:${labels.actorType}` : undefined,
    labels.surface ? `surface:${labels.surface}` : undefined,
    labels.caseGroup ? `case:${labels.caseGroup}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` (${parts.join(" / ")})` : "";
}

/** Build one participant's DesktopParticipantRun from its plan (each participant has its own
 *  desktop, so its own device). */
function buildActorSpec(
  participant: SharedWorldParticipant,
  personas: Map<string, ResolvedPersona>,
): DesktopParticipantRun {
  const mission = participant.assignment.mission ?? DEFAULT_MISSION;
  const focus = participant.assignment.focus;
  const { device, personaId } = participant;
  const resolvedPersona = personaId === undefined ? undefined : personas.get(personaId);
  const composed = composeParticipantInstructions({
    mission,
    ...(personaId === undefined ? {} : { persona: personaId }),
    ...(resolvedPersona === undefined ? {} : { resolvedPersona }),
    ...(focus === undefined ? {} : { instruction: focus }),
    device: { name: device.name, preset: device.preset },
  });
  const run = resolveParticipant(participant, {
    persona: composed.persona,
    instructions: composed.instructions,
    evidenceAssignment: { mission, ...(focus === undefined ? {} : { focus }) },
  });
  return {
    ...run,
    screenshotDir: participant.id,
    traceArtifactPath: `actors/${run.streamId}.json`,
  };
}

/** Thread the host-yielded lobby CODE into a follower's mission at runtime (external-public route).
 *  The CODE flows into the follower's join instruction; it is persisted only as the composed prompt
 *  the model reads (never a raw bundle field), and the lab scrubs the CODE from all narration. The
 *  follower joins through the real UI (a direct /lobby/CODE visit does not auto-join a non-member). */
export function withLobbyCodeMission(
  spec: DesktopParticipantRun,
  code: string,
): DesktopParticipantRun {
  return {
    ...spec,
    instructions: `${spec.instructions}\n\nThe multiplayer lobby code is ${code}. On the home screen choose Join, enter this lobby code, enter your name, and submit to join the shared game (do not open a lobby URL directly — go through the Join flow).`,
  };
}

/** A follower blocked by an expired deadline or an ended host. It never opened a browser;
 * keep the actual reason rather than turning every upstream failure into a timeout. */
export function makeBlockedFollowerOutcome(
  spec: DesktopParticipantRun,
  reason: string,
  timedOut: boolean,
): ParticipantRunOutcome {
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

/** The computer-use runner deps every participant shares, on either plane. */
export type ParticipantRunDeps = Omit<
  CuaParticipantDeps,
  "signalProvisioned" | "appUrl" | "onObservedUrl"
>;

/**
 * A live run publishes an in-progress bundle before its seats start, whether or not an Observer
 * is attached, and the seats' live traces rewrite it as they go, as on the computer-use route. A
 * run killed mid-way leaves that evidence on disk. The flush starts with the first snapshot.
 */
export function startParticipantFlush(
  ctx: PlaneContext,
  live: LiveParticipants,
  bundle: RunBundle,
): void {
  live.flush = startLiveTraceFlush({
    bundle,
    participantRuns: ctx.actorSpecs,
    model: pricedModel(ctx.plan.brain),
    write: (snapshot) => ctx.run.writeSnapshot(snapshot),
  });
}

/**
 * The caller's desktop hooks, plus the runtime stream URLs each seat reports to the live Observer.
 * The Observer learns of a stream before the caller's stream hook runs.
 */
function runtimeStreamHooks(hooks: SharedWorldLabHooks, live: LiveParticipants): CuaActorLabHooks {
  return {
    ...(hooks.loadDesktopModule ? { loadDesktopModule: hooks.loadDesktopModule } : {}),
    ...(hooks.detachedTimers ? { detachedTimers: hooks.detachedTimers } : {}),
    ...(hooks.env ? { env: hooks.env } : {}),
    ...(hooks.prepareDesktop
      ? {
          prepareDesktop: (desktop: E2BDesktopSandbox, participant) =>
            hooks.prepareDesktop!(desktop, participant),
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
 * The runner deps both planes give every participant. The `shared-app` subject provisions nothing
 * and forwards no subject env, which keeps subject creds out of every actor sandbox (FIX-10).
 * `scrubKnownValues` is the plane's scrub: the external-public plane also scrubs the latched lobby
 * code.
 */
export function participantRunDeps(
  ctx: PlaneContext,
  live: LiveParticipants,
  scrubKnownValues: (text: string) => string,
): ParticipantRunDeps {
  const { config, descriptor, env, receiving, runBudget } = ctx;
  return {
    onTrace: (participantId, items, usage, metadata) =>
      live.flush?.flush(participantId, items, usage, metadata),
    config,
    descriptor,
    subject: { kind: "shared-app" },
    env,
    openaiApiKey: ctx.openaiApiKey,
    e2bApiKey: ctx.e2bApiKey,
    requestTimeoutMs: ctx.requestTimeoutMs,
    sandboxMs: ctx.timeoutMs + SANDBOX_TIMEOUT_BUFFER_MS,
    timeoutMs: ctx.timeoutMs,
    participantCount: ctx.plan.plane.participants.length,
    artifactRoot: ctx.runPaths,
    labCwd: ctx.cwd,
    redactScreenshots: ctx.redactScreenshots,
    scrubKnownValues,
    runSession: ctx.runSession,
    // A local-agent brain runs each seat on the operator's signed-in agent, as on computer use.
    brain: ctx.plan.brain,
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
 * Each participant's actor spec, with committed personas compiled in so each prompt carries real
 * behavioral directives (#381). Evidence copies of the assignment, instructions and persona are
 * scrubbed of the run's known secret values.
 */
export async function buildParticipantSpecs(
  participants: readonly SharedWorldParticipant[],
  cwd: string,
  scrubKnownValues: (text: string) => string,
): Promise<DesktopParticipantRun[]> {
  // Only the personas the participants use: an actors[0].persona that every seat overrides is
  // never applied, so it is not read.
  const personaResolution = await resolveCommittedPersonasForCwd(
    cwd,
    participants.map((participant) => participant.personaId),
  );
  const actorSpecs = participants.map((participant) =>
    buildActorSpec(participant, personaResolution.personas),
  );
  for (const spec of actorSpecs) {
    if (spec.evidenceAssignment)
      spec.evidenceAssignment = participantAssignment(spec.evidenceAssignment, scrubKnownValues);
    spec.evidenceInstructions = redactText(scrubKnownValues(spec.instructions));
    spec.persona = scrubPersonaBrief(spec.persona, scrubKnownValues);
  }
  return actorSpecs;
}
