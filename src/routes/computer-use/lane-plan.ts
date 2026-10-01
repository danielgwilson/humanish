import {
  isLocalBrowserLab,
  LOCAL_BROWSER_LIFETIME_MS,
} from "../../substrates/local/runtime-config.js";
import { DEFAULT_STATE_STEP_TIMEOUT_MS } from "../../subject/state.js";
import type { ActorPersonaRef } from "../../actors/contract.js";
import { recipientInboxUrl } from "../../comms/capture-surface.js";
import type { DevicePreset } from "../../lab/device-presets.js";
import {
  computerUseParticipants,
  type ComputerUseParticipant,
} from "../../lab/plan-participants.js";
import type { ComputerUsePlan } from "../../lab/plan-types.js";
import { resolveParticipant } from "../../run/participant.js";
import { type LabConfig } from "../../lab/types.js";
import {
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
  scrubPersonaBrief,
  type ResolvedPersona,
} from "../../lab/persona.js";
import { digestText, redactText } from "../../evidence/redaction.js";
import { type RunRerunLineage } from "../../run/bundle.js";
import { type RunStream } from "../../run/streams.js";
import { loadRunBundle } from "../../run/locate.js";
import { renderTaskPrompt, type LabTask } from "../../lab/tasks.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { resolveCommittedPersonas } from "../../lab/persona-resolve.js";
import type { PreparedSelectedOutputDirectory } from "../../run/contained-output.js";
import {
  CUA_FANOUT_STRATEGY,
  CUA_MAX_CONCURRENCY_ENV,
  type CuaActorLabErrorCode,
  type CuaLanePlan,
  type CuaParticipantPlanEntry,
  type DesktopParticipantRun,
  type CuaRunBudget,
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

const DEFAULT_MISSION =
  "You are testing a web application. The browser is already open at the subject URL. Explore it, accomplish what the scenario asks, and stop when done.";

/**
 * The participant's outcome as ONE fixed first line of its last message (#570, second half). The
 * free-text computer-use provider has no schema to fill; a fixed line is the next best thing, and
 * the loop reads it into the trace's declaredOutcome. Prompt-only control is weak in general, so
 * adherence is measured (declaredOutcome present or absent on the trace) and the regex over the
 * paragraph stays as the fallback when the line is missing. This is a report format, deliberately
 * not a behavioural instruction: it says how to label the ending, never how to act.
 */
export const CLOSING_LINE_DIRECTIVE =
  "When you stop, make the FIRST line of your last message exactly one of these three, on its own line: " +
  "REACHED THE GOAL. / DID NOT REACH THE GOAL. / BLOCKED. " +
  "Then, from the next line, say what you did, what confused you, and where you hesitated.";

/** Compose one lane's actor prompt: persona line + device line + mission + per-lane steer.
 *  At N=1 (homogeneous, no roster) this reproduces the prior composeInstructions byte-for-byte. */
export function composeLaneInstructions(args: {
  mission: string;
  persona?: string;
  instruction?: string;
  /** The lab's declared protocol (#414). Only the participant-facing `goal` halves are rendered
   *  into the prompt; the `success` criteria never appear here. */
  tasks?: readonly LabTask[];
  device: { name: string; preset: DevicePreset };
  /** The COMPILED persona for `args.persona`, when its committed file resolved (#381). Supplying it
   *  makes the persona shape behavior — its traits become directives in the prompt and land in
   *  traitsApplied — instead of appearing as a bare `Persona: <id>.` label. Absent (unsafe id,
   *  no committed file, unparseable YAML) keeps the honest fallback: the bare line and an EMPTY
   *  traitsApplied, never fabricated traits. Resolved by the caller so this stays pure. */
  resolvedPersona?: ResolvedPersona;
  /**
   * desktop-cli (#495): the surface under study is a terminal window, not a page. Said plainly
   * because a participant whose every prior world was a browser will look for one — and because a
   * capability nobody declares is one the recording cannot later be read against. It states that a
   * terminal is open and NOT what to type in it: naming commands would answer the question the
   * study is asking.
   */
  surface?: "desktop-cli";
}): { instructions: string; persona: ActorPersonaRef } {
  const { name, preset } = args.device;
  const deviceLine = preset.isMobile
    ? `You are a mobile user on a ${name} device (${preset.width}x${preset.height} @${preset.deviceScaleFactor}x). Expect a mobile/touch layout.`
    : `You are a desktop user (${name}, ${preset.width}x${preset.height}).`;
  // The protocol as the PARTICIPANT reads it: numbered goals, nothing else. The success criteria
  // are the researcher's instrument and must never reach this prompt — a persona told how it will
  // be measured optimizes for the measurement instead of using the product (src/lab/tasks.ts).
  const taskLines = renderTaskPrompt(args.tasks ?? []);
  // A resolved persona contributes its compiled directives (friction tolerance, skill bias,
  // accessibility behavior, constraints) through the SAME persona.ts compiler the terminal lane
  // uses, so one persona file means one behavior across every route.
  const personaLine = args.resolvedPersona
    ? renderPersonaPromptSection(args.resolvedPersona)
    : args.persona
      ? `Persona: ${args.persona}.`
      : undefined;
  const traitsApplied = args.resolvedPersona
    ? personaToDirectives(args.resolvedPersona).traitsApplied
    : [];
  const surfaceLine =
    args.surface === "desktop-cli"
      ? "A terminal window is already open on this desktop, and there is a terminal in the dock at the bottom of the screen if you want another. Everything you need is on this machine; there is no browser task here."
      : undefined;
  const parts = [
    personaLine,
    deviceLine,
    surfaceLine,
    args.mission,
    taskLines,
    args.instruction ? `Lane focus: ${args.instruction}` : undefined,
    CLOSING_LINE_DIRECTIVE,
  ].filter((part): part is string => Boolean(part));
  const instructions = parts.join("\n\n");
  return {
    instructions,
    persona: {
      id: args.persona ?? "cua-operator",
      traitsApplied,
      ...(args.resolvedPersona ? { brief: personaBrief(args.resolvedPersona) } : {}),
      promptDigest: digestText(instructions, 16),
    },
  };
}

/** Runtime-inject the persona inbox instruction into a lane's prompt (#297 slice B). The inbox URL is a
 *  runtime loopback/getHost address (not secret), so — mirroring the lobby-code runtime injection — this
 *  augments only the instructions the model receives; the authored prompt + its digest are unchanged.
 *  Returns a new spec (never mutates). Shared by the CUA + concurrent shared-world routes. */
export function withInboxMission(
  spec: DesktopParticipantRun,
  inboxUrl: string,
  address?: string,
  receiving = false,
): DesktopParticipantRun {
  // No assigned identity means no participant inbox; never fall back to the shared operator view.
  if (!address?.trim()) return spec;
  // Captured mail is routed to the assigned identity. Supply that identity and inbox
  // access without requiring the participant to wait or complete the email flow.
  const identity = ` Your email address is ${address} — when the app asks for an email address, enter exactly that.`;
  if (receiving)
    return {
      ...spec,
      instructions: `${spec.instructions}\n\nEmail inbox:${identity} This is a fresh test identity; it does not replace an existing account's email address. When the app says it sent email, open ${inboxUrl} to check your inbox. Delivery may take a little time. Decide whether to wait or continue based on your situation. Report what you observe if mail is missing or unavailable. The inbox may block remote images or undeclared destinations; those are harness limitations.`,
    };
  return {
    ...spec,
    instructions: `${spec.instructions}\n\nEmail inbox:${identity} Your inbox is available at ${recipientInboxUrl(inboxUrl, address)} in the browser. It contains captured email addressed to your test identity. Delivery may take a little time. Decide whether to check it, wait or stop based on your situation and what you observe.`,
  };
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
    const composed = composeLaneInstructions({
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
  const plan: CuaLanePlan = {
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
  return { runs, plan };
}

async function resolveCuaRerunSelection(args: {
  cwd: string;
  labId: string;
  sandboxMs: number;
  sourceRunId: string;
  participantIds?: string[];
  participantRuns: DesktopParticipantRun[];
  plan: CuaLanePlan;
}): Promise<
  | {
      ok: true;
      participantRuns: DesktopParticipantRun[];
      plan: CuaLanePlan;
      rerun: RunRerunLineage;
    }
  | { ok: false; message: string }
> {
  const source = await loadRunBundle(args.cwd, args.sourceRunId);
  if (!source) {
    return { ok: false, message: `source run not found or invalid: ${args.sourceRunId}` };
  }
  const bundle = source.bundle;
  if (bundle.mode !== "live") {
    return {
      ok: false,
      message: `source run ${bundle.runId} is ${bundle.mode}; rerun selection only applies to live CUA fan-out evidence.`,
    };
  }
  const fanoutEvent = bundle.events.some((event) => event.type === "cua-lab.fanout.plan");
  if (!fanoutEvent || bundle.streams.length < 2) {
    return { ok: false, message: `source run ${bundle.runId} is not a CUA fan-out run.` };
  }

  const prior = bundle.streams
    .map(snapshotPriorParticipant)
    .filter(
      (entry): entry is NonNullable<ReturnType<typeof snapshotPriorParticipant>> => entry !== null,
    );
  const priorById = new Map(prior.map((entry) => [entry.participantId, entry]));
  if (priorById.size < 2) {
    return { ok: false, message: `source run ${bundle.runId} does not expose multiple lane ids.` };
  }

  const explicitIds = uniqueIds(args.participantIds ?? []);
  const selectedIds =
    explicitIds.length > 0
      ? explicitIds
      : prior.filter((entry) => entry.rerunnable).map((entry) => entry.participantId);
  if (selectedIds.length === 0) {
    return {
      ok: false,
      message: `source run ${bundle.runId} has no failed, blocked, timed-out, or hollow lanes to rerun.`,
    };
  }

  const missingPrior = selectedIds.filter((id) => !priorById.has(id));
  if (missingPrior.length > 0) {
    return {
      ok: false,
      message: `selected lane id(s) were not present in source run ${bundle.runId}: ${missingPrior.join(", ")}`,
    };
  }

  const specsById = new Map(args.participantRuns.map((spec) => [spec.planned.id, spec]));
  const missingCurrent = selectedIds.filter((id) => !specsById.has(id));
  if (missingCurrent.length > 0) {
    return {
      ok: false,
      message: `selected lane id(s) are not present in the current lab config ${args.labId}: ${missingCurrent.join(", ")}`,
    };
  }

  const selectedSpecs = selectedIds.map((id) => specsById.get(id)!);
  const selectedPlanIds = new Set(selectedIds);
  const selectedPlanEntries = args.plan.lanes.filter((entry) => selectedPlanIds.has(entry.id));
  const concurrency = Math.max(1, Math.min(args.plan.concurrency, selectedSpecs.length));
  const plan: CuaLanePlan = {
    ...args.plan,
    laneCount: selectedSpecs.length,
    concurrency,
    waves: Math.ceil(selectedSpecs.length / concurrency),
    worstCaseSandboxMinutes: Math.round((selectedSpecs.length * args.sandboxMs) / 60_000),
    lanes: selectedPlanEntries,
  };

  const previous = selectedIds.map((id) => priorById.get(id)!.previous);
  return {
    ok: true,
    participantRuns: selectedSpecs,
    plan,
    rerun: {
      sourceRunId: bundle.runId,
      selectedLaneIds: selectedIds,
      previous,
    },
  };
}

function uniqueIds(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function snapshotPriorParticipant(stream: RunStream): {
  participantId: string;
  previous: RunRerunLineage["previous"][number];
  rerunnable: boolean;
} | null {
  if (stream.kind !== "browser" || typeof stream.laneId !== "string" || !stream.laneId.trim()) {
    return null;
  }
  const actorStatus = stream.actor?.status;
  const completionReason = stream.actor?.completionReason;
  const reason = stream.ui?.state ?? stream.actor?.reason;
  const actions = stream.actor?.counts.actions ?? 0;
  const messages = stream.actor?.counts.messages ?? 0;
  const hollow = completionReason === "goal_satisfied" && actions === 0 && messages === 0;
  const rerunnable =
    stream.status !== "passed" ||
    actorStatus === "failed" ||
    actorStatus === "blocked" ||
    actorStatus === "timed_out" ||
    completionReason === "harness_error" ||
    hollow;
  return {
    participantId: stream.laneId,
    previous: {
      laneId: stream.laneId,
      streamId: stream.id,
      status: stream.status,
      ...(reason === undefined ? {} : { reason }),
      ...(actorStatus === undefined ? {} : { actorStatus }),
      ...(completionReason === undefined ? {} : { completionReason }),
    },
    rerunnable,
  };
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
): CuaLanePlan {
  const { countOverride, ...rest } = opts;
  return participantRunsAndPlan(plannedParticipantsOf(config, countOverride), rest).plan;
}

/** Print the lane plan to stderr BEFORE any sandbox/provider call (public-safe: ids, devices,
 *  digests, and budgets only — no prompt text, no secrets). */
export function emitPreflightPlan(plan: CuaLanePlan, labId: string): void {
  const lines: string[] = [];
  lines.push(
    `humanish cua fan-out plan (${labId}): ${plan.laneCount} lane(s), strategy ${plan.strategy}, concurrency ${plan.concurrency}${plan.envLoweredConcurrencyFrom === undefined ? "" : ` (lowered from ${plan.envLoweredConcurrencyFrom} by ${CUA_MAX_CONCURRENCY_ENV})`}, ${plan.waves} wave(s).`,
  );
  lines.push(
    `  per-lane session budget ${Math.round(plan.perLaneSessionBudgetMs / 1000)}s; worst-case ~${plan.worstCaseSandboxMinutes} sandbox-minutes total${plan.dryRun ? " (dry-run: $0)" : ""}.`,
  );
  for (const entry of plan.lanes) {
    lines.push(`  - ${formatLanePlanEntry(entry)}`);
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

export function formatLanePlanEntry(entry: CuaParticipantPlanEntry): string {
  const taxonomy = [
    entry.actorType ? `type=${entry.actorType}` : undefined,
    entry.surface ? `surface=${entry.surface}` : undefined,
    entry.caseGroup ? `case=${entry.caseGroup}` : undefined,
    entry.reasoningEffort ? `effort=${entry.reasoningEffort}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${entry.id}: persona=${entry.persona}${taxonomy.length > 0 ? ` ${taxonomy.join(" ")}` : ""} device=${entry.device} ${entry.resolution[0]}x${entry.resolution[1]} prompt#${entry.instructionDigest}${entry.targetDigest ? ` target#${entry.targetDigest}` : ""}`;
}

/** Short id-safe suffix for a subject-phase RunEvent: drops the shared prefix/suffix so each
 *  phase gets a distinct bundle event id (e.g. "clone", "state-before-build"). */
export function phaseEventIdSuffix(type: string): string {
  return type
    .replace(/^cua-lab\.subject\./, "")
    .replace(/\.(started|completed)$/, "")
    .replace(/\./g, "-");
}

export function makeCuaRunBudget(maxTotalUsd: number): CuaRunBudget {
  const participantEstimates = new Map<string, number>();
  return {
    maxTotalUsd,
    note(participantId, estimateUsd) {
      if (estimateUsd !== null) participantEstimates.set(participantId, estimateUsd);
      let total = 0;
      for (const value of participantEstimates.values()) total += value;
      return total;
    },
  };
}

export function digestUrl(url: string): string {
  return digestText(url, 16);
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
 * The participants a computer-use run drives, resolved from its plan before anything is created:
 * committed personas compiled, the pure participant table built from the plan's participants,
 * bound and budgets (the same for dry-run and live), and a rerun narrowed to its selected
 * participants.
 */
export async function planCuaParticipants(args: {
  plan: ComputerUsePlan;
  cwd: string;
  projectRoot: PreparedSelectedOutputDirectory;
  env: Record<string, string | undefined>;
}): Promise<
  | {
      ok: true;
      participantRuns: DesktopParticipantRun[];
      plan: CuaLanePlan;
      rerunLineage?: RunRerunLineage;
    }
  | { ok: false; code: CuaActorLabErrorCode; message: string }
> {
  const routePlan = args.plan;
  const { participants } = routePlan.runner;
  // Compile any committed personas BEFORE planning, so the plan builder stays pure and each lane's
  // prompt carries real behavioral directives rather than a bare `Persona: <id>.` label (#381).
  const personas = await compileParticipantPersonas(
    args.projectRoot,
    participants.map((participant) => participant.personaId),
  );
  const { runs: participantRuns, plan } = participantRunsAndPlan(
    {
      participants,
      concurrency: routePlan.concurrency,
      sessionBudgetMs: routePlan.sessionBudgetMs,
      sandboxMs: routePlan.sandboxMs,
      desktopCli: routePlan.runner.subject.kind === "desktop-cli",
    },
    { env: args.env, dryRun: routePlan.dryRun, personas },
  );
  const rerun = routePlan.rerun;
  if (!rerun) return { ok: true, participantRuns, plan };

  const selected = await resolveCuaRerunSelection({
    cwd: args.cwd,
    labId: routePlan.labId,
    sandboxMs: routePlan.sandboxMs,
    sourceRunId: rerun.sourceRunId,
    ...(rerun.participantIds === undefined ? {} : { participantIds: [...rerun.participantIds] }),
    participantRuns,
    plan,
  });
  if (!selected.ok) {
    return { ok: false, code: "HUMANISH_CUA_LAB_RERUN_INVALID", message: selected.message };
  }
  return {
    ok: true,
    participantRuns: selected.participantRuns,
    plan: selected.plan,
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
