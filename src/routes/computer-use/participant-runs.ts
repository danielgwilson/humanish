// The participant runs a computer-use lab drives, built before anything is created: the sandbox
// and session budgets, the concurrency bound, each participant's prompt, bundle ids and artifact
// paths, and the public plan printed before any sandbox or provider call. loadCuaParticipants
// compiles the committed personas first and narrows a rerun to its selected participants.

import {
  isLocalBrowserLab,
  LOCAL_BROWSER_LIFETIME_MS,
} from "../../substrates/local/runtime-config.js";
import { DEFAULT_STATE_STEP_TIMEOUT_MS } from "../../subject/state.js";
import {
  computerUseParticipants,
  type ComputerUseParticipant,
} from "../../lab/plan-participants.js";
import type { ComputerUsePlan } from "../../lab/plan-types.js";
import { resolveParticipant } from "../../run/participant.js";
import { type LabConfig } from "../../lab/types.js";
import { scrubPersonaBrief, type ResolvedPersona } from "../../lab/persona.js";
import { redactText } from "../../evidence/redaction.js";
import { type RunRerunLineage } from "../../run/bundle.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { resolveCommittedPersonas } from "../../lab/persona-resolve.js";
import type { PreparedSelectedOutputDirectory } from "../../run/contained-output.js";
import {
  CUA_FANOUT_STRATEGY,
  CUA_MAX_CONCURRENCY_ENV,
  type CuaActorLabErrorCode,
  type CuaParticipantPlan,
  type CuaParticipantPlanEntry,
  type DesktopParticipantRun,
  DEFAULT_APP_URL_SESSION_TIMEOUT_MS,
  type ParticipantRunsAndPlan,
  MIN_DERIVED_SESSION_TIMEOUT_MS,
} from "./types.js";
import {
  MAX_SANDBOX_MS,
  SANDBOX_TIMEOUT_BUFFER_MS,
  SUBJECT_PROVISION_BUDGET_MS,
} from "../../substrates/e2b/lifetime.js";
import { readPositiveInt } from "../../lab/parse/values.js";
import { digestUrl } from "./bundle-parts.js";
import { composeParticipantInstructions, DEFAULT_MISSION } from "./participant-prompt.js";
import { resolveCuaRerunSelection } from "./rerun-selection.js";

export function defaultSessionTimeoutMs(config: LabConfig): number {
  const provisionedRoute =
    config.subject.source === "clone" || config.subject.source === "local-tree";
  if (!provisionedRoute) return DEFAULT_APP_URL_SESSION_TIMEOUT_MS;
  const stateBudgetMs = (config.subject.state?.seed ?? []).reduce(
    (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
    0,
  );
  const room =
    MAX_SANDBOX_MS - SUBJECT_PROVISION_BUDGET_MS - stateBudgetMs - SANDBOX_TIMEOUT_BUFFER_MS;
  return Math.max(
    MIN_DERIVED_SESSION_TIMEOUT_MS,
    Math.min(DEFAULT_APP_URL_SESSION_TIMEOUT_MS, room),
  );
}

/** Per-lane sandbox deadline (each lane owns its own desktop). Mirrors the single-lane formula
 *  verbatim so N=1 stays byte-stable: explicit sandboxTimeoutMs, else session budget + (clone
 *  or local-tree: provision budget + Σ state-step budgets) + the server-side
 *  reclamation buffer. Local-tree shares the clone route's provisioning budget: it swaps a
 *  git clone for an upload+extract, but the shared install/build/state/start/probe pipeline
 *  costs the same wall-clock room either way. */
export function resolveParticipantSandboxMs(config: LabConfig): number {
  if (isLocalBrowserLab(config)) return LOCAL_BROWSER_LIFETIME_MS;
  const timeoutMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
  const provisionedRoute =
    config.subject.source === "clone" || config.subject.source === "local-tree";
  const stateBudgetMs = provisionedRoute
    ? (config.subject.state?.seed ?? []).reduce(
        (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
        0,
      )
    : 0;
  return (
    config.execution?.desktop?.sandboxTimeoutMs ??
    timeoutMs +
      (provisionedRoute ? SUBJECT_PROVISION_BUDGET_MS + stateBudgetMs : 0) +
      SANDBOX_TIMEOUT_BUFFER_MS
  );
}

/**
 * The in-flight participant bound a lab declares. Defaults to the participant count — every
 * declared participant runs at once, because a throttle nobody asked for silently turns "N actors
 * live" into waves (#350); total session count and spend are the same either way, only wall-clock
 * and simultaneity differ. A declared execution.concurrency is a CAP, clamped to [1, participants].
 * The planner records it; the route may only lower it from the environment.
 */
export function boundedConcurrency(declared: number | undefined, participantCount: number): number {
  return Math.max(
    1,
    declared === undefined ? participantCount : Math.min(Math.max(1, declared), participantCount),
  );
}

/**
 * The planned bound, lowered by the env override. The override may only LOWER it (never raise
 * concurrent paid desktops — invariant 3), and a lowering is reported via envLoweredFrom so the
 * plan never silently disagrees with the manifest.
 */
function envLoweredConcurrency(
  planned: number,
  participantCount: number,
  env: Record<string, string | undefined>,
): { bound: number; envLoweredFrom?: number } {
  const envLower = readPositiveInt(env[CUA_MAX_CONCURRENCY_ENV], 0);
  if (envLower > 0 && envLower < planned) {
    return {
      bound: Math.max(1, Math.min(planned, envLower, participantCount)),
      envLoweredFrom: planned,
    };
  }
  return { bound: planned };
}

/** What the participant table is built from: the plan's participants, bound and budgets. */
interface PlannedParticipants {
  readonly participants: readonly ComputerUseParticipant[];
  readonly concurrency: number;
  readonly sessionBudgetMs: number;
  readonly sandboxMs: number;
  /** A desktop-cli subject gives each prompt the terminal-surface wording. */
  readonly desktopCli: boolean;
}

/** The same inputs from a config, for callers that have no plan. */
function plannedParticipantsOf(config: LabConfig, countOverride?: number): PlannedParticipants {
  const participants = computerUseParticipants(config, countOverride);
  return {
    participants,
    concurrency: boundedConcurrency(config.execution?.concurrency, participants.length),
    sessionBudgetMs: config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config),
    sandboxMs: resolveParticipantSandboxMs(config),
    desktopCli: config.subject.source === "desktop-cli",
  };
}

/** Build the participant runs AND the public plan from the planned participants (pure). */
function participantRunsAndPlan(
  planned: PlannedParticipants,
  opts: {
    env?: Record<string, string | undefined>;
    dryRun?: boolean;
    personas?: Map<string, ResolvedPersona>;
  } = {},
): ParticipantRunsAndPlan {
  const env = opts.env ?? {};
  // Who each participant is (id, persona, focus, device, limits) comes from the plan; this adds
  // what the route derives from it: the prompt, bundle ids and artifact paths.
  const { participants } = planned;
  const participantCount = participants.length;

  const runs: DesktopParticipantRun[] = participants.map((participant) => {
    const mission = participant.assignment.mission ?? DEFAULT_MISSION;
    const focus = participant.assignment.focus;
    const tasks = participant.tasks;
    const { device, personaId } = participant;
    const resolvedPersona = personaId === undefined ? undefined : opts.personas?.get(personaId);
    const composed = composeParticipantInstructions({
      mission,
      ...(tasks === undefined ? {} : { tasks }),
      ...(personaId === undefined ? {} : { persona: personaId }),
      ...(resolvedPersona === undefined ? {} : { resolvedPersona }),
      ...(focus === undefined ? {} : { instruction: focus }),
      device: { name: device.name, preset: device.preset },
      ...(planned.desktopCli ? { surface: "desktop-cli" as const } : {}),
    });
    const run = resolveParticipant(participant, {
      persona: composed.persona,
      instructions: composed.instructions,
      evidenceAssignment: {
        mission,
        ...(focus === undefined ? {} : { focus }),
        ...(tasks === undefined ? {} : { tasks: tasks.map(({ id, goal }) => ({ id, goal })) }),
      },
    });
    return {
      ...run,
      screenshotDir: participantCount === 1 ? "" : participant.id,
      traceArtifactPath: participantCount === 1 ? "actor.json" : `actors/${run.streamId}.json`,
    };
  });

  const resolved = envLoweredConcurrency(planned.concurrency, participantCount, env);
  const concurrency = resolved.bound;
  const { sessionBudgetMs, sandboxMs } = planned;
  const participantPlan: CuaParticipantPlan = {
    strategy: CUA_FANOUT_STRATEGY,
    laneCount: participantCount,
    concurrency,
    ...(resolved.envLoweredFrom === undefined
      ? {}
      : { envLoweredConcurrencyFrom: resolved.envLoweredFrom }),
    waves: Math.ceil(participantCount / concurrency),
    perLaneSessionBudgetMs: sessionBudgetMs,
    worstCaseSandboxMinutes: Math.round((participantCount * sandboxMs) / 60_000),
    dryRun: opts.dryRun === true,
    lanes: runs.map((spec) => ({
      id: spec.planned.id,
      ...(spec.planned.labels.actorType === undefined
        ? {}
        : { actorType: spec.planned.labels.actorType }),
      ...(spec.planned.labels.surface === undefined
        ? {}
        : { surface: spec.planned.labels.surface }),
      ...(spec.planned.labels.caseGroup === undefined
        ? {}
        : { caseGroup: spec.planned.labels.caseGroup }),
      index: spec.planned.index + 1,
      persona: spec.persona.id,
      device: spec.planned.device.name,
      resolution: spec.planned.device.resolution,
      instructionDigest: spec.persona.promptDigest,
      ...(spec.planned.limits.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: spec.planned.limits.reasoningEffort }),
      ...(spec.planned.limits.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: spec.planned.limits.maxOutputTokens }),
      ...(spec.planned.targetUrl === undefined
        ? {}
        : { targetDigest: digestUrl(spec.planned.targetUrl) }),
    })),
  };
  return { runs, participantPlan };
}

/**
 * Pure pre-flight plan resolver (runs in dry-run AND live). Returns the lane table, the
 * effective concurrency, the wave count, the per-lane session budget, and the worst-case total
 * sandbox-minutes — BEFORE any sandbox or provider call. The same plan appears in dry-run,
 * marked $0 (dryRun: true).
 */
export function resolveCuaParticipantPlan(
  config: LabConfig,
  opts: {
    countOverride?: number;
    env?: Record<string, string | undefined>;
    dryRun?: boolean;
    personas?: Map<string, ResolvedPersona>;
  } = {},
): CuaParticipantPlan {
  const { countOverride, ...rest } = opts;
  return participantRunsAndPlan(plannedParticipantsOf(config, countOverride), rest).participantPlan;
}

/** Print the lane plan to stderr BEFORE any sandbox/provider call (public-safe: ids, devices,
 *  digests, and budgets only — no prompt text, no secrets). */
export function emitPreflightPlan(participantPlan: CuaParticipantPlan, labId: string): void {
  const lines: string[] = [];
  lines.push(
    `humanish computer-use fan-out plan (${labId}): ${participantPlan.laneCount} participant(s), strategy ${participantPlan.strategy}, concurrency ${participantPlan.concurrency}${participantPlan.envLoweredConcurrencyFrom === undefined ? "" : ` (lowered from ${participantPlan.envLoweredConcurrencyFrom} by ${CUA_MAX_CONCURRENCY_ENV})`}, ${participantPlan.waves} wave(s).`,
  );
  lines.push(
    `  session budget ${Math.round(participantPlan.perLaneSessionBudgetMs / 1000)}s per participant; worst-case ~${participantPlan.worstCaseSandboxMinutes} sandbox-minutes total${participantPlan.dryRun ? " (dry-run: $0)" : ""}.`,
  );
  for (const entry of participantPlan.lanes) {
    lines.push(`  - ${formatParticipantPlanEntry(entry)}`);
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

export function formatParticipantPlanEntry(entry: CuaParticipantPlanEntry): string {
  const taxonomy = [
    entry.actorType ? `type=${entry.actorType}` : undefined,
    entry.surface ? `surface=${entry.surface}` : undefined,
    entry.caseGroup ? `case=${entry.caseGroup}` : undefined,
    entry.reasoningEffort ? `effort=${entry.reasoningEffort}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${entry.id}: persona=${entry.persona}${taxonomy.length > 0 ? ` ${taxonomy.join(" ")}` : ""} device=${entry.device} ${entry.resolution[0]}x${entry.resolution[1]} prompt#${entry.instructionDigest}${entry.targetDigest ? ` target#${entry.targetDigest}` : ""}`;
}

/**
 * Compile the committed persona files the participants use, printing a warning for each one that
 * is missing. A refusal that comes after this step reads them first, so a persona-file error still
 * wins over it.
 */
export async function compileParticipantPersonas(
  projectRoot: PreparedSelectedOutputDirectory,
  personaIds: readonly (string | undefined)[],
): Promise<Map<string, ResolvedPersona>> {
  const resolution = await resolveCommittedPersonas(projectRoot, personaIds);
  for (const warning of resolution.warnings) {
    process.stderr.write(`humanish: ${warning}\n`);
  }
  return resolution.personas;
}

/**
 * The participants a computer-use run drives, loaded before anything is created: committed persona
 * files read and compiled, the pure participant table built from the plan's participants, bound
 * and budgets (the same for dry-run and live), and a rerun narrowed to its selected participants
 * by reading the source run.
 */
export async function loadCuaParticipants(args: {
  plan: ComputerUsePlan;
  cwd: string;
  projectRoot: PreparedSelectedOutputDirectory;
  env: Record<string, string | undefined>;
}): Promise<
  | {
      ok: true;
      participantRuns: DesktopParticipantRun[];
      participantPlan: CuaParticipantPlan;
      rerunLineage?: RunRerunLineage;
    }
  | { ok: false; code: CuaActorLabErrorCode; message: string }
> {
  const { plan } = args;
  const { participants } = plan.runner;
  // Compile any committed personas BEFORE planning, so the plan builder stays pure and each lane's
  // prompt carries real behavioral directives rather than a bare `Persona: <id>.` label (#381).
  const personas = await compileParticipantPersonas(
    args.projectRoot,
    participants.map((participant) => participant.personaId),
  );
  const { runs: participantRuns, participantPlan } = participantRunsAndPlan(
    {
      participants,
      concurrency: plan.concurrency,
      sessionBudgetMs: plan.sessionBudgetMs,
      sandboxMs: plan.sandboxMs,
      desktopCli: plan.runner.subject.kind === "desktop-cli",
    },
    { env: args.env, dryRun: plan.dryRun, personas },
  );
  const rerun = plan.rerun;
  if (!rerun) return { ok: true, participantRuns, participantPlan };

  const selected = await resolveCuaRerunSelection({
    cwd: args.cwd,
    labId: plan.labId,
    sandboxMs: plan.sandboxMs,
    sourceRunId: rerun.sourceRunId,
    ...(rerun.participantIds === undefined ? {} : { participantIds: [...rerun.participantIds] }),
    participantRuns,
    participantPlan,
  });
  if (!selected.ok) {
    return { ok: false, code: "HUMANISH_CUA_LAB_RERUN_INVALID", message: selected.message };
  }
  return {
    ok: true,
    participantRuns: selected.participantRuns,
    participantPlan: selected.participantPlan,
    rerunLineage: selected.rerun,
  };
}

/** Scrub known secret values from each lane's declarative snapshot before any bundle uses it. */
export function sanitizeParticipantRuns(
  runs: readonly DesktopParticipantRun[],
  scrub: (text: string) => string,
): void {
  for (const spec of runs) {
    if (spec.evidenceAssignment)
      spec.evidenceAssignment = participantAssignment(spec.evidenceAssignment, scrub);
    spec.evidenceInstructions = redactText(scrub(spec.instructions));
    spec.persona = scrubPersonaBrief(spec.persona, scrub);
  }
}
