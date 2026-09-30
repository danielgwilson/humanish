// The concurrent shared-world route's schema constants, attribution limits, options and result
// types, and the per-seat result the planes collect.

import type {
  AutomaticAnalysisHooks,
  AutomaticAnalysisResult,
} from "../../analysis/automatic-completion.js";
import type { LabConfig } from "../../lab/types.js";
import type { ObserverResult } from "../../observer/render.js";
import type { RunScorerProvenance, RunSubjectProvenance } from "../../run/bundle.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { CuaLaneSpec, LaneRunOutcome } from "../computer-use/types.js";
import type { SharedWorldLabHooks } from "./hooks.js";

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
export interface ActorLaneResult {
  spec: CuaLaneSpec;
  outcome: LaneRunOutcome;
  startedAt: number;
  endedAt: number;
  route: string;
}
