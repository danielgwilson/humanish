import type { CommsReceivingEvidence } from "../comms/receiving-types.js";
import { type RunDesktopRecording } from "../evidence/desktop-recording-types.js";
import { type CodexAppServerTrace } from "../actors/codex/app-server.js";
import { type ActorTrace, type ActorTraceItem } from "../actors/contract.js";
import { captureGitState, type CapturedGitState } from "./git-state.js";
import { type RunLabProvenance } from "./status.js";

export const RUN_BUNDLE_SCHEMA = "humanish.run-bundle.v1";

export const SHARED_WORLD_SCHEMA = "humanish.shared-world.v1";

export const REVIEW_SCHEMA = "humanish.review.v1";

export const CLEANUP_SCHEMA = "humanish.cleanup-result.v1";

export const PUBLIC_TARGET_CWD = "[target-cwd]";

export interface RunOptions {
  /** Which manifest produced this run (#455). */
  lab?: RunLabProvenance;
  cwd: string;
  appUrl?: string;
  dryRun?: boolean;
  runId?: string;
  simCount?: number;
  timeoutMs?: number;
}

export type RunStreamKind =
  | "ui"
  | "browser"
  | "terminal"
  | "tui"
  | "codex-ui"
  | "artifact"
  | "summary";

export type RunSimulationStatus =
  | "queued"
  | "preparing"
  | "running"
  | "passed"
  // Participant outcomes, not harness malfunctions (docs/principles/three-roles.md).
  | "abandoned"
  | "incomplete"
  | "complete"
  | "blocked"
  | "timed_out"
  | "failed"
  | "contract_proof_only";

interface RunStreamCompletion {
  actorLogPath?: string;
  actorLogTail?: string;
  actorLastMessageTail?: string;
  actorPid?: number;
  actorStatus?:
    | "not_started"
    | "running"
    | "passed"
    | "failed"
    | "blocked"
    | "timed_out"
    | "suspended"
    | "unknown";
  appLogPath?: string;
  appPid?: number;
  appReason?: string;
  appStatus?: "not_started" | "running" | "blocked" | "failed" | "missing" | "unknown";
  appUrl?: string;
  checkedAt: string;
  exitCode?: number;
  logTail?: string;
  nestedObserverPresent?: boolean;
  nestedVerifyPassed?: boolean;
  reason: string;
  status: "running" | "passed" | "failed" | "blocked" | "timed_out";
  visualReason?: string;
  visualStatus?: "not_started" | "visible" | "blocked" | "unknown";
  visualWindowCount?: number;
  meaningfulUse?: RunMeaningfulUseScore;
}

/**
 * The CLOSED set of core meaningful-use scoring components. Closed by design: these are the generic
 * dimensions core itself meters (setup/filesystem/nested/actor/product/feedback). A product-specific
 * scorecard does NOT extend this enum (that would be closed-taxonomy rot — every adopter's nouns
 * leaking into core); it ships as a thin in-repo extension that emits a namespaced `RunAdapterScore`
 * via the lane's `score` hook, leaving its own component breakdown in that score's `data`. Exported
 * so a thin adapter can type against core's score shape without forking.
 */
export type RunMeaningfulUseComponentId =
  | "setup-correctness"
  | "filesystem-evidence"
  | "nested-humanish-evidence"
  | "actor-activity"
  | "product-surface"
  | "feedback-quality";

export interface RunMeaningfulUseScore {
  schema: "humanish.meaningful-use-score.v1";
  status: "pass" | "partial" | "fail";
  score: number;
  summary: string;
  hardFailures: string[];
  components: Array<{
    id: RunMeaningfulUseComponentId;
    label: string;
    status: "pass" | "partial" | "fail";
    score: number;
    detail: string;
  }>;
}

/**
 * A namespaced, product-agnostic score a thin adapter attaches to the bundle via the terminal-product
 * lane's `score` hook (the layer-6 extension seam, issue #154 acceptance #8). Core never reads its
 * `data` and knows none of the adopter's nouns — the `namespace` (e.g. `"acme-pixelforge"`) scopes
 * the whole record so core schemas stay product-agnostic and a future inert-field audit does not
 * misfire on a noun core never owned. The adopter's real scorecard (component weights, product
 * rubric) lives in ITS repo and is summarized into the generic status/score/summary; everything
 * product-specific rides under `data`. This is NOT a built-in product scorer — it is the SEAM the
 * adopter's scorer plugs into without forking core.
 */
export interface RunAdapterScore {
  schema: "humanish.adapter-score.v1";
  /** The adapter's namespace — non-core, product-scoped (e.g. an adopter slug). Required + non-empty. */
  namespace: string;
  status: "pass" | "partial" | "fail";
  /** A 0-100 summary the adapter derived from its own (off-core) rubric. */
  score: number;
  summary: string;
  /** Arbitrary product-specific payload (the adopter's component breakdown / nouns). Core never reads it. */
  data?: Record<string, unknown>;
}

export interface RunFeedbackCandidate {
  schema: "humanish.feedback-candidate.v1";
  id: string;
  run_id: string;
  stream_id?: string;
  adapter_id: string;
  scenario_id: string;
  persona_id: string;
  actor:
    | "codex-tui"
    | "codex-exec"
    | "codex-app-server"
    | "computer-use"
    | "synthetic-dry-run"
    | "unknown";
  // `e2b-terminal`: the in-sandbox command-scoped terminal-agent substrate (issue #154 / SLICE 4).
  substrate:
    | "e2b-desktop"
    | "local-desktop"
    | "e2b-terminal"
    | "local-filesystem"
    | "codex-app-server"
    | "unknown";
  failure_owner: "harness" | "target-app" | "actor" | "environment" | "unknown";
  summary: string;
  expected: string;
  actual: string;
  evidence: Array<{
    path: string;
    kind: "review" | "state" | "log" | "trace" | "screenshot" | "filesystem";
    note: string;
  }>;
  redaction: {
    status: "passed";
    notes: string;
  };
  idempotency_key: string;
  proposed_next_state:
    | "watch"
    | "adapter-hardening"
    | "target-app-setup"
    | "actor-auth"
    | "setup-quality-review"
    | "study-quality-review";
  acceptance_proof: string[];
  /**
   * OPTIONAL, ADAPTER-NAMESPACED product-noun block (the layer-6 extension seam, issue #154
   * acceptance #8 + the "record product-specific concepts as NON-core nouns" list). A thin adapter
   * records product-specific concepts — public CLI/product command observed, hosted product
   * success-or-blocker, feedback id/draft observed, media/job/asset ids, explicit
   * no-media/no-provider-spend proof, defection/friction risk — WITHOUT making any of them core
   * primitives. They ride under a single namespaced field so core's feedback enums
   * (`evidence.kind`, `proposed_next_state`) stay product-agnostic and a future inert-field audit
   * never misfires on a noun core never owned. Core validates only the SHAPE (a non-empty
   * `namespace` + a `data` record); the keys inside `data` are the adapter's, never core's.
   */
  adapter?: {
    /** Non-core, product-scoped namespace (e.g. an adopter slug). Required + non-empty. */
    namespace: string;
    /** The adapter's product nouns. Core never reads these keys — it stays product-agnostic. */
    data: Record<string, unknown>;
  };
}

/**
 * Optional, adapter-namespaced artifact references. These let a thin in-repo
 * adapter attach product/state proof outputs to the Humanish evidence packet
 * without teaching core product nouns or inventing fake streams.
 */
export interface RunAdapterArtifact {
  schema: "humanish.adapter-artifact.v1";
  namespace: string;
  label: string;
  path: string;
  kind: "state" | "review" | "log" | "trace" | "screenshot" | "filesystem" | "summary";
  note: string;
}

/**
 * Provenance for a CONFIG-DECLARED adopter scorer (#316): the repo-relative entry path and a digest
 * of its ENTRY-MODULE bytes, recorded so a `review.scorer.ref`/`--scorer` run honestly states which
 * out-of-tree judgment it attached. Core-computed (path + digest), never adopter-supplied. A LIBRARY
 * caller (hooks passed directly through RunLabOptions) has implicit provenance — their code IS their
 * provenance — so this block is ABSENT there and every pre-#316 bundle stays byte-stable + verifiable.
 *
 * The digest pins the entry file's IDENTITY, not its behavioral closure: a `export { score } from
 * "../outside.mjs"` re-export is not captured, and `import()` re-opens the path (a benign same-author
 * TOCTOU). Treat it as evidence-not-gate, and do NOT extend the loader to less-trusted config.
 */
export interface RunScorerProvenance {
  schema: "humanish.scorer-provenance.v1";
  /** Repo-relative entry path (e.g. "scorers/example.mjs"), clamped inside the target cwd. */
  ref: string;
  /** digestText over the readContainedRegularFile ENTRY bytes — the entry module only, not a lockfile of the executed graph. */
  digest: string;
  /** Which door declared it: the committed manifest, or the CLI `--scorer` override. */
  source: "manifest" | "cli-flag";
  /** The whitelisted hooks actually wired from the module (costProbe is intentionally never loadable). */
  exports: ("score" | "deriveFeedback" | "deriveArtifacts")[];
}

export interface RunSimulation {
  id: string;
  index: number;
  personaId: string;
  scenarioId: string;
  status: RunSimulationStatus;
  streamKind: RunStreamKind;
  mode: "browser-sim" | "cli-sim" | "tui-sim" | "codex-app-sim";
  progress: number;
  currentStep: string;
  summary: string;
  streamIds: string[];
  startedAt: string;
  updatedAt: string;
}

export interface RunDesktopGeometry {
  /** E2B/X display geometry. Requested config and verified runtime evidence stay distinct. */
  screen: {
    requested: { width: number; height: number };
    verified?: { width: number; height: number; source: "xdpyinfo" };
    /**
     * The device preset as DECLARED by the lab, present only when it differs from `requested`
     * because the rendered width was floored to MIN_DESKTOP_RENDER_WIDTH.
     *
     * Without this, a floored run is indistinguishable from a faithful one: `verified` compares
     * the floored number with itself and reports a match, so a reader of the bundle sees
     * requested 500 / verified 500 and reasonably concludes a 500-wide preset was asked for. A
     * `mobile` (414) and a `small-mobile` (360) seat both render at 500 and look identical here.
     * When this field is set, the preset width did NOT render; see #221.
     */
    declared?: { width: number; height: number; preset: string };
  };
  /** Measured browser bounds after the fill attempt. X client bounds take precedence for
   * physical visibility; CDP page-reported outer bounds can reflect mobile emulation. */
  browserWindow?: {
    x: number;
    y: number;
    width: number;
    height: number;
    source: "cdp" | "xdotool" | "xwininfo";
  };
  /** Browser CSS layout viewport measured from the running page, never copied from config. */
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    source: "cdp";
  };
  /**
   * Mobile fidelity beyond viewport size (#221), present only when the lab asked for it. `requested`
   * is what was applied through CDP; `resolved` is what the page reported about itself afterwards
   * and is the proof, never copied from the request. A run without this block is a
   * responsive-viewport study, whatever its preset is named.
   */
  fidelity?: {
    tier: "mobile-emulated";
    requested: {
      width: number;
      height: number;
      deviceScaleFactor: number;
      touch: boolean;
      userAgent: string;
    };
    applied: string[];
    resolved?: {
      userAgent: string;
      devicePixelRatio: number;
      innerWidth: number;
      innerHeight: number;
      maxTouchPoints: number;
      coarsePointer: boolean;
      source: "cdp";
    };
    /**
     * Page targets the participant drove AFTER the launch page (a link that opened in a new tab)
     * whose own read-back reported the requested viewport width (#623). Absent when the
     * participant never left the launch tab; a later tab that did NOT report the width is a lane
     * warning instead.
     */
    laterTargets?: {
      targetId: string;
      innerWidth: number;
      devicePixelRatio: number;
      maxTouchPoints: number;
    }[];
    /**
     * The emulation holder's log after its announce, one JSON line per later target it attached
     * to (`attached`, `sent`) and per reply that came back as an error (`replyError`), at most 50
     * lines. Absent when no later target appeared.
     */
    holderLog?: string[];
  };
  /** Public-safe geometry measurement/fill warnings retained with the stream evidence. */
  warnings?: string[];
}

/** The original participant-facing assignment, before runtime access/coordination details. */
export interface RunParticipantAssignment {
  mission: string;
  focus?: string;
  tasks?: Array<{ id: string; goal: string }>;
}

export interface RunStream {
  id: string;
  simId: string;
  /** Adapter-owned lane id for fan-out / target-swarm runs. Safe categorical metadata only. */
  laneId?: string;
  /** Adapter-owned actor class for grouping lanes, e.g. viewer/reviewer/admin. */
  actorType?: string;
  /** Adapter-owned product surface label for grouping lanes without parsing URLs. */
  surface?: string;
  /** Adapter-owned scenario/case grouping label. */
  caseGroup?: string;
  /** Authored/default mission and lane focus, redacted before persistence. Missing on older
   * bundles and uninstrumented routes; never reconstructed from study context or narration. */
  assignment?: RunParticipantAssignment;
  kind: RunStreamKind;
  label: string;
  status: RunSimulationStatus;
  transport: "snapshot" | "polling" | "sse" | "pty" | "app-server";
  updatedAt: string;
  url?: string;
  embed?: {
    kind: "iframe" | "terminal" | "screenshot" | "placeholder";
    url?: string;
    title?: string;
  };
  /** Set by the attached watch server when the lane's sandbox is gone (#357): the injected
   *  live URL would render a provider error page, so viewers fall back to recorded evidence.
   *  Runtime-only — never persisted into bundles; declared here because the served
   *  observer-data carries it and the client is typed against this contract. */
  liveEnded?: boolean;
  /**
   * Browser CSS layout viewport. Deterministic browser adapters may declare and render this
   * exactly; hosted-desktop CUA producers set it only from a runtime measurement. Historical
   * hosted CUA bundles may contain the requested screen size here instead.
   */
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
  };
  /** Truthful screen/window/viewport evidence for hosted desktop browser lanes. */
  desktopGeometry?: RunDesktopGeometry;
  terminal?: {
    title: string;
    format: "ansi" | "plain";
    stdin: "disabled" | "planned" | "sent";
    tail: string;
  };
  ui?: {
    actorStatus?: string;
    appStatus?: string;
    appUrl?: string;
    route?: string;
    intent?: string;
    nestedObserverPath?: string;
    nestedObserverUrl?: string;
    screenshotUrl?: string;
    state?: string;
    visualStatus?: string;
  };
  codex?: {
    provider: "codex-app-server";
    eventCount?: number;
    experimentalApi?: boolean;
    model?: string;
    sessionId?: string;
    state:
      | "not_connected"
      | "connecting"
      | "watching"
      | "running"
      | "completed"
      | "failed"
      | "blocked"
      | "timed_out";
    contract: string;
    threadId?: string;
    trace?: CodexAppServerTrace;
    tracePath?: string;
    turnId?: string;
  };
  // Provider-neutral projection of the actor's evidence (humanish.actor-trace.v1).
  // Populated alongside the raw `codex` evidence; carries persona.traitsApplied.
  actor?: ActorTrace;
  /**
   * Mid-run partial actor evidence (#441): the redacted trace items recorded SO FAR,
   * flushed while a live lane is still running so the attached Observer's timeline can
   * grow. Deliberately NOT an ActorTrace — a running lane has no honest status,
   * completionReason, or completedAt, and this shape cannot claim them. Present ONLY on
   * `inProgress` bundles; the final write replaces it with the real `actor` and never
   * carries it.
   */
  liveActor?: {
    schema: "humanish.live-actor.v1";
    executionProfile?: ActorTrace["executionProfile"];
    providerRequests?: ActorTrace["providerRequests"];
    historyTurnsOmitted?: number;
    tokenUsage?: ActorTrace["tokenUsage"];
    estimatedCost?: ActorTrace["estimatedCost"];
    ids?: ActorTrace["ids"];
    /** When this flush was written (ISO-8601). */
    updatedAt: string;
    items: ActorTraceItem[];
  };
  completion?: RunStreamCompletion;
  recording?: RunDesktopRecording;
  artifacts: Array<{
    label: string;
    path: string;
    kind:
      | "bundle"
      | "review"
      | "observer"
      | "events"
      | "screenshot"
      | "trace"
      | "log"
      | "filesystem"
      | "recording";
  }>;
}

export interface RunEvent {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  type: string;
  message: string;
  simId?: string;
  streamId?: string;
}

/**
 * One executed (or declared) subject-state seed step. Live records carry execution fields
 * (ok/exitCode/timedOut/durationMs); dry-run "declared, not run" records carry only the
 * declaration (name, phase, command DIGEST). The command itself never persists — the digest
 * pins "same recipe" across bundles while the lab YAML in the consumer's repo stays the
 * plaintext source of truth (publish-safe by construction).
 */
export interface RunSubjectStateStepRecord {
  name: string;
  when: "before-build" | "before-start" | "after-ready";
  /** sha256 hex of the exact command string, first 16 chars (the promptDigest convention). */
  commandDigest: string;
  /** Absent on declared-not-run records (dry-run; unreached steps are absent entirely). */
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
}

/**
 * Structured subject provenance (invariant 5): what the subject WAS — code pin (repo/commit,
 * or a local-tree archive digest) AND state story. Optional additive field on
 * humanish.run-bundle.v1; absent on bundles from backends that have not adopted it (and on all
 * pre-existing bundles).
 */
export interface RunSubjectProvenance {
  source: "clone" | "app-url" | "local-tree";
  /** Clone-route only. Honors policies.redactRepos exactly as the provenance event does. */
  repo?: string;
  /** Clone-route: the cloned commit SHA. Local-tree route: the host-side HEAD at pack time,
   *  when the packed root was a git work tree. */
  commit?: string;
  /**
   * Local-tree-route only (additive): 64 lowercase-hex sha256 over the sorted packed-entries
   * list (docs/contracts/schemas.md). This is the provenance PIN for the local-tree route: a
   * dirty working tree cannot be commit-pinned, so the archive content digest stands in for it.
   */
  archiveSha256?: string;
  /**
   * Local-tree-route only (additive): true when the host git work tree had uncommitted changes
   * at pack time. Absent when the packed root was not a git work tree at all.
   */
  dirty?: boolean;
  /** Declared env NAMES provisioned for the subject — names only, values never. */
  envNames?: string[];
  state: {
    /**
     * seeded: live run, steps declared, ALL ran ok, no external state declared.
     * unpinned: external state declared (seed records, if any, still attached — migrating
     *   an external DB is still unpinned overall).
     * declared-not-run: steps declared but not (all) executed ok — dry-run contract bundles
     *   and failed live provisioning.
     * undeclared: no subject.state block (stateless apps, app-url subjects) — the explicit
     *   "absence declared" marker invariant 5 requires.
     * external-public: (#164 phase 2) an operator-DECLARED, operator-OWNED public deployment used
     *   directly as the shared plane — humanish neither provisioned nor seeded it (no getHost, no
     *   clone, no in-sandbox filesystem). NOT "seeded" (nothing was seeded), NOT "unpinned" (this is
     *   an owned target, not an uncontrolled external DB). The honest marker for the external-public
     *   plane class; verify asserts it in place of the getHost seeded gate.
     */
    provenance: "seeded" | "unpinned" | "declared-not-run" | "undeclared" | "external-public";
    seed?: RunSubjectStateStepRecord[];
    externalEnvNames?: string[];
  };
}

/**
 * How well a run attributed INTERACTION between actors — a new, ORTHOGONAL honesty axis to the
 * persona-sampling evidence classes (which answer "how representative is the actor?"). Absent ==
 * `isolated` (every existing bundle byte-stable). `shared-world` means N roles drove ONE mutable
 * plane and their per-role attribution is weaker (its ceiling is pinned in `sharedWorld.attributionLimits`).
 */
export type RunAttributionClass = "isolated" | "shared-world";

/** The ONE shared service-plane provenance for a shared-world run (#164): single commit + a
 *  seed-recipe digest + the provisioned env NAMES (values never). */
export interface SharedWorldPlane {
  /** The cloned commit SHA of the shared plane (when the clone resolved one). */
  commit?: string;
  /** sha256-16 over the ordered seed-step command digests — the seeded-state RECIPE identity
   *  (not the runtime state). Pins "same seed recipe" across bundles. */
  seedDigest: string;
  /** Declared env NAMES provisioned for the shared plane (values never surface). */
  envNames: string[];
  /**
   * CONCURRENT route only (#164 phase 2): sha256-16 of the harness-minted `getHost` URL's ORIGIN
   * (the first-class provisioned-subject target every actor drove — invariant 2). A DIGEST, not the
   * raw URL: a getHost URL embeds the (live) sandbox id and matches the publish-safety e2b-URL
   * redaction, so — like the stream URL and like sandbox ids — it never lands raw in a published
   * bundle (the raw tokenless URL is surfaced only on the ephemeral lab result). The orchestrator
   * confirms the URL is TOKENLESS (no authKey — invariant 1) before digesting. verify proves every
   * actor drove this host by digest equality. Absent on the sequential route.
   */
  hostDigest?: string;
  /**
   * CONCURRENT route only: the author's REQUIRED attestation that the subject behind the
   * internet-reachable getHost URL is synthetic seeded data (FIX-3). This is author-trust + a
   * provenance gate, NOT a no-real-data guarantee. Verify fails closed if absent on the concurrent route.
   *
   * FORBIDDEN on the external-public plane class: claiming synthetic on a real public site the
   * harness neither provisioned nor exposed would be a lie (verify asserts it ABSENT there).
   */
  exposure?: "synthetic";
  /**
   * EXTERNAL-PUBLIC plane class only (#164 phase 2): sha256-16 of the OBSERVED origin the seats
   * CONVERGED on (the honest analog of hostDigest, but WEAKER and disclosed — the harness only
   * OBSERVES that each seat reached this origin; it never MINTED it). It is derived from what the
   * seats actually reached, NOT from the declared appUrl: verify proves every laneWindow.routeHostDigest
   * (that seat's CDP-observed final URL origin) equals it — inter-seat convergence on ONE OBSERVED
   * origin, not harness control of the plane. A digest, not the raw origin (kept consistent with
   * hostDigest hygiene). Absent on getHost.
   */
  publicOriginDigest?: string;
  /**
   * EXTERNAL-PUBLIC plane class only: sha256-16 of the operator-DECLARED origin (from subject.appUrl),
   * recorded for reference/evidence ONLY. It is NEVER asserted equal to publicOriginDigest: a normal
   * cross-origin redirect (apex->www, http->https) makes the OBSERVED origin differ from the declared
   * one, which is expected. Operator OWNERSHIP rests on the subject.publicTarget.authorized attestation
   * + the declared appUrl, NOT on digest equality. A digest, not the raw origin. Absent on getHost.
   */
  declaredOriginDigest?: string;
}

/**
 * CONCURRENT shape (#164 phase 2): one actor's harness-clocked activity window against the ONE
 * shared plane. OVERLAPPING windows mechanically prove ≥2 personas were active simultaneously.
 * `laneWindows` and `stateSeries` are INDEPENDENT series — there is deliberately NO per-delta→actor
 * field (causation under concurrency is structurally inexpressible — FIX-7).
 */
export interface SharedWorldLaneWindow {
  roleId: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  /** Resolves to a real RunSimulation in this bundle. */
  simId: string;
  /** Resolves to a real RunStream (the actor's trace) in this bundle. */
  streamId: string;
  /** ms on the ONE harness clock — the wrapped [start,end] the orchestrator MEASURED (FIX-1). */
  startedAt: number;
  endedAt: number;
  /** The actor's terminal session verdict (per-persona). */
  verdict: string;
  /** sha256-16 of the ORIGIN of the getHost seat URL this actor drove. verify confirms it equals
   *  plane.hostDigest — i.e. the actor drove EXACTLY the harness-minted host (invariant 2; FIX-2).
   *  A digest, not the raw URL (a getHost URL is not publish-safe — see SharedWorldPlane.hostDigest). */
  routeHostDigest: string;
  /** The shared plane's commit this actor observed (omitted when unresolved). */
  commit?: string;
  /** The shared plane's seed-recipe digest this actor observed. */
  seedDigest: string;
}

/** CONCURRENT shape: one cadence checkpoint of the shared world under load. DIGEST-ONLY — the
 *  allowed-keys tripwire (SHARED_WORLD_STATESERIES_KEYS) permits ONLY {timestamp, digest}. */
export interface SharedWorldStateSnapshot {
  /** ms on the ONE harness clock. */
  timestamp: number;
  /** sha256-16 of the (scrubbed, redacted) combined probe output at this snapshot. */
  digest: string;
}

/** CONCURRENT shape: one persona's OUTCOME against the contended world (the "M of N" headline). */
export interface SharedWorldOutcome {
  roleId: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  simId: string;
  streamId: string;
  /** Terminal session status. */
  status: string;
  completionReason?: string;
  /** Reached its goal (terminal, engaged, no harness error). */
  ok: boolean;
}

/** A timeline checkpoint: a read-only digest probe of the shared plane at one moment. Persisted
 *  DIGEST-ONLY — `digest` is sha256-16(scrub+redact(stdout)); no raw value ever lands. */
export interface SharedWorldCheckpoint {
  kind: "checkpoint";
  /** "cp-baseline" for the baseline snapshot; "cp-after-<roleId>" after each role's turn. */
  name: string;
  /** sha256-16 of the (scrubbed, redacted) combined probe output at this snapshot. */
  digest: string;
  /** True when this snapshot's digest differs from the previous checkpoint's — the observed
   *  state changed across the intervening turn (delta attributed to the TURN, not an action). */
  deltaFromPrev: boolean;
}

/** A timeline turn: one role's seat session against the shared plane. Carries the plane
 *  provenance it observed (identical across turns by construction — the single-plane proof). */
export interface SharedWorldTurn {
  kind: "turn";
  roleId: string;
  /** Resolves to a real RunSimulation in this bundle. */
  simId: string;
  /** Resolves to a real RunStream (the role's actor trace) in this bundle. */
  streamId: string;
  /** The shared plane's commit the role observed (omitted when unresolved). */
  commit?: string;
  /** The shared plane's seed-recipe digest the role observed. */
  seedDigest: string;
}

export type SharedWorldTimelineEntry = SharedWorldCheckpoint | SharedWorldTurn;

/** Declared seats that were never started after one executed sequential role stopped the run.
 * The executed timeline plus this ordered tail must account for every declared sim/stream. */
export interface SharedWorldSkippedTail {
  afterRoleId: string;
  roles: Array<{ roleId: string; simId: string; streamId: string }>;
  cause: "harness_error" | "session_error" | "usage_unreported" | "study_spend_limit";
  /** Present only for a measured aggregate threshold; estimates, not provider billing. */
  maxTotalUsd?: number;
  estimatedTotalUsd?: number;
}

/**
 * The shared-world evidence block (`humanish.shared-world.v1`). TWO variants discriminated by
 * `topologyMode` (FIX-8 — renamed off `RunBundle.mode` to avoid the dry-run|live collision):
 *
 * - SEQUENTIAL (`topologyMode: "sequential"`, the PoC): `sequence` + an alternating `timeline`
 *   (cp-baseline → turn → cp → … → cp); limits `sequential-only` etc.
 * - CONCURRENT (`topologyMode: "concurrent"`, #164 phase 2): `laneWindows` + `stateSeries` +
 *   `outcomes`; limits `concurrent` etc. NO `timeline`.
 *
 * Additive + optional on `humanish.run-bundle.v1` — absent on every non-shared-world bundle.
 * The mandatory `attributionLimits` are verify-enforced (FAIL CLOSED on a missing required or a
 * present forbidden limit).
 */
export interface SharedWorldEvidence {
  schema: typeof SHARED_WORLD_SCHEMA;
  topology: "shared-world";
  /** The substrate discriminator (FIX-8). Branched on FIRST by validateSharedWorldEvidence. */
  topologyMode: "sequential" | "concurrent";
  /**
   * CONCURRENT route only (#164 phase 2): the PLANE-class discriminator. Absent == the historical
   * "provisioned-getHost" plane (a clone/local-tree subject served + getHost-exposed in-sandbox — the
   * harness MINTED the host; synthetic-seeded attestation + authoritative in-sandbox checkpoint
   * stateSeries). "external-public" == a real operator-owned public deployment used directly as the
   * plane (NO getHost/clone/seed; operator-attested, not harness-controlled; NO authoritative
   * shared-state proof — concurrency evidenced by temporal co-occupancy + observed lobby convergence).
   * verify gates EVERY getHost-specific assertion on this discriminator; existing bundles omit it and
   * default to provisioned-getHost, byte-stable.
   */
  planeClass?: "provisioned-getHost" | "external-public";
  /** The DECLARED number of role seats. */
  roleCount: number;
  plane: SharedWorldPlane;
  /** The pinned, verify-enforced attribution ceiling (the set differs per topologyMode/planeClass). */
  attributionLimits: string[];
  /**
   * EXTERNAL-PUBLIC plane class only (#164 phase 2, optional-but-strong): sha256-16 of the shared
   * `/lobby/CODE` PATH every seat's CDP-observed URL converged on — the concrete "they were in ONE
   * shared world" proof, observation-derived and needing no subject change. Digest-only (the raw
   * 6-char CODE and full URLs are runtime-only and never land). Absent when seats did not converge.
   */
  lobbyConvergenceDigest?: string;
  // --- SEQUENTIAL shape ---
  /** The role ids that actually took a turn, in declared order. */
  sequence?: string[];
  timeline?: SharedWorldTimelineEntry[];
  /** Explicit unstarted suffix; absent on historical/full-execution bundles. */
  skippedTail?: SharedWorldSkippedTail;
  // --- CONCURRENT shape ---
  /** Per-actor harness-clocked windows (overlap proves simultaneity). */
  laneWindows?: SharedWorldLaneWindow[];
  /** Cadence digests of the shared world under load (baseline + periodic + final). */
  stateSeries?: SharedWorldStateSnapshot[];
  /** Per-persona outcomes (the "M of N succeeded" headline). */
  outcomes?: SharedWorldOutcome[];
}

export interface RunBundle {
  publication?: { restrictions: ["real-communications"] };
  commsReceiving?: CommsReceivingEvidence;
  schema: typeof RUN_BUNDLE_SCHEMA;
  runId: string;
  mode: "dry-run" | "live";
  simCount: number;
  createdAt: string;
  cwd: string;
  artifactRoot: string;
  source: {
    packageName: string | null;
    humanishSource: "present" | "missing";
    git: CapturedGitState;
  };
  persona: {
    id: string;
    name: string;
    source: string;
    sourceDigest: string;
  };
  scenario: {
    id: string;
    title: string;
    goal: string;
    source: string;
    sourceDigest: string;
  };
  lifecycle: Array<{
    at: string;
    event: string;
    message: string;
  }>;
  simulations: RunSimulation[];
  streams: RunStream[];
  events: RunEvent[];
  redaction: {
    status: "passed";
    notes: string;
  };
  artifacts: {
    run: string;
    reviewJson: string;
    reviewMarkdown: string;
    observerData: string;
    events: string;
  };
  review: ReviewSummary;
  feedbackCandidates: RunFeedbackCandidate[];
  /** Structured subject provenance (invariant 5). Optional and additive: emitted by the
   * computer-use backend; tolerated absent everywhere else. */
  subject?: RunSubjectProvenance;
  /**
   * The custom E2B desktop TEMPLATE (image) the run's sandbox(es) actually launched on, from
   * `execution.desktop.template` — so the evidence shows WHICH image ran (a subject needing
   * runtimes the stock `desktop` image lacks runs on an adopter's template). Optional + additive:
   * present only when a template was configured (absent == the stock `desktop` template, every
   * pre-existing bundle byte-stable). A template name is public-safe (not a secret).
   */
  desktopTemplate?: string;
  /**
   * Browser family requested for hosted desktop actor lanes and the in-sandbox command that opened
   * it, when explicitly configured. Optional + additive; absent means the historical default opener
   * path was used or the backend does not create a headed desktop.
   */
  desktopBrowser?: {
    requested: "default" | "chrome" | "chromium" | "firefox";
    resolved?: string;
    /**
     * Synthetic media devices the browser was launched with (#509): the camera feed's origin and
     * in-sandbox path, how the permission dialog is answered, and the exact flags.
     */
    media?: {
      camera?: { source: "synthetic" | "file"; file: string };
      microphone?: { source: "speech" };
      permission: "prompt" | "granted";
      flags: string[];
    };
  };
  /**
   * Optional lineage for a run that intentionally re-executes selected lanes from a prior
   * multi-lane run. This keeps retry-like workflows explicit: the new run is linked to the old
   * evidence, but it never mutates or silently "fixes" the original verdict.
   */
  rerun?: RunRerunLineage;
  /**
   * The interaction-attribution honesty axis (#164). Absent == `isolated` (every existing bundle
   * byte-stable). Set to `shared-world` by the shared-world backend, paired with `sharedWorld`.
   */
  attributionClass?: RunAttributionClass;
  /**
   * Shared-world evidence block (`humanish.shared-world.v1`). Optional + additive; present only on
   * shared-world runs. Verified fail-closed by validateSharedWorldEvidence.
   */
  sharedWorld?: SharedWorldEvidence;
  /**
   * OPTIONAL, ADAPTER-NAMESPACED product score (the layer-6 extension seam, issue #154 acceptance
   * #8). A thin adapter's `score` hook returns a `RunAdapterScore`; the lane attaches it here
   * WITHOUT core knowing any product noun (the score is namespaced + its breakdown lives in `data`).
   * The default mission-based verdict (`review`) is unchanged when no scorer hook is given.
   */
  adapterScore?: RunAdapterScore;
  /**
   * OPTIONAL provenance for a CONFIG-DECLARED scorer (#316). Present only when the scorer was loaded
   * from `review.scorer.ref` / `--scorer`; absent for library callers and every pre-#316 bundle
   * (tolerated-absent in isRunBundle so those still verify). Evidence, not a gate.
   */
  scorerProvenance?: RunScorerProvenance;
  /**
   * OPTIONAL, ADAPTER-NAMESPACED product/state proof artifacts. Core validates
   * shape and local relative artifact references, then verifies the referenced
   * files exist. The adapter owns the payload schema under `namespace`.
   */
  adapterArtifacts?: RunAdapterArtifact[];
  /**
   * Evidence about mutable provider resources observed during this run. Stored ids
   * are not cleanup authority: automatic provider mutation requires a verified
   * resource lease. Optional + additive; core never enumerates provider accounts.
   */
  providerResources?: RunProviderResource[];
  /**
   * Which lab manifest produced this run (#455). Optional + additive: absent on every bundle
   * written before this contract and on library callers who pass a LabConfig directly (the run is
   * then honestly lab-less rather than guessed). For older bundles a reader may fall back to
   * `inferLegacyLabId`, which reads only the historical `persona.source = "lab:<id>"` convention.
   */
  lab?: RunLabProvenance;
  /**
   * OPTIONAL, ADDITIVE run-level cost ESTIMATE (humanish.run-cost-summary.v1): the sum of every
   * lane's model-token estimate PLUS the E2B desktop-minute estimate, carrying the SAME
   * null-discipline the terminal cost ledger already ships. Absent on every pre-existing bundle
   * and on dry-runs that invent no spend (byte-stable). Every dollar figure here is an ESTIMATE,
   * never an authoritative charge; verify asserts its LABELING/provenance, never its magnitude.
   */
  cost?: RunCostSummary;
}

/**
 * One contributing cost line of a RunCostSummary. A line is PRESENT even when it cannot be priced
 * (records that we TRIED and could not) — an unpriceable line carries estimatedCostUsd: null + a
 * `reason` and contributes NOTHING to the summary total (invariant 5). `estimatedCostUsd` is NEVER
 * coerced to 0.
 */
export interface RunCostLine {
  kind: "model-tokens" | "desktop-minutes";
  laneId?: string;
  modelId?: string;
  /** null = NOT MEASURED / no rate; never coerced to 0. */
  estimatedCostUsd: number | null;
  reason?:
    | "no_rate_for_model"
    | "no_rate_for_desktop"
    | "no_token_usage"
    | "no_duration"
    | "closing_usage_unreported"
    | "interaction_usage_unreported"
    | "no_desktop_resources"
    | "desktop_lifetime_incomplete"
    | "account_billing_unknown";
  /** Pricing provenance date; non-null iff estimatedCostUsd is non-null. */
  ratesAsOf: string | null;
  source?: string;
  placeholder?: boolean;
  /** Optional allocation evidence on newer desktop lines; older aggregate lines remain valid. */
  desktop?: {
    minutes: number | null;
    durationBasis: "host-acquired-to-cleanup";
    resources?: { cpuCount: number; memoryMiB: number };
    resourceSource?: "e2b.getInfo";
    resourceUnavailableReason?: "metadata_unavailable" | "metadata_invalid" | "metadata_timeout";
    usdPerSecond?: number;
  };
}

/**
 * The run-level cost ESTIMATE. `estimatedTotalUsd` is the rounded sum of ONLY the non-null
 * `breakdown` lines; it is null iff EVERY line is null (never 0-coerced). `fullyEstimated` is
 * false when any applicable line is null (the total is then a LOWER BOUND). Every non-null dollar
 * figure carries `ratesAsOf`; `placeholder` is true when any contributing rate is a stand-in.
 */
export interface RunCostSummary {
  schema: "humanish.run-cost-summary.v1";
  currency: "usd";
  /** Sum of the KNOWN (non-null) lines; null iff every applicable line is null. */
  estimatedTotalUsd: number | null;
  /** Oldest asOf across contributing rates; null when nothing was priced. */
  ratesAsOf: string | null;
  /** false when any applicable line is null (the total is a lower bound). */
  fullyEstimated: boolean;
  /** true when any contributing rate is a placeholder (a stand-in, not a live sheet). */
  placeholder: boolean;
  breakdown: RunCostLine[];
  /** Missing account token counts remain absent; known counts may be partial. */
  tokenUsage: { input?: number; output?: number; total?: number };
  /** Host-side create->teardown span in minutes; null when no sandbox was created. */
  desktopMinutes: number | null;
  /** Honest "estimated; <x> unmeasured" statement. */
  note: string;
}

export interface RunProviderResource {
  schema: "humanish.provider-resource.v1";
  provider: "e2b-desktop";
  kind: "sandbox";
  id: string;
  owner: "humanish";
  status: "running" | "killed" | "unknown";
  simId?: string;
  streamId?: string;
  laneId?: string;
  createdAt?: string;
  cleanup?: {
    killed: boolean;
    reason: string;
  };
}

export interface RunRerunLineage {
  sourceRunId: string;
  selectedLaneIds: string[];
  previous: Array<{
    laneId: string;
    streamId?: string;
    status: string;
    reason?: string;
    actorStatus?: string;
    completionReason?: string;
  }>;
}

/**
 * What happened to the PARTICIPANTS in a study, with the denominator attached.
 *
 * A stakeholder watching through the glass forms conclusions from vivid moments — that is the
 * classic failure of the viewing room, and it is why researchers synthesize rather than letting the
 * room decide. So anything shown to a stakeholder carries its count, or it becomes a machine for
 * manufacturing certainty from n=1 (docs/principles/three-roles.md).
 *
 * These are OUTCOMES, not scores. `abandoned` is the most valuable thing a usability study
 * produces, and `harnessFailed` is the only member that says the instrument, rather than the
 * product, is what went wrong.
 */
export interface ParticipantOutcomes {
  /** Participants whose sessions reached a terminal state — the denominator for every count below. */
  total: number;
  /** Recorded successful sessions; completion provenance depends on the actor and its evidence. */
  reachedGoal: number;
  /** Stopped trying. A finding about the product. */
  abandoned: number;
  /** Interrupted before reaching the goal, including session, spend and provider limits. */
  ranOut: number;
  /** Needed an approval the run could not give. */
  blocked: number;
  /** The harness failed them: a dead sandbox, a provider error, a broken artifact. */
  harnessFailed: number;
  /**
   * Participants who reported friction or a defect on the way, whatever their outcome.
   *
   * This is NOT a failure count and it overlaps the others on purpose — someone can reach the goal
   * and still tell you the road there was broken. A live two-persona run made the case: both
   * participants signed in, so "2/2 reached the goal" was true, and the keyboard-first one also
   * reported that the signature step could not be completed without a mouse. Reporting only the
   * outcome would have buried the single most useful thing that run produced.
   */
  reportedFriction: number;
}

export interface ReviewSummary {
  schema: typeof REVIEW_SCHEMA;
  verdict: "contract_proof_only" | "pass" | "fail" | "blocked" | "timed_out";
  summary: string;
  gaps: string[];
  /**
   * The study result, separate from the verdict above.
   *
   * `verdict` answers a gate-shaped question and has to collapse a run to one word. This answers
   * the research question — what happened to the people in the study — and does not collapse: a run
   * where two of three participants finished is not usefully "fail", and a run where the harness
   * broke is a different thing from one where a persona gave up. Absent on a dry-run contract
   * bundle, which has no participants.
   */
  participants?: ParticipantOutcomes;
  /**
   * The study's per-task completion rates (#414) — present only when the lab declared a protocol
   * and at least one session produced a funnel. Absent means no protocol was measured, never that
   * everyone finished.
   */
  tasks?: StudyTaskFunnel;
}

/**
 * The study's task funnel: for each declared task, how many participants completed it, out of how
 * many sessions produced a funnel. This is "where did people get stuck" as data — the number a
 * researcher reads first — where the per-participant funnels answer it one journey at a time.
 *
 * Aggregated by task id in declaration order. Every lane in a run shares the actor's protocol, so
 * ids line up across participants; a funnel missing a task id (a future mixed-protocol route)
 * simply does not count toward that task's denominator.
 */
export interface StudyTaskFunnel {
  /** Sessions that produced a funnel — the denominator for every count below. */
  sessions: number;
  tasks: Array<{
    id: string;
    /** Participants whose sessions corroborated this task complete. */
    completed: number;
    /** Sessions whose protocol declared this task — its denominator. */
    sessions: number;
    /** False when the task declared no success criterion: asked for, never measurable. */
    observable: boolean;
    /** Sessions where this task's criteria were never evaluated, because the observations they
     *  read never arrived. Counted apart from failures: "0/3 completed" with 3 unmeasured is a
     *  statement about our instrument, not about the participants (#514). */
    unmeasured: number;
  }>;
}

export async function buildRunSource(args: {
  cwd: string;
  capturedAt?: Date | string;
  humanishSource: RunBundle["source"]["humanishSource"];
  packageName: string | null;
}): Promise<RunBundle["source"]> {
  const gitOptions = args.capturedAt === undefined ? {} : { capturedAt: args.capturedAt };
  return {
    packageName: args.packageName,
    humanishSource: args.humanishSource,
    git: await captureGitState(args.cwd, gitOptions),
  };
}

export interface RunResult {
  schema: "humanish.run-result.v1";
  ok: boolean;
  runId?: string;
  mode?: "dry-run" | "live";
  simCount?: number;
  cwd: string;
  artifactRoot?: string;
  bundlePath?: string;
  reviewPath?: string;
  latestPath?: string;
  warnings: string[];
  error?: {
    code:
      | "HUMANISH_LAB_ANALYSIS_INVALID"
      | "HUMANISH_LAB_ANALYSIS_UNSUPPORTED"
      | "HUMANISH_LAB_TASKS_UNSUPPORTED"
      | "HUMANISH_LAB_COMMS_UNSUPPORTED"
      | "HUMANISH_APP_URL_OPTION_CONFLICT"
      | "HUMANISH_BROWSER_APP_CAPTURE_FAILED"
      | "HUMANISH_LIVE_RUN_UNIMPLEMENTED"
      | "HUMANISH_INVALID_APP_URL"
      | "HUMANISH_INVALID_CWD"
      | "HUMANISH_INVALID_SIM_COUNT"
      | "HUMANISH_INVALID_TIMEOUT"
      | "HUMANISH_INVALID_PORT"
      | "HUMANISH_UNSUPPORTED_RERUN_FLAGS"
      | "HUMANISH_WATCH_OPTION_CONFLICT"
      // #316 CLI-loadable adopter scorer — fail-closed at load, pre-spend.
      | "HUMANISH_LAB_SCORER_BAD_REF"
      | "HUMANISH_LAB_SCORER_NOT_FOUND"
      | "HUMANISH_LAB_SCORER_LOAD_FAILED"
      | "HUMANISH_LAB_SCORER_NO_HOOKS"
      | "HUMANISH_LAB_SCORER_UNSUPPORTED_BACKEND";
    message: string;
  };
}

export interface CleanupResourceResult {
  provider: RunProviderResource["provider"];
  kind: RunProviderResource["kind"];
  id: string;
  status: "killed" | "already_clean" | "failed" | "skipped";
  message: string;
}

export interface CleanupAdapterResult {
  id: string;
  ok: boolean;
  message: string;
}

export interface CleanupResult {
  schema: typeof CLEANUP_SCHEMA;
  ok: boolean;
  cwd: string;
  run: string;
  runId?: string;
  bundlePath?: string;
  cleanupPath?: string;
  checkedAt: string;
  summary: {
    resources: number;
    killed: number;
    alreadyClean: number;
    failed: number;
    skipped: number;
  };
  resources: CleanupResourceResult[];
  adapterResults: CleanupAdapterResult[];
  warnings: string[];
  error?: {
    code: "HUMANISH_RUN_NOT_FOUND" | "HUMANISH_INVALID_RUN_BUNDLE";
    message: string;
  };
}

export interface RunPointer {
  schema: "humanish.latest-run.v1";
  runId: string;
  path: string;
  updatedAt: string;
}

export const CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA =
  "humanish.codex-app-server-trace.projected.v1";
