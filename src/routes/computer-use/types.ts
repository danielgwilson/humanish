import type { Verdict } from "../../run/judge.js";
import type { RunDesktopRecording } from "../../evidence/desktop-recording-types.js";
import type {
  CuaExecutor,
  CuaLiveMetadata,
  CuaLoopResult,
  CuaProvider,
} from "../../actors/computer-use/loop.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import { type ParticipantDesktop } from "./participant-desktop.js";
import type { SubjectPhaseEvent } from "../../subject/steps.js";
import type { DesktopBrowserEvidence } from "../../substrates/e2b/desktop-browser.js";
import {
  type AutomaticAnalysisHooks,
  type AutomaticAnalysisResult,
} from "../../analysis/automatic-completion.js";
import { type CuaDiagnostics } from "./diagnostics.js";
import type {
  ActorCompletionReason,
  ActorStatus,
  ActorStopCause,
  ActorTokenUsage,
  ActorTraceItem,
} from "../../actors/contract.js";
import { type CuaActorDescriptor } from "../../actors/registry.js";
import { type BrowserLabAdapterHooks } from "../../lab/adapter-extension.js";
import type { CuaActorSessionOptions } from "../../actors/computer-use/actor.js";
import { type E2BDesktopModule, type E2BDesktopSandbox } from "../../substrates/e2b/sdk.js";
import { type DesktopResourceObservation } from "../../substrates/e2b/desktop-resources.js";
import { type DetachedTimers } from "../../substrates/detached.js";
import type { Brain, ComputerUsePlan, ComputerUseRunner } from "../../lab/plan-types.js";
import { type LabCommsEmail, type LabConfig } from "../../lab/types.js";
import { renderObserver, type ObserverResult } from "../../observer/render.js";
import { type RunLabProvenance } from "../../run/status.js";
import {
  type RunBundle,
  type RunRerunLineage,
  type RunScorerProvenance,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import { type RunDesktopGeometry } from "../../run/streams.js";
import { type PreparedOutputRoot } from "../../run/contained-output.js";
import { type LocalTreeArchive } from "../../subject/local-tree-archive.js";
import type {
  ComputerUseParticipant,
  SharedWorldParticipant,
} from "../../lab/plan-participants.js";
import type { ResolvedParticipant } from "../../run/participant.js";
import type { CuaLaneSpec } from "./legacy-lane-spec.js";

export const CUA_ACTOR_LAB_SCHEMA = "humanish.cua-lab-result.v2";

// The only fan-out topology this slice ships: N lanes = N independent E2B desktop sandboxes,
// each its own world (clone/serve + subject.state per lane). Shared-world is layer 7 (#164).
export const CUA_FANOUT_STRATEGY = "per-lane-worlds" as const;

// Env override that may only LOWER the effective concurrency (never raise concurrent paid
// desktops — invariant 3). Read names-only into a local; the value never persists.
export const CUA_MAX_CONCURRENCY_ENV = "HUMANISH_CUA_MAX_CONCURRENCY";

// The DEFAULT session budget, sized so a study can FINISH (docs/principles/three-roles.md: a
// session ends because the participant is done, not because a timer fired — the time-box is a
// session-level cap a researcher sets generously; spend protection is the dollar caps' job).
// The old 300s default ended real signup studies mid-flow: observed studies run 16-40 turns at
// ~5-6s per turn BEFORE any email wait, so five minutes was the biggest single source of
// budget_reached endings that read as participant failures.
//
// App-url and in-process routes default to 30 minutes. Provisioned routes (clone/local-tree)
// default to whatever the 1-hour sandbox cap leaves after provisioning, declared state seeding,
// and the teardown buffer — 20 minutes on a stateless clone — floored at the old five minutes so
// a state-heavy lab still gets a session at all. An EXPLICIT execution.timeoutMs is never
// adjusted: when it cannot be provisioned, the plan-time cap refusal shows the arithmetic.
export const DEFAULT_APP_URL_SESSION_TIMEOUT_MS = 30 * 60_000;

export const MIN_DERIVED_SESSION_TIMEOUT_MS = 5 * 60_000;

// Device/screen size comes from the named-preset registry (device-presets.ts), selectable per run
// via execution.desktop.device (default `desktop`=1440x950). NOTE: this is run-wide for now; a
// per-PERSONA device dimension (N personas × devices, as the bespoke sims author) lands with
// fan-out. On this E2B-desktop route only width/height physically render — isMobile/DSF are
// honest metadata + a prompt signal, not rendered (device-presets.ts FIDELITY NOTE) — and the
// rendered WIDTH is floored to MIN_DESKTOP_RENDER_WIDTH (Chrome's ~500px window minimum) so a mobile
// screen the browser can't shrink to does not overflow + clip (see resolveLaneDevice / #221).

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
  prepareDesktop?: (
    desktop: E2BDesktopSandbox,
    lane: { laneId: string; laneIndex: number; laneCount: number },
  ) => Promise<void>;
  /**
   * Pre-flight hook: receives the resolved lane plan BEFORE any sandbox or provider call (dry-run
   * AND live). The engine also prints the plan to stderr; this seam lets tests assert it without
   * scraping stderr. Identical plan in dry-run, marked $0.
   */
  onPreflight?: (plan: CuaParticipantPlan) => void;
  /**
   * Live subject-provisioning phase sink: one call per started/completed boundary (clone,
   * upload/extract, install, build, serve start, ready, and each subject.state seed-step
   * group). Defaults to one stderr line per event, prefixed with the lane id when laneCount > 1
   * (single-lane emission is unconditional: single-lane silence for the whole boot is the bug
   * this event stream closes). Override in tests to capture instead of writing to real stderr.
   */
  onPhase?: (
    event: SubjectPhaseEvent,
    ctx: { laneId: string; laneIndex: number; laneCount: number },
  ) => void;
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
  /** Fired when a lane's sandbox is gone (finished or torn down): the live stream URL is now a
   *  dead noVNC page, so the watch overlay must stop serving it and let the tile fall back to
   *  recorded evidence (#357). Fired only for lanes whose onRuntimeStreamReady fired. */
  onRuntimeStreamEnded?: (stream: {
    laneId: string;
    simId: string;
    streamId: string;
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
  buildExecutor?: (ctx: {
    config: LabConfig;
    actor: CuaActorDescriptor;
    appUrl: string;
  }) => Promise<CuaExecutor>;
  /**
   * Supply a custom provider (a "brain" reasoning over app STATE). REQUIRED alongside
   * `buildExecutor` — the default OpenAI provider is vision-based (requiresFrame) and would fail
   * closed against a state-only executor that returns no screenshot. (`buildProvider` ALONE is
   * allowed — that is just a model swap on the normal E2B route.)
   */
  buildProvider?: (ctx: {
    config: LabConfig;
    actor: CuaActorDescriptor;
    lane: CuaLaneSpec;
    /** How many participants the run has. */
    laneCount: number;
    executor: CuaExecutor;
  }) => Promise<CuaProvider>;
  /**
   * Substitute desktop ownership while retaining the shared participant and evidence loop.
   * @deprecated No replacement: a run's desktop is E2B, the local VM or in process. This goes in
   * the next minor.
   */
  createDesktopLane?: (
    spec: CuaLaneSpec,
    warnings: string[],
    artifactRoot: PreparedOutputRoot,
  ) => ParticipantDesktop;
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock (ms) for the host-side E2B desktop create->teardown span measurement that
   *  feeds the desktop-minute cost estimate. Defaults to Date.now; tests inject a frozen/stepped
   *  clock so the desktop-minute line is deterministic. */
  now?: () => number;
  /** Injected clock/sleep for the detached-step polling (tests only). */
  detachedTimers?: DetachedTimers;
  /**
   * Local-tree packing DI seam (tests only, no npm dependency needed to exercise the route):
   * defaults to createLocalTreeArchive(root, opts) plus a host-side read of the produced
   * archive file into an ArrayBuffer. Called ONCE per run, before lane fan-out, on the live
   * local-tree route; the result (archive metadata + bytes) is shared byte-identically across
   * every fan-out lane, so one archiveSha256 describes every lane's packed content.
   */
  packLocalTree?: (args: {
    root: string;
    extraExclude?: string[];
    maxArchiveBytes?: number;
  }) => Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }>;
}

/**
 * What a computer-use run takes besides its plan and config. The count override and rerun go to
 * participant building with the config.
 */
export type ComputerUseRunInput = Omit<RunCuaActorLabOptions, "config" | "dryRun" | "lab">;

export interface RunCuaActorLabOptions {
  automaticAnalysis?: AutomaticAnalysisHooks;
  cwd: string;
  config: LabConfig;
  /** Which manifest produced this run (#455); threaded into the run's status record + bundle. */
  lab?: RunLabProvenance;
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
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  /** Present only when the browser-route scorer hooks were CONFIG-DECLARED and loaded by the CLI
   *  (#316); core-stamped onto the bundle as evidence. Absent for library callers. */
  scorerProvenance?: RunScorerProvenance;
}

/** A lane's row in the pre-flight plan: identity + the device/persona it will drive. The prompt
 *  text never leaks — only a sha256-16 digest of the composed instructions. */
export interface CuaParticipantPlanEntry {
  id: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  /** 1-based display index. */
  index: number;
  persona: string;
  device: string;
  /** Requested E2B/X screen resolution. This is not the measured browser CSS viewport. */
  resolution: [number, number];
  instructionDigest: string;
  /** The declared reasoning effort for this lane, when the lab declared one. The plan line is what
   *  you read BEFORE spending money, so a declared per-lane difference has to be visible there. */
  reasoningEffort?: string;
  maxOutputTokens?: number;
  /** Present only when a lane overrides subject.appUrl; digest avoids leaking preview hosts in plan logs. */
  targetDigest?: string;
}

/** The pre-flight spend/lane plan (pure; printed to stderr + recorded as a bundle event before
 *  any sandbox or provider call; identical in dry-run, marked $0). */
export interface CuaParticipantPlan {
  strategy: typeof CUA_FANOUT_STRATEGY;
  laneCount: number;
  /** Effective in-flight bound (defaults to laneCount — all seats live; a declared
   *  execution.concurrency is a cap; the env override may only LOWER it). */
  concurrency: number;
  /** Present when the env override lowered the bound below the config's value — recorded so the
   *  plan never silently disagrees with the manifest. */
  envLoweredConcurrencyFrom?: number;
  /** ceil(laneCount / concurrency). */
  waves: number;
  /** Per-lane session wall-clock budget (execution.timeoutMs); there is no run-level wall clock. */
  perLaneSessionBudgetMs: number;
  /** Worst-case TOTAL sandbox-minutes across all lanes (each lane's full sandbox deadline). */
  worstCaseSandboxMinutes: number;
  /** True for a dry-run plan (no spend); the same table appears live. */
  dryRun: boolean;
  lanes: CuaParticipantPlanEntry[];
}

/** One lane's outcome in the result projection. ALWAYS present in `result.lanes` (length 1 at
 *  N=1). A `blocked` lane is one the pipeline-gate / fail-fast skipped before it ran. */
export interface CuaParticipantResult {
  id: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  index: number;
  persona: string;
  device: string;
  /** Requested E2B/X screen resolution. See the run stream's desktopGeometry for measurements. */
  resolution: [number, number];
  /** Terminal lane status; "blocked" = skipped (gate/fail-fast); "contract_proof_only" = dry-run. */
  status: ActorStatus | "blocked" | "contract_proof_only";
  ok: boolean;
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    /** Recorded control cause; absent on older or naturally completed sessions. */
    stopCause?: ActorStopCause;
    reason: string;
    screenshots: number;
  };
  sandbox?: {
    sandboxId: string;
    killed: boolean;
    streamUrlPresent: boolean;
  };
  subject: CuaSubjectProjection;
  diagnostics?: CuaDiagnostics;
  /** Set when the lane was skipped (pinned reason string). */
  skippedReason?: string;
  error?: { code: CuaActorLabErrorCode; message: string };
}

/** Aggregate counts across lanes. */
export interface CuaParticipantSummary {
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
  | "HUMANISH_LAB_ANALYSIS_INVALID"
  | "HUMANISH_LAB_TASKS_UNSUPPORTED"
  | "HUMANISH_LAB_OPTION_CONFLICT"
  | "HUMANISH_LAB_OPTION_UNSUPPORTED"
  | "HUMANISH_CUA_LAB_FAILED"
  | "HUMANISH_CUA_LAB_KEYS_MISSING"
  // A local-agent participant's CLI is not on PATH. Refused at preflight (before any sandbox).
  | "HUMANISH_CUA_LAB_AGENT_MISSING"
  // A local-agent participant's CLI reports not signed in, or could not report its sign-in status.
  // Refused at preflight (before any sandbox); the message names the fix.
  | "HUMANISH_CUA_LAB_AGENT_SIGNIN_REQUIRED"
  | "HUMANISH_CUA_LAB_SUBJECT_ENV_MISSING"
  | "HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED"
  | "HUMANISH_CUA_LAB_SUBJECT_INVALID"
  | "HUMANISH_CUA_LAB_SUBJECT_UNSAFE"
  | "HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER"
  | "HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR"
  | "HUMANISH_CUA_LAB_LOCAL_DESKTOP_MISSING"
  | "HUMANISH_CUA_LAB_FANOUT_INVALID"
  | "HUMANISH_CUA_LAB_RERUN_INVALID"
  | "HUMANISH_CUA_LAB_DEVICE_GEOMETRY"
  | "HUMANISH_RUN_ID_IN_USE"
  // A fail-closed spend cap (execution.caps.maxUsd) was set but src/run/pricing.ts has no rate for the
  // resolved model, so the cap could not be enforced. Refused at preflight (before any sandbox)
  // rather than run uncapped — an unenforceable cap is more dangerous than none.
  | "HUMANISH_CUA_LAB_UNPRICED_CAP"
  // comms.email.external was declared but its catch did not answer as a humanish comms catch.
  // Refused at preflight (before any sandbox): a comms lab whose catch is unreachable collects
  // nothing while every lane still spends (#380).
  | "HUMANISH_CUA_LAB_COMMS_CATCH_UNREACHABLE"
  // watch --expose (tunnel-edge auth) validation + tunnel-startup failures surfaced by runCuaBackend
  // before or around the run. Carried on the CUA lab envelope so `watch <cua-lab> --expose` refusals
  // render through the same formatter as any other CUA lab failure.
  | "HUMANISH_WATCH_ALLOW_REQUIRES_OAUTH"
  | "HUMANISH_WATCH_OAUTH_REQUIRES_TUNNEL"
  | "HUMANISH_WATCH_OPTION_CONFLICT"
  | "HUMANISH_WATCH_TUNNEL_REQUIRES_EXPOSE"
  | "HUMANISH_WATCH_EXPOSE_REQUIRES_EDGE_AUTH"
  | "HUMANISH_WATCH_EXPOSE_REQUIRES_LIVE_FOLLOW"
  | "HUMANISH_WATCH_SAFE_NOT_APPLICABLE"
  | "HUMANISH_SERVE_TUNNEL_NOT_FOUND"
  | "HUMANISH_SERVE_TUNNEL_START_FAILED";

/** Subject provenance projection (invariant 5): what the actor actually drove. */
export interface CuaSubjectProjection {
  source: "app-url" | "clone" | "local-tree";
  /** Clone-route only: the (possibly redacted) owner/repo slug. */
  repo?: string;
  /** Cloned commit SHA (clone route) or host-side HEAD at pack time (local-tree route, when
   *  the packed root was a git work tree). */
  commit?: string;
  /** Local-tree-route only: 64-hex sha256 over the sorted packed-entries list: the content
   *  pin for a tree that cannot be commit-pinned. Absent on dry-run (nothing was packed). */
  archiveSha256?: string;
  /** Local-tree-route only: host-side porcelain status at pack time (true when the working
   *  tree had uncommitted changes). Absent when the packed root was not a git work tree. */
  dirty?: boolean;
  /** Declared env NAMES provisioned for the subject (values never surface anywhere). */
  envNames?: string[];
  /** The subject's state story (seeded digests / UNPINNED external / declared-not-run /
   *  undeclared): the same block the run bundle records. */
  state: RunSubjectProvenance["state"];
}

/** The provisioned-route-only shape threaded through as buildSingleParticipantBundle's
 *  subjectProvenance arg (clone or local-tree; an app-url subject stays undeclared, which that
 *  builder's own default branch already handles without this type). */
export type CuaSubjectProvenanceArg =
  | {
      source: "clone";
      repo: string;
      commit?: string;
      envNames: string[];
      state: RunSubjectProvenance["state"];
    }
  | {
      source: "local-tree";
      archiveSha256?: string;
      commit?: string;
      dirty?: boolean;
      envNames: string[];
      state: RunSubjectProvenance["state"];
    };

export interface CuaActorLabResult extends AutomaticAnalysisResult {
  schema: typeof CUA_ACTOR_LAB_SCHEMA;
  /** True when the Observer verified the bundle, all live lanes passed credibility checks
   * (or this is a dry-run), and no declared adapter/scorer verdict failed. */
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
    /** Recorded control cause; absent on older or naturally completed sessions. */
    stopCause?: ActorStopCause;
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
  plan?: CuaParticipantPlan;
  /** Per-lane results — ALWAYS present once lanes resolve (length 1 at N=1). */
  lanes?: CuaParticipantResult[];
  /** Aggregate lane counts. */
  laneSummary?: CuaParticipantSummary;
  /** Present when this run explicitly re-executes selected lanes from a prior CUA fan-out run. */
  rerun?: RunRerunLineage;
  observer?: ObserverResult;
  diagnostics?: CuaDiagnostics;
  warnings: string[];
  error?: {
    code: CuaActorLabErrorCode;
    message: string;
  };
}

/**
 * What a computer-use lane or a shared-world seat runs: the resolved participant, plus where its
 * evidence goes and any backstop override its route sets. The public projections are
 * CuaParticipantPlanEntry and CuaParticipantResult.
 */
export interface DesktopParticipantRun extends ResolvedParticipant<
  ComputerUseParticipant | SharedWorldParticipant
> {
  /** "" for one participant (screenshots/<name>); the participant id for more
   *  (screenshots/<id>/<name>). */
  readonly screenshotDir: string;
  /** "actor.json" for one participant; "actors/<streamId>.json" for more. */
  readonly traceArtifactPath: string;
  /**
   * Overrides of the CUA idle and no-progress backstops, for a participant whose job includes a
   * long legitimate wait (a shared-world host in the waiting room, a follower before the game
   * starts). Absent means the loop defaults.
   */
  readonly backstop?: { readonly idleSteps?: number; readonly noProgressSteps?: number };
}

export interface ParticipantRunsAndPlan {
  runs: DesktopParticipantRun[];
  participantPlan: CuaParticipantPlan;
}

/**
 * The STUDY's shared spend ledger (#299): one counter across every lane. Each lane notes its own
 * latest running MODEL-spend estimate (monotone per lane — an estimate can only grow) and reads
 * back the run total; the loop stops the lane the moment the total crosses the study budget.
 * Estimated model spend only: desktop-minutes ride the cost summary, not this ledger.
 */
export interface CuaRunBudget {
  maxTotalUsd: number;
  /** Record this lane's latest running estimate (null = unpriceable, ignored) and return the
   *  run's current total across all lanes. */
  note(participantId: string, estimateUsd: number | null): number;
}

/**
 * The subject as a participant's desktop meets it. A computer-use participant gets the plan's
 * subject: a clone or local tree is provisioned in its own sandbox with the declared env, a
 * desktop-cli product is set up there, and an app-url or local-app subject is only opened. A
 * shared-world seat gets `shared-app`: it opens the one app the plane serves, with no subject env
 * names forwarded, no GitHub token and no provisioning in its sandbox.
 */
export type ParticipantSubject = ComputerUseRunner["subject"] | { readonly kind: "shared-app" };

/** The subject env names forwarded into a participant's sandbox: a provisioned subject's only. */
export function participantSubjectEnv(subject: ParticipantSubject): readonly string[] {
  return subject.kind === "clone" || subject.kind === "local-tree" ? subject.env : [];
}

/** Shared deps every lane runner needs (resolved once in the engine). */
export interface CuaParticipantDeps {
  /** Internal ready-desktop seam. The factory must not allocate; prepare owns that work. */
  createDesktop?: (
    spec: DesktopParticipantRun,
    warnings: string[],
    artifactRoot: PreparedOutputRoot,
  ) => ParticipantDesktop;
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  /** The plan's brain: the model and, for a local agent, which signed-in CLI drives the participant. */
  brain: Brain;
  /** What the participant's desktop does with the subject before the participant starts. */
  subject: ParticipantSubject;
  /** Local-tree route only: the once-per-run packed archive bytes, shared byte-identically
   *  across every fan-out lane's upload step. Absent on dry-run and every other route. */
  localTreeArchiveBuffer?: ArrayBuffer;
  env: Record<string, string | undefined>;
  openaiApiKey: string;
  e2bApiKey: string;
  requestTimeoutMs: number;
  sandboxMs: number;
  timeoutMs: number;
  participantCount: number;
  artifactRoot: PreparedOutputRoot;
  /** The lab's resolution directory: relative paths in the config (a camera .y4m) resolve here. */
  labCwd: string;
  redactScreenshots: boolean;
  scrubKnownValues: (text: string) => string;
  receiving?: CommsReceivingRun;
  runSession: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  /** The study's shared spend ledger, present exactly when execution.caps.maxTotalUsd is set on a
   *  live run (#299). Preflight already refused the cap on an unpriced model. */
  runBudget?: CuaRunBudget;
  /** Adopter-hosted comms plane (#380): present on the app-url route when comms.email.external is
   *  declared. Carries the parsed comms block (recipients drive the per-lane inbox instruction)
   *  and the inbox URL the persona opens. The drain runs once at run level, not per lane. */
  externalComms?: { email: LabCommsEmail; inboxUrl: string };
  /** Injected clock (ms). Used to measure the host-side E2B desktop create->teardown span so the
   *  desktop-minute cost estimate is deterministic in tests. Defaults to Date.now. */
  now: () => number;
  hooks: CuaActorLabHooks;
  /** Lane-0 only: signal the pipeline gate after provisioning succeeds (true) or fails (false). */
  signalProvisioned?: (ok: boolean) => void;
  /**
   * How a PARSEABLE requested-vs-verified screen mismatch is treated. Default ("fail-closed"):
   * the lane's device claim is falsified, so the lane fails with DEVICE_GEOMETRY (the
   * single-lane/fan-out contract). "record-evidence" (the concurrent shared-world route):
   * requested and verified stay recorded as separate facts plus an explicit warning, and the
   * lane keeps running, so one seat's screen drift cannot abort a live multi-actor world.
   */
  screenMismatchPolicy?: "fail-closed" | "record-evidence";
  /**
   * RUNTIME-ONLY observed-URL callback (#164 handoff crux): threaded into the lane's session so the
   * orchestrator watches this seat's live location.href mid-run. Never persisted (see
   * CuaLoopOptions.onObservedUrl). The concurrent shared-world barrier passes a host-seat latch here
   * to extract a /lobby/CODE; on ordinary routes it is undefined (no-op).
   */
  onObservedUrl?: (url: string | undefined) => void;
  /** RUNTIME-ONLY per-turn narration callback; see CuaLoopOptions.onMessage. The concurrent
   * shared-world barrier passes a host-seat message scanner here to latch the lobby code. */
  onMessage?: (text: string) => void;
  /** RUNTIME-ONLY per-turn raw-frame callback; see CuaLoopOptions.onScreenshot. The concurrent
   * shared-world barrier passes a host-seat vision reader here to latch the lobby code off-screen. */
  onScreenshot?: (frame: Buffer) => void;
  /** Per-turn trace snapshot from a participant's loop (#441), keyed by participant. The live path
   * wires the incremental in-progress flush here so the attached Observer's timeline grows mid-run. */
  onTrace?: (
    participantId: string,
    items: readonly ActorTraceItem[],
    usage?: ActorTokenUsage,
    metadata?: CuaLiveMetadata,
  ) => void;
}

/** One lane's end-to-end run outcome (internal; projected into CuaParticipantResult + the bundle). */
export interface ParticipantRunOutcome {
  spec: DesktopParticipantRun;
  session?: CuaLoopResult;
  /** The harness failed before the session reached a terminal status. */
  sessionError?: string;
  /** The model provider's cleanup is unconfirmed after the session. An execution failure only:
   *  it does not change how the participant's session ended. */
  providerCleanupError?: string;
  sandboxId?: string;
  /** Host-side E2B desktop create->teardown span (ms). An APPROXIMATION of E2B's server-side
   *  billed lifetime (server-side kill-on-timeout can extend it) — so the derived dollar figure is
   *  doubly an estimate. Absent on the in-process route (no sandbox) and on dry-run. */
  desktopDurationMs?: number;
  desktopResources?: DesktopResourceObservation;
  killed: boolean;
  streamUrlPresent: boolean;
  screenshots: string[];
  subjectCommit?: string;
  desktopBrowser?: DesktopBrowserEvidence;
  /** Requested + measured desktop/browser geometry. Viewport is absent when measurement failed. */
  desktopGeometry?: RunDesktopGeometry;
  recording?: RunDesktopRecording;
  stateStepRecords: RunSubjectStateStepRecord[];
  /** Completed subject-phase records (clone/upload/extract/install/build/ready/state groups),
   *  folded into bundle.events at build time. Empty on the in-process route (no provisioning). */
  phaseRecords: SubjectPhaseEvent[];
  warnings: string[];
  /** Set when the lane was skipped by the pipeline gate / fail-fast (a pinned reason). */
  skippedReason?: string;
  noEngagement: boolean;
  selfReportedBlocker: boolean;
  /** The inclusive friction read (#453): blocker-shaped narration incl. self-resolved arcs.
   *  Feeds the participants tally and feedback candidates; never the lane verdict. Optional so
   *  external outcome constructors (shared-world, test fakes) stay valid; absent counts as false. */
  reportedFriction?: boolean;
  harnessError: boolean;
  failureCode?: CuaActorLabErrorCode;
  /** Relative run-dir path of the digest-only comms-thread evidence artifact this lane wrote
   *  (humanish.comms-thread.v1), when a comms lab captured mail into its in-sandbox catch. Registered
   *  in the lane's stream artifacts. Absent when no comms lab ran or nothing was captured. */
  commsArtifactPath?: string;
}

/** What buildCuaFanoutBundle projects into a fan-out run bundle. */
export interface CuaFanoutBundleArgs {
  /** The run's verdict, from the judge. */
  verdict: Verdict;
  /** Lab provenance for the bundle's own `lab` field (#455). */
  lab?: RunLabProvenance;
  specs: DesktopParticipantRun[];
  outcomes?: ParticipantRunOutcome[];
  subjects: CuaSubjectProjection[];
  aggregateSubject: CuaSubjectProjection;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  createdAt: string;
  dryRun: boolean;
  plan: ComputerUsePlan;
  runId: string;
  source: RunBundle["source"];
  participantPlan: CuaParticipantPlan;
  rerun?: RunRerunLineage;
  failFastReason?: string;
  cloneRoute: boolean;
  localTreeRoute?: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
  inProgress?: boolean;
}
