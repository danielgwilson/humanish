// The concurrent shared-world route's schema constants, attribution limits, options and result
// types, and the per-seat result the planes collect.

import type {
  AutomaticAnalysisHooks,
  AutomaticAnalysisResult,
} from "../../analysis/automatic-completion.js";
import type { CuaActorDescriptor } from "../../actors/registry.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import type { LabActorLane, LabCommsEmail, LabCommsExternal, LabConfig } from "../../lab/types.js";
import type { DesktopResourceObservation } from "../../substrates/e2b/desktop-resources.js";
import type { ObserverResult } from "../../observer/render.js";
import type { ObserverRuntimeStreamUrl } from "../../observer/run-routes.js";
import type {
  RunBundle,
  RunScorerProvenance,
  RunSubjectProvenance,
  RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import type { RunScope } from "../../run/run.js";
import type { SharedWorldStateSnapshot } from "../../run/shared-world-evidence.js";
import type { LocalTreeArchive } from "../../run/source-archive.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { LiveTraceFlush } from "../computer-use/live-flush.js";
import type {
  CuaLaneDeps,
  CuaLaneSpec,
  CuaRunBudget,
  LaneRunOutcome,
} from "../computer-use/types.js";
import type { SharedWorldLabHooks } from "./hooks.js";
import type { ProvisionedPlaneSetup } from "./provisioned.js";

export const CONCURRENT_SHARED_WORLD_LAB_SCHEMA = "humanish.concurrent-shared-world-lab-result.v1";

export const CONCURRENT_SHARED_WORLD_PROVIDER_METADATA = {
  mode: "concurrent-shared-world-lab",
  tool: "humanish",
} as const;

// The verify-enforced CONCURRENT attribution ceiling (FIX-5). Mirrored in
// run/verify-shared-world-concurrent.ts CONCURRENT_REQUIRED_LIMITS.
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

export type ConcurrentSharedWorldLabErrorCode =
  | "HUMANISH_LAB_ANALYSIS_INVALID"
  | "HUMANISH_LAB_TASKS_UNSUPPORTED"
  | "HUMANISH_LAB_OPTION_CONFLICT"
  | "HUMANISH_LAB_OPTION_UNSUPPORTED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING"
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
// set in run/verify-shared-world-concurrent.ts (CONCURRENT_ATTRIBUTION_LIMITS +
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
export interface ConcurrentSharedWorldRoleResult {
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
  roles: ConcurrentSharedWorldRoleResult[];
  observer?: ObserverResult;
  warnings: string[];
  error?: { code: ConcurrentSharedWorldLabErrorCode; message: string };
}

/** One actor lane's measured run (internal). */
/** The provisioned plane's own desktop, for the run's cost estimate. */
export interface SubjectDesktopUsage {
  durationMs: number | undefined;
  observation: DesktopResourceObservation | undefined;
  killed: boolean;
}

export interface ActorLaneResult {
  spec: CuaLaneSpec;
  outcome: LaneRunOutcome;
  startedAt: number;
  endedAt: number;
  route: string;
}

type StartedRun = Extract<Awaited<ReturnType<RunScope["startRun"]>>, { ok: true }>["run"];

/** What a plane reads from the orchestrator. The orchestrator builds it once, after the run starts. */
export interface PlaneContext {
  options: RunConcurrentSharedWorldLabOptions;
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  hooks: SharedWorldLabHooks;
  env: Record<string, string | undefined>;
  roles: LabActorLane[];
  concurrency: number;
  runBudget: CuaRunBudget | undefined;
  runSession: CuaLaneDeps["runSession"];
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
  actorSpecs: CuaLaneSpec[];
  receiving: CommsReceivingRun | undefined;
  /** The run's warnings. Planes append to it. */
  warnings: string[];
}

/**
 * What the seats feed while they run. A plane sets the attached Observer and starts the trace
 * flush; the runtime stream hooks append stream URLs; the orchestrator reads all three at finish.
 */
export interface LiveSeats {
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
  /** Lab provenance for the bundle\'s own `lab` field (#455). */
  lab?: RunLabProvenance;
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  createdAt: string;
  dryRun: boolean;
  inProgress?: boolean;
  runId: string;
  source: RunBundle["source"];
  roles: LabActorLane[];
  actorSpecs: CuaLaneSpec[];
  actorResults: ActorLaneResult[];
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
  actorResults: ActorLaneResult[];
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
