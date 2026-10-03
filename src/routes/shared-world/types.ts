// The concurrent shared-world route's schema constants, attribution limits, options and result
// types, and the per-participant result the planes collect.

import type { LabDeps } from "../../lab/lab-deps.js";
import type { LabEvent } from "../../lab/run-lab-events.js";
import type { RunLabHomes } from "../../lab/run-lab-homes.js";
import type { SharedWorldJudgment } from "../../run/judge.js";
import type { BrowserScorer } from "../../lab/adapter-extension.js";
import type { AutomaticAnalysisResult } from "../../analysis/automatic-completion.js";
import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import type { LabCommsEmail, LabCommsExternal, LabConfig } from "../../lab/types.js";
import type { DesktopResourceObservation } from "../../substrates/e2b/desktop-resources.js";
import type { ObserverResult } from "../../observer/render.js";
import type { ObserverRuntimeStreamUrl } from "../../observer/run-routes.js";
import type {
  BundleRun,
  RunBundle,
  RunScorerProvenance,
  RunSubjectProvenance,
  RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import type { RunScope } from "../../run/run.js";
import type { SharedWorldStateSnapshot } from "../../run/shared-world-evidence.js";
import type { LocalTreeArchive } from "../../subject/local-tree-archive.js";
import type { LiveTraceFlush } from "../computer-use/live-flush.js";
import type {
  CuaParticipantDeps,
  DesktopParticipantRun,
  CuaRunBudget,
  ParticipantRunOutcome,
} from "../computer-use/types.js";
import type { ProvisionedPlaneSetup } from "./provisioned.js";
import type { SharedWorldPlan } from "../../lab/plan-types.js";
import { type StudyResultIdentity } from "../../run/study-result.js";

export const CONCURRENT_SHARED_WORLD_PROVIDER_METADATA = {
  mode: "concurrent-shared-world-lab",
  tool: "humanish",
} as const;

// The verify-enforced concurrent attribution ceiling. Mirrored in
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
  /** Cancels post-run analysis only. */
  analysisSignal?: AbortSignal;
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  /** Keys and subject env for the run. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Runs after a sandbox exists and before anything is provisioned on it: the provisioned plane's
   * subject sandbox, then each participant's desktop. The external-public plane has participants
   * only.
   */
  prepareDesktop?: NonNullable<RunLabHomes["prepareDesktop"]>;
  /** Awaited after a participant's live stream starts, and again after its sandbox is gone. */
  onStream?: NonNullable<RunLabHomes["onStream"]>;
  /** Reports subject phases to onEvent; built by normalizeRunLabOptions. */
  emit?: (event: LabEvent) => void;
  /** Test seams. */
  deps?: LabDeps;
  /** Scores the assembled evidence: `RunLabOptions.scorer`, or the scorer the CLI loads. */
  scorer?: BrowserScorer;
  /** Present only when the scorer was config-declared and loaded by the CLI;
   *  core-stamped onto the bundle as evidence. Absent for library callers. */
  scorerProvenance?: RunScorerProvenance;
}

/** What a shared-world run takes besides its plan. The plan carries the config, dry run and lab. */
export type SharedWorldRunInput = Omit<
  RunConcurrentSharedWorldLabOptions,
  "config" | "dryRun" | "lab"
>;

export type ConcurrentSharedWorldLabErrorCode =
  | "HUMANISH_STUDY_ANALYSIS_INVALID"
  | "HUMANISH_STUDY_TASKS_UNSUPPORTED"
  | "HUMANISH_STUDY_OPTION_UNSUPPORTED"
  | "HUMANISH_SHARED_WORLD_FAILED"
  | "HUMANISH_SHARED_WORLD_ACTOR_UNSUPPORTED"
  | "HUMANISH_SHARED_WORLD_INVALID"
  | "HUMANISH_SHARED_WORLD_KEYS_MISSING"
  /** A local-agent brain's CLI is not on `PATH`. */
  | "HUMANISH_SHARED_WORLD_AGENT_MISSING"
  /** A local-agent brain's CLI is signed out, or could not report its sign-in status. */
  | "HUMANISH_SHARED_WORLD_AGENT_SIGNIN_REQUIRED"
  /** A dollar cap that cannot be priced: an unpriced model, or a ChatGPT-account Codex brain. */
  | "HUMANISH_SHARED_WORLD_UNPRICED_CAP"
  | "HUMANISH_SHARED_WORLD_SUBJECT_ENV_MISSING"
  | "HUMANISH_SHARED_WORLD_GETHOST_UNAVAILABLE"
  | "HUMANISH_SHARED_WORLD_HANDOFF_TIMEOUT"
  | "HUMANISH_RUN_ID_IN_USE"
  /** A declared adopter-hosted comms catch did not answer as a humanish catch. Fail closed
   *  before any actor spend, since the funnel would silently collect nothing. */
  | "HUMANISH_SHARED_WORLD_COMMS_CATCH_UNREACHABLE"
  /** comms.email.external.authTokenEnv names a token shorter than MIN_CATCH_TOKEN_LENGTH or not
   *  well-formed Unicode (src/comms/external-evidence.ts). Refused before the catch is probed. */
  | "HUMANISH_SHARED_WORLD_COMMS_TOKEN_INVALID";

/** The two plane classes of the concurrent shared-world route. */
export type ConcurrentSharedWorldPlaneClass = "provisioned-getHost" | "external-public";

// External-public plane class: the downgraded attribution ceiling. The concurrent family
// plus the mandatory external-public disclosures, mirrored in the required
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

/** One persona's outcome against the contended world (the "M of N" headline). */
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

export interface ConcurrentSharedWorldLabResult
  extends AutomaticAnalysisResult, StudyResultIdentity<"shared-world"> {
  ok: boolean;
  cwd: string;
  actor: string;
  topology: "shared-world";
  topologyMode: "concurrent";
  /** The declared number of personas. */
  roleCount: number;
  /** Effective in-flight bound (execution.concurrency). */
  concurrency: number;
  dryRun: boolean;
  runId: string;
  /** The harness-minted getHost URL the actors drove (tokenless; live only). */
  host?: string;
  /** The one subject sandbox lifecycle proof. */
  subjectSandbox?: { sandboxId: string; killed: boolean };
  /** Whether ≥2 actor windows overlapped in time (proven concurrency; live only). */
  overlapProven?: boolean;
  /** Max participants observed live at the same instant (live only): the simultaneity number; a
   *  6-participant run capped at 3 reports 3 here, never 6. */
  maxSimultaneousLanes?: number;
  /** Subject provenance: the one shared plane. */
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
  /** Read for the subject's serve URL, which each participant's subject names. Participants, their
   *  count and their host and entry come from the plan's participants. */
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  /** The run's test seams; empty outside tests. */
  deps: LabDeps;
  env: Record<string, string | undefined>;
  concurrency: number;
  runBudget: CuaRunBudget | undefined;
  runSession: CuaParticipantDeps["runSession"];
  openaiApiKey: string;
  e2bApiKey: string;
  scrubKnownValues: (text: string) => string;
  /** The values scrubKnownValues removes. Real email receiving adds its secrets before participants
   *  start. */
  knownSecretValues: readonly string[];
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
 * What the participants feed while they run. A plane sets the attached Observer and starts the
 * trace flush; each participant's onStream appends stream URLs; the orchestrator reads all three at
 * finish.
 */
export interface LiveParticipants {
  observer?: ObserverResult & { ok: true };
  flush?: LiveTraceFlush;
  readonly streamUrls: ObserverRuntimeStreamUrl[];
}

/** An adopter-hosted comms catch and the inbox its personas open. */
export interface ExternalCommsWiring {
  external: LabCommsExternal;
  email: LabCommsEmail;
  inboxUrl: string;
}

/** What buildConcurrentSharedWorldBundle projects into a run bundle. */
export interface ConcurrentBundleArgs {
  /** The run's judgment (judgeSharedWorldRun over the other fields). */
  judgment: SharedWorldJudgment;
  /** The run this bundle belongs to; the bundle head reads its id, mode, start and lab. */
  run: BundleRun;
  plan: SharedWorldPlan;
  descriptor: CuaActorDescriptor;
  dryRun: boolean;
  inProgress?: boolean;
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
   *  property of the one shared app, and belongs to no single persona). */
  commsArtifactPath?: string;
  /** The plane-class discriminator (default provisioned-getHost, byte-stable). */
  planeClass?: ConcurrentSharedWorldPlaneClass;
  /** external-public only: sha256-16 of the observed origin the participants converged on (the
   *  convergence proof: what the participants actually reached, tolerant of a declared->observed
   *  redirect). */
  publicOriginDigest?: string;
  /** external-public only: sha256-16 of the operator-declared plane origin (evidence/reference only;
   *  never asserted equal to the observed origin, since a cross-origin redirect is normal). */
  declaredOriginDigest?: string;
  /** external-public only: sha256-16 of the /lobby/CODE path all participants converged on. */
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
  /** The subject sandbox's scrubbed release warning when its release is unconfirmed. */
  subjectReleaseWarning: string | undefined;
  subjectDesktop: SubjectDesktopUsage | undefined;
  getHostUrl: string | undefined;
  // The observed convergence origin, computed after fan-out from what the participants reached (the
  // convergence proof is what the participants observed). Set iff every observing participant
  // agrees on one origin; that agreement is the convergence proof and becomes plane.publicOriginDigest.
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
