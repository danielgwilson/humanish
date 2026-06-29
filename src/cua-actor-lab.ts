// The computer-use lab backend: a subject (an app-url the caller provisioned, or a repo the
// lab clones AND serves in-sandbox) driven by a REGISTRY-RESOLVED computer-use actor inside a
// hosted E2B desktop. This is the path that makes `actors[].type` load-bearing — the
// descriptor returned by the registry runs the session; the lab provisions the desktop and
// subject, composes the prompt from config, persists the evidence bundle, and tears down.
//
// Substrate notes:
// - The desktop is created via the shared loader in e2b-desktop-launch.ts with kill-on-timeout
//   lifecycle, so a dead host process can never orphan a sandbox past its server-side deadline.
// - Env placement follows the doctrine (docs/principles/invariants-and-defaults.md): the
//   ACTOR's key never enters the sandbox (the model drives from outside via the provider API);
//   the SUBJECT's declared env NAMES are provisioned in on the clone route — values come from
//   the caller's environment and are never logged or persisted.
// - The live stream URL is runtime-only (carries an auth key) and is never persisted into run
//   artifacts — only its presence is recorded, mirroring the meta lab's convention.
// - Evidence redaction is mode-aware (docs/principles/invariants-and-defaults.md, the
//   capture-vs-publish rule): screenshots persist RAW (full fidelity) by default into gitignored
//   .mimetic/; `policies.redactScreenshots: true` opts into blur-at-capture for a share-as-is
//   bundle. Length-only typed text and text redaction of reasoning/messages are UNCONDITIONAL;
//   harness errors are redacted at THIS boundary; the bundle's `stream.actor` carries the
//   conformant mimetic.actor-trace.v1 projection, whose `redaction.screenshots` records the
//   run's actual mode ("raw" | "blurred" | "n/a") — every label downstream derives from it.

import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ActorCompletionReason, ActorPersonaRef, ActorStatus, ActorTrace } from "./actor-contract.js";
import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks,
  type BrowserLabAdapterHooks
} from "./adapter-extension.js";
import { actorRegistry, isCuaActorDescriptor, type CuaActorDescriptor } from "./actor-registry.js";
import type { CuaActorSessionOptions } from "./computer-use-actor.js";
import type { CuaExecutor, CuaLoopResult, CuaProvider } from "./computer-use.js";
import type { E2BDesktopLike } from "./e2b-desktop-executor.js";
import {
  createDesktopSandbox,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import {
  probeUrl,
  readDetachedLog,
  runDetachedStep,
  startDetachedProcess,
  type DetachedTimers
} from "./e2b-detached.js";
import {
  DEFAULT_DEVICE_PRESET,
  isDevicePresetName,
  resolveDevicePreset,
  type DevicePreset
} from "./device-presets.js";
import {
  cuaLaneValidationReason,
  isHttpUrl,
  isLoopbackUrl,
  MAX_CUA_LANES,
  subjectStateInvalidReason,
  type LabActorLane,
  type LabConfig,
  type LabDesktopBrowser,
  type LabStateStepWhen,
  type LabSubjectServe,
  type LabSubjectState
} from "./lab-config.js";
import { mapWithConcurrency } from "./concurrency.js";
import { assertScreenshotEvidence } from "./image-evidence.js";
import { renderObserver, type ObserverResult } from "./observer.js";
import { containsSensitive, redactText } from "./redaction.js";
import type { StopWhen } from "./stop-conditions.js";
import {
  buildRunSource,
  loadRunBundle,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunRerunLineage,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord
} from "./run.js";

export const CUA_ACTOR_LAB_SCHEMA = "mimetic.cua-lab-result.v2";

// The only fan-out topology this slice ships: N lanes = N independent E2B desktop sandboxes,
// each its own world (clone/serve + subject.state per lane). Shared-world is layer 7 (#164).
export const CUA_FANOUT_STRATEGY = "per-lane-worlds" as const;
// Default in-flight lane bound when the config does not declare execution.concurrency.
const DEFAULT_CUA_CONCURRENCY = 3;
// Env override that may only LOWER the effective concurrency (never raise concurrent paid
// desktops — invariant 3). Read names-only into a local; the value never persists.
const CUA_MAX_CONCURRENCY_ENV = "MIMETIC_CUA_MAX_CONCURRENCY";

export const CUA_ACTOR_LAB_PROVIDER_METADATA = {
  mode: "cua-actor-lab",
  tool: "mimetic-cli"
} as const;

const DEFAULT_SESSION_TIMEOUT_MS = 300_000;
// Settle after opening the browser, before the first screenshot — long enough for a cold
// browser + page load to paint (2s captured a blank desktop; the render empirically needs ~6-9s).
const BROWSER_SETTLE_MS = 8_000;

export interface DesktopBrowserEvidence {
  requested: LabDesktopBrowser;
  resolved?: string;
}

// Device/viewport comes from the named-preset registry (device-presets.ts), selectable per run
// via execution.desktop.device (default `desktop`=1440x950). NOTE: this is run-wide for now; a
// per-PERSONA device dimension (N personas × devices, as the bespoke sims author) lands with
// fan-out. On this E2B-desktop route only width/height physically render — isMobile/DSF are
// honest metadata + a prompt signal, not rendered (device-presets.ts FIDELITY NOTE).
// Server-side reclamation buffer past the loop's own wall-clock stop.
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;
// Room the clone route adds to the sandbox deadline for clone/install/build/start/probe.
const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;
export const SUBJECT_DIR = "/home/user/subject";
const CLONE_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 180_000;
// Per-step budget for subject.state seed steps; each step's declared (or default) budget is
// also summed into the default sandbox deadline so seeding never eats the session's room.
const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;
// How much of a failing step's log tail rides the (redacted) error message.
const ERROR_TAIL_CHARS = 2000;

/**
 * Library-level hooks. `prepareDesktop` runs after sandbox creation and before subject
 * provisioning / browser launch — library callers use it for extra in-sandbox setup beyond
 * what `subject.serve` declares (or to provision an app-url subject entirely). The rest are
 * DI seams so CI drives the full path with fakes at zero network/zero spend.
 */
export interface CuaActorLabHooks extends BrowserLabAdapterHooks {
  /**
   * Runs after sandbox creation and before subject provisioning / browser launch. Widened
   * back-compatibly with per-lane context so a library caller can provision the right app-url
   * subject per lane (a one-arg `(desktop) => …` still satisfies the type). Called once per lane.
   */
  prepareDesktop?: (desktop: E2BDesktopSandbox, lane: { laneId: string; laneIndex: number; laneCount: number }) => Promise<void>;
  /**
   * Pre-flight hook: receives the resolved lane plan BEFORE any sandbox or provider call (dry-run
   * AND live). The engine also prints the plan to stderr; this seam lets tests assert it without
   * scraping stderr. Identical plan in dry-run, marked $0.
   */
  onPreflight?: (plan: CuaLanePlan) => void;
  /**
   * Runtime-only live desktop stream callback. The URL carries an auth key and must never be
   * persisted into run artifacts; callers use it to hydrate an attached Observer server.
   */
  onRuntimeStreamReady?: (stream: {
    laneId: string;
    sandboxId: string;
    simId: string;
    streamId: string;
    url: string;
  }) => Promise<void> | void;
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  runSession?: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  /**
   * Supply a custom executor (e.g. a window.* JS-contract bridge over an already-running local
   * dev server). When present (with `buildProvider`), `runCuaActorLab` takes the IN-PROCESS
   * branch: it NEVER loads the E2B module, creates a sandbox, runs prepareDesktop, provisions a
   * clone, opens a browser, or starts a stream — so `result.sandbox` is omitted, the verifiable
   * "no E2B SDK call" proof. The whole bundle/Observer/redaction composition below the session
   * call is desktop-agnostic and runs unchanged. Receives the resolved config, the
   * registry-resolved descriptor, and the entry appUrl.
   */
  buildExecutor?: (ctx: { config: LabConfig; actor: CuaActorDescriptor; appUrl: string }) => Promise<CuaExecutor>;
  /**
   * Supply a custom provider (a "brain" reasoning over app STATE). REQUIRED alongside
   * `buildExecutor` — the default OpenAI provider is vision-based (requiresFrame) and would fail
   * closed against a state-only executor that returns no screenshot. (`buildProvider` ALONE is
   * allowed — that is just a model swap on the normal E2B route.)
   */
  buildProvider?: (ctx: { config: LabConfig; actor: CuaActorDescriptor }) => Promise<CuaProvider>;
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock/sleep for the detached-step polling (tests only). */
  detachedTimers?: DetachedTimers;
}

export interface RunCuaActorLabOptions {
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  /** CLI `--count` override for the homogeneous fan-out lane count (ignored when a `lanes`
   *  roster is declared — a roster's length is authoritative). */
  countOverride?: number;
  /** Explicitly create a new run containing failed or selected lanes from a prior fan-out run. */
  rerun?: {
    sourceRunId: string;
    laneIds?: string[];
  };
  hooks?: CuaActorLabHooks;
}

/** A lane's row in the pre-flight plan: identity + the device/persona it will drive. The prompt
 *  text never leaks — only a sha256-16 digest of the composed instructions. */
export interface CuaLanePlanEntry {
  id: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  /** 1-based display index. */
  index: number;
  persona: string;
  device: string;
  resolution: [number, number];
  instructionDigest: string;
  /** Present only when a lane overrides subject.appUrl; digest avoids leaking preview hosts in plan logs. */
  targetDigest?: string;
}

/** The pre-flight spend/lane plan (pure; printed to stderr + recorded as a bundle event before
 *  any sandbox or provider call; identical in dry-run, marked $0). */
export interface CuaLanePlan {
  strategy: typeof CUA_FANOUT_STRATEGY;
  laneCount: number;
  /** Effective in-flight bound (config default min(N,3), only LOWERED by the env override). */
  concurrency: number;
  /** ceil(laneCount / concurrency). */
  waves: number;
  /** Per-lane session wall-clock budget (execution.timeoutMs); there is no run-level wall clock. */
  perLaneSessionBudgetMs: number;
  /** Worst-case TOTAL sandbox-minutes across all lanes (each lane's full sandbox deadline). */
  worstCaseSandboxMinutes: number;
  /** True for a dry-run plan (no spend); the same table appears live. */
  dryRun: boolean;
  lanes: CuaLanePlanEntry[];
}

/** One lane's outcome in the result projection. ALWAYS present in `result.lanes` (length 1 at
 *  N=1). A `blocked` lane is one the pipeline-gate / fail-fast skipped before it ran. */
export interface CuaLaneResult {
  id: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  index: number;
  persona: string;
  device: string;
  resolution: [number, number];
  /** Terminal lane status; "blocked" = skipped (gate/fail-fast); "contract_proof_only" = dry-run. */
  status: ActorStatus | "blocked" | "contract_proof_only";
  ok: boolean;
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
    screenshots: number;
  };
  sandbox?: {
    sandboxId: string;
    killed: boolean;
    streamUrlPresent: boolean;
  };
  subject: CuaSubjectProjection;
  /** Set when the lane was skipped (pinned reason string). */
  skippedReason?: string;
  error?: { code: CuaActorLabErrorCode; message: string };
}

/** Aggregate counts across lanes. */
export interface CuaLaneSummary {
  strategy: typeof CUA_FANOUT_STRATEGY;
  total: number;
  /** Lanes whose own verdict is ok (terminal, engaged, no harness error). */
  passed: number;
  /** Lanes skipped by the pipeline gate / fail-fast. */
  skipped: number;
  /** Lanes that ended in a harness error. */
  harnessErrors: number;
  /** Lanes that returned goal_satisfied with zero engagement (hollow). */
  hollow: number;
  concurrency: number;
  waves: number;
}

export type CuaActorLabErrorCode =
  | "MIMETIC_CUA_LAB_FAILED"
  | "MIMETIC_CUA_LAB_KEYS_MISSING"
  | "MIMETIC_CUA_LAB_SUBJECT_ENV_MISSING"
  | "MIMETIC_CUA_LAB_ACTOR_UNSUPPORTED"
  | "MIMETIC_CUA_LAB_SUBJECT_INVALID"
  | "MIMETIC_CUA_LAB_SUBJECT_UNSAFE"
  | "MIMETIC_CUA_LAB_EXECUTOR_NO_PROVIDER"
  | "MIMETIC_CUA_LAB_LOCAL_APP_NO_EXECUTOR"
  | "MIMETIC_CUA_LAB_FANOUT_INVALID"
  | "MIMETIC_CUA_LAB_RERUN_INVALID"
  | "MIMETIC_CUA_LAB_DEVICE_GEOMETRY";

/** Subject provenance projection (invariant 5): what the actor actually drove. */
export interface CuaSubjectProjection {
  source: "app-url" | "clone";
  repo?: string;
  /** Cloned commit SHA, when the clone route resolved one. */
  commit?: string;
  /** Declared env NAMES provisioned for the subject (values never surface anywhere). */
  envNames?: string[];
  /** The subject's state story (seeded digests / UNPINNED external / declared-not-run /
   *  undeclared) — the same block the run bundle records. */
  state: RunSubjectProvenance["state"];
}

export interface CuaActorLabResult {
  schema: typeof CUA_ACTOR_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or the session reached a terminal verdict
   * without a harness error). The actor's pass/fail is evidence, not the lab's exit code. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the session. */
  actor: string;
  appUrl: string;
  dryRun: boolean;
  runId: string;
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
    screenshots: number;
  };
  sandbox?: {
    sandboxId: string;
    killed: boolean;
    /** The stream URL itself (carries an auth key) is runtime-only and is deliberately NOT
     * surfaced on the result — the sandbox is already dead by the time the result exists. */
    streamUrlPresent: boolean;
  };
  /** Subject provenance (invariant 5): what the actor actually drove. At N>1 this is the
   *  unanimity-gated aggregate (top-level `commit` only when every lane resolved the same one). */
  subject?: CuaSubjectProjection;
  /** The pre-flight lane plan (present once lanes resolve; absent on early validation errors). */
  plan?: CuaLanePlan;
  /** Per-lane results — ALWAYS present once lanes resolve (length 1 at N=1). */
  lanes?: CuaLaneResult[];
  /** Aggregate lane counts. */
  laneSummary?: CuaLaneSummary;
  /** Present when this run explicitly re-executes selected lanes from a prior CUA fan-out run. */
  rerun?: RunRerunLineage;
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code: CuaActorLabErrorCode;
    message: string;
  };
}

const DEFAULT_MISSION =
  "You are testing a web application. The browser is already open at the subject URL. Explore it, accomplish what the scenario asks, and stop when done.";

/** A fully-resolved fan-out lane: identity, the composed prompt, and the device geometry it
 *  renders at. Internal — the public projection is CuaLanePlanEntry / CuaLaneResult. */
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
  /** App-url fan-out only: this lane's explicit browser target; absent falls back to deps.appUrl. */
  targetUrl?: string;
  /** Deterministic harness-owned completion guard. Lane-level override, else actor default. */
  stopWhen?: StopWhen;
  deviceName: string;
  devicePreset: DevicePreset;
  resolution: [number, number];
  /** "" for N=1 (screenshots/<name>); the laneId for N>1 (screenshots/<laneId>/<name>). */
  screenshotDir: string;
  /** "actor.json" for N=1; "actors/<streamId>.json" for N>1. */
  traceArtifactPath: string;
}

/** Compose one lane's actor prompt: persona line + device line + mission + per-lane steer.
 *  At N=1 (homogeneous, no roster) this reproduces the prior composeInstructions byte-for-byte. */
export function composeLaneInstructions(args: {
  mission: string;
  persona?: string;
  instruction?: string;
  device: { name: string; preset: DevicePreset };
}): { instructions: string; persona: ActorPersonaRef } {
  const { name, preset } = args.device;
  const deviceLine = preset.isMobile
    ? `You are a mobile user on a ${name} device (${preset.width}x${preset.height} @${preset.deviceScaleFactor}x). Expect a mobile/touch layout.`
    : `You are a desktop user (${name}, ${preset.width}x${preset.height}).`;
  const parts = [
    args.persona ? `Persona: ${args.persona}.` : undefined,
    deviceLine,
    args.mission,
    args.instruction ? `Lane focus: ${args.instruction}` : undefined
  ].filter((part): part is string => Boolean(part));
  const instructions = parts.join("\n\n");
  return {
    instructions,
    persona: {
      id: args.persona ?? "cua-operator",
      traitsApplied: [],
      promptDigest: createHash("sha256").update(instructions).digest("hex").slice(0, 16)
    }
  };
}

/**
 * Resolve a lane's device + rendered resolution (most-specific wins, exactly as the single-lane
 * path always has): a raw execution.desktop.resolution escape hatch (only legal when no lane
 * sets a device — XOR enforced at parse) → the lane's named device → the run-wide
 * execution.desktop.device → the default preset. A raw resolution is an unnamed custom desktop
 * (non-mobile, DSF 1): we never claim a named preset's mobile/DPR for hand-set geometry.
 */
export function resolveLaneDevice(config: LabConfig, lane: LabActorLane | undefined): {
  name: string;
  preset: DevicePreset;
  resolution: [number, number];
} {
  const rawResolution = config.execution?.desktop?.resolution;
  if (lane?.device === undefined && rawResolution) {
    const preset: DevicePreset = { width: rawResolution[0], height: rawResolution[1], isMobile: false, deviceScaleFactor: 1 };
    return { name: "custom", preset, resolution: [rawResolution[0], rawResolution[1]] };
  }
  const candidate = lane?.device ?? config.execution?.desktop?.device;
  const presetName = isDevicePresetName(candidate) ? candidate : DEFAULT_DEVICE_PRESET;
  const preset = resolveDevicePreset(presetName);
  return { name: presetName, preset, resolution: [preset.width, preset.height] };
}

/** Per-lane sandbox deadline (each lane owns its own desktop). Mirrors the single-lane formula
 *  verbatim so N=1 stays byte-stable: explicit sandboxTimeoutMs, else session budget + (clone:
 *  provision budget + Σ state-step budgets) + the server-side reclamation buffer. */
function resolvePerLaneSandboxMs(config: LabConfig): number {
  const timeoutMs = config.execution?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const cloneRoute = config.subject.source === "clone";
  const stateBudgetMs = cloneRoute
    ? (config.subject.state?.seed ?? []).reduce((sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0)
    : 0;
  return config.execution?.desktop?.sandboxTimeoutMs
    ?? timeoutMs + (cloneRoute ? SUBJECT_PROVISION_BUDGET_MS + stateBudgetMs : 0) + SANDBOX_TIMEOUT_BUFFER_MS;
}

/**
 * Effective in-flight lane bound. Default min(laneCount, 3); a declared execution.concurrency
 * clamps to [1, laneCount]; the env override may only LOWER it (never raise concurrent paid
 * desktops — invariant 3). Pure given (config, laneCount, env).
 */
function resolveCuaConcurrency(config: LabConfig, laneCount: number, env: Record<string, string | undefined>): number {
  const declared = config.execution?.concurrency;
  const base = declared !== undefined
    ? Math.min(Math.max(1, declared), laneCount)
    : Math.min(laneCount, DEFAULT_CUA_CONCURRENCY);
  const envLower = readPositiveInt(env[CUA_MAX_CONCURRENCY_ENV], 0);
  if (envLower > 0) {
    return Math.max(1, Math.min(base, envLower, laneCount));
  }
  return Math.max(1, base);
}

interface LaneSpecsAndPlan {
  lanes: CuaLaneSpec[];
  plan: CuaLanePlan;
}

/** Build the lane specs AND the public plan from a config (pure). countOverride is the CLI
 *  --count for homogeneous fan-out (ignored when a `lanes` roster is declared). */
function laneSpecsAndPlan(
  config: LabConfig,
  opts: { countOverride?: number; env?: Record<string, string | undefined>; dryRun?: boolean } = {}
): LaneSpecsAndPlan {
  const env = opts.env ?? {};
  const actor = config.actors[0];
  const mission = actor?.mission ?? DEFAULT_MISSION;
  const roster = actor?.lanes;
  const laneCount = roster ? roster.length : Math.max(1, opts.countOverride ?? actor?.count ?? 1);

  const lanes: CuaLaneSpec[] = [];
  for (let i = 0; i < laneCount; i += 1) {
    const lane = roster?.[i];
    const laneId = lane?.id ?? `lane-${String(i + 1).padStart(2, "0")}`;
    const simId = `sim-${String(i + 1).padStart(3, "0")}`;
    const streamId = `stream-${String(i + 1).padStart(3, "0")}`;
    const device = resolveLaneDevice(config, lane);
    const composed = composeLaneInstructions({
      mission,
      ...(((roster ? lane?.persona : actor?.persona)) === undefined ? {} : { persona: (roster ? lane?.persona : actor?.persona) as string }),
      ...(((roster ? lane?.instruction : actor?.laneFocus?.instruction)) === undefined ? {} : { instruction: (roster ? lane?.instruction : actor?.laneFocus?.instruction) as string }),
      device: { name: device.name, preset: device.preset }
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
      ...(lane?.target === undefined ? {} : { targetUrl: lane.target }),
      ...((lane?.stopWhen ?? actor?.stopWhen) === undefined ? {} : { stopWhen: (lane?.stopWhen ?? actor?.stopWhen) as StopWhen }),
      deviceName: device.name,
      devicePreset: device.preset,
      resolution: device.resolution,
      screenshotDir: laneCount === 1 ? "" : laneId,
      traceArtifactPath: laneCount === 1 ? "actor.json" : `actors/${streamId}.json`
    });
  }

  const concurrency = resolveCuaConcurrency(config, laneCount, env);
  const perLaneSessionBudgetMs = config.execution?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const perLaneSandboxMs = resolvePerLaneSandboxMs(config);
  const plan: CuaLanePlan = {
    strategy: CUA_FANOUT_STRATEGY,
    laneCount,
    concurrency,
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
      ...(spec.targetUrl === undefined ? {} : { targetDigest: digestUrl(spec.targetUrl) })
    }))
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
    return { ok: false, message: `source run ${bundle.runId} is ${bundle.mode}; rerun selection only applies to live CUA fan-out evidence.` };
  }
  const fanoutEvent = bundle.events.some((event) => event.type === "cua-lab.fanout.plan");
  if (!fanoutEvent || bundle.streams.length < 2) {
    return { ok: false, message: `source run ${bundle.runId} is not a CUA fan-out run.` };
  }

  const prior = bundle.streams
    .map(snapshotPriorCuaLane)
    .filter((lane): lane is ReturnType<typeof snapshotPriorCuaLane> & { laneId: string } => lane !== null);
  const priorById = new Map(prior.map((lane) => [lane.laneId, lane]));
  if (priorById.size < 2) {
    return { ok: false, message: `source run ${bundle.runId} does not expose multiple lane ids.` };
  }

  const explicitLaneIds = uniqueLaneIds(args.laneIds ?? []);
  const selectedLaneIds = explicitLaneIds.length > 0
    ? explicitLaneIds
    : prior.filter((lane) => lane.rerunnable).map((lane) => lane.laneId);
  if (selectedLaneIds.length === 0) {
    return { ok: false, message: `source run ${bundle.runId} has no failed, blocked, timed-out, or hollow lanes to rerun.` };
  }

  const missingPrior = selectedLaneIds.filter((laneId) => !priorById.has(laneId));
  if (missingPrior.length > 0) {
    return { ok: false, message: `selected lane id(s) were not present in source run ${bundle.runId}: ${missingPrior.join(", ")}` };
  }

  const specsById = new Map(args.laneSpecs.map((spec) => [spec.laneId, spec]));
  const missingCurrent = selectedLaneIds.filter((laneId) => !specsById.has(laneId));
  if (missingCurrent.length > 0) {
    return { ok: false, message: `selected lane id(s) are not present in the current lab config ${args.config.id}: ${missingCurrent.join(", ")}` };
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
    worstCaseSandboxMinutes: Math.round((selectedSpecs.length * resolvePerLaneSandboxMs(args.config)) / 60_000),
    lanes: selectedPlanEntries
  };

  const previous = selectedLaneIds.map((laneId) => priorById.get(laneId)!.previous);
  return {
    ok: true,
    laneSpecs: selectedSpecs,
    plan,
    rerun: {
      sourceRunId: bundle.runId,
      selectedLaneIds,
      previous
    }
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

function snapshotPriorCuaLane(stream: RunStream): { laneId: string; previous: RunRerunLineage["previous"][number]; rerunnable: boolean } | null {
  if (stream.kind !== "browser" || typeof stream.laneId !== "string" || !stream.laneId.trim()) {
    return null;
  }
  const actorStatus = stream.actor?.status;
  const completionReason = stream.actor?.completionReason;
  const reason = stream.ui?.state ?? stream.actor?.reason;
  const actions = stream.actor?.counts.actions ?? 0;
  const messages = stream.actor?.counts.messages ?? 0;
  const hollow = completionReason === "goal_satisfied" && actions === 0 && messages === 0;
  const rerunnable = stream.status !== "passed"
    || actorStatus === "failed"
    || actorStatus === "blocked"
    || actorStatus === "timed_out"
    || completionReason === "harness_error"
    || hollow;
  return {
    laneId: stream.laneId,
    previous: {
      laneId: stream.laneId,
      streamId: stream.id,
      status: stream.status,
      ...(reason === undefined ? {} : { reason }),
      ...(actorStatus === undefined ? {} : { actorStatus }),
      ...(completionReason === undefined ? {} : { completionReason })
    },
    rerunnable
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
  opts: { countOverride?: number; env?: Record<string, string | undefined>; dryRun?: boolean } = {}
): CuaLanePlan {
  return laneSpecsAndPlan(config, opts).plan;
}

/** Print the lane plan to stderr BEFORE any sandbox/provider call (public-safe: ids, devices,
 *  digests, and budgets only — no prompt text, no secrets). */
function emitPreflightPlan(plan: CuaLanePlan, labId: string): void {
  const lines: string[] = [];
  lines.push(
    `mimetic cua fan-out plan (${labId}): ${plan.laneCount} lane(s), strategy ${plan.strategy}, concurrency ${plan.concurrency}, ${plan.waves} wave(s).`
  );
  lines.push(
    `  per-lane session budget ${Math.round(plan.perLaneSessionBudgetMs / 1000)}s; worst-case ~${plan.worstCaseSandboxMinutes} sandbox-minutes total${plan.dryRun ? " (dry-run: $0)" : ""}.`
  );
  for (const lane of plan.lanes) {
    lines.push(`  - ${formatLanePlanEntry(lane)}`);
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

function formatLanePlanEntry(lane: CuaLanePlanEntry): string {
  const taxonomy = [
    lane.actorType ? `type=${lane.actorType}` : undefined,
    lane.surface ? `surface=${lane.surface}` : undefined,
    lane.caseGroup ? `case=${lane.caseGroup}` : undefined
  ].filter((part): part is string => part !== undefined);
  return `${lane.id}: persona=${lane.persona}${taxonomy.length > 0 ? ` ${taxonomy.join(" ")}` : ""} device=${lane.device} ${lane.resolution[0]}x${lane.resolution[1]} prompt#${lane.instructionDigest}${lane.targetDigest ? ` target#${lane.targetDigest}` : ""}`;
}

/** Shared deps every lane runner needs (resolved once in the engine). */
export interface CuaLaneDeps {
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  cloneRoute: boolean;
  serve?: LabSubjectServe;
  subjectRepo?: string;
  subjectEnvNames: string[];
  hasGithubToken: boolean;
  env: Record<string, string | undefined>;
  openaiApiKey: string;
  e2bApiKey: string;
  requestTimeoutMs: number;
  perLaneSandboxMs: number;
  timeoutMs: number;
  laneCount: number;
  artifactRoot: string;
  redactScreenshots: boolean;
  scrubKnownValues: (text: string) => string;
  runSession: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  hooks: CuaActorLabHooks;
  /** Lane-0 only: signal the pipeline gate after provisioning succeeds (true) or fails (false). */
  signalProvisioned?: (ok: boolean) => void;
}

/** One lane's end-to-end run outcome (internal; projected into CuaLaneResult + the bundle). */
export interface LaneRunOutcome {
  spec: CuaLaneSpec;
  session?: CuaLoopResult;
  sessionError?: string;
  sandboxId?: string;
  killed: boolean;
  streamUrlPresent: boolean;
  screenshots: string[];
  subjectCommit?: string;
  desktopBrowser?: DesktopBrowserEvidence;
  stateStepRecords: RunSubjectStateStepRecord[];
  warnings: string[];
  /** Set when the lane was skipped by the pipeline gate / fail-fast (a pinned reason). */
  skippedReason?: string;
  noEngagement: boolean;
  selfReportedBlocker: boolean;
  harnessError: boolean;
  failureCode?: CuaActorLabErrorCode;
  entryKind?: "local-app";
}

/** Build a lane's writeScreenshot closure: writes under screenshots/<screenshotDir>/ and records
 *  the relative path the trace references (screenshots/<name> at N=1; screenshots/<laneId>/<name>
 *  at N>1). */
export function makeLaneWriteScreenshot(
  artifactRoot: string,
  spec: { screenshotDir: string },
  screenshots: string[]
): (name: string, bytes: Buffer) => Promise<string> {
  const dirParts = spec.screenshotDir ? ["screenshots", spec.screenshotDir] : ["screenshots"];
  const relPrefix = spec.screenshotDir ? path.posix.join("screenshots", spec.screenshotDir) : "screenshots";
  return async (name: string, bytes: Buffer): Promise<string> => {
    const rel = path.posix.join(relPrefix, name);
    assertScreenshotEvidence(rel, bytes);
    await mkdir(path.join(artifactRoot, ...dirParts), { recursive: true });
    await writeFile(path.join(artifactRoot, ...dirParts, name), bytes);
    screenshots.push(rel);
    return rel;
  };
}

/**
 * Verify the desktop geometry IN-SANDBOX (the per-lane device claim is checked, never assumed).
 * Returns a fail-closed DEVICE_GEOMETRY message on a PARSEABLE mismatch. When xdpyinfo is
 * unavailable or unparseable (only in fakes — a real E2B desktop always answers), it cannot be
 * verified, so the lane proceeds with the requested geometry (no false failure).
 */
async function checkLaneGeometry(
  desktop: E2BDesktopSandbox,
  spec: CuaLaneSpec,
  requestTimeoutMs: number
): Promise<string | undefined> {
  let out = "";
  try {
    const result = await desktop.commands.run("xdpyinfo 2>/dev/null | grep -i dimensions || true", { requestTimeoutMs });
    out = (result.stdout ?? "").trim();
  } catch {
    return undefined;
  }
  const match = out.match(/(\d+)\s*x\s*(\d+)\s*pixels/i);
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const [expectedWidth, expectedHeight] = spec.resolution;
  if (width === expectedWidth && height === expectedHeight) {
    return undefined;
  }
  return `MIMETIC_CUA_LAB_DEVICE_GEOMETRY: lane ${spec.laneId} requested a ${expectedWidth}x${expectedHeight} desktop but xdpyinfo reports ${width}x${height} in-sandbox; the per-lane device geometry is unverified (fail-closed).`;
}

/** A blocked lane outcome (pipeline gate / fail-fast skipped it before it ran). */
function blockedLaneOutcome(spec: CuaLaneSpec, reason: string): LaneRunOutcome {
  return {
    spec,
    killed: false,
    streamUrlPresent: false,
    screenshots: [],
    stateStepRecords: [],
    warnings: [],
    skippedReason: reason,
    noEngagement: false,
    selfReportedBlocker: false,
    harnessError: false
  };
}

async function findVisibleBrowserWindowId(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number
): Promise<string | undefined> {
  const result = await desktop.commands.run([
    "set -euo pipefail",
    "export DISPLAY=\"${DISPLAY:-:0}\"",
    "find_chrome_window() {",
    "  timeout 2s xdotool search --onlyvisible --class 'google-chrome|Google-chrome|chromium|Chromium|chrome|Chrome' 2>/dev/null | tail -n 1 || true",
    "}",
    "find_firefox_window() {",
    "  timeout 2s xdotool search --onlyvisible --class 'firefox|Firefox' 2>/dev/null | tail -n 1 || true",
    "}",
    "find_named_window() {",
    "  timeout 2s xdotool search --onlyvisible --name 'Google Chrome|Chromium|Mozilla Firefox|127[.]0[.]0[.]1|localhost|e2b[.]app|e2b[.]dev' 2>/dev/null | tail -n 1 || true",
    "}",
    "window_id=",
    "for _ in $(seq 1 10); do",
    "  window_id=\"$(find_chrome_window)\"",
    "  if [ -z \"$window_id\" ]; then window_id=\"$(find_firefox_window)\"; fi",
    "  if [ -z \"$window_id\" ]; then window_id=\"$(find_named_window)\"; fi",
    "  if [ -n \"$window_id\" ]; then break; fi",
    "  sleep 0.5",
    "done",
    "if [ -n \"$window_id\" ]; then printf 'WINDOW_ID=%s\\n' \"$window_id\"; fi"
  ].join("\n"), {
    requestTimeoutMs,
    timeoutMs: 15_000
  });
  return (result.stdout ?? "").match(/^WINDOW_ID=(\S+)$/m)?.[1];
}

async function openDesktopBrowserTarget(
  desktop: E2BDesktopSandbox,
  targetUrl: string,
  requestTimeoutMs: number,
  browserPreference: LabDesktopBrowser | undefined
): Promise<DesktopBrowserEvidence | undefined> {
  const requestedBrowser = browserPreference ?? "default";
  if (isHttpUrl(targetUrl)) {
    const result = await desktop.commands.run([
      "set -euo pipefail",
      `target_url=${shellSingleQuote(targetUrl)}`,
      `browser_preference=${shellSingleQuote(requestedBrowser)}`,
      "launch_browser() {",
      "  local label=\"$1\"",
      "  local binary=\"$2\"",
      "  shift 2",
      "  if command -v \"$binary\" >/dev/null 2>&1; then",
      "    nohup \"$binary\" \"$@\" \"$target_url\" >/tmp/mimetic-browser-open.log 2>&1 &",
      "    printf 'MIMETIC_BROWSER_RESOLVED=%s\\n' \"$label\"",
      "    return 0",
      "  fi",
      "  return 1",
      "}",
      "chrome_debug_flags=(--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/mimetic-chrome-profile --no-first-run --no-default-browser-check --disable-default-apps)",
      "open_target() {",
      "  case \"$browser_preference\" in",
      "    chrome)",
      "      launch_browser google-chrome google-chrome --new-window \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser google-chrome-stable google-chrome-stable --new-window \"${chrome_debug_flags[@]}\" && return 0",
      "      echo 'requested browser chrome was not found' >&2",
      "      return 127",
      "      ;;",
      "    chromium)",
      "      launch_browser chromium chromium --new-window \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser chromium-browser chromium-browser --new-window \"${chrome_debug_flags[@]}\" && return 0",
      "      echo 'requested browser chromium was not found' >&2",
      "      return 127",
      "      ;;",
      "    firefox)",
      "      launch_browser firefox firefox --new-window && return 0",
      "      echo 'requested browser firefox was not found' >&2",
      "      return 127",
    "      ;;",
    "    default)",
    "      launch_browser google-chrome google-chrome --new-window \"${chrome_debug_flags[@]}\" && return 0",
    "      launch_browser google-chrome-stable google-chrome-stable --new-window \"${chrome_debug_flags[@]}\" && return 0",
    "      launch_browser chromium chromium --new-window \"${chrome_debug_flags[@]}\" && return 0",
    "      launch_browser chromium-browser chromium-browser --new-window \"${chrome_debug_flags[@]}\" && return 0",
    "      launch_browser firefox firefox --new-window && return 0",
    "      launch_browser xdg-open xdg-open && return 0",
    "      echo 'no browser opener found' >&2",
    "      return 127",
    "      ;;",
      "  esac",
      "}",
      "open_target"
    ].join("\n"), {
      requestTimeoutMs,
      timeoutMs: 15_000
    });
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      throw new Error(`browser launch failed with exit ${result.exitCode}: ${tailOf(result.stderr ?? result.stdout ?? "")}`);
    }
    const resolved = (result.stdout ?? "").match(/^MIMETIC_BROWSER_RESOLVED=(\S+)$/m)?.[1];
    return browserPreference === undefined ? undefined : {
      requested: requestedBrowser,
      ...(resolved === undefined ? {} : { resolved })
    };
  }

  if (browserPreference === undefined || browserPreference === "default") {
    if (desktop.open) {
      await desktop.open(targetUrl);
    } else {
      await desktop.launch("google-chrome", targetUrl);
    }
    return browserPreference === undefined ? undefined : { requested: requestedBrowser };
  }

  const launchTarget = requestedBrowser === "chrome" ? "google-chrome"
    : requestedBrowser === "chromium" ? "chromium"
      : requestedBrowser === "firefox" ? "firefox"
        : "google-chrome";
  await desktop.launch(launchTarget, targetUrl);
  return { requested: requestedBrowser, resolved: launchTarget };
}

export function makeChromeBrowserStateObserver(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number
): () => Promise<{ url?: string; title?: string; text?: string }> {
  return async () => {
    const script = [
      "const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json()).catch(() => []);",
      "const page = Array.isArray(pages) ? pages.find((entry) => entry && entry.type === 'page' && /^https?:/.test(String(entry.url || ''))) : undefined;",
      "if (!page) { console.log('{}'); process.exit(0); }",
      "let text = '';",
      "let url = String(page.url || '');",
      "let title = String(page.title || '');",
      "if (typeof WebSocket === 'function' && page.webSocketDebuggerUrl) {",
      "  const ws = new WebSocket(page.webSocketDebuggerUrl);",
      "  const result = await new Promise((resolve) => {",
      "    const timer = setTimeout(() => resolve(undefined), 1500);",
      "    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: '({ url: location.href, title: document.title, text: (document.body && document.body.innerText || \"\").slice(0, 20000) })' } }));",
      "    ws.onmessage = (event) => {",
      "      try {",
      "        const payload = JSON.parse(String(event.data));",
      "        if (payload.id !== 1) return;",
      "        clearTimeout(timer);",
      "        resolve(payload.result && payload.result.result && payload.result.result.value);",
      "      } catch { clearTimeout(timer); resolve(undefined); }",
      "    };",
      "    ws.onerror = () => { clearTimeout(timer); resolve(undefined); };",
      "  }).finally(() => { try { ws.close(); } catch {} });",
      "  if (result && typeof result === 'object') {",
      "    url = typeof result.url === 'string' ? result.url : url;",
      "    title = typeof result.title === 'string' ? result.title : title;",
      "    text = typeof result.text === 'string' ? result.text : '';",
      "  }",
      "}",
      "console.log(JSON.stringify({ url, title, text }));"
    ].join("\n");
    const result = await desktop.commands.run(`node --input-type=module -e ${shellSingleQuote(script)}`, {
      requestTimeoutMs,
      timeoutMs: 5_000
    });
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      return {};
    }
    try {
      const parsed = JSON.parse((result.stdout ?? "{}").trim() || "{}") as unknown;
      if (!parsed || typeof parsed !== "object") {
        return {};
      }
      const record = parsed as Record<string, unknown>;
      return {
        ...(typeof record.url === "string" && record.url.length > 0 ? { url: record.url } : {}),
        ...(typeof record.title === "string" && record.title.length > 0 ? { title: record.title } : {}),
        ...(typeof record.text === "string" && record.text.length > 0 ? { text: record.text } : {})
      };
    } catch {
      return {};
    }
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function startDesktopStream(
  desktop: E2BDesktopSandbox,
  browserWindowId: string | undefined
): Promise<void> {
  if (!browserWindowId) {
    await desktop.stream.start({ requireAuth: true });
    return;
  }

  try {
    await desktop.stream.start({ requireAuth: true, windowId: browserWindowId });
  } catch {
    await desktop.stream.start({ requireAuth: true });
  }
}

function completionReasonContradictsGoal(reason: string): boolean {
  const text = reason.toLowerCase();
  return /\b(can'?t|cannot|could not|unable|blocked|blocker|failed|invalid|not set)\b/.test(text)
    || /\b(shows|showing|hit|encountered|returned|got)\b.{0,80}\berror\b/.test(text)
    || /\berror[:.]/.test(text)
    || /what would you like me to do|please tell me|need (the )?(task|credentials|instructions)/.test(text);
}

function traceHasStopWhenMatch(session: CuaLoopResult): boolean {
  return session.trace.items.some((item) =>
    item.kind === "notice"
      && item.status === "matched"
      && item.title.startsWith("stopWhen matched"));
}

/**
 * Run ONE E2B desktop lane end-to-end: create the sandbox (per-lane metadata + the lane's device
 * resolution), prepareDesktop, verify geometry, (clone+serve+seed the subject per lane), open the
 * browser, run the session, and ALWAYS tear down THIS lane's sandbox BY ID in a finally. Never
 * enumerates sandboxes. Extracted from the former single-lane block; at N=1 it writes the exact
 * same artifacts (actor.json, screenshots/<name>) the bundle has always referenced.
 */
export async function runCuaLane(spec: CuaLaneSpec, deps: CuaLaneDeps): Promise<LaneRunOutcome> {
  const { config, appUrl, cloneRoute, serve, subjectRepo, subjectEnvNames } = deps;
  const targetUrl = spec.targetUrl ?? appUrl;
  const env = deps.env;
  const warnings: string[] = [];
  const screenshots: string[] = [];
  const writeScreenshot = makeLaneWriteScreenshot(deps.artifactRoot, spec, screenshots);
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  let session: CuaLoopResult | undefined;
  let sessionError: string | undefined;
  let failureCode: CuaActorLabErrorCode | undefined;
  let sandboxId: string | undefined;
  let killed = false;
  let streamUrl: string | undefined;
  let subjectCommit: string | undefined;
  let desktopBrowser: DesktopBrowserEvidence | undefined;
  let provisioned = false;
  let signaled = false;
  const signal = (ok: boolean): void => {
    if (!signaled && deps.signalProvisioned) {
      signaled = true;
      deps.signalProvisioned(ok);
    }
  };

  let desktopModule: E2BDesktopModule | undefined;
  let desktop: E2BDesktopSandbox | undefined;
  try {
    desktopModule = await (deps.hooks.loadDesktopModule ?? loadE2BDesktopModule)();
    // Optional custom desktop template (image): present → Sandbox.create(template, opts); absent →
    // the byte-stable Sandbox.create(opts) default (stock `desktop` template).
    desktop = await createDesktopSandbox(desktopModule, {
      apiKey: deps.e2bApiKey,
      requestTimeoutMs: deps.requestTimeoutMs,
      timeoutMs: deps.perLaneSandboxMs,
      metadata: {
        ...CUA_ACTOR_LAB_PROVIDER_METADATA,
        labId: config.id,
        simId: spec.simId,
        laneId: spec.laneId,
        laneIndex: String(spec.laneIndex),
        laneCount: String(deps.laneCount)
      },
      // Env placement per the doctrine: the ACTOR's key never enters the sandbox (the model drives
      // from outside). The SUBJECT's declared env NAMES are provisioned here on the clone route.
      ...(subjectEnvNames.length > 0
        ? { envs: Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])) }
        : {}),
      resolution: spec.resolution,
      dpi: 96,
      lifecycle: { onTimeout: "kill" }
    }, config.execution?.desktop?.template);
    sandboxId = desktop.sandboxId;

    if (deps.hooks.prepareDesktop) {
      await deps.hooks.prepareDesktop(desktop, { laneId: spec.laneId, laneIndex: spec.laneIndex, laneCount: deps.laneCount });
    }

    // Per-lane geometry assertion (fail-closed) — the device claim is verified in-sandbox.
    const geometryError = await checkLaneGeometry(desktop, spec, deps.requestTimeoutMs);
    if (geometryError) {
      sessionError = geometryError;
      failureCode = "MIMETIC_CUA_LAB_DEVICE_GEOMETRY";
    } else {
      if (cloneRoute && serve && subjectRepo) {
        subjectCommit = await provisionCloneSubject(desktop, {
          repo: subjectRepo,
          depth: config.subject.clone?.depth ?? 1,
          serve,
          ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
          hasGithubToken: deps.hasGithubToken,
          requestTimeoutMs: deps.requestTimeoutMs,
          scrub: deps.scrubKnownValues,
          onCommit: (commit) => {
            subjectCommit = commit;
          },
          onStateStep: (record) => {
            stateStepRecords.push(record);
          },
          ...(deps.hooks.detachedTimers ?? {})
        });
      }

      desktopBrowser = await openDesktopBrowserTarget(
        desktop,
        targetUrl,
        deps.requestTimeoutMs,
        config.execution?.desktop?.browser
      );
      await desktop.wait(BROWSER_SETTLE_MS).catch(() => undefined);

      // World is ready: release the pipeline gate so the remaining lanes may start.
      provisioned = true;
      signal(true);

      try {
        const browserWindowId = await findVisibleBrowserWindowId(desktop, deps.requestTimeoutMs)
          .catch((error: unknown) => {
            warnings.push(`Browser window lookup failed before live stream start (falling back to desktop stream): ${redactText(deps.scrubKnownValues(compactError(error)))}`);
            return undefined;
          });
        await startDesktopStream(desktop, browserWindowId);
        const candidateStreamUrl: unknown = desktop.stream.getUrl({
          authKey: desktop.stream.getAuthKey(),
          autoConnect: true,
          viewOnly: true,
          resize: "scale"
        });
        if (typeof candidateStreamUrl === "string" && candidateStreamUrl.trim().length > 0) {
          streamUrl = candidateStreamUrl;
          await deps.hooks.onRuntimeStreamReady?.({
            laneId: spec.laneId,
            sandboxId: desktop.sandboxId,
            simId: spec.simId,
            streamId: spec.streamId,
            url: streamUrl
          });
        } else {
          warnings.push("Live desktop stream started but did not return a usable watch URL; Observer will fall back to screenshots.");
        }
      } catch (error) {
        warnings.push(`Live desktop stream unavailable (run continues; evidence still captured): ${redactText(deps.scrubKnownValues(compactError(error)))}`);
      }

      const sessionOptions: CuaActorSessionOptions = {
        instructions: spec.instructions,
        persona: spec.persona,
        timeoutMs: deps.timeoutMs,
        openai: {
          apiKey: deps.openaiApiKey,
          ...(config.actors[0]?.model ? { model: config.actors[0]!.model } : {})
        },
        desktop: desktop as unknown as E2BDesktopLike,
        executorOptions: {
          observeBrowserState: makeChromeBrowserStateObserver(desktop, deps.requestTimeoutMs)
        },
        redactScreenshots: deps.redactScreenshots,
        scrubText: deps.scrubKnownValues,
        writeScreenshot,
        ...(spec.stopWhen === undefined ? {} : { stopWhen: spec.stopWhen })
      };
      session = await deps.runSession(sessionOptions);
    }
  } catch (error) {
    sessionError = redactText(deps.scrubKnownValues(compactError(error)));
  } finally {
    if (!provisioned) {
      signal(false);
    }
    if (desktop && desktopModule) {
      const failed = sessionError !== undefined || session === undefined;
      const keepForDebug = config.subject.clone?.keep === true && failed;
      if (keepForDebug) {
        warnings.push(`Sandbox ${desktop.sandboxId} kept for debugging (subject.clone.keep on failure); reclaim it via E2B or it will be killed on its server-side timeout.`);
      } else if (typeof desktopModule.Sandbox.kill === "function") {
        try {
          await desktopModule.Sandbox.kill(desktop.sandboxId, { requestTimeoutMs: 60_000 });
          killed = true;
        } catch (error) {
          warnings.push(`Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(deps.scrubKnownValues(compactError(error)))}`);
        }
      } else {
        warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox.");
      }
    }
  }

  if (session) {
    await mkdir(path.dirname(path.join(deps.artifactRoot, spec.traceArtifactPath)), { recursive: true });
    await writeFile(path.join(deps.artifactRoot, spec.traceArtifactPath), `${JSON.stringify(session.trace, null, 2)}\n`, "utf8");
    if (session.trace.redaction.screenshots === "raw") {
      warnings.push("Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .mimetic and nothing scans these pixels; review them before sharing anywhere. Set policies.redactScreenshots: true to blur a share-as-is bundle.");
    }
  }

  const noEngagement = session !== undefined
    && session.completionReason === "goal_satisfied"
    && (session.trace.counts.actions ?? 0) === 0
    && (session.trace.counts.messages ?? 0) === 0
    && !traceHasStopWhenMatch(session);
  if (noEngagement) {
    warnings.push("Actor returned goal_satisfied with ZERO actions and ZERO messages — it likely saw a blank or still-loading screen and stopped without engaging. NOT counted as a pass. Check the screenshot; raise execution.timeoutMs or confirm the subject painted before the first turn.");
  }

  const blockerReason = session?.completionReason === "goal_satisfied" && completionReasonContradictsGoal(session.reason)
    ? session.reason
    : undefined;
  const selfReportedBlocker = blockerReason !== undefined;
  if (selfReportedBlocker) {
    warnings.push(`Actor returned goal_satisfied while its final message describes a blocker or asks for missing instructions — NOT counted as a pass: ${redactText(deps.scrubKnownValues(blockerReason))}`);
  }

  const harnessError = sessionError !== undefined || session?.completionReason === "harness_error";

  return {
    spec,
    ...(session ? { session } : {}),
    ...(sessionError === undefined ? {} : { sessionError }),
    ...(sandboxId === undefined ? {} : { sandboxId }),
    killed,
    streamUrlPresent: streamUrl !== undefined,
    screenshots,
    ...(subjectCommit === undefined ? {} : { subjectCommit }),
    ...(desktopBrowser === undefined ? {} : { desktopBrowser }),
    stateStepRecords,
    warnings,
    noEngagement,
    selfReportedBlocker,
    harnessError,
    ...(failureCode === undefined ? {} : { failureCode })
  };
}

/** Run the single IN-PROCESS lane (a custom executor + provider; NO E2B). Always one lane. */
async function runInProcessLane(spec: CuaLaneSpec, deps: CuaLaneDeps): Promise<LaneRunOutcome> {
  const warnings: string[] = [];
  const screenshots: string[] = [];
  const writeScreenshot = makeLaneWriteScreenshot(deps.artifactRoot, spec, screenshots);
  let session: CuaLoopResult | undefined;
  let sessionError: string | undefined;
  try {
    const executor = await deps.hooks.buildExecutor!({ config: deps.config, actor: deps.descriptor, appUrl: deps.appUrl });
    const provider = await deps.hooks.buildProvider!({ config: deps.config, actor: deps.descriptor });
    const sessionOptions: CuaActorSessionOptions = {
      instructions: spec.instructions,
      persona: spec.persona,
      timeoutMs: deps.timeoutMs,
      provider,
      executor,
      redactScreenshots: deps.redactScreenshots,
      scrubText: deps.scrubKnownValues,
      writeScreenshot,
      ...(spec.stopWhen === undefined ? {} : { stopWhen: spec.stopWhen })
    };
    session = await deps.runSession(sessionOptions);
  } catch (error) {
    sessionError = redactText(deps.scrubKnownValues(compactError(error)));
  }

  if (session) {
    await mkdir(path.dirname(path.join(deps.artifactRoot, spec.traceArtifactPath)), { recursive: true });
    await writeFile(path.join(deps.artifactRoot, spec.traceArtifactPath), `${JSON.stringify(session.trace, null, 2)}\n`, "utf8");
    if (session.trace.redaction.screenshots === "raw") {
      warnings.push("Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .mimetic and nothing scans these pixels; review them before sharing anywhere. Set policies.redactScreenshots: true to blur a share-as-is bundle.");
    }
  }

  const noEngagement = session !== undefined
    && session.completionReason === "goal_satisfied"
    && (session.trace.counts.actions ?? 0) === 0
    && (session.trace.counts.messages ?? 0) === 0
    && !traceHasStopWhenMatch(session);
  if (noEngagement) {
    warnings.push("Actor returned goal_satisfied with ZERO actions and ZERO messages — it likely saw a blank or still-loading screen and stopped without engaging. NOT counted as a pass. Check the screenshot; raise execution.timeoutMs or confirm the subject painted before the first turn.");
  }
  const blockerReason = session?.completionReason === "goal_satisfied" && completionReasonContradictsGoal(session.reason)
    ? session.reason
    : undefined;
  const selfReportedBlocker = blockerReason !== undefined;
  if (selfReportedBlocker) {
    warnings.push(`Actor returned goal_satisfied while its final message describes a blocker or asks for missing instructions — NOT counted as a pass: ${blockerReason}`);
  }

  return {
    spec,
    ...(session ? { session } : {}),
    ...(sessionError === undefined ? {} : { sessionError }),
    killed: false,
    streamUrlPresent: false,
    screenshots,
    stateStepRecords: [],
    warnings,
    noEngagement,
    selfReportedBlocker,
    harnessError: sessionError !== undefined || session?.completionReason === "harness_error",
    entryKind: "local-app"
  };
}

/**
 * Run N>1 E2B lanes with bounded concurrency, a pipeline gate (lane 1 provisions before the rest
 * start), and session fail-fast on HARNESS errors only (queued lanes become `blocked` with a
 * pinned reason + a fail-fast event; mission verdicts never trip it). Each lane tears down ITS
 * OWN sandbox by id; nothing here ever enumerates.
 */
async function runCuaLanes(
  laneSpecs: CuaLaneSpec[],
  deps: Omit<CuaLaneDeps, "signalProvisioned">,
  concurrency: number
): Promise<{ outcomes: LaneRunOutcome[]; failFastReason?: string }> {
  const failFast: { tripped: boolean; reason: string } = { tripped: false, reason: "" };
  let resolveGate: (() => void) | undefined;
  let rejectGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = () => reject(new Error("gate"));
  });
  // The gate is rejected on lane-0 provisioning failure; swallow the unhandled rejection if no
  // later lane ever awaits it (concurrency could let lane 0 finish alone).
  gate.catch(() => undefined);

  const outcomes = await mapWithConcurrency(laneSpecs, concurrency, async (spec, index): Promise<LaneRunOutcome> => {
    if (index > 0) {
      try {
        await gate;
      } catch {
        return blockedLaneOutcome(spec, `skipped: lane ${laneSpecs[0]?.laneId ?? "lane-01"} failed to provision its world (pipeline gate)`);
      }
    }
    if (failFast.tripped) {
      return blockedLaneOutcome(spec, `skipped: ${failFast.reason}`);
    }
    const outcome = await runCuaLane(spec, {
      ...deps,
      ...(index === 0
        ? {
            signalProvisioned: (ok: boolean) => {
              if (ok) {
                resolveGate?.();
              } else {
                rejectGate?.();
              }
            }
          }
        : {})
    });
    if (outcome.harnessError && !failFast.tripped) {
      failFast.tripped = true;
      failFast.reason = `a prior lane (${outcome.spec.laneId}) ended in a harness error (fail-fast)`;
    }
    return outcome;
  });

  return { outcomes, ...(failFast.tripped ? { failFastReason: failFast.reason } : {}) };
}

/** Project one lane outcome (or a dry-run contract spec) into the public CuaLaneResult. */
function toLaneResult(spec: CuaLaneSpec, outcome: LaneRunOutcome | undefined, subject: CuaSubjectProjection, dryRun: boolean): CuaLaneResult {
  const base = {
    id: spec.laneId,
    ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
    ...(spec.surface === undefined ? {} : { surface: spec.surface }),
    ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
    index: spec.laneIndex + 1,
    persona: spec.persona.id,
    device: spec.deviceName,
    resolution: spec.resolution,
    subject
  };
  if (!outcome || dryRun) {
    return { ...base, status: "contract_proof_only", ok: dryRun };
  }
  if (outcome.skippedReason !== undefined) {
    return {
      ...base,
      status: "blocked",
      ok: false,
      skippedReason: outcome.skippedReason,
      error: { code: "MIMETIC_CUA_LAB_FAILED", message: outcome.skippedReason }
    };
  }
  const session = outcome.session;
  const laneOk = laneOutcomeOk(outcome, dryRun);
  const status: CuaLaneResult["status"] = session ? session.status : "failed";
  return {
    ...base,
    status,
    ok: laneOk,
    ...(session
      ? {
          session: {
            status: session.status,
            completionReason: session.completionReason,
            reason: session.reason,
            screenshots: outcome.screenshots.length
          }
        }
      : {}),
    ...(outcome.sandboxId === undefined
      ? {}
      : { sandbox: { sandboxId: outcome.sandboxId, killed: outcome.killed, streamUrlPresent: outcome.streamUrlPresent } }),
    ...(laneOk
      ? {}
      : {
          error: {
            code: outcome.failureCode ?? "MIMETIC_CUA_LAB_FAILED",
            message: outcome.sessionError
              ?? (outcome.noEngagement
                ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                : outcome.selfReportedBlocker
                  ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
                : session?.completionReason === "harness_error"
                  ? `Computer-use session ended with a harness error: ${session.reason}`
                  : session?.status !== "passed"
                  ? `Computer-use session ended with ${session?.status ?? "unknown"}: ${session?.reason ?? "no terminal reason"}`
                  : "Computer-use lab did not produce a terminal session.")
          }
        })
  };
}

function laneOutcomeOk(outcome: LaneRunOutcome | undefined, dryRun: boolean): boolean {
  if (dryRun) return true;
  if (!outcome || outcome.skippedReason !== undefined) return false;
  return outcome.session !== undefined
    && outcome.session.status === "passed"
    && outcome.session.completionReason !== "harness_error"
    && outcome.sessionError === undefined
    && !outcome.noEngagement
    && !outcome.selfReportedBlocker;
}

function fanoutReviewVerdict(args: {
  dryRun: boolean;
  expectedLaneCount: number;
  outcomes: LaneRunOutcome[] | undefined;
}): ReviewSummary["verdict"] {
  if (args.dryRun) return "contract_proof_only";
  const outcomes = args.outcomes ?? [];
  if (outcomes.length !== args.expectedLaneCount) return "fail";
  if (outcomes.some((outcome) => !laneOutcomeOk(outcome, false))) {
    return outcomes.some((outcome) => outcome.session?.status === "timed_out")
      ? "timed_out"
      : "fail";
  }
  return "pass";
}

/** Build the per-lane subject projection (invariant 5). */
function laneSubjectProjection(args: {
  cloneRoute: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
  subjectCommit?: string;
  subjectState: RunSubjectProvenance["state"];
}): CuaSubjectProjection {
  return args.cloneRoute && args.publicRepo
    ? {
        source: "clone",
        repo: args.publicRepo,
        ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
        envNames: args.subjectEnvNames,
        state: args.subjectState
      }
    : { source: "app-url", state: args.subjectState };
}

export async function runCuaActorLab(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const render = hooks.renderObserverFn ?? renderObserver;

  const cloneRoute = config.subject.source === "clone";
  const serve = config.subject.serve;
  const appUrl = (cloneRoute ? serve?.url : config.subject.appUrl) ?? "";
  const subjectRepo = cloneRoute ? config.subject.repos?.[0] ?? "" : undefined;
  const subjectEnvNames = cloneRoute ? config.subject.env ?? [] : [];
  const actor = config.actors[0];
  const actorType = actor?.type ?? "";

  const fail = (code: CuaActorLabErrorCode, message: string, actorLabel?: string): CuaActorLabResult => ({
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: actorLabel ?? actorType,
    appUrl,
    dryRun,
    runId: options.runId ?? "not-created",
    lanes: [],
    warnings: [],
    error: { code, message }
  });

  // Resolve the actor through the registry — the parse layer validated this, but the engine fails
  // closed rather than trusting a config that arrived through another door.
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail("MIMETIC_CUA_LAB_ACTOR_UNSUPPORTED", `actors[0].type "${actorType}" is not a registered computer-use actor.`);
  }
  const runSession = hooks.runSession ?? descriptor.runSession;
  const inProcessRoute = hooks.buildExecutor !== undefined;
  const localAppSubject = config.subject.source === "local-app";

  // Engine re-enforcement of the clone-route structure (library API surface).
  if (cloneRoute && (!serve || !subjectRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subjectRepo))) {
    return fail(
      "MIMETIC_CUA_LAB_SUBJECT_INVALID",
      !serve
        ? "clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox."
        : `subject.repos[0] must be an owner/repo slug (got "${subjectRepo ?? ""}").`,
      descriptor.id
    );
  }

  // Engine re-enforcement of the state declaration (library API surface).
  if (config.subject.state) {
    const stateReason = !cloneRoute
      ? "`subject.state` applies only to clone subjects (the lab seeds the state it serves)."
      : subjectStateInvalidReason(config.subject.state, config.subject.env);
    if (stateReason) {
      return fail("MIMETIC_CUA_LAB_SUBJECT_INVALID", stateReason, descriptor.id);
    }
  }

  // Re-enforce the entry-target boundary (library API surface).
  const allowPublicTargets = config.policies?.allowPublicTargets === true;
  const declaredTargets = [appUrl, ...(actor?.lanes ?? []).map((lane) => lane.target).filter((target): target is string => target !== undefined)];
  const entryTargetSafe = declaredTargets.every((target) =>
    cloneRoute || localAppSubject
      ? isLoopbackUrl(target)
      : allowPublicTargets
        ? isHttpUrl(target)
        : isLoopbackUrl(target));
  if (!entryTargetSafe) {
    return fail(
      "MIMETIC_CUA_LAB_SUBJECT_UNSAFE",
      cloneRoute || localAppSubject || !allowPublicTargets
        ? "subject.appUrl and any actors[0].lanes[].target entries must be loopback (127.0.0.1 or localhost) unless policies.allowPublicTargets is set for an app-url subject."
        : "subject.appUrl and actors[0].lanes[].target entries must be valid http(s) URLs.",
      descriptor.id
    );
  }

  // In-process route pairing guard (boot-time, BEFORE key-gating): a custom executor needs a
  // custom provider too (the default OpenAI provider is vision-based and would fail closed).
  if (hooks.buildExecutor !== undefined && hooks.buildProvider === undefined) {
    return fail(
      "MIMETIC_CUA_LAB_EXECUTOR_NO_PROVIDER",
      "cuaHooks.buildExecutor requires cuaHooks.buildProvider — a state-driven executor returns no screenshot, so it must be paired with a NON-vision provider (the default OpenAI computer-use provider is vision-based and would fail closed).",
      descriptor.id
    );
  }

  // local-app fail-closed (BEFORE key-gating): there is no built-in in-process driver.
  if (localAppSubject && !inProcessRoute) {
    return fail(
      "MIMETIC_CUA_LAB_LOCAL_APP_NO_EXECUTOR",
      "subject.source: local-app requires a library caller to supply cuaHooks.buildExecutor + buildProvider; there is no built-in driver for an in-process JS contract. (Drive the app via runLab(..., { cuaHooks: { buildExecutor, buildProvider } }).)",
      descriptor.id
    );
  }

  // Re-enforce the fan-out cross-validation (library API surface): lanes XOR count/laneFocus,
  // device XOR raw resolution, cap, unique ids, allowPublicTargets+N>1, clone.fanout.
  const fanoutReason = cuaLaneValidationReason(config);
  if (fanoutReason) {
    return fail("MIMETIC_CUA_LAB_FANOUT_INVALID", fanoutReason, descriptor.id);
  }

  // Resolve the lane plan (pure) — the SAME table for dry-run and live.
  let { lanes: laneSpecs, plan } = laneSpecsAndPlan(config, {
    ...(options.countOverride === undefined ? {} : { countOverride: options.countOverride }),
    env,
    dryRun
  });
  let laneCount = laneSpecs.length;

  if (laneCount > MAX_CUA_LANES) {
    return fail(
      "MIMETIC_CUA_LAB_FANOUT_INVALID",
      `Computer-use fan-out is capped at ${MAX_CUA_LANES} lanes (resolved ${laneCount}); N concurrent paid desktops is real spend.`,
      descriptor.id
    );
  }
  if (inProcessRoute && laneCount > 1) {
    return fail(
      "MIMETIC_CUA_LAB_FANOUT_INVALID",
      "Multi-lane fan-out is not supported on the in-process route (cuaHooks.buildExecutor) — fan-out provisions one independent E2B desktop per lane, which the in-process route deliberately skips. Run a single in-process lane, or fan out on the E2B route.",
      descriptor.id
    );
  }

  let rerunLineage: RunRerunLineage | undefined;
  if (options.rerun) {
    const selected = await resolveCuaRerunSelection({
      cwd,
      config,
      sourceRunId: options.rerun.sourceRunId,
      ...(options.rerun.laneIds === undefined ? {} : { laneIds: options.rerun.laneIds }),
      laneSpecs,
      plan
    });
    if (!selected.ok) {
      return fail("MIMETIC_CUA_LAB_RERUN_INVALID", selected.message, descriptor.id);
    }
    laneSpecs = selected.laneSpecs;
    plan = selected.plan;
    laneCount = laneSpecs.length;
    rerunLineage = selected.rerun;
  }

  // Pre-flight plan: BEFORE any sandbox or provider call (dry-run AND live). The hook fires for
  // every N (observable + testable); the stderr table prints for fan-out (N>1) so single-lane
  // runs stay as quiet as they always were.
  if (laneCount > 1) {
    emitPreflightPlan(plan, config.id);
  }
  hooks.onPreflight?.(plan);

  // Read keys once into locals (names only; values never logged or persisted).
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  // Literal scrubber for every known provisioned value (no secret "shape" to pattern-match).
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? "")
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = (text: string): string =>
    knownSecretValues.reduce((current, value) => current.split(value).join("[REDACTED_SECRET]"), text);

  const redactRepoLabel = config.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo = cloneRoute && subjectRepo ? (redactRepoLabel ? "repo-01" : subjectRepo) : undefined;
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");

  // Key-gating is route-aware: the in-process route uses the caller's OWN model + executor.
  if (!dryRun && !inProcessRoute) {
    const missingKeys = [
      ...(openaiApiKey ? [] : ["OPENAI_API_KEY"]),
      ...(e2bApiKey ? [] : ["E2B_API_KEY"])
    ];
    if (missingKeys.length > 0) {
      return fail(
        "MIMETIC_CUA_LAB_KEYS_MISSING",
        `Live computer-use labs need ${missingKeys.join(" and ")} in the environment (pass them via --env-file; values are never persisted).`,
        descriptor.id
      );
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail(
        "MIMETIC_CUA_LAB_SUBJECT_ENV_MISSING",
        `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
        descriptor.id
      );
    }
  }

  const runId = options.runId ?? makeCuaRunId();
  const artifactRoot = path.join(cwd, ".mimetic", "runs", runId);
  const createdAt = new Date().toISOString();
  const timeoutMs = config.execution?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const requestTimeoutMs = readPositiveInt(env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;

  await mkdir(path.join(artifactRoot, "screenshots"), { recursive: true });
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    mimeticSource: "present",
    packageName: "mimetic-cli"
  });

  const deps: Omit<CuaLaneDeps, "signalProvisioned"> = {
    config,
    descriptor,
    appUrl,
    cloneRoute,
    ...(serve === undefined ? {} : { serve }),
    ...(subjectRepo === undefined ? {} : { subjectRepo }),
    subjectEnvNames,
    hasGithubToken,
    env,
    openaiApiKey,
    e2bApiKey,
    requestTimeoutMs,
    perLaneSandboxMs: resolvePerLaneSandboxMs(config),
    timeoutMs,
    laneCount,
    artifactRoot,
    redactScreenshots,
    scrubKnownValues,
    runSession,
    hooks
  };

  // Run lanes (dry-run runs none). In-process is always one lane.
  let outcomes: LaneRunOutcome[] | undefined;
  let failFastReason: string | undefined;
  if (!dryRun) {
    if (inProcessRoute) {
      outcomes = [await runInProcessLane(laneSpecs[0]!, deps)];
    } else if (laneCount === 1) {
      outcomes = [await runCuaLane(laneSpecs[0]!, deps)];
    } else {
      const ran = await runCuaLanes(laneSpecs, deps, plan.concurrency);
      outcomes = ran.outcomes;
      failFastReason = ran.failFastReason;
    }
  }

  // Per-lane subject projections (invariant 5).
  const laneSubjects = laneSpecs.map((_spec, index) => {
    const outcome = outcomes?.[index];
    const subjectState = resolveSubjectState({
      declared: cloneRoute ? config.subject.state : undefined,
      dryRun,
      executed: outcome?.stateStepRecords ?? []
    });
    return laneSubjectProjection({
      cloneRoute,
      ...(publicRepo === undefined ? {} : { publicRepo }),
      subjectEnvNames,
      ...(outcome?.subjectCommit === undefined ? {} : { subjectCommit: outcome.subjectCommit }),
      subjectState
    });
  });

  // Aggregate subject (top-level + bundle): unanimity-gated commit (+ divergence warning).
  const aggregateWarnings: string[] = [];
  const aggregateSubject = ((): CuaSubjectProjection => {
    const first = laneSubjects[0]!;
    if (first.source !== "clone") {
      return first;
    }
    const commits = (outcomes ?? []).map((outcome) => outcome.subjectCommit).filter((commit): commit is string => commit !== undefined);
    const unanimous = !dryRun && commits.length === laneCount && new Set(commits).size === 1;
    if (!dryRun && laneCount > 1 && new Set(commits).size > 1) {
      aggregateWarnings.push("Fan-out lanes resolved DIVERGENT subject commits — the top-level subject.commit is omitted; see per-lane provenance in result.lanes for each lane's pinned commit.");
    }
    // Build without commit, then add it only when unanimous (avoids an explicit commit:undefined
    // under exactOptionalPropertyTypes).
    return {
      source: "clone",
      ...(first.repo === undefined ? {} : { repo: first.repo }),
      ...(first.envNames === undefined ? {} : { envNames: first.envNames }),
      state: first.state,
      ...(unanimous && commits[0] !== undefined ? { commit: commits[0] } : {})
    };
  })();

  const bundle = laneCount === 1 && rerunLineage === undefined
    ? buildSingleLaneBundle({
        spec: laneSpecs[0]!,
        outcome: outcomes?.[0],
        descriptor,
        appUrl: laneSpecs[0]!.targetUrl ?? appUrl,
        createdAt,
        dryRun,
        config,
        runId,
        source,
        redactScreenshots,
        ...(aggregateSubject.source === "clone" && publicRepo
          ? {
              subjectProvenance: {
                repo: publicRepo,
                ...(aggregateSubject.commit === undefined ? {} : { commit: aggregateSubject.commit }),
                envNames: subjectEnvNames,
                state: aggregateSubject.state
              }
            }
          : {}),
        inProcessRoute,
        localAppSubject
      })
    : buildCuaFanoutBundle({
        specs: laneSpecs,
        ...(outcomes === undefined ? {} : { outcomes }),
        laneSubjects,
        aggregateSubject,
        descriptor,
        appUrl,
        createdAt,
        dryRun,
        config,
        runId,
        source,
        plan,
        ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
        ...(failFastReason === undefined ? {} : { failFastReason }),
        cloneRoute,
        ...(publicRepo === undefined ? {} : { publicRepo }),
        subjectEnvNames
      });

  const adapterWarnings: string[] = [];
  await applyBrowserAdapterHooks({
    hooks,
    bundle,
    context: {
      bundle,
      labId: config.id,
      runId,
      actor: descriptor.id,
      backend: "cua",
      dryRun,
      laneCount
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "cuaHooks"
  });

  await writeFile(path.join(artifactRoot, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.json"), `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.md"), renderCuaReviewMarkdown(bundle), "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeFile(
    path.join(cwd, ".mimetic", "runs", "latest.json"),
    `${JSON.stringify({
      schema: "mimetic.latest-run.v1",
      runId,
      path: path.join(".mimetic", "runs", runId),
      updatedAt: createdAt
    }, null, 2)}\n`,
    "utf8"
  );

  const observer = await render(cwd, runId, { open: options.open === true });

  // Lane-level pass: dry-run lanes are contract-ok; live lanes need a passed, engaged session.
  const laneOk = (outcome: LaneRunOutcome | undefined): boolean => laneOutcomeOk(outcome, dryRun);
  const allLanesOk = laneSpecs.every((_, index) => laneOk(outcomes?.[index]));
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok = observer.ok && allLanesOk && adapterFailure === undefined;

  const laneWarnings = (outcomes ?? []).flatMap((outcome) => outcome.warnings);
  const warnings = [...laneWarnings, ...aggregateWarnings, ...adapterWarnings, ...observer.warnings];

  const laneResults = laneSpecs.map((spec, index) => toLaneResult(spec, outcomes?.[index], laneSubjects[index]!, dryRun));
  const laneSummary = buildLaneSummary(outcomes, laneCount, plan, dryRun);
  const firstOutcome = outcomes?.[0];

  const errorResult = ((): CuaActorLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (adapterFailure !== undefined) {
      return {
        code: "MIMETIC_CUA_LAB_FAILED",
        message: adapterFailure
      };
    }
    if (laneCount === 1) {
      const outcome = firstOutcome;
      return {
        code: outcome?.failureCode ?? "MIMETIC_CUA_LAB_FAILED",
        message: outcome?.sessionError
          ?? (outcome?.noEngagement
            ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
            : observer.ok
              ? outcome?.session?.completionReason === "harness_error"
                ? `Computer-use session ended with a harness error: ${outcome.session.reason}`
                : outcome?.session?.status !== "passed"
                ? `Computer-use session ended with ${outcome?.session?.status ?? "unknown"}: ${outcome?.session?.reason ?? "no terminal reason"}`
                : "Computer-use lab did not produce a terminal session."
              : observer.error?.message ?? "Observer failed for the computer-use lab run.")
      };
    }
    const failingLane = (outcomes ?? []).find((outcome) => !laneOk(outcome));
    const geometryLane = (outcomes ?? []).find((outcome) => outcome.failureCode === "MIMETIC_CUA_LAB_DEVICE_GEOMETRY");
    const code: CuaActorLabErrorCode = geometryLane?.failureCode ?? "MIMETIC_CUA_LAB_FAILED";
    return {
      code,
      message: observer.ok
        ? `Fan-out run failed: ${laneSummary.passed}/${laneCount} lane(s) passed (${laneSummary.skipped} skipped, ${laneSummary.harnessErrors} harness error(s), ${laneSummary.hollow} hollow)${failingLane?.sessionError ? `; first failure: ${failingLane.sessionError}` : ""}.`
        : observer.error?.message ?? "Observer failed for the computer-use fan-out run."
    };
  })();

  return {
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    appUrl,
    dryRun,
    runId,
    ...(firstOutcome?.session
      ? {
          session: {
            status: firstOutcome.session.status,
            completionReason: firstOutcome.session.completionReason,
            reason: firstOutcome.session.reason,
            screenshots: firstOutcome.screenshots.length
          }
        }
      : {}),
    ...(firstOutcome?.sandboxId
      ? { sandbox: { sandboxId: firstOutcome.sandboxId, killed: firstOutcome.killed, streamUrlPresent: firstOutcome.streamUrlPresent } }
      : {}),
    subject: aggregateSubject,
    plan,
    lanes: laneResults,
    laneSummary,
    ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
    observer,
    warnings,
    ...(errorResult === undefined ? {} : { error: errorResult })
  };
}

/** Aggregate lane counts for the result projection. */
function buildLaneSummary(outcomes: LaneRunOutcome[] | undefined, laneCount: number, plan: CuaLanePlan, dryRun: boolean): CuaLaneSummary {
  if (dryRun || !outcomes) {
    return {
      strategy: CUA_FANOUT_STRATEGY,
      total: laneCount,
      passed: 0,
      skipped: 0,
      harnessErrors: 0,
      hollow: 0,
      concurrency: plan.concurrency,
      waves: plan.waves
    };
  }
  let passed = 0;
  let skipped = 0;
  let harnessErrors = 0;
  let hollow = 0;
  for (const outcome of outcomes) {
    if (outcome.skippedReason !== undefined) {
      skipped += 1;
      continue;
    }
    if (outcome.harnessError) harnessErrors += 1;
    if (outcome.noEngagement) hollow += 1;
    if (laneOutcomeOk(outcome, dryRun)) passed += 1;
  }
  return {
    strategy: CUA_FANOUT_STRATEGY,
    total: laneCount,
    passed,
    skipped,
    harnessErrors,
    hollow,
    concurrency: plan.concurrency,
    waves: plan.waves
  };
}

/** Build the N=1 bundle via the unchanged buildCuaBundle (byte-stable). */
function buildSingleLaneBundle(args: {
  spec: CuaLaneSpec;
  outcome: LaneRunOutcome | undefined;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  createdAt: string;
  dryRun: boolean;
  config: LabConfig;
  runId: string;
  source: RunBundle["source"];
  redactScreenshots: boolean;
  subjectProvenance?: { repo: string; commit?: string; envNames: string[]; state: RunSubjectProvenance["state"] };
  inProcessRoute: boolean;
  localAppSubject: boolean;
}): RunBundle {
  const { spec, outcome, config } = args;
  return buildCuaBundle({
    actorId: args.descriptor.id,
    appUrl: args.appUrl,
    laneId: spec.laneId,
    ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
    ...(spec.surface === undefined ? {} : { surface: spec.surface }),
    ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
    createdAt: args.createdAt,
    dryRun: args.dryRun,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    mission: spec.instructions,
    persona: spec.persona,
    resolution: spec.resolution,
    deviceScaleFactor: spec.devicePreset.deviceScaleFactor,
    isMobile: spec.devicePreset.isMobile,
    runId: args.runId,
    screenshots: outcome?.screenshots ?? [],
    captureRedaction: args.redactScreenshots ? "blurred" : "raw",
    ...(outcome?.session ? { session: outcome.session } : {}),
    ...(outcome?.sessionError ? { sessionError: outcome.sessionError } : {}),
    source: args.source,
    ...(args.subjectProvenance === undefined ? {} : { subjectProvenance: args.subjectProvenance }),
    ...(config.execution?.desktop?.template === undefined ? {} : { desktopTemplate: config.execution.desktop.template }),
    ...(outcome?.desktopBrowser === undefined ? {} : { desktopBrowser: outcome.desktopBrowser }),
    ...(args.localAppSubject || args.inProcessRoute ? { entryKind: "local-app" as const } : {}),
    ...(outcome?.session ? { traceArtifactPath: spec.traceArtifactPath } : {})
  });
}


/**
 * Provision a clone subject inside the sandbox: clone → (install) → state(before-build) →
 * (build) → state(before-start) → start → readiness probe → state(after-ready). Returns the
 * latest subject HEAD after successful provisioning. Throws (with a capped log tail for the caller to redact) on any failing
 * step — the lab persists that as a failed-evidence bundle.
 *
 * State steps run through the same detached primitive as serve steps (author-trusted, the
 * "serve commands are author-trusted" corollary) under the reserved `subject-state-<name>`
 * label prefix, so a step name can never collide with subject-clone/install/build/start.
 * after-ready steps complete BEFORE the caller opens the browser — the actor never drives a
 * half-seeded subject and seeding never eats the session budget.
 *
 * Auth: when GITHUB_TOKEN is among the declared subject env names, the clone authenticates
 * via an Authorization header computed IN-SANDBOX from the provisioned env — the token never
 * appears in the script text, the process argv beyond the transient git call, the clone URL,
 * or .git/config.
 */
export async function provisionCloneSubject(
  desktop: E2BDesktopSandbox,
  args: {
    repo: string;
    depth: number;
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    hasGithubToken: boolean;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment the cloned commit resolves, so provenance survives later failures. */
    onCommit?: (commit: string) => void;
    /** Called the moment each state step finishes (mirrors onCommit), success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
  } & DetachedTimers
): Promise<string | undefined> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep })
  };
  let latestCommit: string | undefined;
  const refreshCommit = async (): Promise<void> => {
    const head = await desktop.commands.run(
      `git -C ${SUBJECT_DIR} rev-parse HEAD 2>/dev/null || true`,
      { requestTimeoutMs: args.requestTimeoutMs }
    );
    const commit = (head.stdout ?? "").trim() || undefined;
    if (commit) {
      latestCommit = commit;
      args.onCommit?.(commit);
    }
  };
  const stateSteps = args.state?.seed ?? [];
  const runStateSteps = async (when: LabStateStepWhen): Promise<void> => {
    for (const step of stateSteps) {
      if ((step.when ?? "before-start") !== when) {
        continue;
      }
      const stepTimeoutMs = step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS;
      const now = args.now ?? Date.now;
      const startedAt = now();
      const result = await runDetachedStep(desktop, {
        name: `subject-state-${step.name}`,
        command: step.command,
        cwd: SUBJECT_DIR,
        timeoutMs: stepTimeoutMs,
        requestTimeoutMs: args.requestTimeoutMs,
        ...timers
      });
      args.onStateStep?.({
        name: step.name,
        when,
        // Digest only (sha256-16): the command text never persists — the lab YAML in the
        // consumer's repo is the plaintext source of truth.
        commandDigest: commandDigestOf(step.command),
        ok: result.ok,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.timedOut ? { timedOut: true } : {}),
        durationMs: Math.max(0, now() - startedAt)
      });
      if (!result.ok) {
        // Fail closed with the existing scrub-before-truncate tail chain: literal scrub of
        // every provisioned value PRE-truncation, then pattern redaction + cap in tailOf.
        throw new Error(`subject state step "${step.name}" ${result.timedOut ? `timed out after ${stepTimeoutMs}ms` : `failed (exit ${result.exitCode})`}: ${tailOf(args.scrub(result.logTail))}`);
      }
    }
  };
  const cloneCommand = args.hasGithubToken
    ? `auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0) && git -c http.extraHeader="Authorization: Basic $auth" clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`
    : `git clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`;

  const clone = await runDetachedStep(desktop, {
    name: "subject-clone",
    command: cloneCommand,
    timeoutMs: CLONE_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  if (!clone.ok) {
    throw new Error(`subject clone ${clone.timedOut ? "timed out" : `failed (exit ${clone.exitCode})`}: ${tailOf(args.scrub(clone.logTail))}`);
  }

  await refreshCommit();

  if (args.serve.install) {
    const install = await runDetachedStep(desktop, {
      name: "subject-install",
      command: args.serve.install,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...timers
    });
    if (!install.ok) {
      throw new Error(`subject install ${install.timedOut ? "timed out" : `failed (exit ${install.exitCode})`}: ${tailOf(args.scrub(install.logTail))}`);
    }
    await refreshCommit();
  }

  // before-build: after install, before build (builds that read seeded state, e.g. SSG).
  // When no build is declared this simply precedes start — equivalent to before-start.
  await runStateSteps("before-build");
  await refreshCommit();

  if (args.serve.build) {
    const build = await runDetachedStep(desktop, {
      name: "subject-build",
      command: args.serve.build,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...timers
    });
    if (!build.ok) {
      throw new Error(`subject build ${build.timedOut ? "timed out" : `failed (exit ${build.exitCode})`}: ${tailOf(args.scrub(build.logTail))}`);
    }
    await refreshCommit();
  }

  // before-start (the default phase): migrations, SQL/file fixtures, an in-sandbox DB server
  // (`sudo service postgresql start && pg_isready` is a bounded step; the daemon it forks is
  // reclaimed by the sandbox lifecycle like everything else).
  await runStateSteps("before-start");
  await refreshCommit();

  await startDetachedProcess(desktop, {
    name: "subject-start",
    command: args.serve.start,
    cwd: SUBJECT_DIR,
    requestTimeoutMs: args.requestTimeoutMs
  });

  const ready = await probeUrl(desktop, args.serve.url, {
    timeoutMs: args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  if (!ready) {
    const startLog = await readDetachedLog(desktop, "subject-start", args.requestTimeoutMs).catch(() => "");
    throw new Error(`subject did not answer at ${args.serve.url} within ${args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms; server log tail: ${tailOf(args.scrub(startLog))}`);
  }

  // after-ready: fixture loading through the RUNNING app (loopback curl from in-sandbox —
  // steps are author-trusted provisioning, not actors, so no new URL policy surface). These
  // complete before the caller opens the browser and the session timer starts.
  await runStateSteps("after-ready");
  await refreshCommit();

  return latestCommit;
}

/** sha256 hex of the exact command string, first 16 chars (the promptDigest convention). */
export function commandDigestOf(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

/**
 * Resolve the bundle's state marker from the declaration and what actually ran.
 * Precedence: external declared → "unpinned" (seed records, if any, stay attached — a
 * migrated external DB is still unpinned overall); else seed declared → "seeded" only when
 * every declared step executed ok on a live run, otherwise "declared-not-run" (dry-run
 * contract bundles and failed live provisioning); no declaration → "undeclared".
 */
export function resolveSubjectState(args: {
  declared: LabSubjectState | undefined;
  dryRun: boolean;
  executed: RunSubjectStateStepRecord[];
}): RunSubjectProvenance["state"] {
  const declared = args.declared;
  if (!declared) {
    return { provenance: "undeclared" };
  }
  const declaredSeed = declared.seed ?? [];
  const external = declared.external ?? [];
  // Dry-run: nothing executes (no sandbox) — record the DECLARED recipe: name, phase, and
  // command digest only, with NO execution fields.
  const seed: RunSubjectStateStepRecord[] = args.dryRun
    ? declaredSeed.map((step) => ({
        name: step.name,
        when: step.when ?? "before-start",
        commandDigest: commandDigestOf(step.command)
      }))
    : args.executed;
  const allRanOk = !args.dryRun
    && declaredSeed.length > 0
    && seed.length === declaredSeed.length
    && seed.every((record) => record.ok === true);
  const provenance: RunSubjectProvenance["state"]["provenance"] = external.length > 0
    ? "unpinned"
    : declaredSeed.length === 0
      ? "undeclared"
      : allRanOk
        ? "seeded"
        : "declared-not-run";
  return {
    provenance,
    ...(seed.length > 0 ? { seed } : {}),
    ...(external.length > 0 ? { externalEnvNames: external } : {})
  };
}

/** The human-readable state story appended to the provenance event (and review.md via it). */
function describeSubjectState(state: RunSubjectProvenance["state"], dryRun: boolean): string {
  switch (state.provenance) {
    case "seeded":
      return `seeded (${state.seed?.length ?? 0} step(s): ${(state.seed ?? []).map((record) => record.name).join(", ")})`;
    case "unpinned":
      return `UNPINNED (external: ${(state.externalEnvNames ?? []).join(", ")})`;
    case "declared-not-run":
      return `declared, not run (${dryRun ? "dry-run contract" : "provisioning did not complete"})`;
    case "undeclared":
      return "undeclared";
  }
}

function tailOf(log: string): string {
  // Pattern-redact on the FULL text BEFORE truncating: slicing a tail could otherwise cut
  // through a secret's prefix (e.g. drop "sk-proj-") and defeat the pattern matcher on the
  // remainder. Callers literal-scrub known provisioned values first; this is the pattern pass.
  // (The in-sandbox `tail -c` upstream is a fundamental log-tail limit we cannot redact past.)
  const trimmed = redactText(log).trim();
  return trimmed.length > ERROR_TAIL_CHARS ? `…${trimmed.slice(-ERROR_TAIL_CHARS)}` : trimmed || "(no output)";
}

/**
 * Project a computer-use session into a mimetic.run-bundle.v1. The load-bearing line is
 * `stream.actor = session.trace` — the provider-neutral ActorTrace seam the Observer renders.
 * Exported for the bundle-builder tests.
 */
export function buildCuaBundle(args: {
  actorId: string;
  appUrl: string;
  laneId?: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  createdAt: string;
  dryRun: boolean;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  resolution: [number, number];
  /** Device metadata for the stream viewport (honest; isMobile/DSF are not rendered on this route). */
  deviceScaleFactor?: number;
  isMobile?: boolean;
  runId: string;
  screenshots: string[];
  /**
   * Capture-time screenshot policy ("blurred" when policies.redactScreenshots, else "raw").
   * When a session ran, its trace's `redaction.screenshots` is the evidence-of-record and
   * wins; this fallback keeps labels honest for frames written before a mid-session failure
   * (no trace exists to testify then). Defaults to "raw" — the engine default.
   */
  captureRedaction?: "raw" | "blurred";
  session?: CuaLoopResult;
  sessionError?: string;
  source: RunBundle["source"];
  /** Clone-route provenance: what the actor actually drove (names + digests only, never
   * values or command text), including the subject's state story. */
  subjectProvenance?: { repo: string; commit?: string; envNames: string[]; state: RunSubjectProvenance["state"] };
  /**
   * Entry kind for the non-clone subject.declared event (invariant 5 — declare what the subject
   * WAS). "local-app": an already-running LOCAL dev server driven in-process, un-pinnable —
   * declared honestly as caller-provisioned/unpinned with no E2B. Absent: a plain app-url entry.
   */
  entryKind?: "local-app";
  /** The custom E2B desktop template (image) this lane launched on, when configured (provenance). */
  desktopTemplate?: string;
  /** The configured browser choice and the command that opened, when explicitly configured. */
  desktopBrowser?: DesktopBrowserEvidence;
  traceArtifactPath?: string;
}): RunBundle {
  const publicAppUrl = publicSafeAppUrlLabel(args.appUrl);
  const status: RunSimulationStatus = args.session
    ? args.session.status
    : args.sessionError
      ? "failed"
      : "contract_proof_only";
  const reason = args.session?.reason
    ?? args.sessionError
    ?? "Contract bundle only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.";
  const lastScreenshot = args.screenshots[args.screenshots.length - 1];

  // Honest labels (invariant 6: claims match mechanism): every screenshot label names the
  // run's ACTUAL mode. The session trace is the evidence-of-record; the capture policy covers
  // frames written before a mid-session failure produced a trace.
  const traceScreenshotMode = args.session?.trace.redaction.screenshots;
  const screenshotMode: "raw" | "blurred" =
    traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
      ? traceScreenshotMode
      : args.captureRedaction ?? "raw";

  const simulation: RunSimulation = {
    id: "sim-001",
    index: 1,
    personaId: args.persona.id,
    scenarioId: `cua-${args.labId}`,
    status,
    streamKind: "browser",
    mode: "browser-sim",
    progress: args.session || args.sessionError ? 1 : 0.25,
    currentStep: reason,
    summary: args.session
      ? `Computer-use actor (${args.actorId}) drove the subject app in a hosted desktop browser; ${args.session.completionReason}.`
      : args.sessionError
        ? `Computer-use lab failed before a terminal session verdict: ${args.sessionError}`
        : `Contract lane for the computer-use actor (${args.actorId}) against ${publicAppUrl}.`,
    streamIds: ["stream-001"],
    startedAt: args.createdAt,
    updatedAt: args.createdAt
  };

  const stream: RunStream = {
    id: "stream-001",
    simId: "sim-001",
    laneId: args.laneId ?? "lane-01",
    ...(args.actorType === undefined ? {} : { actorType: args.actorType }),
    ...(args.surface === undefined ? {} : { surface: args.surface }),
    ...(args.caseGroup === undefined ? {} : { caseGroup: args.caseGroup }),
    kind: "browser",
    label: `CUA browser — ${args.labId}`,
    status,
    transport: "snapshot",
    updatedAt: args.createdAt,
    embed: lastScreenshot
      ? { kind: "screenshot", url: lastScreenshot, title: `CUA desktop (${screenshotMode})` }
      : { kind: "placeholder", title: "CUA desktop" },
    viewport: {
      width: args.resolution[0],
      height: args.resolution[1],
      deviceScaleFactor: args.deviceScaleFactor ?? 1,
      ...(args.isMobile === undefined ? {} : { isMobile: args.isMobile })
    },
    ui: {
      route: publicAppUrl,
      intent: "Watch the computer-use actor drive the subject app in a hosted desktop browser.",
      state: reason,
      ...(args.session ? { actorStatus: args.session.status } : {}),
      ...(lastScreenshot ? { screenshotUrl: lastScreenshot } : {})
    },
    // The seam this lab exists to fill: the provider-neutral actor evidence projection.
    ...(args.session ? { actor: args.session.trace } : {}),
    artifacts: [
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "events", path: "events.ndjson", kind: "events" as const },
      ...(args.traceArtifactPath
        ? [{ label: "actor trace", path: args.traceArtifactPath, kind: "trace" as const }]
        : []),
      ...args.screenshots.map((screenshot, index) => ({
        label: `screenshot ${String(index + 1).padStart(2, "0")} (${screenshotMode})`,
        path: screenshot,
        kind: "screenshot" as const
      }))
    ]
  };

  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.createdAt,
      level: "info",
      type: "cua-lab.run.created",
      message: `Created computer-use lab run for ${args.labId} (actor ${args.actorId}).`
    },
    args.subjectProvenance
      ? {
          id: "event-001-subject",
          at: args.createdAt,
          level: "info" as const,
          type: "cua-lab.subject.provenance",
          // HONEST WORDING: claim "cloned and served" only when it actually happened.
          message: `${args.dryRun
            ? `Subject declared: clone of ${args.subjectProvenance.repo}, to be served at ${publicAppUrl} in-sandbox (dry-run contract; nothing cloned)`
            : args.subjectProvenance.commit
              ? args.session
                ? `Subject cloned from ${args.subjectProvenance.repo}@${args.subjectProvenance.commit} and served at ${publicAppUrl} in-sandbox`
                : `Subject cloned from ${args.subjectProvenance.repo}@${args.subjectProvenance.commit}; serving at ${publicAppUrl} did not complete (see session error)`
              : `Subject clone attempted from ${args.subjectProvenance.repo}; commit unresolved (provisioning failed before resolution)`
          } (subject env names: ${args.subjectProvenance.envNames.length > 0 ? args.subjectProvenance.envNames.join(", ") : "none"}; values never persisted); state: ${describeSubjectState(args.subjectProvenance.state, args.dryRun)}.`,
          simId: "sim-001",
          streamId: "stream-001"
        }
      : {
          id: "event-001-subject",
          at: args.createdAt,
          level: "info" as const,
          type: "cua-lab.subject.declared",
          // Invariant 5: declare what the subject WAS, including the ABSENCE of a pin. A
          // local-app / in-process subject is an already-running LOCAL dev server the caller
          // provisioned; it cannot be commit-pinned, so its provenance is honestly UNPINNED and
          // no E2B desktop was created. A plain app-url entry runs inside the desktop sandbox.
          message: args.entryKind === "local-app"
            ? `Subject app declared at ${publicAppUrl} (already-running LOCAL dev server driven in-process; NO clone, NO E2B desktop). Provenance: caller-provisioned and UNPINNED — a running dev server cannot be commit-pinned.`
            : `Subject app declared at ${publicAppUrl} (loopback inside the desktop sandbox).`,
          simId: "sim-001",
          streamId: "stream-001"
        },
    args.session
      ? {
          id: "event-002-session",
          at: args.createdAt,
          level: args.session.status === "passed" ? "info" : "warn",
          type: `cua-lab.session.${args.session.completionReason}`,
          message: `${args.session.status}: ${args.session.reason}`,
          simId: "sim-001",
          streamId: "stream-001"
        }
      : args.sessionError
        ? {
            id: "event-002-session",
            at: args.createdAt,
            level: "error" as const,
            type: "cua-lab.session.error",
            message: args.sessionError,
            simId: "sim-001",
            streamId: "stream-001"
          }
        : {
            id: "event-002-contract",
            at: args.createdAt,
            level: "info" as const,
            type: "cua-lab.contract.ready",
            message: "Dry-run contract bundle ready; switch scenario.mode to live for a real desktop session.",
            simId: "sim-001",
            streamId: "stream-001"
          }
  ];

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict: args.session ? verdictForStatus(args.session.status) : args.sessionError ? "fail" : "contract_proof_only",
    summary: reason,
    gaps: args.session || args.sessionError ? [] : ["Live desktop session not yet run (dry-run contract only)."]
  };

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: 1,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".mimetic", "runs", args.runId),
    source: args.source,
    persona: {
      id: args.persona.id,
      name: `Computer-use operator (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    scenario: {
      id: `cua-${args.labId}`,
      title: args.labTitle ?? `Computer-use lab: ${args.labId}`,
      goal: args.mission,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "cua-lab.run.created",
        message: `Created computer-use lab run with one desktop browser lane (actor ${args.actorId}).`
      }
    ],
    simulations: [simulation],
    streams: [stream],
    events,
    redaction: {
      status: "passed",
      notes: traceScreenshotMode === "raw"
        ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are FULL-FIDELITY (raw), retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle."
        : traceScreenshotMode === "blurred"
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle."
          : args.screenshots.length > 0
            ? `Session ended before a trace was recorded; ${args.screenshots.length} already-written frame(s) follow the capture policy (${screenshotMode}). Typed text is recorded as length only and reasoning/messages pass through text redaction.`
            : "No screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates: [],
    // Custom desktop image provenance (omitted on the stock-template default → byte-stable).
    ...(args.desktopTemplate === undefined ? {} : { desktopTemplate: args.desktopTemplate }),
    ...(args.desktopBrowser === undefined ? {} : { desktopBrowser: args.desktopBrowser }),
    // Structured subject provenance (invariant 5): code pin + state story. Uniform and
    // honest on app-url bundles too — the caller minted the URL, its state is the caller's.
    subject: args.subjectProvenance
      ? {
          source: "clone",
          repo: args.subjectProvenance.repo,
          ...(args.subjectProvenance.commit === undefined ? {} : { commit: args.subjectProvenance.commit }),
          envNames: args.subjectProvenance.envNames,
          state: args.subjectProvenance.state
        }
      : { source: "app-url", state: { provenance: "undeclared" } }
  };
}

/**
 * Project N>1 fan-out lanes into a mimetic.run-bundle.v1 (the evidence schema is unchanged; this
 * is a new producer for the multi-stream shape). One sim + one stream per lane; per-lane
 * provenance/session events; a recorded `cua-lab.fanout.plan` event (and a `cua-lab.fanout.fail-fast`
 * event when a harness error skipped queued lanes). N-ary verify/Observer already handle multiple
 * streams. The N=1 path NEVER reaches here (buildCuaBundle owns it, byte-stable).
 */
export function buildCuaFanoutBundle(args: {
  specs: CuaLaneSpec[];
  outcomes?: LaneRunOutcome[];
  laneSubjects: CuaSubjectProjection[];
  aggregateSubject: CuaSubjectProjection;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  createdAt: string;
  dryRun: boolean;
  config: LabConfig;
  runId: string;
  source: RunBundle["source"];
  plan: CuaLanePlan;
  rerun?: RunRerunLineage;
  failFastReason?: string;
  cloneRoute: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
}): RunBundle {
  const { specs, outcomes, config } = args;
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [];

  events.push({
    id: "event-000-created",
    at: args.createdAt,
    level: "info",
    type: "cua-lab.run.created",
    message: `Created computer-use fan-out run for ${config.id} (actor ${args.descriptor.id}, ${specs.length} lanes, per-lane worlds).`
  });
  events.push({
    id: "event-001-fanout-plan",
    at: args.createdAt,
    level: "info",
    type: "cua-lab.fanout.plan",
    message: `Fan-out plan: ${args.plan.laneCount} lane(s) (${args.plan.strategy}), concurrency ${args.plan.concurrency}, ${args.plan.waves} wave(s); per-lane session budget ${Math.round(args.plan.perLaneSessionBudgetMs / 1000)}s; worst-case ~${args.plan.worstCaseSandboxMinutes} sandbox-minutes${args.dryRun ? " (dry-run: $0)" : ""}. Lanes: ${args.plan.lanes.map(formatLanePlanEntry).join(", ")}.`
  });

  let eventSeq = 2;
  const nextEventId = (suffix: string): string => `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  if (args.rerun) {
    events.push({
      id: nextEventId("fanout-rerun"),
      at: args.createdAt,
      level: "info",
      type: "cua-lab.fanout.rerun",
      message: `Rerun selected ${args.rerun.selectedLaneIds.length} lane(s) from ${args.rerun.sourceRunId}: ${args.rerun.previous.map((lane) => `${lane.laneId} was ${lane.status}${lane.completionReason ? `/${lane.completionReason}` : ""}`).join(", ")}. This is a new linked run; the source run verdict is unchanged.`
    });
  }

  specs.forEach((spec, index) => {
    const outcome = outcomes?.[index];
    const laneAppUrl = spec.targetUrl ?? args.appUrl;
    const publicLaneAppUrl = publicSafeAppUrlLabel(laneAppUrl);
    const subject = args.laneSubjects[index]!;
    const session = outcome?.session;
    const screenshots = outcome?.screenshots ?? [];
    const lastScreenshot = screenshots[screenshots.length - 1];
    const status: RunSimulationStatus = outcome?.skippedReason !== undefined
      ? "blocked"
      : session
        ? session.status
        : outcome?.sessionError
          ? "failed"
          : "contract_proof_only";
    const reason = outcome?.skippedReason
      ?? session?.reason
      ?? outcome?.sessionError
      ?? "Contract bundle only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.";

    const traceScreenshotMode = session?.trace.redaction.screenshots;
    const screenshotMode: "raw" | "blurred" =
      traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
        ? traceScreenshotMode
        : config.policies?.redactScreenshots === true ? "blurred" : "raw";

    simulations.push({
      id: spec.simId,
      index: index + 1,
      personaId: spec.persona.id,
      scenarioId: `cua-${config.id}`,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: session || outcome?.sessionError ? 1 : outcome?.skippedReason !== undefined ? 1 : 0.25,
      currentStep: reason,
      summary: session
        ? `Lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}): computer-use actor (${args.descriptor.id}) drove the subject app; ${session.completionReason}.`
        : outcome?.skippedReason !== undefined
          ? `Lane ${spec.laneId} ${outcome.skippedReason}.`
          : outcome?.sessionError
            ? `Lane ${spec.laneId} failed before a terminal session verdict: ${outcome.sessionError}`
            : `Contract lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}) for ${args.descriptor.id} against ${publicLaneAppUrl}.`,
      streamIds: [spec.streamId],
      startedAt: args.createdAt,
      updatedAt: args.createdAt
    });

    streams.push({
      id: spec.streamId,
      simId: spec.simId,
      laneId: spec.laneId,
      ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
      ...(spec.surface === undefined ? {} : { surface: spec.surface }),
      ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
      kind: "browser",
      label: `CUA lane ${spec.laneId} — ${config.id}`,
      status,
      transport: "snapshot",
      updatedAt: args.createdAt,
      embed: lastScreenshot
        ? { kind: "screenshot", url: lastScreenshot, title: `CUA desktop ${spec.laneId} (${screenshotMode})` }
        : { kind: "placeholder", title: `CUA desktop ${spec.laneId}` },
      viewport: {
        width: spec.resolution[0],
        height: spec.resolution[1],
        deviceScaleFactor: spec.devicePreset.deviceScaleFactor,
        isMobile: spec.devicePreset.isMobile
      },
      ui: {
        route: publicLaneAppUrl,
        intent: `Watch lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}) drive the subject app in its own hosted desktop.`,
        state: reason,
        ...(session ? { actorStatus: session.status } : {}),
        ...(lastScreenshot ? { screenshotUrl: lastScreenshot } : {})
      },
      ...(session ? { actor: session.trace } : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" as const },
        { label: "review", path: "review.md", kind: "review" as const },
        { label: "events", path: "events.ndjson", kind: "events" as const },
        ...(session
          ? [{ label: `lane ${spec.laneId} actor trace`, path: spec.traceArtifactPath, kind: "trace" as const }]
          : []),
        ...screenshots.map((screenshot, screenshotIndex) => ({
          label: `lane ${spec.laneId} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
          path: screenshot,
          kind: "screenshot" as const
        }))
      ]
    });

    // Per-lane subject provenance (invariant 5).
    if (args.cloneRoute && args.publicRepo) {
      events.push({
        id: nextEventId(`subject-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.subject.provenance",
        message: `Lane ${spec.laneId}: ${args.dryRun
          ? `subject declared — clone of ${args.publicRepo}, served at ${publicLaneAppUrl} in-sandbox (dry-run contract; nothing cloned)`
          : subject.commit
            ? session
              ? `subject cloned from ${args.publicRepo}@${subject.commit} and served at ${publicLaneAppUrl} in-sandbox`
              : `subject cloned from ${args.publicRepo}@${subject.commit}; serving did not complete (see session error)`
            : `subject clone attempted from ${args.publicRepo}; commit unresolved`
        } (subject env names: ${args.subjectEnvNames.length > 0 ? args.subjectEnvNames.join(", ") : "none"}; values never persisted); state: ${describeSubjectState(subject.state, args.dryRun)}.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else {
      events.push({
        id: nextEventId(`subject-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.subject.declared",
        message: `Lane ${spec.laneId}: subject app declared at ${publicLaneAppUrl} (loopback inside the lane's own desktop sandbox).`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }

    // Per-lane session event.
    if (session) {
      events.push({
        id: nextEventId(`session-${spec.laneId}`),
        at: args.createdAt,
        level: session.status === "passed" ? "info" : "warn",
        type: `cua-lab.session.${session.completionReason}`,
        message: `Lane ${spec.laneId}: ${session.status} — ${session.reason}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.skippedReason !== undefined) {
      events.push({
        id: nextEventId(`blocked-${spec.laneId}`),
        at: args.createdAt,
        level: "warn",
        type: "cua-lab.session.blocked",
        message: `Lane ${spec.laneId} ${outcome.skippedReason}.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.sessionError) {
      events.push({
        id: nextEventId(`session-error-${spec.laneId}`),
        at: args.createdAt,
        level: "error",
        type: "cua-lab.session.error",
        message: `Lane ${spec.laneId}: ${outcome.sessionError}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else {
      events.push({
        id: nextEventId(`contract-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.contract.ready",
        message: `Lane ${spec.laneId}: dry-run contract lane ready; switch scenario.mode to live for a real desktop session.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }
  });

  if (args.failFastReason) {
    events.push({
      id: nextEventId("fanout-fail-fast"),
      at: args.createdAt,
      level: "warn",
      type: "cua-lab.fanout.fail-fast",
      message: `Fan-out fail-fast: ${args.failFastReason}. In-flight lanes finished; queued lanes were skipped (blocked) — completed evidence is retained.`
    });
  }

  // Worst-of review verdict across lanes; live fan-out must prove every lane.
  const verdict = fanoutReviewVerdict({
    dryRun: args.dryRun,
    expectedLaneCount: specs.length,
    outcomes
  });

  const passedLanes = (outcomes ?? []).filter((outcome) =>
    outcome.skippedReason === undefined
    && outcome.session !== undefined
    && outcome.session.status === "passed"
    && outcome.session.completionReason !== "harness_error"
    && outcome.sessionError === undefined
    && !outcome.noEngagement
    && !outcome.selfReportedBlocker).length;
  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    summary: args.dryRun
      ? `${args.rerun ? `Rerun contract from ${args.rerun.sourceRunId}: ` : ""}Dry-run fan-out contract: ${specs.length} per-lane-world lanes composed for ${args.descriptor.id} against ${args.appUrl}; no desktops launched, $0 spend.`
      : `${args.rerun ? `Rerun from ${args.rerun.sourceRunId}: ` : ""}Computer-use fan-out (${specs.length} per-lane worlds): ${passedLanes}/${specs.length} lane(s) reached a terminal, engaged verdict.`,
    gaps: args.dryRun
      ? ["Live fan-out session not yet run (dry-run contract only)."]
      : specs
          .map((spec, index) => ({ spec, outcome: outcomes?.[index] }))
          .filter(({ outcome }) =>
            outcome === undefined
            || outcome.skippedReason !== undefined
            || outcome.sessionError !== undefined
            || outcome.noEngagement
            || outcome.selfReportedBlocker
            || outcome.session === undefined
            || outcome.session.status !== "passed")
          .map(({ spec, outcome }) => `${spec.laneId}: ${outcome?.skippedReason ?? outcome?.sessionError ?? outcome?.session?.reason ?? "did not pass"}`)
  };

  const anyRaw = (outcomes ?? []).some((outcome) => outcome.session?.trace.redaction.screenshots === "raw");
  const ranLive = (outcomes ?? []).some((outcome) => outcome.session !== undefined || outcome.sessionError !== undefined);
  const configuredBrowser = config.execution?.desktop?.browser;
  const resolvedBrowsers = (outcomes ?? [])
    .map((outcome) => outcome.desktopBrowser?.resolved)
    .filter((value): value is string => value !== undefined);
  const unanimousResolvedBrowser = resolvedBrowsers.length > 0 && new Set(resolvedBrowsers).size === 1
    ? resolvedBrowsers[0]
    : undefined;

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: specs.length,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".mimetic", "runs", args.runId),
    source: args.source,
    persona: {
      id: specs[0]!.persona.id,
      name: `Computer-use fan-out (${specs.length} lanes)`,
      source: `lab:${config.id}`,
      sourceDigest: specs[0]!.persona.promptDigest
    },
    scenario: {
      id: `cua-${config.id}`,
      title: config.title ?? `Computer-use fan-out: ${config.id}`,
      goal: specs[0]!.instructions,
      source: `lab:${config.id}`,
      sourceDigest: specs[0]!.persona.promptDigest
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "cua-lab.run.created",
        message: `Created computer-use fan-out run with ${specs.length} per-lane desktop browser lanes (actor ${args.descriptor.id}).`
      }
    ],
    simulations,
    streams,
    events,
    ...(args.rerun === undefined ? {} : { rerun: args.rerun }),
    redaction: {
      status: "passed",
      notes: ranLive
        ? anyRaw
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Some lanes captured FULL-FIDELITY (raw) screenshots, retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle."
        : "Dry-run fan-out contract bundle: no desktops launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates: [],
    // Custom desktop image provenance (every lane launched on it); omitted on the stock default.
    ...(config.execution?.desktop?.template === undefined ? {} : { desktopTemplate: config.execution.desktop.template }),
    ...(configuredBrowser === undefined
      ? {}
      : { desktopBrowser: { requested: configuredBrowser, ...(unanimousResolvedBrowser === undefined ? {} : { resolved: unanimousResolvedBrowser }) } }),
    subject: args.aggregateSubject
  };
}

function verdictForStatus(status: ActorStatus): ReviewSummary["verdict"] {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "blocked":
      return "blocked";
    case "timed_out":
      return "timed_out";
  }
}

function renderCuaReviewMarkdown(bundle: RunBundle): string {
  const trace: ActorTrace | undefined = bundle.streams[0]?.actor;
  const provenance = bundle.events.find((event) => event.type === "cua-lab.subject.provenance");
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(provenance ? [`- subject: ${provenance.message}`] : []),
    ...(trace
      ? [
          `- actor: ${trace.provider} (${trace.lane}/${trace.protocol})`,
          // Honest count: name the trace's actual screenshot mode ("raw" | "blurred"); say
          // nothing when no frames exist ("n/a") rather than claim a redaction that never ran.
          `- evidence: ${trace.items.length} trace item(s), ${trace.counts.screenshots ?? 0} ${
            trace.redaction.screenshots === "raw" || trace.redaction.screenshots === "blurred"
              ? `${trace.redaction.screenshots} screenshot(s)`
              : "screenshot(s)"
          }`
        ]
      : []),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
}

function makeCuaRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `cua-${stamp}-${randomBytes(4).toString("hex")}`;
}

function publicSafeAppUrlLabel(url: string): string {
  return containsSensitive(url) ? `[target-url:${digestUrl(url)}]` : url;
}

function digestUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
