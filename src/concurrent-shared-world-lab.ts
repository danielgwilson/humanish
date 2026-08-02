// The CONCURRENT shared-world lab backend (#164 phase 2): N persona lanes drive ONE shared,
// mutable service plane SIMULTANEOUSLY — the actual leverage of a sim. A recomposition of shipped
// pieces + the getHost wrapper:
//
//   - ONE SUBJECT sandbox: provisionCloneSubject ONCE (clone+install+build+seed) + serve on
//     0.0.0.0, exposed via getHost(port) → a tokenless reachable URL (the headless service host;
//     no GUI seat).
//   - N ACTOR desktop sandboxes: fan-out's runCuaLane machinery (per-lane device/persona, by-id
//     teardown) bounded by execution.concurrency, each browser pointed at the getHost URL —
//     driving the shared service AT THE SAME TIME. INDEPENDENT (FIX-11): no pipeline gate, no
//     fail-fast — one actor's failure must not block the swarm or corrupt the "M of N" outcomes.
//   - A background prober snapshots the subject DB checkpoint digests on a cadence → a stateSeries
//     of the shared world evolving under load.
//   - ALL N+1 sandboxes torn down BY exact id in a finally — NEVER Sandbox.list.
//
// HONEST ATTRIBUTION (verify-enforced, doctrine-audit fixes incorporated): the bundle declares
// attributionClass: shared-world + a CONCURRENT humanish.shared-world.v1 block (topologyMode
// "concurrent"; laneWindows + stateSeries + outcomes; NO timeline) whose attributionLimits drop
// `sequential-only`/`no-concurrent-races` and add `concurrent`,
// `best-effort-causal-attribution`, `non-deterministic-shared-state`,
// `window-and-snapshot-granularity`, `contention-observed-not-proven-safe`,
// `state-change-not-isolated-to-actors`. laneWindows + stateSeries are INDEPENDENT series with NO
// per-delta→actor field — causation under concurrency is structurally inexpressible.
//
// CAPABILITY vs PROOF (FIX-1): the deterministic $0 gate proves the PLUMBING + the honesty
// contract — the real mapWithConcurrency produces genuinely overlapping laneWindows (a rendezvous
// latch in the fake session forces two lane fns in-flight while the REAL orchestrator clock
// measures the windows). Every generated bundle describes only its own observations; no one run
// establishes scale, repeatability, or adopter-harness replacement.
//
// Synthetic-subject (FIX-3): a getHost URL is internet-reachable for the run, so this route is
// synthetic-seeded-subjects ONLY. Verify fail-closes on subject.state.provenance != "seeded" and
// requires the author attestation subject.exposure: synthetic. This is author-trust + a provenance
// gate, NOT a no-real-data guarantee (Humanish cannot tell synthetic from real data).

import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks
} from "./adapter-extension.js";
import { actorRegistry, isCuaActorDescriptor, type CuaActorDescriptor } from "./actor-registry.js";
import { toErrorMessage } from "./command-failure.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  commandDigestOf,
  composeLaneInstructions,
  defaultPackLocalTree,
  provisionCloneSubject,
  provisionLocalTreeSubject,
  resolveLaneDevice,
  resolveSubjectState,
  runCuaLane,
  type CuaActorLabHooks,
  type CuaLaneDeps,
  type CuaLaneSpec,
  type LaneRunOutcome,
  type SubjectPhaseEvent
} from "./cua-actor-lab.js";
import {
  createDesktopSandbox,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import type { DetachedTimers } from "./e2b-detached.js";
import {
  concurrentSharedWorldValidationReason,
  externalPublicSharedWorldValidationReason,
  type LabActorLane,
  type LabConfig
} from "./lab-config.js";
import { buildObserverData } from "./observer-data.js";
import {
  attachObserverRuntimeStreamUrls,
  renderObserver,
  type ObserverResult,
  type ObserverRuntimeStreamUrl
} from "./observer.js";
import { redactText } from "./redaction.js";
import {
  prepareRunArtifactPaths,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths
} from "./run-paths.js";
import { writeContainedOutputFile, writePreparedRunLatestPointer } from "./selected-output-paths.js";
import {
  combineCheckpointDigest,
  runCheckpointSnapshot,
  seedRecipeDigest,
  type SharedWorldLabHooks
} from "./shared-world-lab.js";
import type { LocalTreeArchive } from "./source-archive.js";
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
  type SharedWorldEvidence,
  type SharedWorldLaneWindow,
  type SharedWorldOutcome,
  type SharedWorldPlane,
  type SharedWorldStateSnapshot
} from "./run.js";

export const CONCURRENT_SHARED_WORLD_LAB_SCHEMA = "humanish.concurrent-shared-world-lab-result.v1";

export const CONCURRENT_SHARED_WORLD_PROVIDER_METADATA = {
  mode: "concurrent-shared-world-lab",
  tool: "humanish"
} as const;

// The verify-enforced CONCURRENT attribution ceiling (FIX-5). Mirrored in run.ts's required set.
export const CONCURRENT_ATTRIBUTION_LIMITS = [
  "concurrent",
  "best-effort-causal-attribution",
  "non-deterministic-shared-state",
  "window-and-snapshot-granularity",
  "contention-observed-not-proven-safe",
  "state-change-not-isolated-to-actors"
] as const;

const DEFAULT_SESSION_TIMEOUT_MS = 300_000;
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;
const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;
const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PROBER_CADENCE_MS = 1000;

const DEFAULT_MISSION =
  "You are one of MANY users hitting a shared web application at the same time. The browser is already open at the app. Accomplish your role's task, then stop.";

export interface RunConcurrentSharedWorldLabOptions {
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  hooks?: SharedWorldLabHooks;
}

export type ConcurrentSharedWorldLabErrorCode =
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_GETHOST_UNAVAILABLE"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT";

/** The two plane classes of the concurrent shared-world route (#164 phase 2). */
export type ConcurrentSharedWorldPlaneClass = "provisioned-getHost" | "external-public";

// EXTERNAL-PUBLIC plane class: the honest-downgrade attribution ceiling. The concurrent family
// (an honest ceiling) PLUS the mandatory external-public disclosures — mirrored in run.ts's required
// set (CONCURRENT_ATTRIBUTION_LIMITS + EXTERNAL_PUBLIC_EXTRA_LIMITS). Verify fails closed on a missing one.
export const EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS = [
  ...CONCURRENT_ATTRIBUTION_LIMITS,
  "external-public-plane",
  "operator-attested-target-not-harness-controlled",
  "no-synthetic-attestation",
  "no-authoritative-shared-state-proof",
  "concurrency-by-temporal-co-occupancy-only"
] as const;

// The default host-first handoff barrier deadline (ms). The host seat must surface a shared-session
// (/lobby/CODE) URL within this budget or the run fails closed and no follower opens.
const DEFAULT_HANDOFF_DEADLINE_MS = 120_000;

/**
 * The cineguessr (and general "/lobby/CODE") shared-session URL matcher. A code is exactly 6 chars of
 * the [A-Z2-9] class; a locale prefix (/en/lobby/…) and a query/hash suffix are tolerated. RUNTIME-ONLY
 * input (a live location.href); only the extracted CODE is used, and it lands only as a digest.
 */
export const LOBBY_CODE_PATTERN = /\/lobby\/([A-Z2-9]{6})(?:$|[/?#])/;

/** Extract the shared-session CODE from a (runtime-only) observed URL, or undefined. Exported for the
 *  handoff regex table test — pure, no side effects, never persists its input. */
export function extractLobbyCode(url: string | undefined): string | undefined {
  if (typeof url !== "string") return undefined;
  const match = url.match(LOBBY_CODE_PATTERN);
  return match ? match[1] : undefined;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: () => boolean;
}

/** A minimal resolve-once latch for the host-first handoff barrier. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let done = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T) => { if (!done) { done = true; res(value); } };
    reject = (reason: unknown) => { if (!done) { done = true; rej(reason); } };
  });
  return { promise, resolve, reject, settled: () => done };
}

/** Marker error the host-first barrier rejects with when the deadline elapses (fail-closed). */
class HandoffTimeoutError extends Error {
  constructor(deadlineMs: number) {
    super(`the host never produced a /lobby/CODE URL within the ${deadlineMs}ms handoff deadline`);
    this.name = "HandoffTimeoutError";
  }
}

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

export interface ConcurrentSharedWorldLabResult {
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
  /** Subject provenance (invariant 5): the ONE shared plane. */
  subject?: RunSubjectProvenance;
  roles: ConcurrentSharedWorldRoleResult[];
  observer?: ObserverResult;
  warnings: string[];
  error?: { code: ConcurrentSharedWorldLabErrorCode; message: string };
}

/** One actor lane's measured run (internal). */
interface ActorLaneResult {
  spec: CuaLaneSpec;
  outcome: LaneRunOutcome;
  startedAt: number;
  endedAt: number;
  route: string;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `concurrent-shared-world-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Extract the in-sandbox port from the (loopback) serve.url so getHost can expose it. */
function servePort(serveUrl: string): number {
  const url = new URL(serveUrl);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** Resolve an actor's seat URL against the harness-minted getHost base (entry is a same-origin
 *  relative path, validated at parse against serve.url). */
function resolveActorSeatUrl(baseUrl: string, entry: string | undefined): string {
  if (!entry) return baseUrl;
  try {
    return new URL(entry, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

/** A getHost URL must be TOKENLESS (no userinfo, no query — no authKey; invariant 1). */
function isTokenlessHost(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "";
  } catch {
    return false;
  }
}

/** sha256-16 of a URL's ORIGIN — the publish-safe host identity persisted in the bundle (the raw
 *  getHost URL embeds the live sandbox id + matches the e2b-URL redaction, so it never lands raw). */
function hostOriginDigest(url: string): string {
  try {
    return commandDigestOf(new URL(url).origin);
  } catch {
    return commandDigestOf(url);
  }
}

/** A public-safe, human-readable route label for the bundle (host redacted to a placeholder; the
 *  entry path kept). Never contains the raw getHost URL. */
function publicSafeRouteLabel(entry: string | undefined): string {
  return `[provisioned-subject]${entry ?? "/"}`;
}

/**
 * Build the ONE subject sandbox's provenance (invariant 5): clone (repo + optional commit) or
 * local-tree (archiveSha256 + optional commit/dirty from the once-per-run host-packed archive -
 * archiveSha256 IS the pin; there is only ONE archive, so no per-lane unanimity math applies,
 * unlike the cua fan-out route). Used for both the in-progress and final bundle: the archive
 * never changes mid-run (packed before any sandbox exists).
 */
function buildSubjectProvenance(args: {
  localTreeRoute: boolean;
  publicRepo: string;
  subjectCommit: string | undefined;
  localTreeArchive: LocalTreeArchive | undefined;
  subjectEnvNames: string[];
  state: RunSubjectProvenance["state"];
}): RunSubjectProvenance {
  if (args.localTreeRoute) {
    return {
      source: "local-tree",
      ...(args.localTreeArchive === undefined ? {} : { archiveSha256: args.localTreeArchive.archiveSha256 }),
      ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
      ...(args.localTreeArchive?.git === undefined ? {} : { dirty: args.localTreeArchive.git.dirty }),
      envNames: args.subjectEnvNames,
      state: args.state
    };
  }
  return {
    source: "clone",
    repo: args.publicRepo,
    ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
    envNames: args.subjectEnvNames,
    state: args.state
  };
}

function laneTaxonomyLabel(spec: Pick<CuaLaneSpec, "actorType" | "surface" | "caseGroup">): string {
  const parts = [
    spec.actorType ? `type:${spec.actorType}` : undefined,
    spec.surface ? `surface:${spec.surface}` : undefined,
    spec.caseGroup ? `case:${spec.caseGroup}` : undefined
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` (${parts.join(" / ")})` : "";
}

/** Build one actor lane's CuaLaneSpec from a roster role (per-actor device IS honored here — each
 *  actor has its OWN desktop, unlike the sequential one-sandbox PoC). */
function buildActorSpec(config: LabConfig, role: LabActorLane, index: number): CuaLaneSpec {
  const mission = config.actors[0]?.mission ?? DEFAULT_MISSION;
  const device = resolveLaneDevice(config, role);
  const composed = composeLaneInstructions({
    mission,
    ...(role.persona === undefined ? {} : { persona: role.persona }),
    ...(role.instruction === undefined ? {} : { instruction: role.instruction }),
    device: { name: device.name, preset: device.preset }
  });
  const roleId = role.id ?? `role-${String(index + 1).padStart(2, "0")}`;
  const streamId = `stream-${String(index + 1).padStart(3, "0")}`;
  return {
    laneId: roleId,
    ...(role.actorType === undefined ? {} : { actorType: role.actorType }),
    ...(role.surface === undefined ? {} : { surface: role.surface }),
    ...(role.caseGroup === undefined ? {} : { caseGroup: role.caseGroup }),
    laneIndex: index,
    simId: `sim-${String(index + 1).padStart(3, "0")}`,
    streamId,
    persona: composed.persona,
    instructions: composed.instructions,
    ...((role.stopWhen ?? config.actors[0]?.stopWhen) === undefined ? {} : { stopWhen: (role.stopWhen ?? config.actors[0]?.stopWhen)! }),
    deviceName: device.name,
    devicePreset: device.preset,
    resolution: device.resolution,
    screenshotDir: roleId,
    traceArtifactPath: `actors/${streamId}.json`
  };
}

/** Thread the host-yielded lobby CODE into a follower's mission at runtime (external-public route).
 *  The CODE flows into the follower's join instruction; it is persisted only as the composed prompt
 *  the model reads (never a raw bundle field), and the lab scrubs the CODE from all narration. The
 *  follower joins through the real UI (a direct /lobby/CODE visit does not auto-join a non-member). */
function withLobbyCodeMission(spec: CuaLaneSpec, code: string): CuaLaneSpec {
  return {
    ...spec,
    instructions: `${spec.instructions}\n\nThe multiplayer lobby code is ${code}. On the home screen choose Join, enter this lobby code, enter your name, and submit to join the shared game (do not open a lobby URL directly — go through the Join flow).`
  };
}

/** A follower lane that failed closed at the host-first barrier (the host never yielded a /lobby/CODE
 *  within the deadline): it NEVER opened a browser, so it carries no session/screenshots — just the
 *  handoff-timeout reason. actorLanePassed(...) is false (no session), so it is honestly non-pass. */
function makeBlockedFollowerOutcome(spec: CuaLaneSpec, deadlineMs: number): LaneRunOutcome {
  return {
    spec,
    sessionError: `handoff barrier: the host never surfaced a /lobby/CODE URL within ${deadlineMs}ms; this follower failed closed WITHOUT opening (no wasted turns).`,
    killed: false,
    streamUrlPresent: false,
    screenshots: [],
    stateStepRecords: [],
    phaseRecords: [],
    warnings: [],
    noEngagement: true,
    selfReportedBlocker: false,
    harnessError: false,
    skippedReason: "handoff-timeout"
  };
}

async function writeConcurrentRunArtifacts(
  bundle: RunBundle,
  preparedRunPaths: PreparedRunArtifactPaths
): Promise<void> {
  const runPaths = await validatePreparedRunArtifactPaths(preparedRunPaths);
  const publicBundle: RunBundle = {
    ...bundle,
    cwd: PUBLIC_TARGET_CWD
  };
  await writeContainedOutputFile(runPaths, "run.json", `${JSON.stringify(publicBundle, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.json", `${JSON.stringify(publicBundle.review, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.md", renderConcurrentReviewMarkdown(publicBundle), "utf8");
  await writeContainedOutputFile(runPaths, "events.ndjson", `${publicBundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeContainedOutputFile(
    runPaths,
    "observer/observer-data.json",
    `${JSON.stringify(buildObserverData(publicBundle), null, 2)}\n`,
    "utf8"
  );
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId: publicBundle.runId,
      path: runPaths.relativeRunRoot,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
}

function observerResultForConcurrentArtifacts(
  cwd: string,
  runId: string,
  artifactRoot: string,
  warnings: string[] = []
): ObserverResult & { ok: true } {
  const observerPath = path.join(artifactRoot, "observer", "index.html");
  const observerDataPath = path.join(artifactRoot, "observer", "observer-data.json");
  const eventsPath = path.join(artifactRoot, "events.ndjson");
  return {
    schema: "humanish.observer-result.v1",
    ok: true,
    cwd,
    run: runId,
    observerPath: path.relative(cwd, observerPath),
    observerDataPath: path.relative(cwd, observerDataPath),
    eventsPath: path.relative(cwd, eventsPath),
    observerUrl: pathToFileURL(observerPath).href,
    bundlePath: path.join(artifactRoot, "run.json"),
    opened: false,
    warnings
  };
}

export async function runConcurrentSharedWorld(options: RunConcurrentSharedWorldLabOptions): Promise<ConcurrentSharedWorldLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const render = hooks.renderObserverFn ?? renderObserver;
  const actorType = config.actors[0]?.type ?? "";
  const concurrency = config.execution?.concurrency ?? 1;
  const roles = config.actors[0]?.lanes ?? [];

  const fail = (code: ConcurrentSharedWorldLabErrorCode, message: string, actorLabel?: string): ConcurrentSharedWorldLabResult => ({
    schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: actorLabel ?? actorType,
    topology: "shared-world",
    topologyMode: "concurrent",
    roleCount: roles.length,
    concurrency,
    dryRun,
    runId: options.runId ?? "not-created",
    roles: [],
    warnings: [],
    error: { code, message }
  });

  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED", `actors[0].type "${actorType}" is not a registered computer-use actor.`);
  }

  // The PLANE-class discriminator (#164 phase 2): an app-url subject is the EXTERNAL-PUBLIC plane (a
  // real operator-owned public deployment used directly as the shared plane — NO getHost, clone,
  // subject sandbox, or seed); everything else is the historical provisioned-getHost plane.
  const planeClass: ConcurrentSharedWorldPlaneClass =
    config.subject.source === "app-url" ? "external-public" : "provisioned-getHost";

  // Re-enforce the cross-validation (library API surface). The external-public branch NEVER touches
  // the getHost synthetic gate — that gate exists because getHost is internet-reachable AND
  // harness-owned; a public site the harness neither provisioned nor exposed has neither property.
  const invalidReason = planeClass === "external-public"
    ? externalPublicSharedWorldValidationReason(config)
    : concurrentSharedWorldValidationReason(config);
  if (invalidReason) {
    return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", invalidReason, descriptor.id);
  }

  // provisioned-getHost fields (all absent on the external-public plane — forbidden at validation).
  const serve = config.subject.serve;
  const localTreeRoute = config.subject.source === "local-tree";
  const subjectRepo = config.subject.repos?.[0] ?? "";
  const subjectEnvNames = config.subject.env ?? [];
  const checkpoints = config.subject.state?.checkpoint ?? [];
  const runSession = hooks.runSession ?? descriptor.runSession;

  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
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
      return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING", `Live concurrent shared-world labs need ${missingKeys.join(" and ")} in the environment (pass via --env-file; values are never persisted).`, descriptor.id);
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING", `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`, descriptor.id);
    }
  }

  const runId = options.runId ?? makeRunId();
  const runPaths = await prepareRunArtifactPaths(cwd, runId);
  const artifactRoot = runPaths.absoluteRunRoot;
  const physicalArtifactRoot = runPaths.physicalRunRoot;
  const createdAt = new Date().toISOString();
  const timeoutMs = config.execution?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;
  const timers: DetachedTimers = hooks.detachedTimers ?? {};
  const now = hooks.now ?? Date.now;
  const proberCadenceMs = hooks.proberCadenceMs ?? DEFAULT_PROBER_CADENCE_MS;
  const seedDigest = seedRecipeDigest(config);

  const source = await buildRunSource({ capturedAt: createdAt, cwd, humanishSource: "present", packageName: "humanish" });

  const warnings: string[] = [];
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  const stateSnapshots: SharedWorldStateSnapshot[] = [];
  const actorSpecs = roles.map((role, i) => buildActorSpec(config, role, i));
  let actorResults: ActorLaneResult[] = [];
  let subjectCommit: string | undefined;
  let subjectSandboxId: string | undefined;
  let subjectKilled = false;
  let getHostUrl: string | undefined;
  let runError: string | undefined;
  let snapshotIndex = 0;
  let liveObserver: (ObserverResult & { ok: true }) | undefined;
  const runtimeStreamUrls: ObserverRuntimeStreamUrl[] = [];

  // EXTERNAL-PUBLIC plane state (#164 phase 2). publicAppUrl is the operator-declared shared plane;
  // its ORIGIN is persisted digest-only (publicOriginDigest), never raw (the raw URL + the runtime
  // observed lobby CODE never land — TENSION 3). The latch code is scrubbed from all narration.
  const publicAppUrl = config.subject.appUrl ?? "";
  // The operator-DECLARED origin (from subject.appUrl) — recorded for evidence/reference ONLY. The
  // operator-OWNERSHIP claim rests on the subject.publicTarget.authorized attestation + this declared
  // appUrl, NOT on digest equality (blocker 2): a normal cross-origin redirect (apex->www, http->https;
  // cineguessr.com 307-redirects) makes the seats' OBSERVED origin differ from the declared one, which
  // is expected and MUST NOT fail the run. Persisted digest-only (never the raw origin).
  const declaredOriginDigest = planeClass === "external-public" && publicAppUrl
    ? hostOriginDigest(publicAppUrl)
    : undefined;
  // The OBSERVED convergence origin — computed AFTER fan-out from what the seats ACTUALLY reached (the
  // convergence proof is what the seats OBSERVED, not what was declared). Set iff every observing seat
  // agrees on ONE origin; that agreement IS the convergence proof and becomes plane.publicOriginDigest.
  let publicOriginDigest: string | undefined;
  // Per-lane runtime-only observed state (never persisted raw): the last observed URL and the last
  // observed /lobby/CODE per seat, fed by onObservedUrl. The URL is digested to ORIGIN for each seat's
  // routeHostDigest (no code leaks); the codes drive the cross-seat lobby-convergence digest.
  const observedFinalUrls: (string | undefined)[] = new Array(roles.length);
  const observedLobbyCodes: (string | undefined)[] = new Array(roles.length);
  let lobbyConvergenceDigest: string | undefined;
  let handoffTimedOut = false;
  // A closure that scrubs the latched lobby CODE from ANY persisted narration once the host resolves
  // it (the 6-char code has no detectable secret shape, so shape-only redaction cannot catch it).
  let latchedLobbyCode: string | undefined;
  const scrubKnownValuesWithLobbyCode = (text: string): string => {
    const base = scrubKnownValues(text);
    return latchedLobbyCode && latchedLobbyCode.length > 0
      ? base.split(latchedLobbyCode).join("[REDACTED_LOBBY_CODE]")
      : base;
  };

  // Pack the working tree ONCE per run, on the host, BEFORE the subject sandbox is created
  // (mirrors the sequential route + the cua route's ordering): a packing failure fails the run
  // closed here, never spending sandbox cost. Dry-run packs nothing.
  let localTreeArchive: LocalTreeArchive | undefined;
  let localTreeArchiveBuffer: ArrayBuffer | undefined;
  if (localTreeRoute && !dryRun) {
    const packLocalTree = hooks.packLocalTree ?? defaultPackLocalTree;
    try {
      const packed = await packLocalTree({
        root: cwd,
        ...(config.subject.localTree?.exclude === undefined ? {} : { extraExclude: config.subject.localTree.exclude }),
        ...(config.subject.localTree?.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: config.subject.localTree.maxArchiveBytes })
      });
      localTreeArchive = packed.archive;
      localTreeArchiveBuffer = packed.buffer;
      process.stderr.write(
        `humanish concurrent shared-world local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}`
        + `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`
      );
    } catch (error) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id
      );
    }
  }

  if (!dryRun && planeClass === "provisioned-getHost") {
    if (!serve) {
      // Defense-in-depth: concurrentSharedWorldValidationReason already required serve above.
      return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", "the provisioned-getHost concurrent shared-world route requires `subject.serve`.", descriptor.id);
    }
    let subjectModule: E2BDesktopModule | undefined;
    let subjectDesktop: E2BDesktopSandbox | undefined;
    // Background prober dispose signal (FIX-9: cleared in finally).
    let proberDisposed = false;
    let releaseDispose: () => void = () => {};
    const disposeSignal = new Promise<void>((resolve) => { releaseDispose = resolve; });
    let proberLoop: Promise<void> | undefined;

    const proberSnapshot = async (): Promise<void> => {
      if (!subjectDesktop) return;
      const timestamp = now();
      const idx = snapshotIndex;
      snapshotIndex += 1;
      const snapshot = await runCheckpointSnapshot({
        desktop: subjectDesktop,
        snapshotIndex: idx,
        name: `state-${idx}`,
        checkpoints,
        prevDigest: undefined,
        scrub: scrubKnownValues,
        requestTimeoutMs,
        timers
      });
      stateSnapshots.push({ timestamp, digest: snapshot.digest });
    };

    try {
      subjectModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
      // The ONE subject sandbox: headless service host (no GUI seat). The SUBJECT env is provisioned
      // HERE; the actor sandboxes get NONE of it (FIX-10). A custom desktop template (image) is
      // honored on BOTH the subject sandbox (here) and every actor sandbox (via runCuaLane, which
      // reads the same config); absent keeps the byte-stable Sandbox.create(opts) default.
      subjectDesktop = await createDesktopSandbox(subjectModule, {
        apiKey: e2bApiKey,
        requestTimeoutMs,
        timeoutMs: timeoutMs + SUBJECT_PROVISION_BUDGET_MS
          + (config.subject.state?.seed ?? []).reduce((sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0)
          + SANDBOX_TIMEOUT_BUFFER_MS,
        metadata: {
          ...CONCURRENT_SHARED_WORLD_PROVIDER_METADATA,
          labId: config.id,
          topology: "shared-world",
          topologyMode: "concurrent",
          role: "subject",
          roleCount: String(roles.length)
        },
        ...(subjectEnvNames.length > 0
          ? { envs: Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])) }
          : {}),
        dpi: 96,
        lifecycle: { onTimeout: "kill" }
      }, config.execution?.desktop?.template);
      subjectSandboxId = subjectDesktop.sandboxId;

      if (hooks.prepareDesktop) {
        await hooks.prepareDesktop(subjectDesktop);
      }

      // Provision the ONE shared plane: clone + install/build + seed + serve on 0.0.0.0 + probe
      // (clone route), or upload/extract the once-per-run packed archive + the SAME shared serve
      // pipeline (local-tree route).
      const onSubjectPhase = hooks.onPhase ?? ((event: SubjectPhaseEvent) => {
        process.stderr.write(
          `humanish shared-world (concurrent): ${event.message}${event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`}\n`
        );
      });
      if (localTreeRoute) {
        await provisionLocalTreeSubject(subjectDesktop, {
          archiveBuffer: localTreeArchiveBuffer!,
          serve,
          ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
          requestTimeoutMs,
          scrub: scrubKnownValues,
          onStateStep: (record) => { stateStepRecords.push(record); },
          onPhase: onSubjectPhase,
          ...timers
        });
      } else {
        subjectCommit = await provisionCloneSubject(subjectDesktop, {
          repo: subjectRepo,
          depth: config.subject.clone?.depth ?? 1,
          serve,
          ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
          hasGithubToken,
          requestTimeoutMs,
          scrub: scrubKnownValues,
          onCommit: (commit) => { subjectCommit = commit; },
          onStateStep: (record) => { stateStepRecords.push(record); },
          onPhase: onSubjectPhase,
          ...timers
        });
      }

      // Expose the served port via getHost (FIX-2). Fail closed if the SDK lacks it.
      if (typeof subjectDesktop.getHost !== "function") {
        throw new Error("the installed @e2b/desktop SDK does not expose getHost(port); the concurrent shared-world route requires it to reach the subject plane");
      }
      // getHost returns a BARE host (e.g. "3000-<sandboxId>.e2b.app", no scheme); e2b exposes the
      // port over https. Normalize to a full URL before the tokenless check + before persisting.
      const rawHost = subjectDesktop.getHost(servePort(serve.url));
      const hostUrl = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
      if (!isTokenlessHost(hostUrl)) {
        throw new Error("getHost returned a non-tokenless URL; refusing to persist a host URL that may carry a credential (invariant 1)");
      }
      getHostUrl = hostUrl;

      // Baseline state snapshot, then start the background cadence prober.
      await proberSnapshot();
      if (options.onObserverReady) {
        const inProgressPlaneCommit = localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit;
        const inProgressSubject = buildSubjectProvenance({
          localTreeRoute,
          publicRepo,
          subjectCommit: inProgressPlaneCommit,
          localTreeArchive,
          subjectEnvNames,
          state: resolveSubjectState({ declared: config.subject.state, dryRun: false, executed: stateStepRecords })
        });
        const inProgressBundle = buildConcurrentSharedWorldBundle({
          config,
          descriptor,
          createdAt,
          dryRun: false,
          inProgress: true,
          runId,
          source,
          roles,
          actorSpecs,
          actorResults: [],
          stateSnapshots,
          subject: inProgressSubject,
          seedDigest,
          ...(inProgressPlaneCommit === undefined ? {} : { subjectCommit: inProgressPlaneCommit }),
          hostDigest: hostOriginDigest(getHostUrl!)
        });
        await writeConcurrentRunArtifacts(inProgressBundle, runPaths);
        liveObserver = observerResultForConcurrentArtifacts(cwd, runId, artifactRoot, [
          "Live concurrent shared-world Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted."
        ]);
        await options.onObserverReady(liveObserver);
      }
      proberLoop = (async () => {
        while (!proberDisposed) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            new Promise<void>((resolve) => { timer = setTimeout(resolve, proberCadenceMs); }),
            disposeSignal
          ]);
          if (timer) clearTimeout(timer); // FIX-9: no dangling prober timer.
          if (proberDisposed) break;
          await proberSnapshot().catch(() => undefined);
        }
      })();

      // Launch N actor sandboxes CONCURRENTLY, INDEPENDENT (FIX-11: runCuaLane + mapWithConcurrency,
      // NOT runCuaLanes — no pipeline gate / fail-fast). Each actor's window is measured on the ONE
      // orchestrator clock (FIX-1). cloneRoute=false + subjectEnvNames=[] keep subject creds out of
      // every actor sandbox (FIX-10).
      const cuaHooks: CuaActorLabHooks = {
        ...(hooks.loadDesktopModule ? { loadDesktopModule: hooks.loadDesktopModule } : {}),
        ...(hooks.detachedTimers ? { detachedTimers: hooks.detachedTimers } : {}),
        ...(hooks.env ? { env: hooks.env } : {}),
        ...(hooks.prepareDesktop ? { prepareDesktop: (desktop: E2BDesktopSandbox) => hooks.prepareDesktop!(desktop) } : {}),
        onRuntimeStreamReady: (stream) => {
          runtimeStreamUrls.push({ streamId: stream.streamId, url: stream.url });
          if (liveObserver) {
            attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
          }
        }
      };
      const baseActorDeps: Omit<CuaLaneDeps, "signalProvisioned" | "appUrl"> = {
        config,
        descriptor,
        cloneRoute: false,
        subjectEnvNames: [],
        hasGithubToken: false,
        env,
        openaiApiKey,
        e2bApiKey,
        requestTimeoutMs,
        perLaneSandboxMs: timeoutMs + SANDBOX_TIMEOUT_BUFFER_MS,
        timeoutMs,
        laneCount: roles.length,
        artifactRoot: runPaths,
        redactScreenshots,
        scrubKnownValues,
        runSession,
        now,
        hooks: cuaHooks,
        // Concurrent lanes are independent evidence seats: a requested-vs-verified screen
        // mismatch is recorded as separate facts + a warning instead of failing the lane's
        // device claim closed, so one seat's window-manager drift cannot abort the whole
        // live multi-actor world (the single-lane/fan-out routes keep fail-closed).
        screenMismatchPolicy: "record-evidence"
      };

      actorResults = await mapWithConcurrency(actorSpecs, Math.max(1, concurrency), async (spec, i) => {
        const route = resolveActorSeatUrl(getHostUrl!, roles[i]?.entry);
        const startedAt = now();
        const outcome = await runCuaLane(spec, { ...baseActorDeps, appUrl: route });
        const endedAt = now();
        return { spec, outcome, startedAt, endedAt, route };
      });
    } catch (error) {
      runError = redactText(scrubKnownValues(toErrorMessage(error)));
      warnings.push(`Concurrent shared-world run failed before completion: ${runError}`);
    } finally {
      // FIX-9: stop the prober, take a final snapshot while the subject is still alive, then tear
      // down the ONE subject sandbox BY id (the actor sandboxes are torn down inside runCuaLane).
      proberDisposed = true;
      releaseDispose();
      if (proberLoop) {
        await proberLoop.catch(() => undefined);
      }
      if (subjectDesktop && getHostUrl) {
        await proberSnapshot().catch(() => undefined);
      }
      if (subjectDesktop && subjectModule) {
        if (typeof subjectModule.Sandbox.kill === "function") {
          try {
            await subjectModule.Sandbox.kill(subjectDesktop.sandboxId, { requestTimeoutMs: 60_000 });
            subjectKilled = true;
          } catch (error) {
            warnings.push(`Subject sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(toErrorMessage(error)))}`);
          }
        } else {
          warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the subject sandbox.");
        }
      }
    }
  }

  // EXTERNAL-PUBLIC plane (#164 phase 2): NO subject sandbox, NO getHost, NO prober. The shared plane
  // is the operator-declared public deployment (publicAppUrl); each seat opens it directly and reaches
  // the shared session through the real UI. A host-first barrier extracts the /lobby/CODE from the host
  // seat's CDP-observed URL (onObservedUrl) and threads it into the follower missions; a follower fails
  // closed WITHOUT opening if the host never yields a code within the handoff deadline.
  if (!dryRun && planeClass === "external-public") {
    const cuaHooks: CuaActorLabHooks = {
      ...(hooks.loadDesktopModule ? { loadDesktopModule: hooks.loadDesktopModule } : {}),
      ...(hooks.detachedTimers ? { detachedTimers: hooks.detachedTimers } : {}),
      ...(hooks.env ? { env: hooks.env } : {}),
      ...(hooks.prepareDesktop ? { prepareDesktop: (desktop: E2BDesktopSandbox) => hooks.prepareDesktop!(desktop) } : {}),
      onRuntimeStreamReady: (stream) => {
        runtimeStreamUrls.push({ streamId: stream.streamId, url: stream.url });
        if (liveObserver) {
          attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
        }
      }
    };
    const baseActorDeps: Omit<CuaLaneDeps, "signalProvisioned" | "appUrl" | "onObservedUrl"> = {
      config,
      descriptor,
      cloneRoute: false,
      subjectEnvNames: [],
      hasGithubToken: false,
      env,
      openaiApiKey,
      e2bApiKey,
      requestTimeoutMs,
      perLaneSandboxMs: timeoutMs + SANDBOX_TIMEOUT_BUFFER_MS,
      timeoutMs,
      laneCount: roles.length,
      artifactRoot: runPaths,
      redactScreenshots,
      // Scrub the latched lobby CODE (known once the host resolves it) from ALL narration.
      scrubKnownValues: scrubKnownValuesWithLobbyCode,
      runSession,
      now,
      hooks: cuaHooks,
      screenMismatchPolicy: "record-evidence"
    };

    // Publish an attached live Observer BEFORE fan-out (mirrors the provisioned path).
    if (options.onObserverReady) {
      const inProgressBundle = buildConcurrentSharedWorldBundle({
        config,
        descriptor,
        createdAt,
        dryRun: false,
        inProgress: true,
        runId,
        source,
        roles,
        actorSpecs,
        actorResults: [],
        stateSnapshots: [],
        subject: { source: "app-url", envNames: [], state: { provenance: "external-public" } },
        seedDigest,
        planeClass: "external-public",
        // Pre-fan-out snapshot: no seat has observed an origin yet, so the OBSERVED publicOriginDigest
        // is not available; surface the DECLARED origin for the live Observer's reference.
        ...(declaredOriginDigest === undefined ? {} : { declaredOriginDigest })
      });
      await writeConcurrentRunArtifacts(inProgressBundle, runPaths);
      liveObserver = observerResultForConcurrentArtifacts(cwd, runId, artifactRoot, [
        "Live external-public concurrent shared-world Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted."
      ]);
      await options.onObserverReady(liveObserver);
    }

    // The host-first handoff barrier.
    //
    // TEMPORARY SHIM (tracked by #296): this CDP URL-relay handoff — reading the host's /lobby/CODE off
    // its own browser and threading it into the follower missions — is a temporary coordination shim.
    // It is to be augmented/replaced by the actor message bus (faux SMS/email invite) in #297: the
    // human-realistic version is the HOST SENDING the invite link and followers RECEIVING and tapping
    // it, rather than the orchestrator relaying the code out-of-band.
    const lobbyCodeLatch = deferred<string>();
    const handoffDeadlineMs = hooks.handoffDeadlineMs ?? Math.min(DEFAULT_HANDOFF_DEADLINE_MS, timeoutMs);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => reject(new HandoffTimeoutError(handoffDeadlineMs)), handoffDeadlineMs);
    });
    deadline.catch(() => undefined); // never an unhandled rejection

    const makeLaneObservedUrl = (laneIndex: number, isHost: boolean) => (url: string | undefined): void => {
      if (typeof url !== "string" || url.length === 0) return;
      observedFinalUrls[laneIndex] = url; // runtime-only; digested to origin, never persisted raw
      const code = extractLobbyCode(url);
      if (code !== undefined) {
        observedLobbyCodes[laneIndex] = code;
        if (isHost) {
          latchedLobbyCode = code; // scrub it from any subsequent narration
          if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = undefined; }
          lobbyCodeLatch.resolve(code);
        }
      }
    };

    // The HOST lane (which yields the /lobby/CODE the followers wait on) runs on its OWN dedicated
    // slot, and the FOLLOWERS run through a bounded pool of size concurrency-1 (blockers 1 & 4):
    // followers block on `Promise.race([lobbyCodeLatch.promise, deadline])` while holding a worker
    // slot, so if the host lane were scheduled INSIDE the same bounded pool it could be starved (never
    // scheduled among the first `concurrency` workers) and the run would die with a spurious
    // HANDOFF_TIMEOUT (e.g. lanes [p2,p3,host] with concurrency 2). Giving the host its own slot,
    // started IMMEDIATELY and OUTSIDE the follower pool, guarantees it is ALWAYS schedulable regardless
    // of its roster position or of concurrency vs lane count — while total in-flight paid desktops stay
    // ≤ the declared concurrency (host + up to concurrency-1 followers), preserving the spend cap.
    const runHostLane = async (spec: CuaLaneSpec, laneIndex: number): Promise<ActorLaneResult> => {
      const onObservedUrl = makeLaneObservedUrl(laneIndex, true);
      const startedAt = now();
      let outcome: LaneRunOutcome;
      try {
        outcome = await runCuaLane(spec, { ...baseActorDeps, appUrl: publicAppUrl, onObservedUrl });
      } finally {
        // If the host finished without ever surfacing a code, release followers to fail closed
        // immediately rather than wait the full deadline (a no-op if it already resolved).
        lobbyCodeLatch.reject(new HandoffTimeoutError(handoffDeadlineMs));
      }
      const endedAt = now();
      return { spec, outcome, startedAt, endedAt, route: observedFinalUrls[laneIndex] ?? publicAppUrl };
    };
    const runFollowerLane = async (spec: CuaLaneSpec, laneIndex: number): Promise<ActorLaneResult> => {
      const onObservedUrl = makeLaneObservedUrl(laneIndex, false);
      // FOLLOWER: do NOT compose a mission or open the target until the host yields a lobby code.
      let code: string;
      try {
        code = await Promise.race([lobbyCodeLatch.promise, deadline]);
      } catch {
        // Fail closed WITHOUT opening (no wasted turns against a codeless home page).
        handoffTimedOut = true;
        const at = now();
        return { spec, outcome: makeBlockedFollowerOutcome(spec, handoffDeadlineMs), startedAt: at, endedAt: at, route: publicAppUrl };
      }
      const followerSpec = withLobbyCodeMission(spec, code);
      const startedAt = now();
      const outcome = await runCuaLane(followerSpec, { ...baseActorDeps, appUrl: publicAppUrl, onObservedUrl });
      const endedAt = now();
      return { spec, outcome, startedAt, endedAt, route: observedFinalUrls[laneIndex] ?? publicAppUrl };
    };

    // Split the roster into the designated host lane and the followers, preserving each follower's
    // ORIGINAL lane index so results land back in lane order (validation guarantees EXACTLY ONE host).
    const hostLaneIndex = roles.findIndex((role) => role.host === true);
    const followerEntries = actorSpecs
      .map((spec, index) => ({ spec, index }))
      .filter(({ index }) => index !== hostLaneIndex);
    const laneResults: ActorLaneResult[] = new Array(actorSpecs.length);
    try {
      const hostPromise = hostLaneIndex >= 0 && actorSpecs[hostLaneIndex] !== undefined
        ? runHostLane(actorSpecs[hostLaneIndex]!, hostLaneIndex)
        : undefined;
      const followerResultsPromise = mapWithConcurrency(
        followerEntries,
        Math.max(1, concurrency - 1),
        ({ spec, index }) => runFollowerLane(spec, index)
      );
      const [hostResult, followerResults] = await Promise.all([hostPromise, followerResultsPromise]);
      if (hostResult !== undefined && hostLaneIndex >= 0) {
        laneResults[hostLaneIndex] = hostResult;
      }
      followerEntries.forEach((entry, i) => { laneResults[entry.index] = followerResults[i]!; });
      actorResults = laneResults;
    } catch (error) {
      runError = redactText(scrubKnownValuesWithLobbyCode(toErrorMessage(error)));
      warnings.push(`External-public concurrent shared-world run failed before completion: ${runError}`);
    } finally {
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = undefined; }
    }

    // Observed-origin convergence proof (blocker 2): the convergence claim is about what the seats
    // OBSERVED, not what was DECLARED. Digest each observing seat's origin and require they AGREE on
    // ONE — that agreement IS the convergence proof and becomes plane.publicOriginDigest. A normal
    // cross-origin redirect (declared apex -> observed www) is therefore tolerated: the seats still
    // converge on ONE observed origin. Leave it undefined (verify fails closed) only if the seats did
    // not converge on a single observed origin (or none observed one).
    const observedOriginDigests = observedFinalUrls
      .filter((url): url is string => typeof url === "string" && url.length > 0)
      .map((url) => hostOriginDigest(url));
    const distinctObservedOrigins = new Set(observedOriginDigests);
    publicOriginDigest = distinctObservedOrigins.size === 1
      ? [...distinctObservedOrigins][0]
      // NOTHING observed (e.g. a handoff-timeout run where no seat ever navigated): fall back to the
      // DECLARED origin so a FAILED run's bundle stays structurally valid (every seat's route then
      // digests to the declared origin too). The run still fails closed for its own reason (HANDOFF_
      // TIMEOUT / no lobby convergence / no overlap-on-pass). GENUINE divergence (≥2 distinct observed
      // origins) leaves it undefined so verify fails closed on the non-convergence.
      : distinctObservedOrigins.size === 0
        ? declaredOriginDigest
        : undefined;

    // Lobby-convergence proof: a digest of the shared /lobby/CODE path iff EVERY seat converged on the
    // SAME code (a follower stuck on "/" yields no code → no false convergence). Digest-only. NOTE:
    // observedLobbyCodes may be a SPARSE array (a seat that never observed a code leaves a hole), and
    // Array.prototype.every SKIPS holes — so count the DEFINED codes explicitly, never rely on every().
    const definedCodes = observedLobbyCodes.filter((code): code is string => code !== undefined);
    const distinctCodes = new Set(definedCodes);
    if (distinctCodes.size === 1 && definedCodes.length === roles.length) {
      lobbyConvergenceDigest = commandDigestOf(`/lobby/${[...distinctCodes][0]}`);
    }
    if (handoffTimedOut && runError === undefined) {
      runError = `The host seat never produced a /lobby/CODE URL within the ${handoffDeadlineMs}ms handoff deadline; follower seats failed closed without opening.`;
    }
  }

  // Subject provenance: external-public is the operator-declared, operator-owned public deployment
  // (neither provisioned nor seeded); the provisioned path builds clone/local-tree provenance.
  const subject: RunSubjectProvenance = planeClass === "external-public"
    ? { source: "app-url", envNames: [], state: { provenance: "external-public" } }
    : buildSubjectProvenance({
        localTreeRoute,
        publicRepo,
        subjectCommit: localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit,
        localTreeArchive,
        subjectEnvNames,
        state: resolveSubjectState({ declared: config.subject.state, dryRun, executed: stateStepRecords })
      });
  const planeCommit = localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit;

  // Collect per-actor warnings (each lane's own teardown/raw-screenshot notes).
  for (const result of actorResults) {
    warnings.push(...result.outcome.warnings);
  }

  const bundle = buildConcurrentSharedWorldBundle({
    config,
    descriptor,
    createdAt,
    dryRun,
    runId,
    source,
    roles,
    actorSpecs,
    actorResults,
    stateSnapshots,
    subject,
    seedDigest,
    planeClass,
    ...(planeCommit === undefined ? {} : { subjectCommit: planeCommit }),
    ...(getHostUrl === undefined ? {} : { hostDigest: hostOriginDigest(getHostUrl) }),
    ...(publicOriginDigest === undefined ? {} : { publicOriginDigest }),
    ...(declaredOriginDigest === undefined ? {} : { declaredOriginDigest }),
    ...(lobbyConvergenceDigest === undefined ? {} : { lobbyConvergenceDigest }),
    ...(runError === undefined ? {} : { runError })
  });

  const adapterWarnings: string[] = [];
  await applyBrowserAdapterHooks({
    hooks,
    bundle,
    context: {
      bundle,
      runDir: physicalArtifactRoot,
      labId: config.id,
      runId,
      actor: descriptor.id,
      backend: "concurrent-shared-world",
      dryRun,
      laneCount: roles.length
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "sharedWorldHooks"
  });

  await writeConcurrentRunArtifacts(bundle, runPaths);

  const observer = await render(cwd, runId, { open: options.open === true });
  if (observer.ok && liveObserver) {
    attachObserverRuntimeStreamUrls(observer as ObserverResult & { ok: true }, runtimeStreamUrls);
  }

  const roleOk = (result: ActorLaneResult | undefined): boolean => {
    if (dryRun) return true;
    return actorLanePassed(result);
  };
  // Concurrent "ok": every actor must produce a terminal, engaged PASSED session. Per-persona
  // mission success is still the "M of N" headline, but a failed actor trace cannot make the
  // route green just because the harness got a terminal.
  const swarmRan = !dryRun && actorResults.length === roles.length
    && actorResults.every(actorLanePassed);
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok = observer.ok && runError === undefined && (dryRun || swarmRan) && adapterFailure === undefined;

  const overlapProven = !dryRun && actorWindowsOverlap(actorResults);

  const roleResults: ConcurrentSharedWorldRoleResult[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const base = { id: spec.laneId, index: index + 1, persona: spec.persona.id };
    if (dryRun || !result) {
      return { ...base, status: "contract_proof_only", ok: dryRun };
    }
    const session = result.outcome.session;
    const thisOk = roleOk(result);
    return {
      ...base,
      status: session ? session.status : "failed",
      ok: thisOk,
      window: { startedAt: result.startedAt, endedAt: result.endedAt },
      ...(session
        ? { session: { status: session.status, completionReason: session.completionReason, reason: session.reason, screenshots: result.outcome.screenshots.length } }
        : {}),
      ...(result.outcome.sandboxId === undefined
        ? {}
        : { sandbox: { sandboxId: result.outcome.sandboxId, killed: result.outcome.killed } }),
      ...(thisOk
        ? {}
        : {
            error: {
              code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED" as const,
              message: result.outcome.sessionError
                ?? (result.outcome.noEngagement
                  ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                  : result.outcome.selfReportedBlocker
                    ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
                  : session?.completionReason === "harness_error"
                    ? `Actor seat ended with a harness error: ${session.reason}`
                    : "Actor did not produce a terminal session.")
            }
          })
    };
  });

  const errorResult = ((): ConcurrentSharedWorldLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (handoffTimedOut) {
      // Checked BEFORE the observer failure: the host never yielded a /lobby/CODE within the
      // deadline (followers failed closed without opening), which is the ROOT CAUSE — and it can
      // itself make the Observer unable to render a coherent run. Report the distinct, honest
      // handoff-timeout code rather than a generic observer/run failure.
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT", message: runError ?? "The host seat never produced a /lobby/CODE URL within the handoff deadline." };
    }
    if (!observer.ok) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: observer.error?.message ?? "Observer failed for the concurrent shared-world run." };
    }
    if (runError) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: runError };
    }
    if (adapterFailure !== undefined) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: adapterFailure };
    }
    const passed = roleResults.filter((role) => role.ok).length;
    return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: `Concurrent shared-world run did not run coherently: ${passed}/${roles.length} actor(s) reached a terminal, engaged passed session.` };
  })();

  return {
    schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    topology: "shared-world",
    topologyMode: "concurrent",
    roleCount: roles.length,
    concurrency,
    dryRun,
    runId,
    ...(getHostUrl === undefined ? {} : { host: getHostUrl }),
    ...(subjectSandboxId === undefined ? {} : { subjectSandbox: { sandboxId: subjectSandboxId, killed: subjectKilled } }),
    ...(dryRun ? {} : { overlapProven }),
    subject,
    roles: roleResults,
    observer,
    warnings: [...warnings, ...adapterWarnings, ...observer.warnings],
    ...(errorResult === undefined ? {} : { error: errorResult })
  };
}

/** True when ≥2 actor windows overlap in time (the proven-concurrency signal). */
function actorWindowsOverlap(results: ActorLaneResult[]): boolean {
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const a = results[i]!;
      const b = results[j]!;
      if (a.startedAt < b.endedAt && b.startedAt < a.endedAt) {
        return true;
      }
    }
  }
  return false;
}

function actorLanePassed(result: ActorLaneResult | undefined): boolean {
  if (!result) return false;
  const session = result.outcome.session;
  return session !== undefined
    && session.status === "passed"
    && session.completionReason !== "harness_error"
    && result.outcome.sessionError === undefined
    && !result.outcome.noEngagement
    && !result.outcome.selfReportedBlocker;
}

/** Project the concurrent run into a humanish.run-bundle.v1 with the CONCURRENT shared-world block. */
export function buildConcurrentSharedWorldBundle(args: {
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
}): RunBundle {
  const { config, descriptor, createdAt, dryRun, actorSpecs, actorResults, roles } = args;
  const inProgress = args.inProgress === true;
  const external = (args.planeClass ?? "provisioned-getHost") === "external-public";
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [];
  // Public-safe label only — neither the raw getHost URL (provisioned) nor the raw public origin
  // (external-public) lands in the bundle. The plane identity is a DIGEST (plane.hostDigest on
  // getHost; plane.publicOriginDigest on external-public).
  const appUrl = external ? "[external-public-plane]" : "[provisioned-subject]";
  const planeCommit = external ? undefined : dryRun ? undefined : args.subjectCommit;

  events.push({
    id: "event-000-created",
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.run.created",
    message: `Created CONCURRENT shared-world run for ${config.id} (actor ${descriptor.id}, ${actorSpecs.length} persona(s) vs ONE shared plane, max ${config.execution?.concurrency ?? 1} concurrent).`
  });
  // Human-readable plane label, byte-stable for the clone route (see shared-world-lab.ts's
  // buildSharedWorldBundle for the same pattern). local-tree has no repo slug: it labels the
  // packed archive instead (archiveSha256 + dirty/clean when the packed root was a git work tree).
  const dryRunPlaneLabel = args.subject.source === "local-tree"
    ? "packed working tree"
    : `clone of ${args.subject.repo}`;
  const livePlaneLabel = args.subject.source === "local-tree"
    ? (args.subject.archiveSha256
        ? `packed working tree (archiveSha256 ${args.subject.archiveSha256}${args.subject.dirty === true ? ", dirty working tree" : args.subject.dirty === false ? ", clean working tree" : ""})`
        : "packed working tree (archive digest unresolved; provisioning failed before resolution)")
    : `clone of ${args.subject.repo}${args.subjectCommit ? `@${args.subjectCommit}` : ""}`;
  // External-public plane provenance is HONESTLY different: an operator-declared, operator-OWNED
  // public deployment humanish neither provisioned nor seeded — NO getHost, NO clone, NO synthetic
  // attestation (claiming synthetic on a real site is a lie). The origin persists digest-only.
  const externalPlaneOwner = config.subject.publicTarget?.owner ?? "(operator-declared)";
  events.push({
    id: "event-001-plane",
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.plane.provenance",
    message: external
      ? `Shared plane: an EXTERNAL-PUBLIC deployment (operator-attested owner ${externalPlaneOwner}, authorized) used DIRECTLY as the shared plane — NO getHost, clone, subject sandbox, or seed. The harness OBSERVES that each seat reached the operator-declared origin (publicOriginDigest); it did NOT mint or control the plane. Author-trust ownership attestation, NOT a synthetic-data claim.`
      : dryRun
      ? `Shared plane declared: ${dryRunPlaneLabel}, served + getHost-exposed in-sandbox (dry-run contract; nothing ${args.subject.source === "local-tree" ? "packed" : "cloned"}). Seed recipe ${args.seedDigest}; SYNTHETIC subject (author-attested); env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`
      : `Shared plane: ${livePlaneLabel}, served + exposed at the harness-minted getHost URL; seed recipe ${args.seedDigest}; SYNTHETIC subject (author-attested); env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`,
    simId: actorSpecs[0]?.simId ?? "sim-001",
    streamId: actorSpecs[0]?.streamId ?? "stream-001"
  });

  let eventSeq = 2;
  const nextEventId = (suffix: string): string => `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  actorSpecs.forEach((spec, index) => {
    const taxonomy = laneTaxonomyLabel(spec);
    const result = actorResults[index];
    const outcome = result?.outcome;
    const session = outcome?.session;
    const screenshots = outcome?.screenshots ?? [];
    const lastScreenshot = screenshots[screenshots.length - 1];
    // public-safe (origin redacted): external-public seats open the public plane; getHost seats a seat path.
    const route = external ? "[external-public-plane]" : publicSafeRouteLabel(roles[index]?.entry);
    const status: RunSimulationStatus = session
      ? session.status
      : outcome?.sessionError
        ? "failed"
        : inProgress
          ? "running"
          : "contract_proof_only";
    const reason = session?.reason
      ?? outcome?.sessionError
      ?? (inProgress
        ? "Actor desktop is running; the attached Observer hydrates the runtime stream URL without persisting it."
        : "Contract actor only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.");
    const traceScreenshotMode = session?.trace.redaction.screenshots;
    const desktopGeometry = outcome?.desktopGeometry ?? {
      screen: { requested: { width: spec.resolution[0], height: spec.resolution[1] } }
    };
    const screenshotMode: "raw" | "blurred" =
      traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
        ? traceScreenshotMode
        : config.policies?.redactScreenshots === true ? "blurred" : "raw";

    simulations.push({
      id: spec.simId,
      index: index + 1,
      personaId: spec.persona.id,
      scenarioId: `concurrent-shared-world-${config.id}`,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: inProgress ? 35 : 100,
      currentStep: reason,
      summary: session
        ? `Persona ${spec.laneId}${taxonomy} (${spec.persona.id}): drove the shared plane concurrently; ${session.completionReason}.`
        : outcome?.sessionError
          ? `Persona ${spec.laneId}${taxonomy} failed before a terminal session verdict: ${outcome.sessionError}`
          : inProgress
            ? `Persona ${spec.laneId}${taxonomy} (${spec.persona.id}) is running against the shared plane.`
          : `Contract persona ${spec.laneId}${taxonomy} (${spec.persona.id}) for ${descriptor.id} against the shared plane at ${appUrl}.`,
      streamIds: [spec.streamId],
      startedAt: createdAt,
      updatedAt: createdAt
    });

    streams.push({
      id: spec.streamId,
      simId: spec.simId,
      kind: "browser",
      label: `Concurrent persona ${spec.laneId}${taxonomy} — ${config.id}`,
      status,
      transport: "snapshot",
      updatedAt: createdAt,
      embed: lastScreenshot
        ? { kind: "screenshot", url: lastScreenshot, title: `Shared plane, persona ${spec.laneId} (${screenshotMode})` }
        : { kind: "placeholder", title: `Shared plane, persona ${spec.laneId}` },
      ...(desktopGeometry.viewport === undefined
        ? {}
        : {
            viewport: {
              width: desktopGeometry.viewport.width,
              height: desktopGeometry.viewport.height,
              deviceScaleFactor: desktopGeometry.viewport.deviceScaleFactor,
              isMobile: spec.devicePreset.isMobile
            }
          }),
      desktopGeometry,
      ui: {
        route,
        intent: `Watch persona ${spec.laneId}${taxonomy} (${spec.persona.id}) drive the SHARED plane concurrently with the other personas.`,
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
          ? [{ label: `persona ${spec.laneId} actor trace`, path: spec.traceArtifactPath, kind: "trace" as const }]
          : []),
        ...screenshots.map((screenshot, screenshotIndex) => ({
          label: `persona ${spec.laneId} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
          path: screenshot,
          kind: "screenshot" as const
        }))
      ]
    });

    for (const warning of outcome?.warnings ?? []) {
      events.push({
        id: nextEventId(`warning-${spec.laneId}`),
        at: createdAt,
        level: "warn",
        type: "concurrent-shared-world.actor.warning",
        message: `Persona ${spec.laneId}: ${warning}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }

    if (session) {
      events.push({
        id: nextEventId(`session-${spec.laneId}`),
        at: createdAt,
        level: session.status === "passed" ? "info" : "warn",
        type: `concurrent-shared-world.session.${session.completionReason}`,
        message: `Persona ${spec.laneId}: ${session.status} — ${session.reason}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.sessionError) {
      events.push({
        id: nextEventId(`session-error-${spec.laneId}`),
        at: createdAt,
        level: "error",
        type: "concurrent-shared-world.session.error",
        message: `Persona ${spec.laneId}: ${outcome.sessionError}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (inProgress) {
      events.push({
        id: nextEventId(`running-${spec.laneId}`),
        at: createdAt,
        level: "info",
        type: "actor.running",
        message: `Persona ${spec.laneId}: desktop actor is running; live stream URL is runtime-only and not persisted.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else {
      events.push({
        id: nextEventId(`contract-${spec.laneId}`),
        at: createdAt,
        level: "info",
        type: "concurrent-shared-world.contract.ready",
        message: `Persona ${spec.laneId}: dry-run contract actor ready; switch scenario.mode to live for a real concurrent session.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }
  });

  // Build the concurrent shared-world evidence block. routeHostDigest is sha256-16 of the ORIGIN each
  // seat reached: on getHost the seat URL the actor drove (verify confirms == plane.hostDigest); on
  // external-public the seat's CDP-OBSERVED URL origin (verify confirms == plane.publicOriginDigest).
  const fallbackHostDigest = external
    ? (args.publicOriginDigest ?? commandDigestOf("[external-public-plane]"))
    : (args.hostDigest ?? commandDigestOf("[provisioned-subject]"));
  const laneWindows: SharedWorldLaneWindow[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const session = result?.outcome.session;
    const routeHostDigest = result ? hostOriginDigest(result.route) : fallbackHostDigest;
    return {
      roleId: spec.laneId,
      ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
      ...(spec.surface === undefined ? {} : { surface: spec.surface }),
      ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
      simId: spec.simId,
      streamId: spec.streamId,
      startedAt: result?.startedAt ?? 0,
      endedAt: result?.endedAt ?? 0,
      verdict: session ? session.status : result?.outcome.sessionError ? "failed" : inProgress ? "running" : "contract_proof_only",
      routeHostDigest,
      ...(planeCommit === undefined ? {} : { commit: planeCommit }),
      seedDigest: args.seedDigest
    };
  });

  // Option A (external-public): NO authoritative shared-state proof — OMIT stateSeries entirely (there
  // is no in-sandbox filesystem to digest; concurrency is proven by temporal co-occupancy + lobby
  // convergence). The provisioned-getHost plane keeps its authoritative in-sandbox checkpoint series.
  const stateSeries: SharedWorldStateSnapshot[] | undefined = external
    ? undefined
    : dryRun
      ? [{ timestamp: 0, digest: declaredStateDigest(config) }]
      : [...args.stateSnapshots].sort((a, b) => a.timestamp - b.timestamp);

  const outcomes: SharedWorldOutcome[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const session = result?.outcome.session;
    const ok = !dryRun && actorLanePassed(result);
    return {
      roleId: spec.laneId,
      ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
      ...(spec.surface === undefined ? {} : { surface: spec.surface }),
      ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
      simId: spec.simId,
      streamId: spec.streamId,
      status: session ? session.status : result?.outcome.sessionError ? "failed" : inProgress ? "running" : "contract_proof_only",
      ...(session ? { completionReason: session.completionReason } : {}),
      ok
    };
  });

  // The plane block is plane-class-specific. getHost: harness-minted hostDigest + synthetic
  // attestation. external-public: operator-declared publicOriginDigest, NO hostDigest, NO exposure
  // (claiming synthetic on a real site would be a lie — verify asserts both ABSENT there).
  const plane: SharedWorldPlane = external
    ? {
        seedDigest: args.seedDigest,
        envNames: [],
        // publicOriginDigest is the OBSERVED convergence origin; declaredOriginDigest records the
        // operator-declared origin for reference (a redirect makes them differ — not a failure).
        ...(args.publicOriginDigest === undefined ? {} : { publicOriginDigest: args.publicOriginDigest }),
        ...(args.declaredOriginDigest === undefined ? {} : { declaredOriginDigest: args.declaredOriginDigest })
      }
    : {
        ...(planeCommit === undefined ? {} : { commit: planeCommit }),
        seedDigest: args.seedDigest,
        envNames: args.subject.envNames ?? [],
        ...(args.hostDigest === undefined ? {} : { hostDigest: args.hostDigest }),
        exposure: "synthetic"
      };

  const sharedWorld: SharedWorldEvidence = {
    schema: SHARED_WORLD_SCHEMA,
    topology: "shared-world",
    topologyMode: "concurrent",
    // Byte-stable: the provisioned-getHost plane omits planeClass (absent == provisioned-getHost).
    ...(external ? { planeClass: "external-public" as const } : {}),
    roleCount: actorSpecs.length,
    plane,
    attributionLimits: external ? [...EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS] : [...CONCURRENT_ATTRIBUTION_LIMITS],
    laneWindows,
    // Option A: external-public carries NO stateSeries.
    ...(stateSeries === undefined ? {} : { stateSeries }),
    outcomes,
    ...(args.lobbyConvergenceDigest === undefined ? {} : { lobbyConvergenceDigest: args.lobbyConvergenceDigest })
  };

  const overlaps = actorWindowsOverlap(actorResults);
  const deltas = (stateSeries ?? []).filter((snapshot, i) => i > 0 && snapshot.digest !== (stateSeries ?? [])[i - 1]!.digest).length;
  const stateSeriesLabel = external
    ? "stateSeries omitted (no authoritative shared-state proof on the external-public plane)"
    : `stateSeries ${(stateSeries ?? []).length} snapshot(s), ${deltas} delta(s)`;
  const convergenceLabel = external
    ? `; lobby convergence ${args.lobbyConvergenceDigest ? "PROVEN (all seats reached one /lobby/CODE)" : "not observed"}`
    : "";
  events.push({
    id: nextEventId("concurrency"),
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.concurrency",
    message: `Concurrency: ${laneWindows.length} actor window(s)${dryRun ? " (dry-run contract; $0)" : `, overlap ${overlaps ? "PROVEN" : "not observed"}`}; ${stateSeriesLabel}${convergenceLabel}. Attribution ceiling: ${sharedWorld.attributionLimits.join(", ")}. ${dryRun ? "This contract-only run proves no live concurrency, scale, or adoption." : "This run reports only its own observed overlap and state changes; it does not prove scale, repeatability, or adopter-harness replacement."}`
  });

  // Concurrent verdict: dryRun → contract; else every actor produced a terminal, engaged PASSED
  // session → pass; otherwise fail. Per-persona mission success is the M-of-N in outcomes[].
  const verdict: ReviewSummary["verdict"] = dryRun
    ? "contract_proof_only"
    : inProgress
      ? "contract_proof_only"
    : (actorResults.length === actorSpecs.length
        && actorResults.every(actorLanePassed)
        ? "pass"
        : "fail");
  const passedMissions = outcomes.filter((outcome) => outcome.ok).length;

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    // Plane-class-aware: the external-public plane has NO getHost/clone/seed and carries NO
    // authoritative state series, so its summary must not claim a getHost-exposed plane (dry-run) nor
    // report "state delta(s) under load" (live) — it reports lobby convergence instead.
    summary: dryRun
      ? external
        ? `Dry-run concurrent shared-world contract: ${actorSpecs.length} persona(s) declared against ONE external-public shared plane (a real public deployment used directly; no getHost/clone/seed); no sandboxes launched, $0 spend.`
        : `Dry-run concurrent shared-world contract: ${actorSpecs.length} persona(s) declared against ONE getHost-exposed plane (${descriptor.id}); no sandboxes launched, $0 spend.`
      : inProgress
        ? `In-progress concurrent shared-world Observer snapshot: ${actorSpecs.length} persona(s) running against ONE shared plane; final verification is pending.`
      : external
        ? `Concurrent shared-world (ONE external-public plane, ${actorSpecs.length} simultaneous personas): swarm ${verdict === "pass" ? "ran coherently" : "did not run coherently"}; ${passedMissions}/${actorSpecs.length} reached their goal; overlap ${overlaps ? "proven" : "not observed"}; ${args.lobbyConvergenceDigest ? `${actorSpecs.length} seats converged on one lobby` : "lobby convergence not observed"}.`
        : `Concurrent shared-world (ONE plane, ${actorSpecs.length} simultaneous personas): swarm ${verdict === "pass" ? "ran coherently" : "did not run coherently"}; ${passedMissions}/${actorSpecs.length} reached their goal; overlap ${overlaps ? "proven" : "not observed"}; ${deltas} state delta(s) under load.`,
    gaps: dryRun
      ? ["This dry-run launched no concurrent shared-world session; it proves contract shape only, not live behavior, scale, or adopter-harness replacement."]
      : inProgress
        ? ["Final actor traces, screenshots, state deltas, and verification are pending; this Observer is for live watch only."]
      : actorResults
          .filter((result) =>
            result.outcome.sessionError !== undefined
            || result.outcome.noEngagement
            || result.outcome.selfReportedBlocker
            || result.outcome.session === undefined
            || result.outcome.session.status !== "passed")
          .map((result) => `${result.spec.laneId}: ${result.outcome.sessionError ?? result.outcome.session?.reason ?? "did not pass"}`)
  };

  const anyRaw = actorResults.some((result) => result.outcome.session?.trace.redaction.screenshots === "raw");
  const ranLive = actorResults.some((result) => result.outcome.session !== undefined || result.outcome.sessionError !== undefined);

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: dryRun ? "dry-run" : "live",
    simCount: actorSpecs.length,
    createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".humanish", "runs", args.runId),
    source: args.source,
    persona: {
      id: actorSpecs[0]?.persona.id ?? "concurrent-persona",
      name: `Concurrent shared-world swarm (${actorSpecs.length} personas)`,
      source: `lab:${config.id}`,
      sourceDigest: actorSpecs[0]?.persona.promptDigest ?? args.seedDigest
    },
    scenario: {
      id: `concurrent-shared-world-${config.id}`,
      title: config.title ?? `Concurrent shared-world: ${config.id}`,
      goal: actorSpecs[0]?.instructions ?? "Concurrent shared-world interaction.",
      source: `lab:${config.id}`,
      sourceDigest: actorSpecs[0]?.persona.promptDigest ?? args.seedDigest
    },
    lifecycle: [
      {
        at: createdAt,
        event: "concurrent-shared-world.run.created",
        message: `Created concurrent shared-world run with ONE shared plane and ${actorSpecs.length} simultaneous actor seats (actor ${descriptor.id}).`
      }
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: ranLive
        ? anyRaw
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Some personas captured FULL-FIDELITY (raw) screenshots, retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle. stateSeries persists digest-only."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle. stateSeries persists digest-only."
        : inProgress
          ? "In-progress live Observer snapshot: runtime stream auth URLs are process-local only and are not persisted. Final typed text, traces, and screenshots are pending. stateSeries persists digest-only."
        : "Dry-run concurrent shared-world contract bundle: no sandboxes launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs. stateSeries persists digest-only."
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
    // Custom desktop image provenance (subject + every actor sandbox launched on it); omitted on the default.
    ...(config.execution?.desktop?.template === undefined ? {} : { desktopTemplate: config.execution.desktop.template }),
    subject: args.subject,
    attributionClass: "shared-world",
    sharedWorld
  };
}

/** The declared (dry-run) state digest: the probe RECIPE (command digests), no run. */
function declaredStateDigest(config: LabConfig): string {
  const probes = config.subject.state?.checkpoint ?? [];
  return combineCheckpointDigest(probes.map((probe) => `${probe.name}=${commandDigestOf(probe.command)}`));
}

function renderConcurrentReviewMarkdown(bundle: RunBundle): string {
  const plane = bundle.events.find((event) => event.type === "concurrent-shared-world.plane.provenance");
  const concurrency = bundle.events.find((event) => event.type === "concurrent-shared-world.concurrency");
  const sw = bundle.sharedWorld;
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- attribution class: ${bundle.attributionClass ?? "isolated"}`,
    `- topology: ${sw?.topology ?? "(none)"} / ${sw?.topologyMode ?? "(none)"}`,
    `- personas: ${sw?.roleCount ?? 0}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(plane ? [`- plane: ${plane.message}`] : []),
    ...(concurrency ? [`- concurrency: ${concurrency.message}`] : []),
    ...(sw ? [`- attribution limits: ${sw.attributionLimits.join(", ")}`] : []),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
}
