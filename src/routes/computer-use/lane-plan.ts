import {
  isLocalBrowserLab,
  LOCAL_BROWSER_LIFETIME_MS,
} from "../../substrates/local/runtime-config.js";
import { DEFAULT_STATE_STEP_TIMEOUT_MS } from "../../subject/state.js";
import type { ActorPersonaRef } from "../../actors/contract.js";
import { recipientInboxUrl } from "../../comms/capture-surface.js";
import {
  DEFAULT_DEVICE_PRESET,
  isDevicePresetName,
  resolveDevicePreset,
  type DevicePreset,
} from "../../lab/device-presets.js";
import { type LabActorLane, type LabConfig } from "../../lab/types.js";
import {
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
  scrubPersonaBrief,
  type ResolvedPersona,
} from "../../lab/persona.js";
import type { ReasoningEffort } from "../../actors/reasoning-effort.js";
import { digestText, redactText } from "../../evidence/redaction.js";
import { type RunRerunLineage } from "../../run/bundle.js";
import { type RunStream } from "../../run/streams.js";
import { loadRunBundle } from "../../run/locate.js";
import type { DwellWindow, StopWhen } from "../../actors/stop-conditions.js";
import { renderTaskPrompt, type LabTask } from "../../lab/tasks.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { labPersonaIds, resolveCommittedPersonas } from "../../lab/persona-resolve.js";
import { participantIdAt } from "../../lab/routing.js";
import type { PreparedSelectedOutputDirectory } from "../../run/selected-output-paths.js";
import {
  CUA_FANOUT_STRATEGY,
  CUA_MAX_CONCURRENCY_ENV,
  type CuaActorLabErrorCode,
  type CuaLanePlan,
  type CuaLanePlanEntry,
  type CuaLaneSpec,
  type CuaRunBudget,
  DEFAULT_APP_URL_SESSION_TIMEOUT_MS,
  type LaneSpecsAndPlan,
  MAX_SANDBOX_MS,
  MIN_DERIVED_SESSION_TIMEOUT_MS,
  type RunCuaActorLabOptions,
  SANDBOX_TIMEOUT_BUFFER_MS,
  SUBJECT_PROVISION_BUDGET_MS,
} from "./types.js";

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
  spec: CuaLaneSpec,
  inboxUrl: string,
  address?: string,
  receiving = false,
): CuaLaneSpec {
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

/**
 * The narrowest browser WINDOW Chrome/Chromium will render on the E2B desktop. Chrome refuses to
 * make its window narrower than this (~500 CSS px observed: a 414-wide X screen produced a 500-wide
 * window that OVERFLOWED it, clipping the right edge of the page off-screen). So the physically
 * RENDERED screen width is floored here: a sub-500 mobile preset (mobile 414, small-mobile 360,
 * narrow-mobile 320) gets a 500-wide screen the window fits exactly — no clip. The device PRESET keeps
 * its true identity (isMobile, nominal width) for the persona prompt + metadata; only the rendered
 * screen is floored. True sub-500 CSS-viewport rendering (page laid out at 414 regardless of window
 * width, via CDP device-metric emulation) is the separate #221 upgrade.
 */
export const MIN_DESKTOP_RENDER_WIDTH = 500;

/** Floor a screen resolution's WIDTH to what Chrome can actually render (see MIN_DESKTOP_RENDER_WIDTH). */
export function floorRenderResolution(resolution: readonly [number, number]): [number, number] {
  return [Math.max(resolution[0], MIN_DESKTOP_RENDER_WIDTH), resolution[1]];
}

/**
 * Resolve a lane's device + rendered resolution (most-specific wins, exactly as the single-lane
 * path always has): a raw execution.desktop.resolution escape hatch (only legal when no lane
 * sets a device — XOR enforced at parse) → the lane's named device → the run-wide
 * execution.desktop.device → the default preset. A raw resolution is an unnamed custom desktop
 * (non-mobile, DSF 1): we never claim a named preset's mobile/DPR for hand-set geometry. The rendered
 * `resolution` is floored to MIN_DESKTOP_RENDER_WIDTH so the browser window fits its X screen (no clip);
 * `preset` keeps the declared device identity (a mobile preset stays 414/isMobile for the prompt).
 */
export function resolveLaneDevice(
  config: LabConfig,
  lane: LabActorLane | undefined,
): {
  name: string;
  preset: DevicePreset;
  resolution: [number, number];
} {
  const rawResolution = config.execution?.desktop?.resolution;
  if (lane?.device === undefined && rawResolution) {
    const preset: DevicePreset = {
      width: rawResolution[0],
      height: rawResolution[1],
      isMobile: false,
      deviceScaleFactor: 1,
    };
    return {
      name: "custom",
      preset,
      resolution: floorRenderResolution([rawResolution[0], rawResolution[1]]),
    };
  }
  const candidate = lane?.device ?? config.execution?.desktop?.device;
  const presetName = isDevicePresetName(candidate) ? candidate : DEFAULT_DEVICE_PRESET;
  const preset = resolveDevicePreset(presetName);
  return {
    name: presetName,
    preset,
    resolution: floorRenderResolution([preset.width, preset.height]),
  };
}

/** Per-lane sandbox deadline (each lane owns its own desktop). Mirrors the single-lane formula
 *  verbatim so N=1 stays byte-stable: explicit sandboxTimeoutMs, else session budget + (clone
 *  or local-tree: provision budget + Σ state-step budgets) + the server-side
 *  reclamation buffer. Local-tree shares the clone route's provisioning budget: it swaps a
 *  git clone for an upload+extract, but the shared install/build/state/start/probe pipeline
 *  costs the same wall-clock room either way. */
export function resolvePerLaneSandboxMs(config: LabConfig): number {
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
 * Effective in-flight lane bound. Defaults to laneCount — every declared seat runs at once,
 * because a throttle nobody asked for silently turns "N actors live" into waves (#350); total
 * session count and spend are the same either way, only wall-clock and simultaneity differ. A
 * declared execution.concurrency is a CAP, clamped to [1, laneCount]; the env override may only
 * LOWER it (never raise concurrent paid desktops — invariant 3), and a lowering is reported via
 * envLoweredFrom so the plan never silently disagrees with the manifest. Pure given
 * (config, laneCount, env).
 */
function resolveCuaConcurrency(
  config: LabConfig,
  laneCount: number,
  env: Record<string, string | undefined>,
): { bound: number; envLoweredFrom?: number } {
  const declared = config.execution?.concurrency;
  const base = Math.max(
    1,
    declared !== undefined ? Math.min(Math.max(1, declared), laneCount) : laneCount,
  );
  const envLower = readPositiveInt(env[CUA_MAX_CONCURRENCY_ENV], 0);
  if (envLower > 0 && envLower < base) {
    return { bound: Math.max(1, Math.min(base, envLower, laneCount)), envLoweredFrom: base };
  }
  return { bound: base };
}

/** Build the lane specs AND the public plan from a config (pure). countOverride is the CLI
 *  --count for homogeneous fan-out (ignored when a `lanes` roster is declared). */
function laneSpecsAndPlan(
  config: LabConfig,
  opts: {
    countOverride?: number;
    env?: Record<string, string | undefined>;
    dryRun?: boolean;
    personas?: Map<string, ResolvedPersona>;
  } = {},
): LaneSpecsAndPlan {
  const env = opts.env ?? {};
  const actor = config.actors[0];
  const mission = actor?.mission ?? DEFAULT_MISSION;
  const tasks = actor?.tasks;
  const roster = actor?.lanes;
  const laneCount = roster ? roster.length : Math.max(1, opts.countOverride ?? actor?.count ?? 1);

  const lanes: CuaLaneSpec[] = [];
  for (let i = 0; i < laneCount; i += 1) {
    const lane = roster?.[i];
    const laneId = participantIdAt(i, lane?.id, "lane");
    const simId = `sim-${String(i + 1).padStart(3, "0")}`;
    const streamId = `stream-${String(i + 1).padStart(3, "0")}`;
    const device = resolveLaneDevice(config, lane);
    // A lane's persona FALLS BACK to actors[0].persona, matching this field's own doc comment
    // in src/lab/types.ts and its sibling resolutions (stopWhen, reasoningEffort) two lines
    // below. Reading only lane.persona when a roster was present meant every fan-out lane of
    // every lab that declared actors[0].persona ran with no persona at all: no personaLine in
    // the prompt, traitsApplied [], and nothing warned (#512).
    const personaId = (lane?.persona ?? actor?.persona) as string | undefined;
    const resolvedPersona = personaId === undefined ? undefined : opts.personas?.get(personaId);
    const composed = composeLaneInstructions({
      mission,
      ...(tasks === undefined ? {} : { tasks }),
      ...(personaId === undefined ? {} : { persona: personaId }),
      ...(resolvedPersona === undefined ? {} : { resolvedPersona }),
      ...((roster ? lane?.instruction : actor?.laneFocus?.instruction) === undefined
        ? {}
        : { instruction: (roster ? lane?.instruction : actor?.laneFocus?.instruction) as string }),
      device: { name: device.name, preset: device.preset },
      ...(config.subject.source === "desktop-cli" ? { surface: "desktop-cli" as const } : {}),
    });
    lanes.push({
      laneId,
      ...(lane?.actorType === undefined ? {} : { actorType: lane.actorType }),
      ...(lane?.surface === undefined ? {} : { surface: lane.surface }),
      ...(lane?.caseGroup === undefined ? {} : { caseGroup: lane.caseGroup }),
      laneIndex: i,
      simId,
      streamId,
      persona: composed.persona,
      instructions: composed.instructions,
      assignment: {
        mission,
        ...((roster ? lane?.instruction : actor?.laneFocus?.instruction) === undefined
          ? {}
          : { focus: (roster ? lane?.instruction : actor?.laneFocus?.instruction)! }),
        ...(tasks === undefined ? {} : { tasks: tasks.map(({ id, goal }) => ({ id, goal })) }),
      },
      ...(lane?.target === undefined ? {} : { targetUrl: lane.target }),
      ...((lane?.stopWhen ?? actor?.stopWhen) === undefined
        ? {}
        : { stopWhen: (lane?.stopWhen ?? actor?.stopWhen) as StopWhen }),
      ...((lane?.dwell ?? actor?.dwell) === undefined
        ? {}
        : { dwell: (lane?.dwell ?? actor?.dwell) as DwellWindow }),
      ...((lane?.reasoningEffort ?? actor?.reasoningEffort) === undefined
        ? {}
        : {
            reasoningEffort: (lane?.reasoningEffort ?? actor?.reasoningEffort) as ReasoningEffort,
          }),
      ...(actor?.maxOutputTokens === undefined ? {} : { maxOutputTokens: actor.maxOutputTokens }),
      ...(tasks === undefined ? {} : { tasks }),
      deviceName: device.name,
      devicePreset: device.preset,
      resolution: device.resolution,
      screenshotDir: laneCount === 1 ? "" : laneId,
      traceArtifactPath: laneCount === 1 ? "actor.json" : `actors/${streamId}.json`,
    });
  }

  const resolved = resolveCuaConcurrency(config, laneCount, env);
  const concurrency = resolved.bound;
  const perLaneSessionBudgetMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
  const perLaneSandboxMs = resolvePerLaneSandboxMs(config);
  const plan: CuaLanePlan = {
    strategy: CUA_FANOUT_STRATEGY,
    laneCount,
    concurrency,
    ...(resolved.envLoweredFrom === undefined
      ? {}
      : { envLoweredConcurrencyFrom: resolved.envLoweredFrom }),
    waves: Math.ceil(laneCount / concurrency),
    perLaneSessionBudgetMs,
    worstCaseSandboxMinutes: Math.round((laneCount * perLaneSandboxMs) / 60_000),
    dryRun: opts.dryRun === true,
    lanes: lanes.map((spec) => ({
      id: spec.laneId,
      ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
      ...(spec.surface === undefined ? {} : { surface: spec.surface }),
      ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
      index: spec.laneIndex + 1,
      persona: spec.persona.id,
      device: spec.deviceName,
      resolution: spec.resolution,
      instructionDigest: spec.persona.promptDigest,
      ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort }),
      ...(spec.maxOutputTokens === undefined ? {} : { maxOutputTokens: spec.maxOutputTokens }),
      ...(spec.targetUrl === undefined ? {} : { targetDigest: digestUrl(spec.targetUrl) }),
    })),
  };
  return { lanes, plan };
}

async function resolveCuaRerunSelection(args: {
  cwd: string;
  config: LabConfig;
  sourceRunId: string;
  laneIds?: string[];
  laneSpecs: CuaLaneSpec[];
  plan: CuaLanePlan;
}): Promise<
  | { ok: true; laneSpecs: CuaLaneSpec[]; plan: CuaLanePlan; rerun: RunRerunLineage }
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
    .map(snapshotPriorCuaLane)
    .filter(
      (lane): lane is ReturnType<typeof snapshotPriorCuaLane> & { laneId: string } => lane !== null,
    );
  const priorById = new Map(prior.map((lane) => [lane.laneId, lane]));
  if (priorById.size < 2) {
    return { ok: false, message: `source run ${bundle.runId} does not expose multiple lane ids.` };
  }

  const explicitLaneIds = uniqueLaneIds(args.laneIds ?? []);
  const selectedLaneIds =
    explicitLaneIds.length > 0
      ? explicitLaneIds
      : prior.filter((lane) => lane.rerunnable).map((lane) => lane.laneId);
  if (selectedLaneIds.length === 0) {
    return {
      ok: false,
      message: `source run ${bundle.runId} has no failed, blocked, timed-out, or hollow lanes to rerun.`,
    };
  }

  const missingPrior = selectedLaneIds.filter((laneId) => !priorById.has(laneId));
  if (missingPrior.length > 0) {
    return {
      ok: false,
      message: `selected lane id(s) were not present in source run ${bundle.runId}: ${missingPrior.join(", ")}`,
    };
  }

  const specsById = new Map(args.laneSpecs.map((spec) => [spec.laneId, spec]));
  const missingCurrent = selectedLaneIds.filter((laneId) => !specsById.has(laneId));
  if (missingCurrent.length > 0) {
    return {
      ok: false,
      message: `selected lane id(s) are not present in the current lab config ${args.config.id}: ${missingCurrent.join(", ")}`,
    };
  }

  const selectedSpecs = selectedLaneIds.map((laneId) => specsById.get(laneId)!);
  const selectedPlanLaneIds = new Set(selectedLaneIds);
  const selectedPlanEntries = args.plan.lanes.filter((lane) => selectedPlanLaneIds.has(lane.id));
  const concurrency = Math.max(1, Math.min(args.plan.concurrency, selectedSpecs.length));
  const plan: CuaLanePlan = {
    ...args.plan,
    laneCount: selectedSpecs.length,
    concurrency,
    waves: Math.ceil(selectedSpecs.length / concurrency),
    worstCaseSandboxMinutes: Math.round(
      (selectedSpecs.length * resolvePerLaneSandboxMs(args.config)) / 60_000,
    ),
    lanes: selectedPlanEntries,
  };

  const previous = selectedLaneIds.map((laneId) => priorById.get(laneId)!.previous);
  return {
    ok: true,
    laneSpecs: selectedSpecs,
    plan,
    rerun: {
      sourceRunId: bundle.runId,
      selectedLaneIds,
      previous,
    },
  };
}

function uniqueLaneIds(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const laneId = value.trim();
    if (!laneId || seen.has(laneId)) continue;
    seen.add(laneId);
    result.push(laneId);
  }
  return result;
}

function snapshotPriorCuaLane(
  stream: RunStream,
): { laneId: string; previous: RunRerunLineage["previous"][number]; rerunnable: boolean } | null {
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
    laneId: stream.laneId,
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
export function resolveCuaLanePlan(
  config: LabConfig,
  opts: {
    countOverride?: number;
    env?: Record<string, string | undefined>;
    dryRun?: boolean;
    personas?: Map<string, ResolvedPersona>;
  } = {},
): CuaLanePlan {
  return laneSpecsAndPlan(config, opts).plan;
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
  for (const lane of plan.lanes) {
    lines.push(`  - ${formatLanePlanEntry(lane)}`);
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

export function formatLanePlanEntry(lane: CuaLanePlanEntry): string {
  const taxonomy = [
    lane.actorType ? `type=${lane.actorType}` : undefined,
    lane.surface ? `surface=${lane.surface}` : undefined,
    lane.caseGroup ? `case=${lane.caseGroup}` : undefined,
    lane.reasoningEffort ? `effort=${lane.reasoningEffort}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${lane.id}: persona=${lane.persona}${taxonomy.length > 0 ? ` ${taxonomy.join(" ")}` : ""} device=${lane.device} ${lane.resolution[0]}x${lane.resolution[1]} prompt#${lane.instructionDigest}${lane.targetDigest ? ` target#${lane.targetDigest}` : ""}`;
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
  const laneEstimates = new Map<string, number>();
  return {
    maxTotalUsd,
    note(laneId, estimateUsd) {
      if (estimateUsd !== null) laneEstimates.set(laneId, estimateUsd);
      let total = 0;
      for (const value of laneEstimates.values()) total += value;
      return total;
    },
  };
}

export function digestUrl(url: string): string {
  return digestText(url, 16);
}

export function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The lanes a computer-use run drives, resolved before anything is created: committed personas
 * compiled, the pure lane table built (the same for dry-run and live), the lane cap enforced, and
 * a rerun narrowed to its selected lanes.
 */
export async function planCuaLanes(args: {
  config: LabConfig;
  cwd: string;
  projectRoot: PreparedSelectedOutputDirectory;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  /**
   * planComputerUseLab's lane-cap or in-process fan-out refusal. It is returned after the persona
   * files are read, where those checks have always run, so a persona-file error still wins.
   */
  refusal?: { readonly code: CuaActorLabErrorCode; readonly message: string };
  countOverride?: number;
  rerun?: RunCuaActorLabOptions["rerun"];
}): Promise<
  | { ok: true; laneSpecs: CuaLaneSpec[]; plan: CuaLanePlan; rerunLineage?: RunRerunLineage }
  | { ok: false; code: CuaActorLabErrorCode; message: string }
> {
  // Compile any committed personas BEFORE planning, so the plan builder stays pure and each lane's
  // prompt carries real behavioral directives rather than a bare `Persona: <id>.` label (#381).
  const personaResolution = await resolveCommittedPersonas(
    args.projectRoot,
    labPersonaIds(args.config),
  );
  for (const warning of personaResolution.warnings) {
    process.stderr.write(`humanish: ${warning}\n`);
  }
  if (args.refusal) return { ok: false, code: args.refusal.code, message: args.refusal.message };

  const { lanes: laneSpecs, plan } = laneSpecsAndPlan(args.config, {
    ...(args.countOverride === undefined ? {} : { countOverride: args.countOverride }),
    env: args.env,
    dryRun: args.dryRun,
    personas: personaResolution.personas,
  });
  if (!args.rerun) return { ok: true, laneSpecs, plan };

  const selected = await resolveCuaRerunSelection({
    cwd: args.cwd,
    config: args.config,
    sourceRunId: args.rerun.sourceRunId,
    ...(args.rerun.laneIds === undefined ? {} : { laneIds: args.rerun.laneIds }),
    laneSpecs,
    plan,
  });
  if (!selected.ok) {
    return { ok: false, code: "HUMANISH_CUA_LAB_RERUN_INVALID", message: selected.message };
  }
  return {
    ok: true,
    laneSpecs: selected.laneSpecs,
    plan: selected.plan,
    rerunLineage: selected.rerun,
  };
}

/** Scrub known secret values from each lane's declarative snapshot before any bundle uses it. */
export function sanitizeLaneSpecs(
  laneSpecs: readonly CuaLaneSpec[],
  scrub: (text: string) => string,
): void {
  for (const spec of laneSpecs) {
    if (spec.assignment) spec.assignment = participantAssignment(spec.assignment, scrub);
    spec.evidenceInstructions = redactText(scrub(spec.instructions));
    spec.persona = scrubPersonaBrief(spec.persona, scrub);
  }
}
