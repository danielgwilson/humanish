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
// attributionClass: shared-world + a CONCURRENT homun.shared-world.v1 block (topologyMode
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
// measures the windows). It does NOT prove "we ran many concurrent users at scale" — that
// CAPABILITY is backed only by the deferred, separately-authorized live receipt.
//
// Synthetic-subject (FIX-3): a getHost URL is internet-reachable for the run, so this route is
// synthetic-seeded-subjects ONLY. Verify fail-closes on subject.state.provenance != "seeded" and
// requires the author attestation subject.exposure: synthetic. This is author-trust + a provenance
// gate, NOT a no-real-data guarantee (Homun cannot tell synthetic from real data).

import { mkdir, writeFile } from "node:fs/promises";
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
  type SharedWorldStateSnapshot
} from "./run.js";

export const CONCURRENT_SHARED_WORLD_LAB_SCHEMA = "homun.concurrent-shared-world-lab-result.v1";

export const CONCURRENT_SHARED_WORLD_PROVIDER_METADATA = {
  mode: "concurrent-shared-world-lab",
  tool: "homun"
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
  | "HOMUN_CONCURRENT_SHARED_WORLD_LAB_FAILED"
  | "HOMUN_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED"
  | "HOMUN_CONCURRENT_SHARED_WORLD_LAB_INVALID"
  | "HOMUN_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING"
  | "HOMUN_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING"
  | "HOMUN_CONCURRENT_SHARED_WORLD_LAB_GETHOST_UNAVAILABLE";

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

async function writeConcurrentRunArtifacts(
  cwd: string,
  artifactRoot: string,
  bundle: RunBundle
): Promise<void> {
  const publicBundle: RunBundle = {
    ...bundle,
    cwd: PUBLIC_TARGET_CWD
  };
  await writeFile(path.join(artifactRoot, "run.json"), `${JSON.stringify(publicBundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.json"), `${JSON.stringify(publicBundle.review, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.md"), renderConcurrentReviewMarkdown(publicBundle), "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${publicBundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await mkdir(path.join(artifactRoot, "observer"), { recursive: true });
  await writeFile(
    path.join(artifactRoot, "observer", "observer-data.json"),
    `${JSON.stringify(buildObserverData(publicBundle), null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(cwd, ".homun", "runs", "latest.json"),
    `${JSON.stringify({
      schema: "homun.latest-run.v1",
      runId: publicBundle.runId,
      path: path.join(".homun", "runs", publicBundle.runId),
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
    schema: "homun.observer-result.v1",
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
    return fail("HOMUN_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED", `actors[0].type "${actorType}" is not a registered computer-use actor.`);
  }

  // Re-enforce the concurrent cross-validation (library API surface).
  const invalidReason = concurrentSharedWorldValidationReason(config);
  if (invalidReason) {
    return fail("HOMUN_CONCURRENT_SHARED_WORLD_LAB_INVALID", invalidReason, descriptor.id);
  }

  const serve = config.subject.serve!;
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
      return fail("HOMUN_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING", `Live concurrent shared-world labs need ${missingKeys.join(" and ")} in the environment (pass via --env-file; values are never persisted).`, descriptor.id);
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail("HOMUN_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING", `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`, descriptor.id);
    }
  }

  const runId = options.runId ?? makeRunId();
  const artifactRoot = path.join(cwd, ".homun", "runs", runId);
  const createdAt = new Date().toISOString();
  const timeoutMs = config.execution?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const requestTimeoutMs = readPositiveInt(env.HOMUN_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;
  const timers: DetachedTimers = hooks.detachedTimers ?? {};
  const now = hooks.now ?? Date.now;
  const proberCadenceMs = hooks.proberCadenceMs ?? DEFAULT_PROBER_CADENCE_MS;
  const seedDigest = seedRecipeDigest(config);

  await mkdir(artifactRoot, { recursive: true });
  const source = await buildRunSource({ capturedAt: createdAt, cwd, homunSource: "present", packageName: "homun" });

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
        `homun concurrent shared-world local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}`
        + `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`
      );
    } catch (error) {
      return fail(
        "HOMUN_CONCURRENT_SHARED_WORLD_LAB_FAILED",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id
      );
    }
  }

  if (!dryRun) {
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
          `homun shared-world (concurrent): ${event.message}${event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`}\n`
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
        await writeConcurrentRunArtifacts(cwd, artifactRoot, inProgressBundle);
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
        artifactRoot,
        redactScreenshots,
        scrubKnownValues,
        runSession,
        hooks: cuaHooks
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

  const subjectState = resolveSubjectState({ declared: config.subject.state, dryRun, executed: stateStepRecords });
  const planeCommit = localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit;
  const subject = buildSubjectProvenance({
    localTreeRoute,
    publicRepo,
    subjectCommit: planeCommit,
    localTreeArchive,
    subjectEnvNames,
    state: subjectState
  });

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
    ...(planeCommit === undefined ? {} : { subjectCommit: planeCommit }),
    ...(getHostUrl === undefined ? {} : { hostDigest: hostOriginDigest(getHostUrl) }),
    ...(runError === undefined ? {} : { runError })
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
      backend: "concurrent-shared-world",
      dryRun,
      laneCount: roles.length
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "sharedWorldHooks"
  });

  await writeConcurrentRunArtifacts(cwd, artifactRoot, bundle);

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
              code: "HOMUN_CONCURRENT_SHARED_WORLD_LAB_FAILED" as const,
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
    if (!observer.ok) {
      return { code: "HOMUN_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: observer.error?.message ?? "Observer failed for the concurrent shared-world run." };
    }
    if (runError) {
      return { code: "HOMUN_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: runError };
    }
    if (adapterFailure !== undefined) {
      return { code: "HOMUN_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: adapterFailure };
    }
    const passed = roleResults.filter((role) => role.ok).length;
    return { code: "HOMUN_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: `Concurrent shared-world run did not run coherently: ${passed}/${roles.length} actor(s) reached a terminal, engaged passed session.` };
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

/** Project the concurrent run into a homun.run-bundle.v1 with the CONCURRENT shared-world block. */
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
  runError?: string;
}): RunBundle {
  const { config, descriptor, createdAt, dryRun, actorSpecs, actorResults, roles } = args;
  const inProgress = args.inProgress === true;
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [];
  // Public-safe label only — the raw getHost URL never lands in the bundle (it embeds the live
  // sandbox id + matches the e2b-URL redaction). The host identity is carried by plane.hostDigest.
  const appUrl = "[provisioned-subject]";
  const planeCommit = dryRun ? undefined : args.subjectCommit;

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
  events.push({
    id: "event-001-plane",
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.plane.provenance",
    message: dryRun
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
    const route = publicSafeRouteLabel(roles[index]?.entry); // public-safe (host redacted)
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
      viewport: {
        width: spec.resolution[0],
        height: spec.resolution[1],
        deviceScaleFactor: spec.devicePreset.deviceScaleFactor,
        isMobile: spec.devicePreset.isMobile
      },
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

  // Build the concurrent shared-world evidence block. routeHostDigest is sha256-16 of the ORIGIN of
  // the getHost seat URL each actor drove (publish-safe; verify confirms it == plane.hostDigest).
  const fallbackHostDigest = args.hostDigest ?? commandDigestOf("[provisioned-subject]");
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

  const stateSeries: SharedWorldStateSnapshot[] = dryRun
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

  const sharedWorld: SharedWorldEvidence = {
    schema: SHARED_WORLD_SCHEMA,
    topology: "shared-world",
    topologyMode: "concurrent",
    roleCount: actorSpecs.length,
    plane: {
      ...(planeCommit === undefined ? {} : { commit: planeCommit }),
      seedDigest: args.seedDigest,
      envNames: args.subject.envNames ?? [],
      ...(args.hostDigest === undefined ? {} : { hostDigest: args.hostDigest }),
      exposure: "synthetic"
    },
    attributionLimits: [...CONCURRENT_ATTRIBUTION_LIMITS],
    laneWindows,
    stateSeries,
    outcomes
  };

  const overlaps = actorWindowsOverlap(actorResults);
  const deltas = stateSeries.filter((snapshot, i) => i > 0 && snapshot.digest !== stateSeries[i - 1]!.digest).length;
  events.push({
    id: nextEventId("concurrency"),
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.concurrency",
    message: `Concurrency: ${laneWindows.length} actor window(s)${dryRun ? " (dry-run contract; $0)" : `, overlap ${overlaps ? "PROVEN" : "not observed"}`}; stateSeries ${stateSeries.length} snapshot(s), ${deltas} delta(s). Attribution ceiling: ${sharedWorld.attributionLimits.join(", ")}. CAPABILITY at scale is backed only by the deferred live receipt.`
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
    summary: dryRun
      ? `Dry-run concurrent shared-world contract: ${actorSpecs.length} persona(s) declared against ONE getHost-exposed plane (${descriptor.id}); no sandboxes launched, $0 spend.`
      : inProgress
        ? `In-progress concurrent shared-world Observer snapshot: ${actorSpecs.length} persona(s) running against ONE shared plane; final verification is pending.`
      : `Concurrent shared-world (ONE plane, ${actorSpecs.length} simultaneous personas): swarm ${verdict === "pass" ? "ran coherently" : "did not run coherently"}; ${passedMissions}/${actorSpecs.length} reached their goal; overlap ${overlaps ? "proven" : "not observed"}; ${deltas} state delta(s) under load.`,
    gaps: dryRun
      ? ["Live concurrent shared-world session not yet run (dry-run contract only); the concurrency capability at scale is backed only by the deferred live receipt."]
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
    artifactRoot: path.join(".homun", "runs", args.runId),
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
