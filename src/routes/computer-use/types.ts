import type { Verdict } from "../../run/judge.js";
import type { RunDesktopRecording } from "../../evidence/desktop-recording-types.js";
import type {
  CuaExecutor,
  CuaLiveMetadata,
  CuaLoopResult,
  CuaProvider,
} from "../../actors/computer-use/loop.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import { type ParticipantDesktop, type ParticipantDesktopFactory } from "./participant-desktop.js";
import type { SubjectPhaseEvent } from "../../subject/steps.js";
import type { DesktopBrowserEvidence } from "../../substrates/e2b/desktop-browser.js";
import { type AutomaticAnalysisResult } from "../../analysis/automatic-completion.js";
import type { AutomaticAnalysisRefusal } from "../../analysis/job.js";
import { type CuaDiagnostics } from "./diagnostics.js";
import type {
  ActorCompletionReason,
  ActorStatus,
  ActorStopCause,
  ActorTokenUsage,
  ActorTraceItem,
} from "../../actors/contract.js";
import { type CuaActorDescriptor } from "../../actors/registry.js";
import type { StudyDeps } from "../../study/study-deps.js";
import type { StudyEvent, ParticipantRef } from "../../study/run-study-events.js";
import type {
  InProcessDriver,
  ProviderFactory,
  RunStudyHomes,
} from "../../study/run-study-homes.js";
import { type BrowserScorer } from "../../study/adapter-extension.js";
import type { CuaActorSessionOptions } from "../../actors/computer-use/actor.js";
import { type E2BDesktopModule } from "../../substrates/e2b/sdk.js";
import { type DesktopResourceObservation } from "../../substrates/e2b/desktop-resources.js";
import { type DetachedTimers } from "../../substrates/detached.js";
import type {
  Brain,
  ComputerUsePlan,
  ComputerUseRunner,
  ResidualConfig,
} from "../../study/plan-types.js";
import { type StudyCommsEmail } from "../../study/types.js";
import { type ObserverResult } from "../../observer/render.js";
import {
  type BundleRun,
  type RunBundle,
  type RunRerunLineage,
  type RunScorerProvenance,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import { type RunDesktopGeometry } from "../../run/streams.js";
import { type PreparedOutputRoot } from "../../run/contained-output.js";
import type {
  ComputerUseParticipant,
  SharedWorldParticipant,
} from "../../study/plan-participants.js";
import type { ResolvedParticipant } from "../../run/participant.js";
import { type StudyResultIdentity } from "../../run/study-result.js";

// The fan-out topology of this route: N participants = N independent E2B desktop sandboxes,
// each its own world (clone/serve + subject.state per participant). Shared-world has its own route.
export const CUA_FANOUT_STRATEGY = "per-lane-worlds" as const;

// Env override that may only lower the effective concurrency (never raise concurrent paid
// desktops). Read names-only into a local; the value never persists.
export const CUA_MAX_CONCURRENCY_ENV = "HUMANISH_CUA_MAX_CONCURRENCY";

// The default session budget, sized so a study can finish (docs/principles/three-roles.md: a
// session ends because the participant is done, not because a timer fired; the time-box is a
// session-level cap a researcher sets generously; spend protection is the dollar caps' job).
// The old 300s default ended real signup studies mid-flow: observed studies run 16-40 turns at
// ~5-6s per turn before any email wait, so five minutes was the biggest single source of
// budget_reached endings that read as participant failures.
//
// App-url and in-process routes default to 30 minutes. Provisioned routes (clone/local-tree)
// default to whatever the 1-hour sandbox cap leaves after provisioning, declared state seeding,
// and the teardown buffer (20 minutes on a stateless clone), floored at the old five minutes so
// a state-heavy study still gets a session at all. An explicit execution.timeoutMs is never
// adjusted: when it cannot be provisioned, the plan-time cap refusal shows the arithmetic.
export const DEFAULT_APP_URL_SESSION_TIMEOUT_MS = 30 * 60_000;

export const MIN_DERIVED_SESSION_TIMEOUT_MS = 5 * 60_000;

// Device/screen size comes from the named-preset registry (device-presets.ts), selectable per run
// via execution.desktop.device (default `desktop`=1440x950). NOTE: this is run-wide for now; a
// per-persona device dimension (N personas × devices, as the bespoke sims author) lands with
// fan-out. On this E2B-desktop route only width/height physically render; isMobile/DSF are
// metadata + a prompt signal and are not rendered (see the header of device-presets.ts), and the
// rendered width is floored to MIN_DESKTOP_RENDER_WIDTH (Chrome's ~500px window minimum) so a mobile
// screen the browser can't shrink to does not overflow + clip (see resolveParticipantDevice).

/**
 * What runStudyWith's local VM study gives a computer-use run: the desktop each participant runs on, the
 * reason automatic analysis must not run (the study's cleanup is unconfirmed), and the signal its
 * sessions abort on.
 */
export interface LocalVmInput {
  readonly desktop: ParticipantDesktopFactory;
  /** The skip reason automatic analysis records instead of running, or undefined to run it. */
  readonly analysisRefusal: () => AutomaticAnalysisRefusal | undefined;
  readonly signal?: AbortSignal;
}

/**
 * What a computer-use run takes besides its plan and config. The count override and rerun go to
 * participant building with the config.
 */
export interface ComputerUseRunInput {
  /** Cancels post-run analysis only. */
  analysisSignal?: AbortSignal;
  cwd: string;
  open?: boolean;
  runId?: string;
  /** CLI `--count` override for the homogeneous fan-out participant count (ignored when a `lanes`
   *  roster is declared; a roster's length is authoritative). */
  countOverride?: number;
  /** Explicitly create a new run containing failed or selected participants from a prior fan-out run. */
  rerun?: {
    sourceRunId: string;
    participantIds?: string[];
  };
  /** Keys and subject env for the run. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** E2B only. Runs on each participant's desktop after it exists and before provisioning. */
  prepareDesktop?: NonNullable<RunStudyHomes["prepareDesktop"]>;
  /** runStudyWith's local VM study, for an app-url study on the local target. */
  localVm?: LocalVmInput;
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  /** Awaited after a participant's live stream starts, and again after its sandbox is gone. */
  onStream?: NonNullable<RunStudyHomes["onStream"]>;
  /** The caller's brain for each participant, in place of the study's own. */
  createProvider?: ProviderFactory;
  /** Drives an app-url or local-app subject in this process, with no desktop. Needs createProvider. */
  inProcess?: InProcessDriver;
  /** Reports the plan and subject phases to onEvent; built by normalizeRunStudyOptions. */
  emit?: (event: StudyEvent) => void;
  /** Test seams. */
  deps?: StudyDeps;
  /** Scores the assembled evidence: `RunStudyOptions.scorer`, or the scorer the CLI loads. */
  scorer?: BrowserScorer;
  /** Present only when the scorer was config-declared and loaded by the CLI;
   *  core-stamped onto the bundle as evidence. Absent for library callers. */
  scorerProvenance?: RunScorerProvenance;
}

/** A participant's row in the pre-flight plan: identity + the device/persona it will drive. The prompt
 *  text never leaks: only a sha256-16 digest of the composed instructions. */
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
  /** The declared reasoning effort for this participant, when the study declared one. The plan line is what
   *  you read before spending money, so a declared per-participant difference has to be visible there. */
  reasoningEffort?: string;
  maxOutputTokens?: number;
  /** Present only when a participant overrides subject.appUrl; digest avoids leaking preview hosts in plan logs. */
  targetDigest?: string;
}

/** The pre-flight spend and participant plan (pure; printed to stderr + recorded as a bundle event before
 *  any sandbox or provider call; identical in dry-run, marked $0). */
export interface CuaParticipantPlan {
  strategy: typeof CUA_FANOUT_STRATEGY;
  laneCount: number;
  /** Effective in-flight bound (defaults to laneCount, all participants live; a declared
   *  execution.concurrency is a cap; the env override may only lower it). */
  concurrency: number;
  /** Present when the env override lowered the bound below the config's value, recorded so the
   *  plan never silently disagrees with the manifest. */
  envLoweredConcurrencyFrom?: number;
  /** ceil(laneCount / concurrency). */
  waves: number;
  /** Per-participant session wall-clock budget (execution.timeoutMs); there is no run-level wall clock. */
  perLaneSessionBudgetMs: number;
  /** Worst-case total sandbox-minutes across all participants (each one's full sandbox deadline). */
  worstCaseSandboxMinutes: number;
  /** True for a dry-run plan (no spend); the same table appears live. */
  dryRun: boolean;
  lanes: CuaParticipantPlanEntry[];
}

/** One participant's outcome in the result projection. Always present in `result.lanes` (length
 *  1 at N=1). A `blocked` participant is one the pipeline-gate / fail-fast skipped before it ran. */
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
  /** Terminal participant status; "blocked" = skipped (gate/fail-fast); "contract_proof_only" = dry-run. */
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
    /** "[redacted-sandbox-id]"; the raw id is only in the run's sandbox-receipts.ndjson. */
    sandboxId: string;
    /** The id's digest, which matches its receipt. */
    sandboxIdDigest?: string;
    killed: boolean;
    streamUrlPresent: boolean;
  };
  subject: CuaSubjectProjection;
  diagnostics?: CuaDiagnostics;
  /** Set when the participant was skipped (pinned reason string). */
  skippedReason?: string;
  error?: { code: CuaActorStudyErrorCode; message: string };
}

/** Aggregate counts across participants. */
export interface CuaParticipantSummary {
  strategy: typeof CUA_FANOUT_STRATEGY;
  total: number;
  /** Participants whose own verdict is ok (terminal, engaged, no harness error). */
  passed: number;
  /** Participants skipped by the pipeline gate / fail-fast. */
  skipped: number;
  /** Participants that ended in a harness error. */
  harnessErrors: number;
  /** Participants that returned goal_satisfied with zero engagement (hollow). */
  hollow: number;
  concurrency: number;
  waves: number;
}

export type CuaActorStudyErrorCode =
  | "HUMANISH_STUDY_ANALYSIS_INVALID"
  | "HUMANISH_STUDY_TASKS_UNSUPPORTED"
  | "HUMANISH_STUDY_OPTION_UNSUPPORTED"
  | "HUMANISH_STUDY_V2_UNSUPPORTED"
  | "HUMANISH_COMPUTER_USE_FAILED"
  | "HUMANISH_COMPUTER_USE_KEYS_MISSING"
  // A local-agent participant's CLI is not on `PATH`. Refused at preflight (before any sandbox).
  | "HUMANISH_COMPUTER_USE_AGENT_MISSING"
  // A local-agent participant's CLI reports not signed in, or could not report its sign-in status.
  // Refused at preflight (before any sandbox); the message names the fix.
  | "HUMANISH_COMPUTER_USE_AGENT_SIGNIN_REQUIRED"
  | "HUMANISH_COMPUTER_USE_SUBJECT_ENV_MISSING"
  | "HUMANISH_COMPUTER_USE_ACTOR_UNSUPPORTED"
  | "HUMANISH_COMPUTER_USE_SUBJECT_INVALID"
  | "HUMANISH_COMPUTER_USE_SUBJECT_UNSAFE"
  | "HUMANISH_COMPUTER_USE_EXECUTOR_NO_PROVIDER"
  | "HUMANISH_COMPUTER_USE_LOCAL_APP_NO_EXECUTOR"
  | "HUMANISH_COMPUTER_USE_LOCAL_DESKTOP_MISSING"
  | "HUMANISH_COMPUTER_USE_FANOUT_INVALID"
  | "HUMANISH_COMPUTER_USE_RERUN_INVALID"
  | "HUMANISH_COMPUTER_USE_DEVICE_GEOMETRY"
  | "HUMANISH_RUN_ID_IN_USE"
  // A fail-closed spend cap (execution.caps.maxUsd) was set but src/run/pricing.ts has no rate for the
  // resolved model, so the cap could not be enforced. Refused at preflight (before any sandbox)
  // rather than run uncapped: an unenforceable cap is more dangerous than none.
  | "HUMANISH_COMPUTER_USE_UNPRICED_CAP"
  // comms.email.external was declared but its catch did not answer as a humanish comms catch.
  // Refused at preflight (before any sandbox): a comms study whose catch is unreachable collects
  // nothing while every participant still spends.
  | "HUMANISH_COMPUTER_USE_COMMS_CATCH_UNREACHABLE"
  // comms.email.external.authTokenEnv names a token shorter than MIN_CATCH_TOKEN_LENGTH or not
  // well-formed Unicode (src/comms/external-evidence.ts). Refused at preflight, before the catch is
  // probed.
  | "HUMANISH_COMPUTER_USE_COMMS_TOKEN_INVALID"
  // watch --expose (tunnel-edge auth) validation + tunnel-startup failures surfaced by prepareCuaWatch
  // before or around the run. Carried on the computer-use route's envelope so
  // `watch <computer-use study> --expose` refusals render through the same formatter as any other computer-use
  // study failure.
  | "HUMANISH_WATCH_ALLOW_REQUIRES_OAUTH"
  | "HUMANISH_WATCH_OAUTH_REQUIRES_TUNNEL"
  | "HUMANISH_WATCH_OPTION_CONFLICT"
  | "HUMANISH_WATCH_TUNNEL_REQUIRES_EXPOSE"
  | "HUMANISH_WATCH_EXPOSE_REQUIRES_EDGE_AUTH"
  | "HUMANISH_WATCH_EXPOSE_REQUIRES_LIVE_FOLLOW"
  | "HUMANISH_WATCH_SAFE_NOT_APPLICABLE"
  | "HUMANISH_SERVE_TUNNEL_NOT_FOUND"
  | "HUMANISH_SERVE_TUNNEL_START_FAILED";

/** Subject provenance projection: what the actor actually drove. */
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
  /** Declared env names provisioned for the subject (values never surface anywhere). */
  envNames?: string[];
  /** The subject's state story (seeded digests / unpinned external / declared-not-run /
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

export interface CuaActorStudyResult
  extends AutomaticAnalysisResult, StudyResultIdentity<"computer-use"> {
  /** True when the Observer verified the bundle, all live participants passed credibility checks
   * (or this is a dry-run), and no declared adapter/scorer verdict failed. */
  ok: boolean;
  cwd: string;
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
    /** "[redacted-sandbox-id]"; the raw id is only in the run's sandbox-receipts.ndjson. */
    sandboxId: string;
    /** The id's digest, which matches its receipt. */
    sandboxIdDigest?: string;
    killed: boolean;
    /** The stream URL itself (carries an auth key) is runtime-only and is deliberately not
     * surfaced on the result; the sandbox is already dead by the time the result exists. */
    streamUrlPresent: boolean;
  };
  /** Subject provenance: what the actor actually drove. At N>1 this is the
   *  unanimity-gated aggregate (top-level `commit` only when every participant resolved the same one). */
  subject?: CuaSubjectProjection;
  /** The pre-flight participant plan (present once participants resolve; absent on early validation errors). */
  plan?: CuaParticipantPlan;
  /** Per-participant results, always present once participants resolve (length 1 at N=1). */
  lanes?: CuaParticipantResult[];
  /** Aggregate participant counts. */
  laneSummary?: CuaParticipantSummary;
  /** Present when this run explicitly re-executes selected participants from a prior CUA fan-out run. */
  rerun?: RunRerunLineage;
  observer?: ObserverResult;
  diagnostics?: CuaDiagnostics;
  warnings: string[];
  error?: {
    code: CuaActorStudyErrorCode;
    message: string;
  };
}

/**
 * What a computer-use or shared-world participant runs: the resolved participant, plus where its
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
 * The study's shared spend ledger: one counter across every participant. Each one notes its
 * own latest running model-spend estimate (monotone per participant: an estimate can only grow)
 * and reads back the run total; the loop stops the participant the moment the total crosses the study budget.
 * Estimated model spend only: desktop-minutes ride the cost summary, not this ledger.
 */
export interface CuaRunBudget {
  maxTotalUsd: number;
  /** Record this participant's latest running estimate (null = unpriceable, ignored) and return
   *  the run's current total across all participants. */
  note(participantId: string, estimateUsd: number | null): number;
}

/**
 * The subject as a participant's desktop meets it. A computer-use participant gets the plan's
 * subject: a clone or local tree is provisioned in its own sandbox with the declared env, a
 * desktop-cli product is set up there, and an app-url or local-app subject is only opened. A
 * shared-world participant gets `shared-app`: it opens the one app the plane serves, with no
 * subject env names forwarded, no GitHub token and no provisioning in its sandbox.
 */
export type ParticipantSubject =
  | ComputerUseRunner["subject"]
  | {
      readonly kind: "shared-app";
      /** The shared app's in-sandbox serve URL, which the receiving inbox maps links back to. */
      readonly serveUrl?: string;
    };

/** The subject env names forwarded into a participant's sandbox: a provisioned subject's only. */
export function participantSubjectEnv(subject: ParticipantSubject): readonly string[] {
  return subject.kind === "clone" || subject.kind === "local-tree" ? subject.env : [];
}

/** The serve URL a participant's inbox maps links back to: the served app's, when there is one. */
export function participantServeUrl(subject: ParticipantSubject): string | undefined {
  if (subject.kind === "clone" || subject.kind === "local-tree") return subject.serve.url;
  return "serveUrl" in subject ? subject.serveUrl : undefined;
}

/** What the E2B desktop (e2b-desktop/*) reads from a participant's deps. */
export interface E2BDesktopDeps {
  /** The plan's residual config: comms, policies, the desktop and target, and subject leftovers. */
  residual: Readonly<ResidualConfig>;
  studyId: string;
  appUrl: string;
  /** What the participant's desktop does with the subject before the participant starts. */
  subject: ParticipantSubject;
  /** Local-tree route only: the once-per-run packed archive bytes, shared byte-identically
   *  across every fan-out participant's upload step. Absent on dry-run and every other route. */
  localTreeArchiveBuffer?: ArrayBuffer;
  env: Record<string, string | undefined>;
  e2bApiKey: string;
  requestTimeoutMs: number;
  sandboxMs: number;
  participantCount: number;
  artifactRoot: PreparedOutputRoot;
  /** The study's resolution directory: relative paths in the config (a camera .y4m) resolve here. */
  studyCwd: string;
  scrubKnownValues: (text: string) => string;
  receiving?: CommsReceivingRun;
  /** Adopter-hosted comms plane: present on the app-url route when comms.email.external is
   *  declared. Carries the parsed comms block (recipients drive the per-participant inbox instruction)
   *  and the inbox URL the persona opens. The drain runs once at run level, not per participant. */
  externalComms?: { email: StudyCommsEmail; inboxUrl: string };
  /** Injected clock (ms). It measures the host-side E2B desktop create->teardown span so the
   *  desktop-minute cost estimate is deterministic in tests. Defaults to Date.now. */
  now: () => number;
  /** Loads the E2B SDK for the participant's desktop. Defaults to loadE2BDesktopModule. */
  desktopModule?: () => Promise<E2BDesktopModule>;
  /** The caller's prepareDesktop, called with the participant as its target. */
  prepareDesktop?: NonNullable<RunStudyHomes["prepareDesktop"]>;
  /** Clock and sleep for detached provisioning steps. */
  detachedTimers?: DetachedTimers;
  /** Receives each live stream's ready and ended: the Observer's tracker, then the caller's onStream. */
  onStream: NonNullable<RunStudyHomes["onStream"]>;
  /** Reports a subject phase to the phase sink (stderr by default) and to onEvent. */
  reportSubjectPhase: (event: SubjectPhaseEvent, participant: ParticipantRef) => void;
  /**
   * How a parseable requested-vs-verified screen mismatch is treated. Default ("fail-closed"):
   * the participant's device claim is falsified, so it fails with DEVICE_GEOMETRY (the
   * single-participant/fan-out contract). "record-evidence" (the concurrent shared-world route):
   * requested and verified stay recorded as separate facts plus an explicit warning, and the
   * participant keeps running, so one participant's screen drift cannot abort a live multi-actor world.
   */
  screenMismatchPolicy?: "fail-closed" | "record-evidence";
}

/** What a participant's model and session (participant-model.ts) read from its deps. */
export interface ParticipantModelDeps {
  /** The caller's createProvider with the run's config bound. Absent, the plan's brain drives. */
  createProvider?: (participant: ParticipantRef, executor: CuaExecutor) => Promise<CuaProvider>;
  /** The plan's spend caps; maxUsd is each participant's own. */
  caps: ComputerUsePlan["caps"];
  /** The plan's brain: the model and, for a local agent, which signed-in CLI drives the participant. */
  brain: Brain;
  env: Record<string, string | undefined>;
  openaiApiKey: string;
  timeoutMs: number;
  participantCount: number;
  artifactRoot: PreparedOutputRoot;
  redactScreenshots: boolean;
  scrubKnownValues: (text: string) => string;
  /** The study's shared spend ledger, present exactly when execution.caps.maxTotalUsd is set on a
   *  live run. Preflight already refused the cap on an unpriced model. */
  runBudget?: CuaRunBudget;
  /**
   * runtime-only observed-URL callback (the shared-world handoff): threaded into the participant's session so the
   * orchestrator watches this participant's live location.href mid-run. Never persisted (see
   * CuaLoopOptions.onObservedUrl). The concurrent shared-world barrier passes a host latch here
   * to extract a /lobby/CODE; on ordinary routes it is undefined (no-op).
   */
  onObservedUrl?: (url: string | undefined) => void;
  /** runtime-only per-turn narration callback; see CuaLoopOptions.onMessage. The concurrent
   * shared-world barrier passes a host message scanner here to latch the lobby code. */
  onMessage?: (text: string) => void;
  /** runtime-only per-turn raw-frame callback; see CuaLoopOptions.onScreenshot. The concurrent
   * shared-world barrier passes a host vision reader here to latch the lobby code off-screen. */
  onScreenshot?: (frame: Buffer) => void;
  /** Per-turn trace snapshot from a participant's loop, keyed by participant. The live path
   * wires the incremental in-progress flush here so the attached Observer's timeline grows mid-run. */
  onTrace?: (
    participantId: string,
    items: readonly ActorTraceItem[],
    usage?: ActorTokenUsage,
    metadata?: CuaLiveMetadata,
  ) => void;
}

/**
 * One participant's deps: the E2B desktop's and the model's, and what runCuaParticipant reads to
 * choose the desktop and run the session. setup.ts and shared-world participant-specs.ts build it.
 */
export type CuaParticipantDeps = E2BDesktopDeps &
  ParticipantModelDeps & {
    /** Internal ready-desktop seam. The factory must not allocate; prepare owns that work. */
    createDesktop?: (
      spec: DesktopParticipantRun,
      warnings: string[],
      artifactRoot: PreparedOutputRoot,
    ) => ParticipantDesktop;
    /** The caller's inProcess executor with the run's config bound. Read by the in-process desktop. */
    inProcessExecutor?: (appUrl: string) => Promise<CuaExecutor>;
    runSession: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
    /** Lane-0 only: signal the pipeline gate after provisioning succeeds (true) or fails (false). */
    signalProvisioned?: (ok: boolean) => void;
  };

/** Why a sandbox was not confirmed released. */
export interface SandboxReleaseFact {
  state: "retained" | "unconfirmed";
  warning: string;
  /** How to release it by hand, when `humanish reclaim` cannot: a local VM has no receipt. */
  recovery?: string;
}

/** One participant's end-to-end run outcome (internal; projected into CuaParticipantResult + the bundle). */
export interface ParticipantRunOutcome {
  spec: DesktopParticipantRun;
  session?: CuaLoopResult;
  /** The harness failed before the session reached a terminal status. */
  sessionError?: string;
  /** The model provider's cleanup is unconfirmed after the session. An execution failure only:
   *  it does not change how the participant's session ended. */
  providerCleanupError?: string;
  /** The model provider reported a disallowed operation after the session's last request, which
   *  the session's evidence does not show. An execution failure, scrubbed, like the cleanup one. */
  providerPolicyError?: string;
  sandboxId?: string;
  /** Host-side E2B desktop create->teardown span (ms). An approximation of E2B's server-side
   *  billed lifetime (server-side kill-on-timeout can extend it), so the derived dollar figure is
   *  doubly an estimate. Absent on the in-process route (no sandbox) and on dry-run. */
  desktopDurationMs?: number;
  desktopResources?: DesktopResourceObservation;
  killed: boolean;
  /** Set when the sandbox was not confirmed released: kept for debugging, or a release the
   *  provider did not confirm. `warning` is the scrubbed release warning. */
  sandboxRelease?: SandboxReleaseFact;
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
  /** Set when the participant was skipped by the pipeline gate / fail-fast (a pinned reason). */
  skippedReason?: string;
  noEngagement: boolean;
  selfReportedBlocker: boolean;
  /** The inclusive friction read: blocker-shaped narration incl. self-resolved arcs.
   *  Feeds the participants tally and feedback candidates; never the participant verdict. Optional so
   *  external outcome constructors (shared-world, test fakes) stay valid; absent counts as false. */
  reportedFriction?: boolean;
  harnessError: boolean;
  failureCode?: CuaActorStudyErrorCode;
  /** Relative run-dir path of the digest-only comms-thread evidence artifact this participant wrote
   *  (humanish.comms-thread.v1), when a comms study captured mail into its in-sandbox catch. Registered
   *  in the participant's stream artifacts. Absent when no comms study ran or nothing was captured. */
  commsArtifactPath?: string;
}

/** What buildCuaFanoutBundle projects into a fan-out run bundle. */
export interface CuaFanoutBundleArgs {
  /** The run's verdict, from the judge. */
  verdict: Verdict;
  /** The run this bundle belongs to; the bundle head reads its id, mode, start and study. */
  run: BundleRun;
  specs: DesktopParticipantRun[];
  outcomes?: ParticipantRunOutcome[];
  subjects: CuaSubjectProjection[];
  aggregateSubject: CuaSubjectProjection;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  dryRun: boolean;
  plan: ComputerUsePlan;
  source: RunBundle["source"];
  participantPlan: CuaParticipantPlan;
  rerun?: RunRerunLineage;
  failFastReason?: string;
  publicRepo?: string;
  inProgress?: boolean;
}
