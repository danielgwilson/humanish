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
import { realpath } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { actorRegistry, isCuaActorDescriptor } from "../../actors/registry.js";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { describeMissingKeys } from "../../cli/key-resolution.js";
import { FakeInbox } from "../../comms/fake-inbox.js";
import { buildOriginMap, type OriginMap } from "../../comms/inbox.js";
import { prepareReceivingRun } from "../../comms/receiving-runtime.js";
import type { CommsReceivingRun } from "../../comms/receiving.js";
import {
  DEFAULT_SANDBOX_CATCH_PORT,
  collectCommsThread,
  collectExternalCommsThread,
  deployCommsCatch,
  externalCatchHealthy,
  externalInboxUrl,
  refreshInboxSurface,
  writeInboxSurface,
  type DeployedCommsCatch,
} from "../../comms/sandbox-catch.js";
import type { CommsAddress } from "../../comms/types.js";
import { redactText, scrubLiterals } from "../../evidence/redaction.js";
import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks,
} from "../../lab/adapter-extension.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { labPersonaIds, resolveCommittedPersonasForCwd } from "../../lab/persona-resolve.js";
import { scrubPersonaBrief } from "../../lab/persona.js";
import {
  concurrentSharedWorldValidationReason,
  desktopMediaValidationReason,
  externalPublicSharedWorldValidationReason,
  outputTokenLimitValidationReason,
  receivingEmailValidationReason,
  taskProtocolValidationReason,
} from "../../lab/validation.js";
import { liveObserverResult } from "../../observer/live.js";
import { attachObserverRuntimeStreamUrls, type ObserverResult } from "../../observer/render.js";
import type { ObserverRuntimeStreamUrl } from "../../observer/run-routes.js";
import {
  buildRunSource,
  type RunBundle,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
} from "../../run/bundle.js";
import { mapWithConcurrency } from "../../run/concurrency.js";
import { withTransientCommsSecrets } from "../../run/narration-secrets.js";
import { MODEL_RATES } from "../../run/pricing.js";
import { runScope, type RunScope } from "../../run/run.js";
import {
  prepareSelectedOutputDirectory,
  writeContainedOutputFile,
} from "../../run/selected-output-paths.js";
import type { SharedWorldStateSnapshot } from "../../run/shared-world-evidence.js";
import type { LocalTreeArchive } from "../../run/source-archive.js";
import { provisionCloneSubject } from "../../subject/clone.js";
import { provisionLocalTreeSubject } from "../../subject/local-tree.js";
import { commandDigestOf } from "../../subject/state.js";
import type { SubjectPhaseEvent } from "../../subject/steps.js";
import { toErrorMessage } from "../../substrates/command-failure.js";
import type { DetachedTimers } from "../../substrates/detached.js";
import {
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox,
} from "../../substrates/e2b/desktop-launch.js";
import { acquireE2BDesktopSandbox } from "../../substrates/e2b/sandbox.js";
import { e2bShell } from "../../substrates/e2b/shell.js";
import type { Shell } from "../../substrates/shell.js";
import {
  defaultPackLocalTree,
  inboxRecipientFor,
  laneHasInboxRecipient,
  resolveSubjectState,
} from "../computer-use/lab.js";
import { makeCuaRunBudget, withInboxMission } from "../computer-use/lane-plan.js";
import { runCuaLane } from "../computer-use/lanes.js";
import { startLiveTraceFlush, type LiveTraceFlush } from "../computer-use/live-flush.js";
import type {
  CuaActorLabHooks,
  CuaLaneDeps,
  CuaLaneSpec,
  LaneRunOutcome,
} from "../computer-use/types.js";
import {
  actorLanePassed,
  actorWindowsOverlap,
  buildConcurrentSharedWorldBundle,
  maxSimultaneousWindows,
  renderConcurrentReviewMarkdown,
} from "./bundle.js";
import { runCheckpointSnapshot, seedRecipeDigest } from "./checkpoints.js";
import {
  extractLobbyCode,
  extractLobbyCodeFromNarration,
  readLobbyCodeFromFrame,
} from "./lobby-code.js";
import {
  buildSubjectProvenance,
  hostOriginDigest,
  isTokenlessHost,
  servePort,
} from "./provenance.js";
import {
  DEFAULT_STATE_STEP_TIMEOUT_MS,
  SANDBOX_TIMEOUT_BUFFER_MS,
  SUBJECT_PROVISION_BUDGET_MS,
  buildActorSpec,
  defaultSeatSessionTimeoutMs,
  makeBlockedFollowerOutcome,
  resolveActorSeatUrl,
  withLobbyCodeMission,
} from "./seats.js";
import {
  CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
  CONCURRENT_SHARED_WORLD_PROVIDER_METADATA,
  type ActorLaneResult,
  type ConcurrentSharedWorldLabErrorCode,
  type ConcurrentSharedWorldLabResult,
  type ConcurrentSharedWorldPlaneClass,
  type ConcurrentSharedWorldRoleResult,
  type RunConcurrentSharedWorldLabOptions,
} from "./types.js";

const DEFAULT_PROBER_CADENCE_MS = 1000;

// The FLOOR for the host-first handoff barrier deadline (ms). The host seat must surface a
// shared-session (/lobby/CODE) URL within the deadline or the run fails closed and no follower
// opens. The effective deadline SCALES with the per-seat run budget (execution.timeoutMs): a fixed
// 2 min is too tight for a real create-a-lobby flow on a mobile-layout seat once you subtract the
// seat's own desktop provisioning — the host reaches /lobby/CODE, but after the followers already
// gave up. So use max(FLOOR, 40% of the budget), capped at the budget. The latch resolves the
// instant the host actually reaches /lobby, so a generous ceiling only affects the fail-closed case.
const DEFAULT_HANDOFF_DEADLINE_MS = 120_000;

const HANDOFF_DEADLINE_BUDGET_FRACTION = 0.4;

// Per-seat runaway backstop for the vision-off-frame lobby-code read (used by the host to LATCH the
// handoff code, and by each follower to independently OBSERVE its own code for the convergence proof):
// at most this many single-frame reads before the seat is assumed to be somewhere without a code. Each
// reader stops the instant it has what it needs, so in practice only a handful fire (a seat reaches its
// /lobby within a few turns). NOTE: these reads are out-of-band OpenAI calls (external-public route
// only) and are NOT counted against execution.caps.maxUsd — this hard cap is what bounds their spend
// instead (each read is one cheap single-frame OCR call). If this route ever runs under a strict
// budget, fold the estimate in.
const MAX_LOBBY_CODE_VISION_READS = 30;

// Idle/no-progress backstop for the HOST lane specifically (default is 6/8). The host legitimately sits
// on an unchanging waiting-room screen while followers provision and join; it must not give up first.
const HOST_WAIT_IDLE_STEPS = 80;

const FOLLOWER_WAIT_IDLE_STEPS = 40;

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
    resolve = (value: T) => {
      if (!done) {
        done = true;
        res(value);
      }
    };
    reject = (reason: unknown) => {
      if (!done) {
        done = true;
        rej(reason);
      }
    };
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

/**
 * A failure of the caller's `onObserverReady` gate on the provisioned plane. The gate runs inside
 * the try that records participant failures, so it is wrapped to be told apart and rethrown: a gate
 * failure stops the run before any participant starts, as it does on the other routes, and the
 * teardown in that try's finally still kills the subject.
 */
class ObserverGateError extends Error {
  constructor(cause: unknown) {
    super("onObserverReady failed", { cause });
    this.name = "ObserverGateError";
  }
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

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runConcurrentSharedWorld(
  options: RunConcurrentSharedWorldLabOptions,
): Promise<ConcurrentSharedWorldLabResult> {
  return withTransientCommsSecrets(() => runConcurrentSharedWorldWithSecrets(options));
}

async function runConcurrentSharedWorldWithSecrets(
  options: RunConcurrentSharedWorldLabOptions,
): Promise<ConcurrentSharedWorldLabResult> {
  const analysis = resolveAutomaticAnalysis(options.config.review?.analysis);
  const { result, finished } = await runScope((scope) =>
    runConcurrentSharedWorldInScope(options, scope),
  );
  return completeAutomaticAnalysis(
    result,
    finished,
    analysis.ok ? analysis.config : undefined,
    options.automaticAnalysis,
    options.config.review?.analysis === undefined ? "default" : "explicit",
    analysis.ok && analysis.preferLargerOutput === true,
  );
}

async function runConcurrentSharedWorldInScope(
  options: RunConcurrentSharedWorldLabOptions,
  scope: RunScope,
): Promise<ConcurrentSharedWorldLabResult> {
  const { config, dryRun } = options;
  const requestedCwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const actorType = config.actors[0]?.type ?? "";
  const roles = config.actors[0]?.lanes ?? [];
  // All-parallel default (#350): the parser fills concurrency for multi-seat labs, so this
  // fallback serves only library callers constructing configs directly — same meaning: every
  // declared seat runs at once unless the author declared a cap.
  const concurrency = config.execution?.concurrency ?? Math.max(1, roles.length);

  const fail = (
    code: ConcurrentSharedWorldLabErrorCode,
    message: string,
    actorLabel?: string,
  ): ConcurrentSharedWorldLabResult => ({
    schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
    ok: false,
    cwd: requestedCwd,
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
    error: { code, message },
  });

  const mediaReason = desktopMediaValidationReason(config, false);
  if (mediaReason) return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", mediaReason);

  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  if (!analysis.ok) return fail("HUMANISH_LAB_ANALYSIS_INVALID", analysis.message);
  const tasksReason = taskProtocolValidationReason(config, false);
  if (tasksReason) return fail("HUMANISH_LAB_TASKS_UNSUPPORTED", tasksReason);

  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail(
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered computer-use actor.`,
    );
  }

  // The PLANE-class discriminator (#164 phase 2): an app-url subject is the EXTERNAL-PUBLIC plane (a
  // real operator-owned public deployment used directly as the shared plane — NO getHost, clone,
  // subject sandbox, or seed); everything else is the historical provisioned-getHost plane.
  const planeClass: ConcurrentSharedWorldPlaneClass =
    config.subject.source === "app-url" ? "external-public" : "provisioned-getHost";

  // Re-enforce the cross-validation (library API surface). The external-public branch NEVER touches
  // the getHost synthetic gate — that gate exists because getHost is internet-reachable AND
  // harness-owned; a public site the harness neither provisioned nor exposed has neither property.
  const invalidReason =
    outputTokenLimitValidationReason(config) ??
    (planeClass === "external-public"
      ? externalPublicSharedWorldValidationReason(config)
      : concurrentSharedWorldValidationReason(config));
  if (invalidReason) {
    return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", invalidReason, descriptor.id);
  }
  if (config.actors[0]?.maxOutputTokens !== undefined && hooks.runSession) {
    return fail(
      "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID",
      "maxOutputTokens cannot be enforced by a custom runSession.",
      descriptor.id,
    );
  }

  const caps = config.execution?.caps;
  if (!dryRun && (caps?.maxUsd !== undefined || caps?.maxTotalUsd !== undefined)) {
    const model = (config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL).trim().toLowerCase();
    if (!MODEL_RATES[model]) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID",
        `The declared spend cap cannot be enforced for unpriced model "${model}".`,
        descriptor.id,
      );
    }
  }
  const runBudget =
    !dryRun && caps?.maxTotalUsd !== undefined ? makeCuaRunBudget(caps.maxTotalUsd) : undefined;

  // provisioned-getHost fields (all absent on the external-public plane — forbidden at validation).
  const serve = config.subject.serve;
  const localTreeRoute = config.subject.source === "local-tree";
  const subjectRepo = config.subject.repos?.[0] ?? "";
  const subjectEnvNames = config.subject.env ?? [];
  const checkpoints = config.subject.state?.checkpoint ?? [];
  const runSession = hooks.runSession ?? descriptor.runSession;
  // The per-seat vision lobby-code reader (default: the real single-frame OpenAI read). Injectable so the
  // barrier's handoff + convergence proof are testable without a live vision call.
  const readLobbyCode = hooks.readLobbyCodeFromFrame ?? readLobbyCodeFromFrame;

  const receivingReason = receivingEmailValidationReason(config);
  if (receivingReason)
    return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", receivingReason, descriptor.id);
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? ""),
    ...checkpoints.flatMap((probe) => probe.redact ?? []),
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = scrubLiterals(knownSecretValues);

  const redactRepoLabel = config.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo = redactRepoLabel ? "repo-01" : subjectRepo;
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");

  if (!dryRun) {
    const missingKeys = [
      ...(openaiApiKey ? [] : ["OPENAI_API_KEY"]),
      ...(e2bApiKey ? [] : ["E2B_API_KEY"]),
    ];
    if (missingKeys.length > 0) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING",
        `Live concurrent shared-world labs need ${missingKeys.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missingKeys, env)}`,
        descriptor.id,
      );
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING",
        `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
        descriptor.id,
      );
    }
  }

  // Bind the physical project before the run starts, as the computer-use route does. Everything
  // below (run storage, source and persona reads, local-tree packing, comms, the Observer) uses it,
  // so retargeting a symlinked cwd from a hook cannot redirect any of it into another project.
  const physicalCwd = await realpath(requestedCwd);
  const cwd = (await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd))
    .physicalPath;
  const started = await scope.startRun({
    cwd,
    runId: options.runId,
    mintRunId: makeRunId,
    mode: dryRun ? "dry-run" : "live",
    lab: options.lab,
    renderReview: renderConcurrentReviewMarkdown,
    observer: { open: options.open === true, render: hooks.renderObserverFn },
  });
  if (!started.ok) return fail(started.code, started.message, descriptor.id);
  const { run } = started;
  const { runId, createdAt, paths: runPaths } = run;
  const artifactRoot = runPaths.absoluteRunRoot;
  const physicalArtifactRoot = runPaths.physicalRunRoot;
  const timeoutMs = config.execution?.timeoutMs ?? defaultSeatSessionTimeoutMs(config);
  const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;
  const timers: DetachedTimers = hooks.detachedTimers ?? {};
  const now = hooks.now ?? Date.now;
  const proberCadenceMs = hooks.proberCadenceMs ?? DEFAULT_PROBER_CADENCE_MS;
  const seedDigest = seedRecipeDigest(config);

  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  const warnings: string[] = [];
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  const stateSnapshots: SharedWorldStateSnapshot[] = [];
  // Compile committed personas so each seat's prompt carries real behavioral directives (#381).
  const personaResolution = await resolveCommittedPersonasForCwd(cwd, labPersonaIds(config));
  const actorSpecs = roles.map((role, i) =>
    buildActorSpec(config, role, i, personaResolution.personas),
  );
  for (const spec of actorSpecs) {
    if (spec.assignment) spec.assignment = participantAssignment(spec.assignment, scrubKnownValues);
    spec.evidenceInstructions = redactText(scrubKnownValues(spec.instructions));
    spec.persona = scrubPersonaBrief(spec.persona, scrubKnownValues);
  }
  let actorResults: ActorLaneResult[] = [];
  let subjectCommit: string | undefined;
  let subjectSandboxId: string | undefined;
  let subjectKilled = false;
  let getHostUrl: string | undefined;
  // Persona inbox SURFACE (#297 slice B, shared-world): the getHost-exposed inbox URL a persona (in a
  // DIFFERENT sandbox) opens, the serve->getHost origin-rewrite map (REQUIRED here so the app's loopback
  // verify links resolve to a reachable host), and the dedicated surface channel + render loop.
  let commsInboxUrl: string | undefined;
  let commsOriginMap: OriginMap = [];
  let surfaceRenderedCount = 0;
  let surfaceLoop: Promise<void> | undefined;
  let runError: string | undefined;
  let snapshotIndex = 0;
  let liveObserver: (ObserverResult & { ok: true }) | undefined;
  const runtimeStreamUrls: ObserverRuntimeStreamUrl[] = [];
  // A live run publishes an in-progress bundle before its seats start, whether or not an Observer
  // is attached, and the seats' live traces rewrite it as they go, as on the computer-use route. A
  // run killed mid-way leaves that evidence on disk. The flush starts with the first snapshot.
  let liveFlush: LiveTraceFlush | undefined;
  const startSeatFlush = (bundle: RunBundle): void => {
    liveFlush = startLiveTraceFlush({
      bundle,
      laneSpecs: actorSpecs,
      model: config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL,
      write: (snapshot) => run.writeSnapshot(snapshot),
    });
  };

  // Off-app comms (#297): on the provisioned-getHost plane the harness owns the ONE subject sandbox, so
  // it can redirect the app's email-API sends into an in-sandbox catch and evidence them. Gated ENTIRELY
  // on config.comms — no comms declared → zero change. The base-URL env is injected into the subject
  // sandbox at create (fixed port known up front); the catch is deployed before serve; the drain + digest
  // evidence run at subject teardown, then register run-level in the bundle. NOT available on the
  // external-public plane (the app is an operator-owned deployment the harness never provisions).
  const commsEmail =
    planeClass === "provisioned-getHost" && config.comms?.email?.kind === "fake"
      ? config.comms.email
      : undefined;
  const commsPort = commsEmail ? (commsEmail.port ?? DEFAULT_SANDBOX_CATCH_PORT) : undefined;
  // injectEnv is absent on an adopter-hosted plane (#328): there is no subject env to inject
  // because the operator points their own app at their own catch.
  const commsEnv: Record<string, string> =
    commsEmail?.injectEnv !== undefined && commsPort !== undefined
      ? { [commsEmail.injectEnv]: `http://127.0.0.1:${commsPort}` }
      : {};
  let commsArtifactPath: string | undefined;
  // ADOPTER-HOSTED ingress (#328): on the external-public plane the harness provisions nothing, so
  // it cannot host a catch — but the OPERATOR can, and then humanish still does every other part of
  // the funnel: it tells each persona its address and inbox URL, drains the declared catch over
  // HTTP at teardown, and writes the same digest-only evidence. Declaring `external` is what turns
  // the previously-inert block into a working one.
  const externalComms =
    planeClass === "external-public" ? config.comms?.email?.external : undefined;
  const externalCommsEmail = externalComms ? config.comms?.email : undefined;
  if (
    config.comms?.email?.kind === "fake" &&
    planeClass === "external-public" &&
    externalComms === undefined
  ) {
    warnings.push(
      "comms.email is declared but this is the external-public plane (the shared plane is an operator-owned public deployment the harness does not provision) — the in-sandbox email catch cannot be deployed and no comms evidence is collected. Declare `comms.email.external` to host the catch yourself (#328).",
    );
  }

  if (externalComms) {
    commsInboxUrl = externalInboxUrl(externalComms);
    // Fail closed BEFORE any actor sandbox is created: a comms lab whose catch is unreachable
    // collects nothing while every lane still spends. The probe asserts OUR service marker in
    // /health, so an adopter's proxy answering 200 for everything cannot pass for a catch.
    if (!dryRun && !(await externalCatchHealthy(externalComms))) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_CATCH_UNREACHABLE",
        `The external comms catch or inbox is unreachable or incompatible (GET /health must identify humanish-comms-catch and advertise recipient-inbox-v1). Update Humanish on the catch host and restart it with \`humanish comms catch\` on that host, or drop comms.email to run without the inbox funnel.`,
      );
    }
  }

  // EXTERNAL-PUBLIC plane state (#164 phase 2). publicAppUrl is the operator-declared shared plane;
  // its ORIGIN is persisted digest-only (publicOriginDigest), never raw (the raw URL + the runtime
  // observed lobby CODE never land — TENSION 3). The latch code is scrubbed from all narration.
  const publicAppUrl = config.subject.appUrl ?? "";
  // The operator-DECLARED origin (from subject.appUrl) — recorded for evidence/reference ONLY. The
  // operator-OWNERSHIP claim rests on the subject.publicTarget.authorized attestation + this declared
  // appUrl, NOT on digest equality (blocker 2): a normal cross-origin redirect (apex->www, http->https;
  // lobby-trivia.example.test 307-redirects) makes the seats' OBSERVED origin differ from the declared one, which
  // is expected and MUST NOT fail the run. Persisted digest-only (never the raw origin).
  const declaredOriginDigest =
    planeClass === "external-public" && publicAppUrl ? hostOriginDigest(publicAppUrl) : undefined;
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
  let hostHandoffFailure: string | undefined;
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
  // (mirrors the cua route's ordering): a packing failure fails the run
  // closed here, never spending sandbox cost. Dry-run packs nothing.
  let localTreeArchive: LocalTreeArchive | undefined;
  let localTreeArchiveBuffer: ArrayBuffer | undefined;
  if (localTreeRoute && !dryRun) {
    const packLocalTree = hooks.packLocalTree ?? defaultPackLocalTree;
    try {
      const packed = await packLocalTree({
        root: cwd,
        ...(config.subject.localTree?.exclude === undefined
          ? {}
          : { extraExclude: config.subject.localTree.exclude }),
        ...(config.subject.localTree?.maxArchiveBytes === undefined
          ? {}
          : { maxArchiveBytes: config.subject.localTree.maxArchiveBytes }),
      });
      localTreeArchive = packed.archive;
      localTreeArchiveBuffer = packed.buffer;
      process.stderr.write(
        `humanish concurrent shared-world local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}` +
          `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`,
      );
    } catch (error) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id,
      );
    }
  }

  let receiving: CommsReceivingRun | undefined;
  if (!dryRun && config.comms?.email?.kind === "real") {
    try {
      receiving = await prepareReceivingRun({
        cwd,
        runId,
        config,
        env,
        participants: actorSpecs.map((spec) => spec.laneId),
        runPaths,
        registerSecrets: (values) => {
          for (const value of values)
            if (value.length >= 4 && !knownSecretValues.includes(value))
              knownSecretValues.push(value);
        },
      });
      commsArtifactPath = "comms/receiving.json";
    } catch {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID",
        "Real email setup failed before desktop allocation. Run humanish comms check --online and humanish comms recover to inspect authentication and pending cleanup.",
        descriptor.id,
      );
    }
  }
  try {
    if (!dryRun && planeClass === "provisioned-getHost") {
      if (!serve) {
        // Defense-in-depth: concurrentSharedWorldValidationReason already required serve above.
        return fail(
          "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID",
          "the provisioned-getHost concurrent shared-world route requires `subject.serve`.",
          descriptor.id,
        );
      }
      let subjectModule: E2BDesktopModule | undefined;
      let subjectDesktop: E2BDesktopSandbox | undefined;
      let subjectShell: Shell | undefined;
      // The in-sandbox email catch on the ONE subject sandbox (#297); drained at teardown. Undefined
      // unless a comms lab declared it. Hoisted so the finally can drain before the subject is killed.
      let deployedComms: DeployedCommsCatch | undefined;
      // Background prober dispose signal (FIX-9: cleared in finally).
      let proberDisposed = false;
      let releaseDispose: () => void = () => {};
      const disposeSignal = new Promise<void>((resolve) => {
        releaseDispose = resolve;
      });
      let proberLoop: Promise<void> | undefined;

      const proberSnapshot = async (): Promise<void> => {
        if (!subjectShell) return;
        const timestamp = now();
        const idx = snapshotIndex;
        snapshotIndex += 1;
        const snapshot = await runCheckpointSnapshot({
          shell: subjectShell,
          snapshotIndex: idx,
          name: `state-${idx}`,
          checkpoints,
          prevDigest: undefined,
          scrub: scrubKnownValues,
          requestTimeoutMs,
          timers,
        });
        stateSnapshots.push({ timestamp, digest: snapshot.digest });
      };

      try {
        subjectModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
        // The ONE subject sandbox: headless service host (no GUI seat). The SUBJECT env is provisioned
        // HERE; the actor sandboxes get NONE of it (FIX-10). A custom desktop template (image) is
        // honored on BOTH the subject sandbox (here) and every actor sandbox (via runCuaLane, which
        // reads the same config); absent keeps the byte-stable Sandbox.create(opts) default. The
        // receipt is on disk before any work, so `humanish reclaim` can kill it by exact id.
        const subject = await acquireE2BDesktopSandbox({
          module: subjectModule,
          options: {
            apiKey: e2bApiKey,
            requestTimeoutMs,
            timeoutMs:
              timeoutMs +
              SUBJECT_PROVISION_BUDGET_MS +
              (config.subject.state?.seed ?? []).reduce(
                (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
                0,
              ) +
              SANDBOX_TIMEOUT_BUFFER_MS,
            metadata: {
              ...CONCURRENT_SHARED_WORLD_PROVIDER_METADATA,
              labId: config.id,
              topology: "shared-world",
              topologyMode: "concurrent",
              role: "subject",
              roleCount: String(roles.length),
            },
            ...(subjectEnvNames.length > 0 || Object.keys(commsEnv).length > 0
              ? {
                  envs: {
                    ...Object.fromEntries(
                      subjectEnvNames.map((name) => [name, env[name] as string]),
                    ),
                    ...commsEnv,
                  },
                }
              : {}),
            dpi: 96,
            lifecycle: { onTimeout: "kill" },
          },
          template: config.execution?.desktop?.template,
          receipt: { root: runPaths, laneId: "subject" },
        });
        subjectDesktop = subject.sandbox;
        subjectShell = e2bShell(subjectDesktop);
        subjectSandboxId = subject.allocation.resourceId;

        if (hooks.prepareDesktop) {
          await hooks.prepareDesktop(subjectDesktop);
        }

        // Start the in-sandbox email catch BEFORE the subject serve, so the app's send-API base URL
        // (injected into its env at create) resolves the moment it boots. Fail closed if the catch can't
        // stand up rather than let a comms-declared app silently send real mail to the internet.
        if (commsEmail && commsPort !== undefined) {
          // A SECOND (0.0.0.0) read-only inbox listener on commsPort+1 so the persona — which lives in a
          // DIFFERENT sandbox here — can reach the inbox surface via getHost; capture stays loopback.
          deployedComms = await deployCommsCatch(subjectShell, {
            port: commsPort,
            inboxPort: commsPort + 1,
            requestTimeoutMs,
            timers,
          });
          if (!deployedComms.ready) {
            throw new Error(
              `comms email catch did not become ready in the subject sandbox (loopback capture ${commsPort} / inbox ${commsPort + 1})`,
            );
          }
        }

        // Provision the ONE shared plane: clone + install/build + seed + serve on 0.0.0.0 + probe
        // (clone route), or upload/extract the once-per-run packed archive + the SAME shared serve
        // pipeline (local-tree route).
        const onSubjectPhase =
          hooks.onPhase ??
          ((event: SubjectPhaseEvent) => {
            process.stderr.write(
              `humanish shared-world (concurrent): ${event.message}${event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`}\n`,
            );
          });
        if (localTreeRoute) {
          await provisionLocalTreeSubject(subjectShell, {
            archiveBuffer: localTreeArchiveBuffer!,
            serve,
            ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
            requestTimeoutMs,
            scrub: scrubKnownValues,
            onStateStep: (record) => {
              stateStepRecords.push(record);
            },
            onPhase: onSubjectPhase,
            ...timers,
          });
        } else {
          subjectCommit = await provisionCloneSubject(subjectShell, {
            repo: subjectRepo,
            depth: config.subject.clone?.depth ?? 1,
            serve,
            ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
            hasGithubToken,
            requestTimeoutMs,
            scrub: scrubKnownValues,
            onCommit: (commit) => {
              subjectCommit = commit;
            },
            onStateStep: (record) => {
              stateStepRecords.push(record);
            },
            onPhase: onSubjectPhase,
            ...timers,
          });
        }

        // Expose the served port via getHost (FIX-2). Fail closed if the SDK lacks it.
        if (typeof subjectDesktop.getHost !== "function") {
          throw new Error(
            "the installed @e2b/desktop SDK does not expose getHost(port); the concurrent shared-world route requires it to reach the subject plane",
          );
        }
        // getHost returns a BARE host (e.g. "3000-<sandboxId>.e2b.app", no scheme); e2b exposes the
        // port over https. Normalize to a full URL before the tokenless check + before persisting.
        const rawHost = subjectDesktop.getHost(servePort(serve.url));
        const hostUrl = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
        if (!isTokenlessHost(hostUrl)) {
          throw new Error(
            "getHost returned a non-tokenless URL; refusing to persist a host URL that may carry a credential (invariant 1)",
          );
        }
        getHostUrl = hostUrl;

        // Persona inbox SURFACE (#297 slice B, shared-world): getHost-expose the read-only inbox listener so
        // a persona in a DIFFERENT sandbox can open it; build the serve->getHost origin map (REQUIRED here —
        // the app's loopback verify links must be rewritten to a reachable host); provision the surface
        // channel; write the EMPTY inbox up front (so /inbox never 404s); and start a render loop that drains
        // + re-renders on a cadence. The loop shares the prober's dispose signal (disposed together, before
        // the teardown evidence drain), and uses a DEDICATED FakeInbox + cursor (independent of that drain).
        if (commsEmail && deployedComms?.inboxPort !== undefined) {
          const rawInboxHost = subjectDesktop.getHost(deployedComms.inboxPort);
          const inboxHostUrl = /^https?:\/\//i.test(rawInboxHost)
            ? rawInboxHost
            : `https://${rawInboxHost}`;
          if (!isTokenlessHost(inboxHostUrl)) {
            throw new Error(
              "getHost returned a non-tokenless URL for the comms inbox; refusing to advertise it (invariant 1)",
            );
          }
          commsInboxUrl = `${inboxHostUrl}/inbox`;
          commsOriginMap = buildOriginMap({
            internalServeUrl: serve.url,
            reachableBaseUrl: getHostUrl,
            ...(commsEmail.linkOrigin === undefined ? {} : { linkOrigin: commsEmail.linkOrigin }),
          });
          const surfaceRecipients = (commsEmail.recipients ?? [])
            .filter(
              (recipient): recipient is { lane: string; address: string } =>
                recipient.address !== undefined,
            )
            .map((recipient) => ({ lane: recipient.lane, address: recipient.address }));
          await writeInboxSurface(subjectShell, deployedComms.surfaceDir, [], {
            originMap: commsOriginMap,
            requestTimeoutMs,
          });
          const surfaceDeployed = deployedComms;
          const surfaceCadenceMs = 2500;
          surfaceLoop = (async () => {
            // Full, idempotent rebuild each tick; surfaceRenderedCount advances only on a successful render,
            // so a transient failure retries cleanly. Real timer (dispose-interruptible + cleared) — an
            // unbounded loop must not busy-spin on the injected instant clock.
            for (;;) {
              try {
                const refreshed = await refreshInboxSurface({
                  shell: subjectShell!,
                  deployed: surfaceDeployed,
                  recipients: surfaceRecipients,
                  sinceCount: surfaceRenderedCount,
                  originMap: commsOriginMap,
                  requestTimeoutMs,
                });
                if (refreshed.rendered) surfaceRenderedCount = refreshed.count;
              } catch {
                // Never throw into the render loop; the teardown drain + by-id teardown must still run.
              }
              if (proberDisposed) break;
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, surfaceCadenceMs);
                void disposeSignal.then(() => {
                  clearTimeout(timer);
                  resolve();
                });
              });
              if (proberDisposed) break;
            }
          })();
        }

        // Baseline state snapshot, then start the background cadence prober.
        await proberSnapshot();
        const inProgressPlaneCommit = localTreeRoute
          ? localTreeArchive?.git?.commit
          : subjectCommit;
        const inProgressSubject = buildSubjectProvenance({
          localTreeRoute,
          publicRepo,
          subjectCommit: inProgressPlaneCommit,
          localTreeArchive,
          subjectEnvNames,
          state: resolveSubjectState({
            declared: config.subject.state,
            dryRun: false,
            executed: stateStepRecords,
          }),
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
          hostDigest: hostOriginDigest(getHostUrl!),
        });
        await run.writeSnapshot(inProgressBundle);
        if (options.onObserverReady) {
          liveObserver = liveObserverResult(cwd, runId, artifactRoot, [
            "Live concurrent shared-world Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted.",
          ]);
          try {
            await options.onObserverReady(liveObserver);
          } catch (error) {
            throw new ObserverGateError(error);
          }
        }
        startSeatFlush(inProgressBundle);
        proberLoop = (async () => {
          while (!proberDisposed) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, proberCadenceMs);
              }),
              disposeSignal,
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
          ...(hooks.prepareDesktop
            ? { prepareDesktop: (desktop: E2BDesktopSandbox) => hooks.prepareDesktop!(desktop) }
            : {}),
          onRuntimeStreamReady: (stream) => {
            runtimeStreamUrls.push({ streamId: stream.streamId, url: stream.url });
            if (liveObserver) {
              attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
            }
          },
          onRuntimeStreamEnded: (stream) => {
            // Mark, never remove (#357): the tile falls back to recorded evidence and says why.
            for (const entry of runtimeStreamUrls) {
              if (entry.streamId === stream.streamId) entry.ended = true;
            }
            if (liveObserver) {
              attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
            }
          },
        };
        const baseActorDeps: Omit<CuaLaneDeps, "signalProvisioned" | "appUrl"> = {
          onTrace: (laneId, items, usage, metadata) =>
            liveFlush?.flush(laneId, items, usage, metadata),
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
          labCwd: cwd,
          redactScreenshots,
          scrubKnownValues,
          runSession,
          ...(receiving ? { receiving } : {}),
          now,
          hooks: cuaHooks,
          ...(runBudget === undefined ? {} : { runBudget }),
          // Concurrent lanes are independent evidence seats: a requested-vs-verified screen
          // mismatch is recorded as separate facts + a warning instead of failing the lane's
          // device claim closed, so one seat's window-manager drift cannot abort the whole
          // live multi-actor world (the single-lane/fan-out routes keep fail-closed).
          screenMismatchPolicy: "record-evidence",
        };

        actorResults = await mapWithConcurrency(
          actorSpecs,
          Math.max(1, concurrency),
          async (spec, i) => {
            const route = resolveActorSeatUrl(getHostUrl!, roles[i]?.entry);
            // Tell this persona its (getHost-reachable) inbox URL — but only when comms is live AND this lane
            // has a declared recipient it can actually receive mail into (else it would stall on an empty
            // inbox). Only the in-sandbox catch exists on this plane; the adopter-hosted catch is the
            // external-public plane's, wired in ITS execution block below (#387).
            const laneSpec =
              commsEmail && commsInboxUrl && laneHasInboxRecipient(commsEmail, spec.laneId)
                ? withInboxMission(
                    spec,
                    commsInboxUrl,
                    inboxRecipientFor(commsEmail, spec.laneId)?.address,
                  )
                : spec;
            const startedAt = now();
            const outcome = await runCuaLane(laneSpec, { ...baseActorDeps, appUrl: route });
            const endedAt = now();
            return { spec, outcome, startedAt, endedAt, route };
          },
        );
      } catch (error) {
        if (error instanceof ObserverGateError) throw error.cause;
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
        // Stop the inbox-surface render loop too (shares the prober's dispose signal), before the teardown
        // evidence drain below — so the two in-sandbox reads never overlap and the surface state is final.
        if (surfaceLoop) {
          await surfaceLoop.catch(() => undefined);
        }
        if (subjectDesktop && getHostUrl) {
          await proberSnapshot().catch(() => undefined);
        }
        // Off-app comms evidence (#297): drain everything the in-sandbox catch captured, route it into a
        // host fake inbox addressed to the declared recipients, and write the run-level digest-only thread
        // artifact — while the subject is STILL alive, before it is killed below. Wrapped so a drain error
        // never blocks teardown (invariant: all sandboxes torn down by id in this finally).
        if (commsEmail && deployedComms?.ready && subjectShell) {
          try {
            const commsChannel = new FakeInbox();
            const commsInboxes: CommsAddress[] = [];
            for (const recipient of commsEmail.recipients ?? []) {
              if (recipient.address !== undefined) {
                commsInboxes.push(
                  await commsChannel.provisionAddress(recipient.lane, recipient.address),
                );
              }
            }
            const collected = await collectCommsThread({
              shell: subjectShell,
              deployed: deployedComms,
              channel: commsChannel,
              inboxes: commsInboxes,
              requestTimeoutMs,
            });
            if (collected.artifact) {
              await writeContainedOutputFile(
                runPaths,
                "comms/thread.json",
                `${JSON.stringify(collected.artifact, null, 2)}\n`,
                "utf8",
              );
              commsArtifactPath = "comms/thread.json";
            } else if (collected.captured > 0) {
              warnings.push(
                `Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`,
              );
            } else {
              // Zero captures is the silent-broken shape (#351): the app never posted to the catch.
              warnings.push(
                `Comms catch captured ZERO email sends — the app never delivered mail through the catch. Verify the app reads ${commsEmail.injectEnv} for its email API base URL (an SDK that ignores it sends real mail or throws) and that the flow reached an email step.`,
              );
            }
          } catch (error) {
            warnings.push(
              `Comms evidence collection failed (run continues; subject still torn down): ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
            );
          }
        }
        if (subjectSandboxId !== undefined && subjectModule) {
          if (typeof subjectModule.Sandbox.kill === "function") {
            try {
              await subjectModule.Sandbox.kill(subjectSandboxId, {
                requestTimeoutMs: 60_000,
              });
              subjectKilled = true;
            } catch (error) {
              warnings.push(
                `Subject sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
              );
            }
          } else {
            warnings.push(
              "Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the subject sandbox.",
            );
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
        ...(hooks.prepareDesktop
          ? { prepareDesktop: (desktop: E2BDesktopSandbox) => hooks.prepareDesktop!(desktop) }
          : {}),
        onRuntimeStreamReady: (stream) => {
          runtimeStreamUrls.push({ streamId: stream.streamId, url: stream.url });
          if (liveObserver) {
            attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
          }
        },
        onRuntimeStreamEnded: (stream) => {
          // Mark, never remove (#357): the tile falls back to recorded evidence and says why.
          for (const entry of runtimeStreamUrls) {
            if (entry.streamId === stream.streamId) entry.ended = true;
          }
          if (liveObserver) {
            attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
          }
        },
      };
      const baseActorDeps: Omit<CuaLaneDeps, "signalProvisioned" | "appUrl" | "onObservedUrl"> = {
        onTrace: (laneId, items, usage, metadata) =>
          liveFlush?.flush(laneId, items, usage, metadata),
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
        labCwd: cwd,
        redactScreenshots,
        // Scrub the latched lobby CODE (known once the host resolves it) from ALL narration.
        scrubKnownValues: scrubKnownValuesWithLobbyCode,
        runSession,
        ...(receiving ? { receiving } : {}),
        now,
        hooks: cuaHooks,
        ...(runBudget === undefined ? {} : { runBudget }),
        screenMismatchPolicy: "record-evidence",
      };

      // Publish the in-progress bundle and attach any live Observer before fan-out, as on the
      // provisioned path.
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
        ...(declaredOriginDigest === undefined ? {} : { declaredOriginDigest }),
      });
      await run.writeSnapshot(inProgressBundle);
      if (options.onObserverReady) {
        liveObserver = liveObserverResult(cwd, runId, artifactRoot, [
          "Live external-public concurrent shared-world Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted.",
        ]);
        await options.onObserverReady(liveObserver);
      }
      startSeatFlush(inProgressBundle);

      // The host-first handoff barrier.
      //
      // TEMPORARY SHIM (tracked by #296): this CDP URL-relay handoff — reading the host's /lobby/CODE off
      // its own browser and threading it into the follower missions — is a temporary coordination shim.
      // It is to be augmented/replaced by the actor message bus (fake SMS/email invite) in #297: the
      // human-realistic version is the HOST SENDING the invite link and followers RECEIVING and tapping
      // it, rather than the orchestrator relaying the code out-of-band.
      const lobbyCodeLatch = deferred<string>();
      const handoffDeadlineMs =
        hooks.handoffDeadlineMs ??
        Math.min(
          timeoutMs,
          Math.max(
            DEFAULT_HANDOFF_DEADLINE_MS,
            Math.floor(timeoutMs * HANDOFF_DEADLINE_BUDGET_FRACTION),
          ),
        );
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new HandoffTimeoutError(handoffDeadlineMs)),
          handoffDeadlineMs,
        );
      });
      deadline.catch(() => undefined); // never an unhandled rejection

      // Resolve the host->follower handoff latch from WHICHEVER path sees the code first (CDP url-read,
      // host narration, or vision-off-frame). Idempotent: only the first code wins, and it is also stashed
      // as latchedLobbyCode so it gets scrubbed from any later narration. The latched code and observed URLs
      // are runtime-only and land in persisted METADATA only as digests (origin + convergence). (The code
      // is a shareable game code, not a secret, and it still renders in the host's screenshots, which are
      // full-fidelity unless redactScreenshots is set — the digesting is about narration/URL metadata.)
      const latchLobbyCode = (code: string, laneIndex: number): void => {
        if (latchedLobbyCode !== undefined) return;
        observedLobbyCodes[laneIndex] = code;
        latchedLobbyCode = code;
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        lobbyCodeLatch.resolve(code);
      };

      // Build an onScreenshot handler that vision-reads the lobby code off THIS seat's own frame (the
      // CDP-independent observation). `done()` short-circuits once this seat has what it needs (the host
      // once latched; a follower once it has recorded its own observed code), `onCode` records/latches the
      // result. One read in flight at a time, bounded by MAX_LOBBY_CODE_VISION_READS so a seat that never
      // reaches a lobby can't rack up unbounded calls (fire-and-forget; the loop never awaits it).
      const makeLobbyCodeVisionReader = (
        done: () => boolean,
        onCode: (code: string) => void,
      ): ((frame: Buffer) => void) => {
        let inFlight = false;
        let reads = 0;
        return (frame: Buffer): void => {
          if (done() || inFlight || reads >= MAX_LOBBY_CODE_VISION_READS) return;
          inFlight = true;
          reads += 1;
          void readLobbyCode(frame, openaiApiKey)
            .then((code) => {
              if (code !== undefined && !done()) onCode(code);
            })
            .catch(() => undefined)
            .finally(() => {
              inFlight = false;
            });
        };
      };

      const makeLaneObservedUrl =
        (laneIndex: number, isHost: boolean) =>
        (url: string | undefined): void => {
          if (typeof url !== "string" || url.length === 0) return;
          observedFinalUrls[laneIndex] = url; // runtime-only; digested to origin, never persisted raw
          const code = extractLobbyCode(url);
          if (code !== undefined) {
            observedLobbyCodes[laneIndex] = code;
            if (isHost) latchLobbyCode(code, laneIndex);
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
      const runHostLane = async (
        spec: CuaLaneSpec,
        laneIndex: number,
      ): Promise<ActorLaneResult> => {
        const onObservedUrl = makeLaneObservedUrl(laneIndex, true);
        // CDP-INDEPENDENT handoff paths (the E2B-desktop CDP url-read the onObservedUrl path relies on is
        // unreliable in practice). Two backups, both resolving the SAME latch; whichever sees the code first
        // wins, all digest-only:
        //   (1) onMessage — scan the host's own narration IF it happens to state the lobby URL; and
        //   (2) onScreenshot — vision-read the code straight off the host's waiting-room frame. This is the
        //       robust one: the code is rendered on screen even when CDP fails AND when the host never
        //       narrates it, and — crucially — the host is NOT asked to announce anything, so it keeps
        //       running (create -> wait for players -> Start -> play) instead of ending on a stray message.
        const onMessage = (text: string): void => {
          if (latchedLobbyCode !== undefined) return;
          const code = extractLobbyCodeFromNarration(text);
          if (code !== undefined) latchLobbyCode(code, laneIndex);
        };
        // Vision-read the host's waiting-room frame and LATCH the code for the followers (stops once latched).
        const onScreenshot = makeLobbyCodeVisionReader(
          () => latchedLobbyCode !== undefined,
          (code) => latchLobbyCode(code, laneIndex),
        );
        // The host's job includes a long LEGITIMATE idle wait — sitting in the waiting room while the
        // followers provision their own desktops and walk the Join flow (easily 15-30 turns of an
        // unchanging "waiting for players" screen). At the default idle backstop (6) the host would give up
        // before anyone arrives, orphaning the lobby (exactly the earlier failure). Raise the host's idle /
        // no-progress tolerance so it waits patiently; the per-seat timeout still bounds a truly stuck host.
        // Adopter-hosted inbox (#387): the persona is told its address and inbox URL on THIS plane —
        // previously only the provisioned plane's seats ever got the instruction, so external comms
        // ran on no route at all.
        const hostInboxSpec =
          externalCommsEmail &&
          commsInboxUrl &&
          laneHasInboxRecipient(externalCommsEmail, spec.laneId)
            ? withInboxMission(
                spec,
                commsInboxUrl,
                inboxRecipientFor(externalCommsEmail, spec.laneId)?.address,
              )
            : spec;
        const hostSpec: CuaLaneSpec = {
          ...hostInboxSpec,
          idleSteps: spec.idleSteps ?? HOST_WAIT_IDLE_STEPS,
          noProgressSteps: spec.noProgressSteps ?? HOST_WAIT_IDLE_STEPS,
        };
        const startedAt = now();
        let outcome: LaneRunOutcome | undefined;
        try {
          outcome = await runCuaLane(hostSpec, {
            ...baseActorDeps,
            appUrl: publicAppUrl,
            onObservedUrl,
            onMessage,
            onScreenshot,
          });
        } finally {
          // If the host finished without ever surfacing a code, release followers to fail closed
          // immediately rather than wait the full deadline (a no-op if it already resolved).
          if (!lobbyCodeLatch.settled()) {
            const reason =
              outcome?.sessionError ??
              outcome?.session?.reason ??
              "no terminal host outcome was recorded";
            hostHandoffFailure = scrubKnownValuesWithLobbyCode(
              `Host seat ended before producing a lobby URL: ${reason}`,
            );
            lobbyCodeLatch.reject(new Error(hostHandoffFailure));
          }
        }
        const endedAt = now();
        return {
          spec,
          outcome,
          startedAt,
          endedAt,
          route: observedFinalUrls[laneIndex] ?? publicAppUrl,
        };
      };
      const runFollowerLane = async (
        spec: CuaLaneSpec,
        laneIndex: number,
      ): Promise<ActorLaneResult> => {
        const onObservedUrl = makeLaneObservedUrl(laneIndex, false);
        // FOLLOWER: do NOT compose a mission or open the target until the host yields a lobby code.
        let code: string;
        try {
          code = await Promise.race([lobbyCodeLatch.promise, deadline]);
        } catch (error) {
          // An ended host is not a deadline expiry. Preserve its actual failure.
          const timedOut = error instanceof HandoffTimeoutError;
          handoffTimedOut ||= timedOut;
          const reason = scrubKnownValuesWithLobbyCode(toErrorMessage(error));
          const at = now();
          return {
            spec,
            outcome: makeBlockedFollowerOutcome(spec, reason, timedOut),
            startedAt: at,
            endedAt: at,
            route: publicAppUrl,
          };
        }
        // Followers also idle-wait — in the waiting room until the host starts, and between rounds. Raise
        // their idle backstop too (less than the host's: they wait less), so a follower that joins ahead of
        // the other does not give up before the game begins. Per-seat timeout still bounds a stuck follower.
        const followerInboxSpec =
          externalCommsEmail &&
          commsInboxUrl &&
          laneHasInboxRecipient(externalCommsEmail, spec.laneId)
            ? withInboxMission(
                spec,
                commsInboxUrl,
                inboxRecipientFor(externalCommsEmail, spec.laneId)?.address,
              )
            : spec;
        const followerSpec: CuaLaneSpec = {
          ...withLobbyCodeMission(followerInboxSpec, code),
          idleSteps: spec.idleSteps ?? FOLLOWER_WAIT_IDLE_STEPS,
          noProgressSteps: spec.noProgressSteps ?? FOLLOWER_WAIT_IDLE_STEPS,
        };
        // Independently OBSERVE this follower's own lobby code by vision-reading its waiting-room frame,
        // and record it for the cross-seat convergence proof. This does NOT latch anything (followers gate
        // on the HOST's code, not their own) — it just fills this seat's observedLobbyCodes slot from a
        // reliable signal instead of the flaky CDP url-read, so lobbyConvergenceDigest can prove all seats
        // reached the SAME /lobby/CODE. If a follower somehow joined a DIFFERENT lobby, it reads a different
        // code and convergence correctly fails (no false proof); if it never reads one, the seat stays a
        // hole and convergence is honestly "not observed" for that seat.
        const onScreenshot = makeLobbyCodeVisionReader(
          () => observedLobbyCodes[laneIndex] !== undefined,
          (observed) => {
            observedLobbyCodes[laneIndex] = observed;
          },
        );
        const startedAt = now();
        const outcome = await runCuaLane(followerSpec, {
          ...baseActorDeps,
          appUrl: publicAppUrl,
          onObservedUrl,
          onScreenshot,
        });
        const endedAt = now();
        return {
          spec,
          outcome,
          startedAt,
          endedAt,
          route: observedFinalUrls[laneIndex] ?? publicAppUrl,
        };
      };

      // Split the roster into the designated host lane and the followers, preserving each follower's
      // ORIGINAL lane index so results land back in lane order (validation guarantees EXACTLY ONE host).
      const hostLaneIndex = roles.findIndex((role) => role.host === true);
      const followerEntries = actorSpecs
        .map((spec, index) => ({ spec, index }))
        .filter(({ index }) => index !== hostLaneIndex);
      const laneResults: ActorLaneResult[] = new Array(actorSpecs.length);
      try {
        const hostPromise =
          hostLaneIndex >= 0 && actorSpecs[hostLaneIndex] !== undefined
            ? runHostLane(actorSpecs[hostLaneIndex]!, hostLaneIndex)
            : undefined;
        const followerResultsPromise = mapWithConcurrency(
          followerEntries,
          Math.max(1, concurrency - 1),
          ({ spec, index }) => runFollowerLane(spec, index),
        );
        const [hostResult, followerResults] = await Promise.all([
          hostPromise,
          followerResultsPromise,
        ]);
        if (hostResult !== undefined && hostLaneIndex >= 0) {
          laneResults[hostLaneIndex] = hostResult;
        }
        followerEntries.forEach((entry, i) => {
          laneResults[entry.index] = followerResults[i]!;
        });
        actorResults = laneResults;
      } catch (error) {
        runError = redactText(scrubKnownValuesWithLobbyCode(toErrorMessage(error)));
        warnings.push(
          `External-public concurrent shared-world run failed before completion: ${runError}`,
        );
      } finally {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        // Adopter-hosted drain (#328/#387): same routing and digest-only artifact as the in-sandbox
        // catch — only the transport differs (HTTP GET /deliveries against the catch the operator
        // runs). In the finally so the evidence survives a failed run; a drain error never masks
        // the run's own outcome.
        if (externalComms && externalCommsEmail) {
          try {
            const commsChannel = new FakeInbox();
            const commsInboxes: CommsAddress[] = [];
            for (const recipient of externalCommsEmail.recipients ?? []) {
              if (recipient.address !== undefined) {
                commsInboxes.push(
                  await commsChannel.provisionAddress(recipient.lane, recipient.address),
                );
              }
            }
            const authToken =
              externalComms.authTokenEnv === undefined
                ? undefined
                : env[externalComms.authTokenEnv];
            const collected = await collectExternalCommsThread({
              external: { ...externalComms, ...(authToken === undefined ? {} : { authToken }) },
              channel: commsChannel,
              inboxes: commsInboxes,
            });
            if (collected.artifact) {
              const path = "comms/thread.json";
              await writeContainedOutputFile(
                runPaths,
                path,
                `${JSON.stringify(collected.artifact, null, 2)}\n`,
                "utf8",
              );
              commsArtifactPath = path;
            } else if (collected.captured > 0) {
              warnings.push(
                `Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`,
              );
            } else {
              warnings.push(
                `Comms catch captured ZERO email sends — your app never delivered mail through the catch at ${externalComms.catchBaseUrl}. Verify the app's email-API base URL points at it and that the flow reached an email step.`,
              );
            }
          } catch (error) {
            warnings.push(
              `Comms evidence collection failed against the adopter-hosted catch (run continues): ${redactText(toErrorMessage(error))}`,
            );
          }
        }
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
      publicOriginDigest =
        distinctObservedOrigins.size === 1
          ? [...distinctObservedOrigins][0]
          : // NOTHING observed (e.g. a handoff-timeout run where no seat ever navigated): fall back to the
            // DECLARED origin so a FAILED run's bundle stays structurally valid (every seat's route then
            // digests to the declared origin too). The run still fails closed for its own reason (HANDOFF_
            // TIMEOUT / no lobby convergence / no overlap-on-pass). GENUINE divergence (≥2 distinct observed
            // origins) leaves it undefined so verify fails closed on the non-convergence.
            distinctObservedOrigins.size === 0
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
  } finally {
    try {
      await receiving?.finish();
    } catch {
      warnings.push(
        "Email finalization could not complete. Inspect humanish comms recover; provider cleanup remains unresolved.",
      );
    }
    // Stop the seats' flush timer on every exit, before the final write.
    await liveFlush?.stop();
  }

  // Subject provenance: external-public is the operator-declared, operator-owned public deployment
  // (neither provisioned nor seeded); the provisioned path builds clone/local-tree provenance.
  const subject: RunSubjectProvenance =
    planeClass === "external-public"
      ? { source: "app-url", envNames: [], state: { provenance: "external-public" } }
      : buildSubjectProvenance({
          localTreeRoute,
          publicRepo,
          subjectCommit: localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit,
          localTreeArchive,
          subjectEnvNames,
          state: resolveSubjectState({
            declared: config.subject.state,
            dryRun,
            executed: stateStepRecords,
          }),
        });
  const planeCommit = localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit;

  // Collect per-actor warnings (each lane's own teardown/raw-screenshot notes).
  for (const result of actorResults) {
    warnings.push(...result.outcome.warnings);
  }

  const bundle = buildConcurrentSharedWorldBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
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
    ...(commsArtifactPath === undefined ? {} : { commsArtifactPath }),
    ...(runError === undefined ? {} : { runError }),
  });

  const adapterWarnings: string[] = [];
  const scorerResult = await applyBrowserAdapterHooks({
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
      laneCount: roles.length,
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "sharedWorldHooks",
    ...(options.scorerProvenance === undefined
      ? {}
      : { scorerProvenance: options.scorerProvenance }),
  });

  if (receiving) bundle.commsReceiving = receiving.snapshot();
  const finished = await run.finish(bundle);
  const observer = await finished.renderObserver();
  if (observer.ok && liveObserver) {
    attachObserverRuntimeStreamUrls(observer as ObserverResult & { ok: true }, runtimeStreamUrls);
  }

  const roleOk = (result: ActorLaneResult | undefined): boolean => {
    if (dryRun) return true;
    return actorLanePassed(result);
  };
  // Concurrent "ok": every actor must produce a terminal, engaged PASSED session. This is a
  // harness/session-credibility gate, not mission-completion proof; a failed actor trace cannot
  // make the route green just because the harness got a terminal.
  const swarmRan =
    !dryRun && actorResults.length === roles.length && actorResults.every(actorLanePassed);
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok =
    observer.ok &&
    runError === undefined &&
    (dryRun || swarmRan) &&
    adapterFailure === undefined &&
    scorerResult.declaredVerdictFailure === undefined;

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
        ? {
            session: {
              status: session.status,
              completionReason: session.completionReason,
              reason: session.reason,
              screenshots: result.outcome.screenshots.length,
            },
          }
        : {}),
      ...(result.outcome.sandboxId === undefined
        ? {}
        : { sandbox: { sandboxId: result.outcome.sandboxId, killed: result.outcome.killed } }),
      ...(thisOk
        ? {}
        : {
            error: {
              code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED" as const,
              message:
                result.outcome.sessionError ??
                (result.outcome.noEngagement
                  ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                  : result.outcome.selfReportedBlocker
                    ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
                    : session?.completionReason === "harness_error"
                      ? `Actor seat ended with a harness error: ${session.reason}`
                      : "Actor did not produce a terminal session."),
            },
          }),
    };
  });

  const errorResult = ((): ConcurrentSharedWorldLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (handoffTimedOut) {
      // Checked BEFORE the observer failure: the host never yielded a /lobby/CODE within the
      // deadline (followers failed closed without opening), which is the ROOT CAUSE — and it can
      // itself make the Observer unable to render a coherent run. Report the distinct, honest
      // handoff-timeout code rather than a generic observer/run failure.
      return {
        code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT",
        message:
          runError ?? "The host seat never produced a /lobby/CODE URL within the handoff deadline.",
      };
    }
    if (hostHandoffFailure !== undefined) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: hostHandoffFailure };
    }
    if (!observer.ok) {
      return {
        code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
        message: observer.error?.message ?? "Observer failed for the concurrent shared-world run.",
      };
    }
    if (runError) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: runError };
    }
    if (adapterFailure !== undefined) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: adapterFailure };
    }
    const passed = roleResults.filter((role) => role.ok).length;
    return {
      code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
      message: `Concurrent shared-world run did not run coherently: ${passed}/${roles.length} actor(s) reached a terminal, engaged passed session.`,
    };
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
    ...(subjectSandboxId === undefined
      ? {}
      : { subjectSandbox: { sandboxId: subjectSandboxId, killed: subjectKilled } }),
    ...(dryRun ? {} : { overlapProven }),
    ...(dryRun ? {} : { maxSimultaneousLanes: maxSimultaneousWindows(actorResults) }),
    subject,
    roles: roleResults,
    observer,
    warnings: [...warnings, ...adapterWarnings, ...observer.warnings],
    ...(errorResult === undefined ? {} : { error: errorResult }),
  };
}
