// The shared-world lab backend (#164): the SEQUENTIAL deterministic proof-of-concept of the
// shared-world topology. ONE sandbox provisions a mutable service plane ONCE (clone + serve +
// seed), then N role SEATS take turns IN DECLARED ORDER (each an isolated browser
// profile + identity) against the shared loopback app. A read-only state
// CHECKPOINT (digest probe) runs at baseline + after each role's turn, producing a
// harness-clocked timeline that PROVES role B acted on a world already containing role A's
// mutation (the checkpoint after A strictly precedes B's turn in one clock).
//
// Doctrine (docs/goals/shared-world-topology/goal.md): the bundle declares a VERIFIED, weaker
// `attributionClass: shared-world` + a `mimetic.shared-world.v1` block whose `attributionLimits`
// pin the attribution ceiling (sequential-only, no-concurrent-races,
// delta-attributed-to-turn-not-action). verifyRun fails closed on any overclaim.
//
// Safety rails (same as the fan-out packet + the 2026-06-16 prod incident): ONE Sandbox.create;
// ONE teardown BY exact sandboxId in a finally — NEVER Sandbox.list (account-wide ops are
// forbidden). Provisioned values are literal-scrubbed before any error/log persists; checkpoints
// persist DIGEST-ONLY. The concurrent (getHost) topology, a handoff/barrier grammar, an onTurn
// hook, and real per-role login are named NON-GOALS (PR2+).
//
// FIDELITY NOTE: one sandbox has ONE desktop geometry, so a role's `device` is a PROMPT SIGNAL
// (composed into its persona context) — physical per-role geometry is the concurrent topology's
// job. Each role's stream viewport records the sandbox's actual rendered resolution (honest).

import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import type { ActorCompletionReason, ActorPersonaRef, ActorStatus } from "./actor-contract.js";
import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks,
  type BrowserLabAdapterHooks
} from "./adapter-extension.js";
import { actorRegistry, isCuaActorDescriptor, type CuaActorDescriptor } from "./actor-registry.js";
import {
  CHROMIUM_EVIDENCE_HYGIENE_FLAGS,
  chromiumEvidenceProfilePreferencesJson
} from "./browser-evidence-hygiene.js";
import type { CuaActorSessionOptions } from "./computer-use-actor.js";
import type { CuaLoopResult } from "./computer-use.js";
import {
  commandDigestOf,
  composeLaneInstructions,
  makeChromeBrowserStateObserver,
  makeLaneWriteScreenshot,
  provisionCloneSubject,
  resolveLaneDevice,
  resolveSubjectState,
  SUBJECT_DIR,
  type DesktopBrowserEvidence
} from "./cua-actor-lab.js";
import type { E2BDesktopLike } from "./e2b-desktop-executor.js";
import {
  createDesktopSandbox,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import { runDetachedStep, type DetachedTimers } from "./e2b-detached.js";
import type { DevicePreset } from "./device-presets.js";
import {
  resolveSeatUrl,
  sharedWorldValidationReason,
  type LabActorLane,
  type LabConfig,
  type LabDesktopBrowser,
  type LabSubjectStateCheckpoint
} from "./lab-config.js";
import { renderObserver, type ObserverResult } from "./observer.js";
import { redactText } from "./redaction.js";
import type { StopWhen } from "./stop-conditions.js";
import {
  buildRunSource,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  SHARED_WORLD_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
  type SharedWorldCheckpoint,
  type SharedWorldEvidence,
  type SharedWorldTimelineEntry
} from "./run.js";

export const SHARED_WORLD_LAB_SCHEMA = "mimetic.shared-world-lab-result.v1";

export const SHARED_WORLD_LAB_PROVIDER_METADATA = {
  mode: "shared-world-lab",
  tool: "mimetic-cli"
} as const;

const DEFAULT_SESSION_TIMEOUT_MS = 300_000;
// Settle after opening a seat's browser, before the session's first screenshot.
const BROWSER_SETTLE_MS = 8_000;
// Server-side reclamation buffer past the loop's own wall-clock stop.
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;
// Room for the one-time clone/install/build/start/probe + the sequential per-role sessions.
const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;
// Per-checkpoint probe budget (read-only aggregate probes are fast).
const CHECKPOINT_TIMEOUT_MS = 60_000;
const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_MISSION =
  "You are testing a shared web application other roles also use. The browser is already open at your entry URL. Accomplish what your role asks, then stop.";

/**
 * Library-level hooks mirroring CuaActorLabHooks — the DI seams that let CI drive the FULL
 * orchestration with fakes at $0/zero-network. The fake desktop module records create/kill BY id
 * and exposes NO `list` method (the by-id teardown rail is then provable by construction).
 */
export interface SharedWorldLabHooks extends BrowserLabAdapterHooks {
  /** Lazy-load the E2B desktop module (tests inject a fake; default loadE2BDesktopModule). */
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  /** Runs once after sandbox creation, before subject provisioning (library setup seam). */
  prepareDesktop?: (desktop: E2BDesktopSandbox) => Promise<void>;
  /** The per-seat computer-use session runner (default: the resolved actor descriptor's). */
  runSession?: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  /** The operator environment (keys + subject env values). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock/sleep for the detached-step polling (tests only). */
  detachedTimers?: DetachedTimers;
  /**
   * CONCURRENT route only (#164 phase 2): the harness clock used to MEASURE each actor's laneWindow
   * [start,end] (default Date.now). The deterministic heart test does NOT override this — overlap is
   * produced by a rendezvous latch in the fake runSession + measured by the REAL clock (FIX-1), so
   * the windows are real, not injected. (A test may override only for non-overlap assertions.)
   */
  now?: () => number;
  /** CONCURRENT route only: the background stateSeries prober cadence (ms). Default 1000. */
  proberCadenceMs?: number;
}

export interface RunSharedWorldLabOptions {
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  hooks?: SharedWorldLabHooks;
}

export type SharedWorldLabErrorCode =
  | "MIMETIC_SHARED_WORLD_LAB_FAILED"
  | "MIMETIC_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED"
  | "MIMETIC_SHARED_WORLD_LAB_INVALID"
  | "MIMETIC_SHARED_WORLD_LAB_KEYS_MISSING"
  | "MIMETIC_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING";

/** One role seat's terminal outcome in the result projection. */
export interface SharedWorldRoleResult {
  id: string;
  index: number;
  persona: string;
  /** Terminal role status; "blocked" = fail-fast skipped it; "contract_proof_only" = dry-run. */
  status: ActorStatus | "blocked" | "contract_proof_only";
  ok: boolean;
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
    screenshots: number;
  };
  /** The user-data-dir profile this seat drove (proves per-seat isolation). */
  profileDir: string;
  /** Set when the role was skipped by fail-fast (a pinned reason string). */
  skippedReason?: string;
  error?: { code: SharedWorldLabErrorCode; message: string };
}

export interface SharedWorldLabResult {
  schema: typeof SHARED_WORLD_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or every role reached a terminal, engaged
   * verdict without a harness error). The roles' pass/fail is evidence, not the lab's exit code. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the seats. */
  actor: string;
  topology: "shared-world";
  /** The DECLARED number of role seats. */
  roleCount: number;
  /** The role ids that actually took a turn, in declared order. */
  sequence: string[];
  dryRun: boolean;
  runId: string;
  /** Live-only: the ONE shared sandbox's lifecycle proof (the stream/key value is never surfaced). */
  sandbox?: {
    sandboxId: string;
    killed: boolean;
  };
  /** Subject provenance (invariant 5): the ONE shared plane. */
  subject?: RunSubjectProvenance;
  roles: SharedWorldRoleResult[];
  observer?: ObserverResult;
  warnings: string[];
  error?: { code: SharedWorldLabErrorCode; message: string };
}

/** A fully-resolved role seat (internal). */
interface RoleSpec {
  roleId: string;
  /** 0-based. */
  roleIndex: number;
  simId: string;
  streamId: string;
  persona: ActorPersonaRef;
  instructions: string;
  /** The role's declared device (a PROMPT SIGNAL — see the file's FIDELITY NOTE). */
  deviceName: string;
  /** Deterministic harness-owned completion guard. Lane-level override, else actor default. */
  stopWhen?: StopWhen;
  entry?: string;
  seatUrl: string;
  screenshotDir: string;
  traceArtifactPath: string;
  profileDir: string;
}

/** One role seat's end-to-end run outcome (internal; projected into the result + the bundle). */
interface RoleOutcome {
  spec: RoleSpec;
  session?: CuaLoopResult;
  sessionError?: string;
  screenshots: string[];
  desktopBrowser?: DesktopBrowserEvidence;
  /** Set when fail-fast skipped this role before it ran. */
  skippedReason?: string;
  noEngagement: boolean;
  harnessError: boolean;
  /** The checkpoint snapshot taken AFTER this role's turn (absent for skipped roles). */
  afterCheckpoint?: SharedWorldCheckpoint;
}

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function makeSharedWorldRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `shared-world-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Single-quote a value for safe interpolation into the seat-launch shell command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Launch ONE seat's browser with its OWN isolated profile — the shared-world topology needs a
 * fresh browser identity boundary per role (cookies/session isolated per seat). Absent/default
 * preserves the historical shared-world opener (Chrome best-effort). A concrete preference is
 * fail-closed and records the resolved in-sandbox command.
 */
async function launchSeatBrowser(
  desktop: E2BDesktopSandbox,
  args: {
    browserPreference?: LabDesktopBrowser;
    profileDir: string;
    requestTimeoutMs: number;
    seatUrl: string;
  }
): Promise<DesktopBrowserEvidence | undefined> {
  const requested = args.browserPreference ?? "default";
  const chromiumFlags = CHROMIUM_EVIDENCE_HYGIENE_FLAGS.map(shellQuote).join(" ");
  const command = [
    "set -euo pipefail",
    `browser_preference=${shellQuote(requested)}`,
    `profile_dir=${shellQuote(args.profileDir)}`,
    `seat_url=${shellQuote(args.seatUrl)}`,
    `chrome_preferences_json=${shellQuote(chromiumEvidenceProfilePreferencesJson())}`,
    'mkdir -p "$profile_dir"',
    "chrome_debug_flags=(" + chromiumFlags + ")",
    "prepare_chrome_profile() {",
    "  mkdir -p \"$profile_dir/Default\"",
    "  printf '%s\\n' \"$chrome_preferences_json\" > \"$profile_dir/Default/Preferences\"",
    "}",
    "launch_chrome() {",
    "  local label=\"$1\"",
    "  local binary=\"$2\"",
    "  if ! command -v \"$binary\" >/dev/null 2>&1; then return 127; fi",
    "  echo \"MIMETIC_BROWSER_RESOLVED=$label\"",
    "  pkill -f '[r]emote-debugging-port=9222' 2>/dev/null || true",
    "  prepare_chrome_profile",
    "  setsid -f \"$binary\" --new-window --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=\"$profile_dir\" \"${chrome_debug_flags[@]}\" \"$seat_url\" > /dev/null 2>&1 < /dev/null",
    "}",
    "launch_firefox() {",
    "  if ! command -v firefox >/dev/null 2>&1; then return 127; fi",
    "  echo \"MIMETIC_BROWSER_RESOLVED=firefox\"",
    "  setsid -f firefox --new-window --profile \"$profile_dir\" \"$seat_url\" > /dev/null 2>&1 < /dev/null",
    "}",
    "case \"$browser_preference\" in",
    "  chrome)",
    "    launch_chrome google-chrome google-chrome || launch_chrome google-chrome-stable google-chrome-stable",
    "    ;;",
    "  chromium)",
    "    launch_chrome chromium chromium || launch_chrome chromium-browser chromium-browser",
    "    ;;",
    "  firefox)",
    "    launch_firefox",
    "    ;;",
    "  default)",
    "    launch_chrome google-chrome google-chrome || true",
    "    ;;",
    "esac"
  ].join("\n");
  const result = await desktop.commands.run(command, { requestTimeoutMs: args.requestTimeoutMs });
  if (args.browserPreference !== undefined && args.browserPreference !== "default" && result.exitCode !== undefined && result.exitCode !== 0) {
    throw new Error(`requested desktop browser "${args.browserPreference}" could not be launched for shared-world seat`);
  }
  if (args.browserPreference === undefined) {
    return undefined;
  }
  const resolved = (result.stdout ?? "").match(/^MIMETIC_BROWSER_RESOLVED=(\S+)$/m)?.[1];
  return {
    requested,
    ...(resolved === undefined ? {} : { resolved })
  };
}

/** Combine a snapshot's per-probe digests into ONE sha256-16 (digest-only; no raw value). */
export function combineCheckpointDigest(parts: string[]): string {
  return commandDigestOf(parts.join("\n"));
}

/**
 * Run ONE checkpoint snapshot LIVE: each declared probe runs read-only via the detached
 * primitive; its stdout is literal-scrubbed (provisioned values + the probe's declared redact
 * literals, folded into `scrub`) then pattern-redacted, then digested. Only the COMBINED digest
 * persists — never the raw value (the seed-step lockdown). Unique step names per snapshot prevent
 * stale-status reuse across snapshots.
 */
export async function runCheckpointSnapshot(args: {
  desktop: E2BDesktopSandbox;
  snapshotIndex: number;
  name: string;
  checkpoints: LabSubjectStateCheckpoint[];
  prevDigest: string | undefined;
  scrub: (text: string) => string;
  requestTimeoutMs: number;
  timers: DetachedTimers;
}): Promise<SharedWorldCheckpoint> {
  const parts: string[] = [];
  for (const probe of args.checkpoints) {
    const result = await runDetachedStep(args.desktop, {
      name: `checkpoint-${args.snapshotIndex}-${probe.name}`,
      command: probe.command,
      cwd: SUBJECT_DIR,
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...args.timers
    });
    const scrubbed = redactText(args.scrub(result.logTail));
    parts.push(`${probe.name}=${commandDigestOf(scrubbed)}`);
  }
  const digest = combineCheckpointDigest(parts);
  return {
    kind: "checkpoint",
    name: args.name,
    digest,
    deltaFromPrev: args.prevDigest !== undefined && digest !== args.prevDigest
  };
}

/** The DECLARED (dry-run) checkpoint snapshot: digest the probe RECIPE (command digests), no run. */
export function declaredCheckpointSnapshot(name: string, checkpoints: LabSubjectStateCheckpoint[]): SharedWorldCheckpoint {
  const parts = checkpoints.map((probe) => `${probe.name}=${commandDigestOf(probe.command)}`);
  return { kind: "checkpoint", name, digest: combineCheckpointDigest(parts), deltaFromPrev: false };
}

/** sha256-16 over the ordered seed-step command digests — the seeded-state RECIPE identity. */
export function seedRecipeDigest(config: LabConfig): string {
  const seed = config.subject.state?.seed ?? [];
  return commandDigestOf(seed.map((step) => `${step.name}:${commandDigestOf(step.command)}`).join("\n"));
}

/** Build the resolved role roster from actors[0].lanes (the role roster). */
function buildRoleSpecs(config: LabConfig, serveUrl: string): RoleSpec[] {
  const actor = config.actors[0];
  const mission = actor?.mission ?? DEFAULT_MISSION;
  const roster = actor?.lanes ?? [];
  return roster.map((lane: LabActorLane, i): RoleSpec => {
    const roleId = lane.id ?? `role-${String(i + 1).padStart(2, "0")}`;
    const device = resolveLaneDevice(config, lane);
    const composed = composeLaneInstructions({
      mission,
      ...(lane.persona === undefined ? {} : { persona: lane.persona }),
      ...(lane.instruction === undefined ? {} : { instruction: lane.instruction }),
      device: { name: device.name, preset: device.preset }
    });
    return {
      roleId,
      roleIndex: i,
      simId: `sim-${String(i + 1).padStart(3, "0")}`,
      streamId: `stream-${String(i + 1).padStart(3, "0")}`,
      persona: composed.persona,
      instructions: composed.instructions,
      deviceName: device.name,
      ...((lane.stopWhen ?? actor?.stopWhen) === undefined ? {} : { stopWhen: (lane.stopWhen ?? actor?.stopWhen) as StopWhen }),
      ...(lane.entry === undefined ? {} : { entry: lane.entry }),
      seatUrl: resolveSeatUrl(serveUrl, lane.entry) ?? serveUrl,
      screenshotDir: roleId,
      traceArtifactPath: `actors/${`stream-${String(i + 1).padStart(3, "0")}`}.json`,
      profileDir: `/tmp/seat-${roleId}`
    };
  });
}

export async function runSharedWorldLab(options: RunSharedWorldLabOptions): Promise<SharedWorldLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const render = hooks.renderObserverFn ?? renderObserver;
  const actorType = config.actors[0]?.type ?? "";

  const fail = (code: SharedWorldLabErrorCode, message: string, actorLabel?: string): SharedWorldLabResult => ({
    schema: SHARED_WORLD_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: actorLabel ?? actorType,
    topology: "shared-world",
    roleCount: config.actors[0]?.lanes?.length ?? 0,
    sequence: [],
    dryRun,
    runId: options.runId ?? "not-created",
    roles: [],
    warnings: [],
    error: { code, message }
  });

  // Resolve the actor through the registry — the parser validated this, but the engine fails closed
  // rather than trusting a config that arrived through the library door (this fn is npm surface).
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail("MIMETIC_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED", `actors[0].type "${actorType}" is not a registered computer-use actor.`);
  }

  // Re-enforce the shared-world cross-validation (library API surface).
  const invalidReason = sharedWorldValidationReason(config);
  if (invalidReason) {
    return fail("MIMETIC_SHARED_WORLD_LAB_INVALID", invalidReason, descriptor.id);
  }

  const serve = config.subject.serve!;
  const subjectRepo = config.subject.repos?.[0] ?? "";
  const subjectEnvNames = config.subject.env ?? [];
  const checkpoints = config.subject.state?.checkpoint ?? [];
  const roleSpecs = buildRoleSpecs(config, serve.url);
  const roleCount = roleSpecs.length;
  const runSession = hooks.runSession ?? descriptor.runSession;

  // Read keys once into locals (names only; values never logged or persisted).
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  // Literal scrubber for every known provisioned value (no secret "shape" to pattern-match):
  // provider/E2B keys, subject env values, AND each checkpoint's declared redact literals.
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? ""),
    ...checkpoints.flatMap((probe) => probe.redact ?? [])
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = (text: string): string =>
    knownSecretValues.reduce((current, value) => current.split(value).join("[REDACTED_SECRET]"), text);

  const redactRepoLabel = config.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo = redactRepoLabel ? "repo-01" : subjectRepo;
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");

  if (!dryRun) {
    const missingKeys = [
      ...(openaiApiKey ? [] : ["OPENAI_API_KEY"]),
      ...(e2bApiKey ? [] : ["E2B_API_KEY"])
    ];
    if (missingKeys.length > 0) {
      return fail(
        "MIMETIC_SHARED_WORLD_LAB_KEYS_MISSING",
        `Live shared-world labs need ${missingKeys.join(" and ")} in the environment (pass them via --env-file; values are never persisted).`,
        descriptor.id
      );
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail(
        "MIMETIC_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING",
        `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
        descriptor.id
      );
    }
  }

  const runId = options.runId ?? makeSharedWorldRunId();
  const artifactRoot = path.join(cwd, ".mimetic", "runs", runId);
  const createdAt = new Date().toISOString();
  const timeoutMs = config.execution?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const requestTimeoutMs = readPositiveInt(env.MIMETIC_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;
  const timers: DetachedTimers = hooks.detachedTimers ?? {};
  // ONE sandbox geometry for the shared desktop (run-wide; per-role device is a prompt signal).
  const sandboxDevice = resolveLaneDevice(config, undefined);
  const sandboxResolution = sandboxDevice.resolution;
  const sandboxPreset: DevicePreset = sandboxDevice.preset;
  const perRunSandboxMs = config.execution?.desktop?.sandboxTimeoutMs
    ?? timeoutMs * Math.max(1, roleCount)
      + SUBJECT_PROVISION_BUDGET_MS
      + (config.subject.state?.seed ?? []).reduce((sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0)
      + SANDBOX_TIMEOUT_BUFFER_MS;

  await mkdir(artifactRoot, { recursive: true });
  const source = await buildRunSource({ capturedAt: createdAt, cwd, mimeticSource: "present", packageName: "mimetic-cli" });

  const warnings: string[] = [];
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  const roleOutcomes: RoleOutcome[] = [];
  const baselineDeclared = declaredCheckpointSnapshot("cp-baseline", checkpoints);
  let baselineCheckpoint: SharedWorldCheckpoint = baselineDeclared;
  let subjectCommit: string | undefined;
  let sandboxId: string | undefined;
  let killed = false;
  let failFastReason: string | undefined;

  if (!dryRun) {
    let desktopModule: E2BDesktopModule | undefined;
    let desktop: E2BDesktopSandbox | undefined;
    let runFailed = false;
    try {
      desktopModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
      // ONE Sandbox.create for the whole run (metadata.topology + roleCount; the SUBJECT env is
      // provisioned here on the clone route — the ACTOR key never enters the sandbox). An optional
      // custom desktop template (image) selects Sandbox.create(template, opts); absent keeps the
      // byte-stable Sandbox.create(opts) default.
      desktop = await createDesktopSandbox(desktopModule, {
        apiKey: e2bApiKey,
        requestTimeoutMs,
        timeoutMs: perRunSandboxMs,
        metadata: {
          ...SHARED_WORLD_LAB_PROVIDER_METADATA,
          labId: config.id,
          topology: "shared-world",
          roleCount: String(roleCount)
        },
        ...(subjectEnvNames.length > 0
          ? { envs: Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])) }
          : {}),
        resolution: sandboxResolution,
        dpi: 96,
        lifecycle: { onTimeout: "kill" }
      }, config.execution?.desktop?.template);
      sandboxId = desktop.sandboxId;

      if (hooks.prepareDesktop) {
        await hooks.prepareDesktop(desktop);
      }

      // Provision the shared plane ONCE (clone + install/build + seed + serve + readiness probe).
      subjectCommit = await provisionCloneSubject(desktop, {
        repo: subjectRepo,
        depth: config.subject.clone?.depth ?? 1,
        serve,
        ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
        hasGithubToken,
        requestTimeoutMs,
        scrub: scrubKnownValues,
        onCommit: (commit) => { subjectCommit = commit; },
        onStateStep: (record) => { stateStepRecords.push(record); },
        ...timers
      });

      // Baseline checkpoint (before any role acts).
      baselineCheckpoint = await runCheckpointSnapshot({
        desktop,
        snapshotIndex: 0,
        name: "cp-baseline",
        checkpoints,
        prevDigest: undefined,
        scrub: scrubKnownValues,
        requestTimeoutMs,
        timers
      });
      let prevDigest = baselineCheckpoint.digest;

      // Sequential per-role loop (DECLARED order). A HARNESS error blocks the REMAINING roles
      // (the shared-state premise is broken); a MISSION failure is data, never trips fail-fast.
      for (const [index, spec] of roleSpecs.entries()) {
        if (failFastReason) {
          roleOutcomes.push({
            spec,
            screenshots: [],
            skippedReason: `skipped: ${failFastReason}`,
            noEngagement: false,
            harnessError: false
          });
          continue;
        }

        const screenshots: string[] = [];
        const writeScreenshot = makeLaneWriteScreenshot(artifactRoot, { screenshotDir: spec.screenshotDir }, screenshots);
        let session: CuaLoopResult | undefined;
        let sessionError: string | undefined;
        let desktopBrowser: DesktopBrowserEvidence | undefined;
        try {
          // Fresh isolated browser profile per seat, opened at the role's same-origin loopback entry.
          desktopBrowser = await launchSeatBrowser(desktop, {
            ...(config.execution?.desktop?.browser === undefined ? {} : { browserPreference: config.execution.desktop.browser }),
            profileDir: spec.profileDir,
            seatUrl: spec.seatUrl,
            requestTimeoutMs
          });
          await desktop.wait(BROWSER_SETTLE_MS).catch(() => undefined);
          const sessionOptions: CuaActorSessionOptions = {
            instructions: spec.instructions,
            persona: spec.persona,
            timeoutMs,
            openai: {
              apiKey: openaiApiKey,
              ...(config.actors[0]?.model ? { model: config.actors[0]!.model } : {})
            },
            desktop: desktop as unknown as E2BDesktopLike,
            executorOptions: {
              observeBrowserState: makeChromeBrowserStateObserver(desktop, requestTimeoutMs)
            },
            redactScreenshots,
            scrubText: scrubKnownValues,
            writeScreenshot,
            ...(spec.stopWhen === undefined ? {} : { stopWhen: spec.stopWhen })
          };
          session = await runSession(sessionOptions);
        } catch (error) {
          sessionError = redactText(scrubKnownValues(compactError(error)));
        }

        if (session) {
          await mkdir(path.dirname(path.join(artifactRoot, spec.traceArtifactPath)), { recursive: true });
          await writeFile(path.join(artifactRoot, spec.traceArtifactPath), `${JSON.stringify(session.trace, null, 2)}\n`, "utf8");
          if (session.trace.redaction.screenshots === "raw") {
            warnings.push("Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .mimetic and nothing scans these pixels; review them before sharing anywhere. Set policies.redactScreenshots: true to blur a share-as-is bundle.");
          }
        }

        const noEngagement = session !== undefined
          && session.completionReason === "goal_satisfied"
          && (session.trace.counts.actions ?? 0) === 0
          && (session.trace.counts.messages ?? 0) === 0;
        if (noEngagement) {
          warnings.push(`Role ${spec.roleId} returned goal_satisfied with ZERO actions and ZERO messages — likely a blank/still-loading screen; NOT counted as a pass.`);
        }
        const harnessError = sessionError !== undefined || session?.completionReason === "harness_error";

        // Checkpoint AFTER this role's turn (the interaction-proof snapshot). Runs even on a
        // harness-errored turn (the probe is read-only state, independent of the browser seat).
        const afterCheckpoint = await runCheckpointSnapshot({
          desktop,
          snapshotIndex: index + 1,
          name: `cp-after-${spec.roleId}`,
          checkpoints,
          prevDigest,
          scrub: scrubKnownValues,
          requestTimeoutMs,
          timers
        });
        prevDigest = afterCheckpoint.digest;

        roleOutcomes.push({
          spec,
          ...(session ? { session } : {}),
          ...(sessionError === undefined ? {} : { sessionError }),
          screenshots,
          ...(desktopBrowser === undefined ? {} : { desktopBrowser }),
          noEngagement,
          harnessError,
          afterCheckpoint
        });

        if (harnessError && !failFastReason) {
          failFastReason = `role "${spec.roleId}" ended in a harness error — the shared-state premise is broken (fail-fast)`;
        }
      }
    } catch (error) {
      runFailed = true;
      warnings.push(`Shared-world run failed before completion: ${redactText(scrubKnownValues(compactError(error)))}`);
    } finally {
      // ONE teardown BY exact sandboxId — NEVER Sandbox.list (the 2026-06-16 prod-incident rail).
      if (desktop && desktopModule) {
        const anyRoleFailed = runFailed
          || failFastReason !== undefined
          || roleOutcomes.some((outcome) => outcome.harnessError || outcome.sessionError !== undefined);
        const keepForDebug = config.subject.clone?.keep === true && anyRoleFailed;
        if (keepForDebug) {
          warnings.push(`Sandbox ${desktop.sandboxId} kept for debugging (subject.clone.keep on failure); reclaim it via E2B or it will be killed on its server-side timeout.`);
        } else if (typeof desktopModule.Sandbox.kill === "function") {
          try {
            await desktopModule.Sandbox.kill(desktop.sandboxId, { requestTimeoutMs: 60_000 });
            killed = true;
          } catch (error) {
            warnings.push(`Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(compactError(error)))}`);
          }
        } else {
          warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox.");
        }
      }
    }
  }

  // Subject provenance (invariant 5): the ONE shared plane.
  const subjectState = resolveSubjectState({
    declared: config.subject.state,
    dryRun,
    executed: stateStepRecords
  });
  const subject: RunSubjectProvenance = {
    source: "clone",
    repo: publicRepo,
    ...(subjectCommit === undefined ? {} : { commit: subjectCommit }),
    envNames: subjectEnvNames,
    state: subjectState
  };

  const bundle = buildSharedWorldBundle({
    config,
    descriptor,
    createdAt,
    dryRun,
    runId,
    source,
    roleSpecs,
    roleOutcomes,
    baselineCheckpoint,
    subject,
    sandboxResolution,
    sandboxPreset,
    seedDigest: seedRecipeDigest(config),
    ...(subjectCommit === undefined ? {} : { subjectCommit }),
    ...(failFastReason === undefined ? {} : { failFastReason })
  });

  const adapterWarnings: string[] = [];
  await applyBrowserAdapterHooks({
    hooks,
    bundle,
    context: {
      bundle,
      runDir: artifactRoot,
      labId: config.id,
      runId,
      actor: descriptor.id,
      backend: "shared-world",
      dryRun,
      laneCount: roleSpecs.length
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "sharedWorldHooks"
  });

  await writeFile(path.join(artifactRoot, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.json"), `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.md"), renderSharedWorldReviewMarkdown(bundle), "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeFile(
    path.join(cwd, ".mimetic", "runs", "latest.json"),
    `${JSON.stringify({ schema: "mimetic.latest-run.v1", runId, path: path.join(".mimetic", "runs", runId), updatedAt: createdAt }, null, 2)}\n`,
    "utf8"
  );

  const observer = await render(cwd, runId, { open: options.open === true });

  const roleOk = (outcome: RoleOutcome | undefined): boolean => {
    return sharedWorldRoleOutcomeOk(outcome, dryRun);
  };
  const allRolesOk = roleSpecs.every((_, index) => roleOk(roleOutcomes[index]));
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok = observer.ok && allRolesOk && failFastReason === undefined && adapterFailure === undefined;
  const allWarnings = [...warnings, ...adapterWarnings, ...observer.warnings];

  const roles: SharedWorldRoleResult[] = roleSpecs.map((spec, index) => {
    const outcome = roleOutcomes[index];
    const base = { id: spec.roleId, index: spec.roleIndex + 1, persona: spec.persona.id, profileDir: spec.profileDir };
    if (dryRun || !outcome) {
      return { ...base, status: "contract_proof_only" as const, ok: dryRun };
    }
    if (outcome.skippedReason !== undefined) {
      return {
        ...base,
        status: "blocked" as const,
        ok: false,
        skippedReason: outcome.skippedReason,
        error: { code: "MIMETIC_SHARED_WORLD_LAB_FAILED" as const, message: outcome.skippedReason }
      };
    }
    const session = outcome.session;
    const thisOk = roleOk(outcome);
    return {
      ...base,
      status: session ? session.status : ("failed" as const),
      ok: thisOk,
      ...(session
        ? { session: { status: session.status, completionReason: session.completionReason, reason: session.reason, screenshots: outcome.screenshots.length } }
        : {}),
      ...(thisOk
        ? {}
        : {
            error: {
              code: "MIMETIC_SHARED_WORLD_LAB_FAILED" as const,
              message: outcome.sessionError
                ?? (outcome.noEngagement
                  ? "Role took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                  : session?.completionReason === "harness_error"
                    ? `Role seat ended with a harness error: ${session.reason}`
                    : "Role did not produce a terminal session.")
            }
          })
    };
  });

  const sequence = roleOutcomes
    .filter((outcome) => outcome.skippedReason === undefined && outcome.afterCheckpoint !== undefined)
    .map((outcome) => outcome.spec.roleId);

  const errorResult = ((): SharedWorldLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (!observer.ok) {
      return { code: "MIMETIC_SHARED_WORLD_LAB_FAILED", message: observer.error?.message ?? "Observer failed for the shared-world run." };
    }
    if (adapterFailure !== undefined) {
      return { code: "MIMETIC_SHARED_WORLD_LAB_FAILED", message: adapterFailure };
    }
    const passed = roles.filter((role) => role.ok).length;
    return {
      code: "MIMETIC_SHARED_WORLD_LAB_FAILED",
      message: `Shared-world run failed: ${passed}/${roleCount} role(s) passed${failFastReason ? ` (fail-fast: ${failFastReason})` : ""}.`
    };
  })();

  return {
    schema: SHARED_WORLD_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    topology: "shared-world",
    roleCount,
    sequence,
    dryRun,
    runId,
    ...(sandboxId === undefined ? {} : { sandbox: { sandboxId, killed } }),
    subject,
    roles,
    observer,
    warnings: allWarnings,
    ...(errorResult === undefined ? {} : { error: errorResult })
  };
}

/** Project the shared-world run into a mimetic.run-bundle.v1 with the sharedWorld evidence block. */
export function buildSharedWorldBundle(args: {
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  createdAt: string;
  dryRun: boolean;
  runId: string;
  source: RunBundle["source"];
  roleSpecs: RoleSpec[];
  roleOutcomes: RoleOutcome[];
  baselineCheckpoint: SharedWorldCheckpoint;
  subject: RunSubjectProvenance;
  sandboxResolution: [number, number];
  sandboxPreset: DevicePreset;
  seedDigest: string;
  subjectCommit?: string;
  failFastReason?: string;
}): RunBundle {
  const { config, descriptor, createdAt, dryRun, roleSpecs, roleOutcomes } = args;
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [];
  const appUrl = config.subject.serve?.url ?? "";

  events.push({
    id: "event-000-created",
    at: createdAt,
    level: "info",
    type: "shared-world.run.created",
    message: `Created shared-world run for ${config.id} (actor ${descriptor.id}, ${roleSpecs.length} role(s), ONE shared plane, sequential turns).`
  });
  events.push({
    id: "event-001-plane",
    at: createdAt,
    level: "info",
    type: "shared-world.plane.provenance",
    message: dryRun
      ? `Shared plane declared: clone of ${args.subject.repo}, served at ${appUrl} in-sandbox (dry-run contract; nothing cloned). Seed recipe ${args.seedDigest}; env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`
      : `Shared plane: clone of ${args.subject.repo}${args.subjectCommit ? `@${args.subjectCommit}` : ""}, served at ${appUrl} in-sandbox; seed recipe ${args.seedDigest}; env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`,
    simId: roleSpecs[0]?.simId ?? "sim-001",
    streamId: roleSpecs[0]?.streamId ?? "stream-001"
  });

  let eventSeq = 2;
  const nextEventId = (suffix: string): string => `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  roleSpecs.forEach((spec, index) => {
    const outcome = roleOutcomes[index];
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
      ?? "Contract role only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.";
    const traceScreenshotMode = session?.trace.redaction.screenshots;
    const screenshotMode: "raw" | "blurred" =
      traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
        ? traceScreenshotMode
        : config.policies?.redactScreenshots === true ? "blurred" : "raw";

    simulations.push({
      id: spec.simId,
      index: index + 1,
      personaId: spec.persona.id,
      scenarioId: `shared-world-${config.id}`,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: 100,
      currentStep: reason,
      summary: session
        ? `Role ${spec.roleId} (${spec.persona.id}): drove the shared app; ${session.completionReason}.`
        : outcome?.skippedReason !== undefined
          ? `Role ${spec.roleId} ${outcome.skippedReason}.`
          : outcome?.sessionError
            ? `Role ${spec.roleId} failed before a terminal session verdict: ${outcome.sessionError}`
            : `Contract role ${spec.roleId} (${spec.persona.id}) for ${descriptor.id} against the shared plane at ${appUrl}.`,
      streamIds: [spec.streamId],
      startedAt: createdAt,
      updatedAt: createdAt
    });

    streams.push({
      id: spec.streamId,
      simId: spec.simId,
      kind: "browser",
      label: `Shared-world role ${spec.roleId} — ${config.id}`,
      status,
      transport: "snapshot",
      updatedAt: createdAt,
      embed: lastScreenshot
        ? { kind: "screenshot", url: lastScreenshot, title: `Shared desktop, role ${spec.roleId} (${screenshotMode})` }
        : { kind: "placeholder", title: `Shared desktop, role ${spec.roleId}` },
      viewport: {
        width: args.sandboxResolution[0],
        height: args.sandboxResolution[1],
        deviceScaleFactor: args.sandboxPreset.deviceScaleFactor,
        isMobile: args.sandboxPreset.isMobile
      },
      ui: {
        route: spec.seatUrl,
        intent: `Watch role ${spec.roleId} (${spec.persona.id}) drive the SHARED app (one plane; sequential turn).`,
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
          ? [{ label: `role ${spec.roleId} actor trace`, path: spec.traceArtifactPath, kind: "trace" as const }]
          : []),
        ...screenshots.map((screenshot, screenshotIndex) => ({
          label: `role ${spec.roleId} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
          path: screenshot,
          kind: "screenshot" as const
        }))
      ]
    });

    // Per-role session event.
    if (session) {
      events.push({
        id: nextEventId(`session-${spec.roleId}`),
        at: createdAt,
        level: session.status === "passed" ? "info" : "warn",
        type: `shared-world.session.${session.completionReason}`,
        message: `Role ${spec.roleId}: ${session.status} — ${session.reason}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.skippedReason !== undefined) {
      events.push({
        id: nextEventId(`blocked-${spec.roleId}`),
        at: createdAt,
        level: "warn",
        type: "shared-world.session.blocked",
        message: `Role ${spec.roleId} ${outcome.skippedReason}.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.sessionError) {
      events.push({
        id: nextEventId(`session-error-${spec.roleId}`),
        at: createdAt,
        level: "error",
        type: "shared-world.session.error",
        message: `Role ${spec.roleId}: ${outcome.sessionError}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else {
      events.push({
        id: nextEventId(`contract-${spec.roleId}`),
        at: createdAt,
        level: "info",
        type: "shared-world.contract.ready",
        message: `Role ${spec.roleId}: dry-run contract role ready; switch scenario.mode to live for a real shared-world session.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }
  });

  // Build the shared-world evidence block (the timeline + plane + attribution ceiling).
  const seedDigest = args.seedDigest;
  const planeCommit = dryRun ? undefined : args.subjectCommit;
  const timeline: SharedWorldTimelineEntry[] = [args.baselineCheckpoint];
  const sequence: string[] = [];
  if (dryRun) {
    // Declared (contract) timeline: every role would take a turn; recipe-digest checkpoints, no delta.
    roleSpecs.forEach((spec) => {
      timeline.push({
        kind: "turn",
        roleId: spec.roleId,
        simId: spec.simId,
        streamId: spec.streamId,
        seedDigest
      });
      timeline.push(declaredCheckpointSnapshot(`cp-after-${spec.roleId}`, config.subject.state?.checkpoint ?? []));
      sequence.push(spec.roleId);
    });
  } else {
    // Executed timeline: only roles that took a turn (skipped roles contribute nothing).
    for (const outcome of roleOutcomes) {
      if (outcome.skippedReason !== undefined || outcome.afterCheckpoint === undefined) {
        continue;
      }
      timeline.push({
        kind: "turn",
        roleId: outcome.spec.roleId,
        simId: outcome.spec.simId,
        streamId: outcome.spec.streamId,
        ...(planeCommit === undefined ? {} : { commit: planeCommit }),
        seedDigest
      });
      timeline.push(outcome.afterCheckpoint);
      sequence.push(outcome.spec.roleId);
    }
  }

  const sharedWorld: SharedWorldEvidence = {
    schema: SHARED_WORLD_SCHEMA,
    topology: "shared-world",
    topologyMode: "sequential",
    roleCount: roleSpecs.length,
    plane: {
      ...(planeCommit === undefined ? {} : { commit: planeCommit }),
      seedDigest,
      envNames: args.subject.envNames ?? []
    },
    sequence,
    timeline,
    attributionLimits: ["sequential-only", "no-concurrent-races", "delta-attributed-to-turn-not-action"]
  };

  events.push({
    id: nextEventId("timeline"),
    at: createdAt,
    level: "info",
    type: "shared-world.timeline",
    message: `Interaction timeline: ${timeline.length} entries (${sequence.length} turn(s) interleaved with checkpoints); deltas observed on ${timeline.filter((entry) => entry.kind === "checkpoint" && entry.deltaFromPrev).map((entry) => (entry as SharedWorldCheckpoint).name).join(", ") || "none"}. Attribution ceiling: ${sharedWorld.attributionLimits.join(", ")}.`
  });
  if (args.failFastReason) {
    events.push({
      id: nextEventId("fail-fast"),
      at: createdAt,
      level: "warn",
      type: "shared-world.fail-fast",
      message: `Fail-fast: ${args.failFastReason}. Remaining roles were blocked; completed evidence is retained.`
    });
  }

  // Worst-of review verdict across roles.
  const verdict: ReviewSummary["verdict"] = dryRun
    ? "contract_proof_only"
    : (() => {
        const allPassed = roleOutcomes.length === roleSpecs.length
          && roleOutcomes.every((outcome) => sharedWorldRoleOutcomeOk(outcome, false));
        if (allPassed) return "pass";
        const anyFail = roleOutcomes.some((outcome) =>
          outcome.skippedReason !== undefined
          || outcome.harnessError
          || outcome.noEngagement
          || outcome.sessionError !== undefined
          || outcome.session === undefined
          || outcome.session.status === "failed"
          || outcome.session.status === "blocked");
        if (anyFail) return "fail";
        if (roleOutcomes.some((outcome) => outcome.session?.status === "timed_out")) return "timed_out";
        return "fail";
      })();
  const passedRoles = roleOutcomes.filter((outcome) =>
    sharedWorldRoleOutcomeOk(outcome, dryRun)).length;
  const configuredBrowser = config.execution?.desktop?.browser;
  const resolvedBrowsers = roleOutcomes
    .map((outcome) => outcome.desktopBrowser?.resolved)
    .filter((value): value is string => value !== undefined);
  const unanimousResolvedBrowser = resolvedBrowsers.length > 0 && new Set(resolvedBrowsers).size === 1
    ? resolvedBrowsers[0]
    : undefined;

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    summary: dryRun
      ? `Dry-run shared-world contract: ${roleSpecs.length} role(s) declared against ONE plane (${descriptor.id}) at ${appUrl}; no desktop launched, $0 spend.`
      : `Shared-world run (ONE plane, sequential): ${passedRoles}/${roleSpecs.length} role(s) reached a terminal, engaged verdict; ${timeline.filter((entry) => entry.kind === "checkpoint" && entry.deltaFromPrev).length} checkpoint delta(s) observed.`,
    gaps: dryRun
      ? ["Live shared-world session not yet run (dry-run contract only)."]
      : roleOutcomes
          .filter((outcome) =>
            outcome.skippedReason !== undefined
            || outcome.sessionError !== undefined
            || outcome.noEngagement
            || outcome.session === undefined
            || outcome.session.status !== "passed")
          .map((outcome) => `${outcome.spec.roleId}: ${outcome.skippedReason ?? outcome.sessionError ?? outcome.session?.reason ?? "did not pass"}`)
  };

  const anyRaw = roleOutcomes.some((outcome) => outcome.session?.trace.redaction.screenshots === "raw");
  const ranLive = roleOutcomes.some((outcome) => outcome.session !== undefined || outcome.sessionError !== undefined);

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: dryRun ? "dry-run" : "live",
    simCount: roleSpecs.length,
    createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".mimetic", "runs", args.runId),
    source: args.source,
    persona: {
      id: roleSpecs[0]?.persona.id ?? "shared-world-role",
      name: `Shared-world roster (${roleSpecs.length} roles)`,
      source: `lab:${config.id}`,
      sourceDigest: roleSpecs[0]?.persona.promptDigest ?? seedDigest
    },
    scenario: {
      id: `shared-world-${config.id}`,
      title: config.title ?? `Shared-world: ${config.id}`,
      goal: roleSpecs[0]?.instructions ?? "Shared-world sequential interaction.",
      source: `lab:${config.id}`,
      sourceDigest: roleSpecs[0]?.persona.promptDigest ?? seedDigest
    },
    lifecycle: [
      {
        at: createdAt,
        event: "shared-world.run.created",
        message: `Created shared-world run with ONE shared plane and ${roleSpecs.length} sequential role seats (actor ${descriptor.id}).`
      }
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: ranLive
        ? anyRaw
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Some roles captured FULL-FIDELITY (raw) screenshots, retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle. Checkpoints persist digest-only."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle. Checkpoints persist digest-only."
        : "Dry-run shared-world contract bundle: no desktop launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs. Checkpoints persist digest-only."
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
    // Custom desktop image provenance (the ONE shared plane launched on it); omitted on the default.
    ...(config.execution?.desktop?.template === undefined ? {} : { desktopTemplate: config.execution.desktop.template }),
    ...(configuredBrowser === undefined
      ? {}
      : { desktopBrowser: { requested: configuredBrowser, ...(unanimousResolvedBrowser === undefined ? {} : { resolved: unanimousResolvedBrowser }) } }),
    subject: args.subject,
    attributionClass: "shared-world",
    sharedWorld
  };
}

function sharedWorldRoleOutcomeOk(outcome: RoleOutcome | undefined, dryRun: boolean): boolean {
  if (dryRun) return true;
  if (!outcome || outcome.skippedReason !== undefined) return false;
  return outcome.session !== undefined
    && outcome.session.status === "passed"
    && outcome.session.completionReason !== "harness_error"
    && outcome.sessionError === undefined
    && !outcome.noEngagement;
}

function renderSharedWorldReviewMarkdown(bundle: RunBundle): string {
  const plane = bundle.events.find((event) => event.type === "shared-world.plane.provenance");
  const timeline = bundle.events.find((event) => event.type === "shared-world.timeline");
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- attribution class: ${bundle.attributionClass ?? "isolated"}`,
    `- topology: ${bundle.sharedWorld?.topology ?? "(none)"}`,
    `- roles: ${bundle.sharedWorld?.roleCount ?? 0}; sequence: ${(bundle.sharedWorld?.sequence ?? []).join(" → ") || "(none)"}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(plane ? [`- plane: ${plane.message}`] : []),
    ...(timeline ? [`- timeline: ${timeline.message}`] : []),
    ...(bundle.sharedWorld ? [`- attribution limits: ${bundle.sharedWorld.attributionLimits.join(", ")}`] : []),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
}
