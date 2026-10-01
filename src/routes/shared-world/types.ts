// The concurrent shared-world route's schema constants, attribution limits, options and result
// types, and the per-seat result the planes collect.

import type { SharedWorldJudgment } from "../../run/judge.js";
import type { CuaActorSessionOptions } from "../../actors/computer-use/actor.js";
import type { CuaLoopResult } from "../../actors/computer-use/loop.js";
import type { BrowserLabAdapterHooks } from "../../lab/adapter-extension.js";
import type { SubjectPhaseEvent } from "../../subject/steps.js";
import type { DetachedTimers } from "../../substrates/detached.js";
import type { E2BDesktopModule, E2BDesktopSandbox } from "../../substrates/e2b/sdk.js";
import type {
  AutomaticAnalysisHooks,
  AutomaticAnalysisResult,
} from "../../analysis/automatic-completion.js";
import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import type { LabCommsEmail, LabCommsExternal, LabConfig } from "../../lab/types.js";
import type { DesktopResourceObservation } from "../../substrates/e2b/desktop-resources.js";
import type { ObserverResult, renderObserver } from "../../observer/render.js";
import type { ObserverRuntimeStreamUrl } from "../../observer/run-routes.js";
import type {
  RunBundle,
  RunScorerProvenance,
  RunSubjectProvenance,
  RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import type { RunScope } from "../../run/run.js";
import type { SharedWorldStateSnapshot } from "../../run/shared-world-evidence.js";
import type { LocalTreeArchive } from "../../subject/local-tree-archive.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { LiveTraceFlush } from "../computer-use/live-flush.js";
import type {
  CuaParticipantDeps,
  DesktopParticipantRun,
  CuaRunBudget,
  ParticipantRunOutcome,
} from "../computer-use/types.js";
import type { ProvisionedPlaneSetup } from "./provisioned.js";
import type { SharedWorldPlan } from "../../lab/plan-types.js";

export const CONCURRENT_SHARED_WORLD_LAB_SCHEMA = "humanish.concurrent-shared-world-lab-result.v1";

export const CONCURRENT_SHARED_WORLD_PROVIDER_METADATA = {
  mode: "concurrent-shared-world-lab",
  tool: "humanish",
} as const;

// The verify-enforced CONCURRENT attribution ceiling (FIX-5). Mirrored in
// verify/shared-world-concurrent.ts CONCURRENT_REQUIRED_LIMITS.
export const CONCURRENT_ATTRIBUTION_LIMITS = [
  "concurrent",
  "best-effort-causal-attribution",
  "non-deterministic-shared-state",
  "window-and-snapshot-granularity",
  "contention-observed-not-proven-safe",
  "state-change-not-isolated-to-actors",
] as const;

export interface RunConcurrentSharedWorldLabOptions {
  automaticAnalysis?: AutomaticAnalysisHooks;
  /** Which manifest produced this run (#455); threaded into the status record + bundle. */
  lab?: RunLabProvenance;
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  hooks?: SharedWorldLabHooks;
  /** Present only when the browser-route scorer hooks were CONFIG-DECLARED and loaded by the CLI
   *  (#316); core-stamped onto the bundle as evidence. Absent for library callers. */
  scorerProvenance?: RunScorerProvenance;
}

/** What a shared-world run takes besides its plan. The plan carries the config, dry run and lab. */
export type SharedWorldRunInput = Omit<
  RunConcurrentSharedWorldLabOptions,
  "config" | "dryRun" | "lab"
>;

export type ConcurrentSharedWorldLabErrorCode =
  | "HUMANISH_LAB_ANALYSIS_INVALID"
  | "HUMANISH_LAB_TASKS_UNSUPPORTED"
  | "HUMANISH_LAB_OPTION_CONFLICT"
  | "HUMANISH_LAB_OPTION_UNSUPPORTED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING"
  /** A local-agent brain's CLI is not on PATH, is signed out, or could not report its status. */
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_AGENT_SIGNIN_REQUIRED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_GETHOST_UNAVAILABLE"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT"
  | "HUMANISH_RUN_ID_IN_USE"
  /** A declared adopter-hosted comms catch (#328) did not answer as a humanish catch — fail closed
   *  BEFORE any actor spend, since the funnel would silently collect nothing. */
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_CATCH_UNREACHABLE";

/** The two plane classes of the concurrent shared-world route (#164 phase 2). */
export type ConcurrentSharedWorldPlaneClass = "provisioned-getHost" | "external-public";

// EXTERNAL-PUBLIC plane class: the honest-downgrade attribution ceiling. The concurrent family
// (an honest ceiling) PLUS the mandatory external-public disclosures — mirrored in the required
// set in verify/shared-world-concurrent.ts (CONCURRENT_ATTRIBUTION_LIMITS +
// EXTERNAL_PUBLIC_EXTRA_LIMITS). Verify fails closed on a missing one.
export const EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS = [
  ...CONCURRENT_ATTRIBUTION_LIMITS,
  "external-public-plane",
  "operator-attested-target-not-harness-controlled",
  "no-synthetic-attestation",
  "no-authoritative-shared-state-proof",
  "concurrency-by-temporal-co-occupancy-only",
] as const;

/** One persona's OUTCOME against the contended world (the "M of N" headline). */
export interface ConcurrentSharedWorldParticipantResult {
  id: string;
  index: number;
  persona: string;
  status: string;
  ok: boolean;
  /** The harness-clocked [start,end] window the orchestrator measured (live). */
  window?: { startedAt: number; endedAt: number };
  session?: { status: string; completionReason: string; reason: string; screenshots: number };
  /** The actor sandbox lifecycle proof (the getHost/key value is never surfaced here). */
  sandbox?: { sandboxId: string; killed: boolean };
  error?: { code: ConcurrentSharedWorldLabErrorCode; message: string };
}

export interface ConcurrentSharedWorldLabResult extends AutomaticAnalysisResult {
  schema: typeof CONCURRENT_SHARED_WORLD_LAB_SCHEMA;
  ok: boolean;
  cwd: string;
  labId: string;
  actor: string;
  topology: "shared-world";
  topologyMode: "concurrent";
  /** The DECLARED number of persona seats. */
  roleCount: number;
  /** Effective in-flight bound (execution.concurrency). */
  concurrency: number;
  dryRun: boolean;
  runId: string;
  /** The harness-minted getHost URL the actors drove (tokenless; live only). */
  host?: string;
  /** The ONE subject sandbox lifecycle proof. */
  subjectSandbox?: { sandboxId: string; killed: boolean };
  /** Whether ≥2 actor windows overlapped in time (proven concurrency; live only). */
  overlapProven?: boolean;
  /** Max lanes observed live at the same instant (live only) — the honest simultaneity number; a
   *  6-lane run capped at 3 reports 3 here, never 6 (#350). */
  maxSimultaneousLanes?: number;
  /** Subject provenance (invariant 5): the ONE shared plane. */
  subject?: RunSubjectProvenance;
  roles: ConcurrentSharedWorldParticipantResult[];
  observer?: ObserverResult;
  warnings: string[];
  error?: { code: ConcurrentSharedWorldLabErrorCode; message: string };
}

/** The provisioned plane's own desktop, for the run's cost estimate. */
export interface SubjectDesktopUsage {
  durationMs: number | undefined;
  observation: DesktopResourceObservation | undefined;
  killed: boolean;
}

/** One actor's measured run (internal). */
export interface ActorRunResult {
  spec: DesktopParticipantRun;
  outcome: ParticipantRunOutcome;
  startedAt: number;
  endedAt: number;
  route: string;
}

type StartedRun = Extract<Awaited<ReturnType<RunScope["startRun"]>>, { ok: true }>["run"];

/** What a plane reads from the orchestrator. The orchestrator builds it once, after the run starts. */
export interface PlaneContext {
  plan: SharedWorldPlan;
  input: SharedWorldRunInput;
  /** Read by the computer-use lane runner, whose hooks and desktop setup take the whole config.
   *  Seats, their count and their host and entry come from the plan's participants. */
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  hooks: SharedWorldLabHooks;
  env: Record<string, string | undefined>;
  concurrency: number;
  runBudget: CuaRunBudget | undefined;
  runSession: CuaParticipantDeps["runSession"];
  openaiApiKey: string;
  e2bApiKey: string;
  scrubKnownValues: (text: string) => string;
  cwd: string;
  run: StartedRun;
  runId: string;
  createdAt: string;
  runPaths: StartedRun["paths"];
  artifactRoot: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  redactScreenshots: boolean;
  now: () => number;
  source: RunBundle["source"];
  seedDigest: string;
  actorSpecs: DesktopParticipantRun[];
  receiving: CommsReceivingRun | undefined;
  /** The run's warnings. Planes append to it. */
  warnings: string[];
}

/**
 * What the seats feed while they run. A plane sets the attached Observer and starts the trace
 * flush; the runtime stream hooks append stream URLs; the orchestrator reads all three at finish.
 */
export interface LiveParticipants {
  observer?: ObserverResult & { ok: true };
  flush?: LiveTraceFlush;
  readonly streamUrls: ObserverRuntimeStreamUrl[];
}

/** An adopter-hosted comms catch (#328) and the inbox its personas open. */
export interface ExternalCommsWiring {
  external: LabCommsExternal;
  email: LabCommsEmail;
  inboxUrl: string;
}

/** What buildConcurrentSharedWorldBundle projects into a run bundle. */
export interface ConcurrentBundleArgs {
  /** The run's judgment (judgeSharedWorldRun over the other fields). */
  judgment: SharedWorldJudgment;
  /** Lab provenance for the bundle\'s own `lab` field (#455). */
  lab?: RunLabProvenance;
  plan: SharedWorldPlan;
  descriptor: CuaActorDescriptor;
  createdAt: string;
  dryRun: boolean;
  inProgress?: boolean;
  runId: string;
  source: RunBundle["source"];
  actorSpecs: DesktopParticipantRun[];
  actorResults: ActorRunResult[];
  stateSnapshots: SharedWorldStateSnapshot[];
  subject: RunSubjectProvenance;
  seedDigest: string;
  subjectCommit?: string;
  hostDigest?: string;
  /** Run-level digest-only comms-thread evidence path (humanish.comms-thread.v1), when a comms lab
   *  captured mail into the subject sandbox's catch. Registered on the first persona stream (it is a
   *  property of the ONE shared app, not of any single persona). */
  commsArtifactPath?: string;
  /** #164 phase 2: the plane-class discriminator (default provisioned-getHost, byte-stable). */
  planeClass?: ConcurrentSharedWorldPlaneClass;
  /** external-public only: sha256-16 of the OBSERVED origin the seats converged on (the convergence
   *  proof — what the seats actually reached, tolerant of a declared->observed redirect). */
  publicOriginDigest?: string;
  /** external-public only: sha256-16 of the operator-DECLARED plane origin (evidence/reference only;
   *  NOT asserted equal to the observed origin — a cross-origin redirect is normal and expected). */
  declaredOriginDigest?: string;
  /** external-public only: sha256-16 of the shared /lobby/CODE path all seats converged on. */
  lobbyConvergenceDigest?: string;
  runError?: string;
  /** The provisioned plane's own desktop; absent on external-public planes and dry runs. */
  subjectDesktop?: SubjectDesktopUsage;
}

/** What the plane that ran reports to the finish. A plane leaves the fields it has no part in unset. */
export interface PlaneResults {
  actorResults: ActorRunResult[];
  runError: string | undefined;
  subjectCommit: string | undefined;
  subjectSandboxId: string | undefined;
  subjectKilled: boolean;
  subjectDesktop: SubjectDesktopUsage | undefined;
  getHostUrl: string | undefined;
  // The OBSERVED convergence origin — computed AFTER fan-out from what the seats ACTUALLY reached (the
  // convergence proof is what the seats OBSERVED, not what was declared). Set iff every observing seat
  // agrees on ONE origin; that agreement IS the convergence proof and becomes plane.publicOriginDigest.
  publicOriginDigest: string | undefined;
  lobbyConvergenceDigest: string | undefined;
  handoffTimedOut: boolean;
  hostHandoffFailure: string | undefined;
  commsArtifactPath: string | undefined;
}

/** Which plane runs, and the setup it needs beyond the plane context. */
export interface PlaneSelection {
  planeClass: ConcurrentSharedWorldPlaneClass;
  /** Undefined when the lab declares no `subject.serve`. */
  provisioned: ProvisionedPlaneSetup | undefined;
  externalWiring: ExternalCommsWiring | undefined;
}

/** What the finish reads about the plane besides its results. */
export interface FinishFacts {
  planeClass: ConcurrentSharedWorldPlaneClass;
  localTreeRoute: boolean;
  localTreeArchive: LocalTreeArchive | undefined;
  publicRepo: string;
  subjectEnvNames: string[];
  stateStepRecords: RunSubjectStateStepRecord[];
  stateSnapshots: SharedWorldStateSnapshot[];
  declaredOriginDigest: string | undefined;
}

/**
 * Library-level hooks mirroring CuaActorLabHooks — the DI seams that let CI drive the FULL
 * orchestration with fakes at $0/zero-network. The fake desktop module records create/kill BY id
 * and exposes NO `list` method (the by-id teardown rail is then provable by construction).
 */
export interface SharedWorldLabHooks extends BrowserLabAdapterHooks {
  /** Lazy-load the E2B desktop module (tests inject a fake; default loadE2BDesktopModule). */
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  /**
   * Runs after a sandbox is created and before anything is provisioned on it. The provisioned
   * plane calls it for the subject sandbox with no lane, then for each seat's desktop with its lane;
   * the external-public plane calls it for the seats only.
   */
  prepareDesktop?: (
    desktop: E2BDesktopSandbox,
    lane?: { laneId: string; laneIndex: number; laneCount: number },
  ) => Promise<void>;
  /**
   * Awaited after a seat's live desktop stream starts. The URL carries an auth key and must never
   * be persisted. A rejection becomes a run warning, as on the computer-use route.
   */
  onRuntimeStreamReady?: (stream: {
    laneId: string;
    sandboxId: string;
    simId: string;
    streamId: string;
    url: string;
  }) => Promise<void> | void;
  /** Awaited after a seat's sandbox is gone, for seats whose stream started. Rejections are swallowed. */
  onRuntimeStreamEnded?: (stream: {
    laneId: string;
    simId: string;
    streamId: string;
  }) => Promise<void> | void;
  /** The per-seat computer-use session runner (default: the resolved actor descriptor's). */
  runSession?: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  /** The operator environment (keys + subject env values). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock/sleep for the detached-step polling (tests only). */
  detachedTimers?: DetachedTimers;
  /**
   * Subject-provisioning phase sink (mirrors CuaActorLabHooks.onPhase): one call per
   * started/completed boundary during the ONE shared-plane provision (clone route: clone, install,
   * build, serve start, ready, subject.state seed-step groups; local-tree route: upload, extract,
   * install, build, serve start, ready, seed-step groups - no clone phase). Defaults to one stderr
   * line per event. Override in tests to capture instead of writing to real stderr.
   */
  onPhase?: (event: SubjectPhaseEvent) => void;
  /**
   * CONCURRENT route only (#164 phase 2): the harness clock used to MEASURE each actor's laneWindow
   * [start,end] (default Date.now). The deterministic heart test does NOT override this — overlap is
   * produced by a rendezvous latch in the fake runSession + measured by the REAL clock (FIX-1), so
   * the windows are real, not injected. (A test may override only for non-overlap assertions.)
   */
  now?: () => number;
  /** CONCURRENT route only: the background stateSeries prober cadence (ms). Default 1000. */
  proberCadenceMs?: number;
  /**
   * EXTERNAL-PUBLIC concurrent route only (#164 phase 2): the host-first handoff barrier deadline
   * (ms). The host seat must surface a shared-session (/lobby/CODE) URL within this budget or the run
   * fails closed with HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT and no follower opens.
   * Default 120000 (also capped by execution.timeoutMs). Tests inject a short value to exercise the
   * fail-closed path deterministically.
   */
  handoffDeadlineMs?: number;
  /**
   * EXTERNAL-PUBLIC concurrent route only: the vision reader that extracts a /lobby/CODE off a seat's
   * screenshot frame (the CDP-independent handoff relay + per-seat convergence observation). Defaults to
   * the real single-frame OpenAI read (readLobbyCodeFromFrame). Tests inject a fake so the barrier's
   * handoff + convergence proof can be exercised deterministically without a live vision call.
   */
  readLobbyCodeFromFrame?: (frame: Buffer, apiKey: string) => Promise<string | undefined>;
  /**
   * Local-tree packing DI seam (tests only, no npm dependency needed to exercise the route):
   * defaults to createLocalTreeArchive(root, opts) plus a host-side read of the produced archive
   * file into an ArrayBuffer (the SAME default routes/computer-use/route.ts uses). Called ONCE per run, before
   * the ONE shared-plane sandbox is created, on the live local-tree route.
   */
  packLocalTree?: (args: {
    root: string;
    extraExclude?: string[];
    maxArchiveBytes?: number;
  }) => Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }>;
}
