import { contradictsAccountBilling } from "./pricing.js";
import type { CommsReceivingEvidence } from "../comms/receiving-types.js";
import { isCommsReceivingEvidence } from "../comms/receiving-evidence.js";
import {
  desktopRecordingMetadataSchema,
  type RunDesktopRecording,
} from "../evidence/desktop-recording-types.js";
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

// The deterministic browser-persona driver lives in the scripted-browser-actor leaf module
// (moved there so the actor registry can reuse it without a run.ts import cycle). This file
// keeps the `run --app-url` orchestration; behavior is byte-identical.
import {
  browserSurfaces,
  builtinBrowserPersonaJourney,
  captureBrowserSurface,
  normalizeLocalAppUrl,
  parseBrowserPersonaJourneyFromScenario,
  resolveBrowserCommand,
  type BrowserPersonaJourney,
  type BrowserSurfaceCapture,
} from "../actors/scripted-browser.js";
import {
  CODEX_APP_SERVER_TRACE_SCHEMA,
  type CodexAppServerTrace,
} from "../actors/codex/app-server.js";
import {
  artifactReferenceIfWritten,
  hasWrittenScreenshot,
} from "../evidence/artifact-reference.js";
import {
  ACTOR_TRACE_SCHEMA,
  validActorExecutionProfile,
  validActorProviderRequests,
  type ActorStatus,
  type ActorTrace,
  type ActorTraceItem,
} from "../actors/contract.js";
import {
  cuaGoalSource,
  isCuaTrace,
  CUA_COMPLETION_NOTE,
  type CuaGoalSource,
} from "../actors/goal-source.js";
import { actorEnding } from "../actors/stop-cause.js";
import type { TaskFunnel } from "../lab/tasks.js";
import { captureGitState, GIT_STATE_SCHEMA, type CapturedGitState } from "./git-state.js";
import { screenshotEvidenceError } from "../evidence/image.js";
import { buildObserverData } from "../observer/data.js";
import { parseResolvedPersona, type ResolvedPersona } from "../lab/persona.js";
import { round6 } from "./pricing.js";
import { loadStudyAnalysis, listStudyAnalysisExecutions } from "../analysis/store.js";
import { isStudyAnalysisRecordPath, studyAnalysisSharingProblems } from "../analysis/sharing.js";
import { containsSensitive, digestText, redactText } from "../evidence/redaction.js";
import type { E2BDesktopModule } from "../substrates/e2b/desktop-launch.js";
import {
  bindExistingRunArtifactPaths,
  RUNS_RELATIVE_ROOT,
  isSafeRunIdSegment,
  prepareRunArtifactPaths,
  resolveExistingRunDirectory,
  resolveLatestRunDirectory,
  resolveRunsRoot,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import { probeKeySources } from "../cli/key-resolution.js";
import {
  beginRunStatus,
  withRunStatusScope,
  type RunLabProvenance,
  type RunStatusHandle,
} from "./status.js";
import { nodeSupportsTui, terminalSurfaceMessage, tuiBundleUrl } from "../tui/contract.js";
import {
  detectLocalAgents,
  localAgentDoctorMessage,
  type DetectLocalAgentsOptions,
} from "../actors/local-agent/cli.js";
import { labSetupChecks } from "../lab/doctor.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  bindExistingManagedHumanishOutputDirectory,
  prepareContainedOutputDirectory,
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  openContainedRegularFile,
  type PreparedSelectedOutputDirectory,
  writeContainedOutputFile,
  writePreparedRunLatestPointer,
} from "./selected-output-paths.js";

export const RUN_BUNDLE_SCHEMA = "humanish.run-bundle.v1";
export const SHARED_WORLD_SCHEMA = "humanish.shared-world.v1";
export const REVIEW_SCHEMA = "humanish.review.v1";
export const VERIFY_SCHEMA = "humanish.verify-result.v1";
export const RUNS_SCHEMA = "humanish.runs-result.v1";
export const DOCTOR_SCHEMA = "humanish.doctor-result.v1";
export const CLEANUP_SCHEMA = "humanish.cleanup-result.v1";
export const PUBLIC_TARGET_CWD = "[target-cwd]";
const SAFE_GIT_NOTES = new Set([
  "Git command could not be started.",
  "Git HEAD capture timed out.",
  "Git HEAD command could not be started.",
  "Git metadata could not be inspected safely.",
  "Git status command could not be captured.",
  "Git status command could not be started.",
  "Git status could not be captured.",
  "Git status capture timed out.",
  "Git metadata failed containment validation.",
  "Git ref-state capture timed out.",
  "Git ref-state command could not be started.",
  "Git work-tree detection timed out.",
  "Git work tree had changes; only counts were captured, not branch names, remotes, paths, or file names.",
  "Git work tree was clean; branch names, remotes, paths, and file names were not captured.",
  "No git work tree was detected.",
  "public-safe synthetic fixture",
  "public-safe synthetic OSS meta-lab fixture",
]);

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

export interface RunStreamCompletion {
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

export interface RunSetupQualitySnapshot {
  schema: "humanish.setup-quality.v1";
  generatedAt: string;
  redaction: {
    status: "passed";
    rawPreviews: "included" | "suppressed";
    notes: string;
  };
  summary: string;
  status: "passed" | "needs_review" | "blocked";
  checks: Array<{
    id: string;
    label: string;
    ok: boolean;
    detail: string;
  }>;
  tree: Array<{
    path: string;
    type: "file" | "directory";
    sizeBytes?: number;
  }>;
  previews: Array<{
    path: string;
    language: "json" | "yaml" | "typescript" | "markdown" | "text";
    truncated: boolean;
    text: string;
  }>;
  studyQuality?: {
    schema: "humanish.study-quality.v1";
    rating: "none" | "ceremonial" | "useful" | "high_leverage";
    summary: string;
    checks: Array<{
      id: string;
      label: string;
      ok: boolean;
      detail: string;
    }>;
    signals: {
      appUrlProofBlocked: boolean;
      appUrlProofMentioned: boolean;
      actorInsightCaptured: boolean;
      coverageCustomized: boolean;
      personaCustomized: boolean;
      scenarioCustomized: boolean;
    };
  };
  packageScripts: Record<string, string>;
  humanish: {
    configPresent: boolean;
    personaCount: number;
    scenarioCount: number;
    packageScriptPresent: boolean;
    gitignoreContainsRuntimeIgnore: boolean;
  };
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

/** Tally participant outcomes from actor statuses. Statuses this does not recognise are counted in
 *  `total` but nowhere else, so the parts can never exceed the whole. */
export function tallyParticipantOutcomes(
  statuses: readonly ActorStatus[],
  /** Per-participant: did this one report friction or a defect? Same order as `statuses`. */
  reportedFriction: readonly boolean[] = [],
): ParticipantOutcomes {
  const tally: ParticipantOutcomes = {
    total: statuses.length,
    reachedGoal: 0,
    abandoned: 0,
    ranOut: 0,
    blocked: 0,
    harnessFailed: 0,
    reportedFriction: reportedFriction.filter(Boolean).length,
  };
  for (const status of statuses) {
    if (status === "passed") tally.reachedGoal += 1;
    else if (status === "abandoned") tally.abandoned += 1;
    else if (status === "incomplete" || status === "timed_out") tally.ranOut += 1;
    else if (status === "blocked") tally.blocked += 1;
    else if (status === "failed") tally.harnessFailed += 1;
  }
  return tally;
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

/** Roll per-participant funnels up into the study funnel. Undefined when nothing measured one. */
export function aggregateTaskFunnels(funnels: readonly TaskFunnel[]): StudyTaskFunnel | undefined {
  if (funnels.length === 0) return undefined;
  const order: string[] = [];
  const byId = new Map<
    string,
    { completed: number; sessions: number; observable: boolean; unmeasured: number }
  >();
  for (const funnel of funnels) {
    for (const task of funnel.tasks) {
      let entry = byId.get(task.id);
      if (entry === undefined) {
        entry = { completed: 0, sessions: 0, observable: false, unmeasured: 0 };
        byId.set(task.id, entry);
        order.push(task.id);
      }
      entry.sessions += 1;
      if (task.completed) entry.completed += 1;
      if (task.observable) entry.observable = true;
      if (task.inputsObserved === false) entry.unmeasured += 1;
    }
  }
  return {
    sessions: funnels.length,
    tasks: order.map((id) => {
      const entry = byId.get(id)!;
      return {
        id,
        completed: entry.completed,
        sessions: entry.sessions,
        observable: entry.observable,
        unmeasured: entry.unmeasured,
      };
    }),
  };
}

/** The funnel as one line, denominator on every number: `signup 2/2 · verify-email 1/2`. */
export function formatStudyTaskFunnel(funnel: StudyTaskFunnel): string {
  if (funnel.tasks.length === 0) return "no tasks declared";
  return funnel.tasks
    .map((task) => {
      if (!task.observable) return `${task.id} (no completion criterion)`;
      // A count that is entirely unmeasured must not render as a bare "0/3": that reads as a
      // participant failure when it is our observer that produced nothing (#514).
      if (task.unmeasured === task.sessions) {
        return `${task.id} (never measured in ${task.sessions})`;
      }
      const caveat = task.unmeasured > 0 ? ` (${task.unmeasured} never measured)` : "";
      return `${task.id} ${task.completed}/${task.sessions}${caveat}`;
    })
    .join(" · ");
}

type ParticipantOutcomeDetail = { status: ActorStatus; label?: string; goalSource?: CuaGoalSource };

function participantCompletionLine(
  outcomes: ParticipantOutcomes,
  terminalCauses: readonly ParticipantOutcomeDetail[],
): string {
  const completions = terminalCauses.filter((entry) => entry.status === "passed");
  const reported = completions.filter((entry) => entry.goalSource === "participant_report").length;
  const matched = completions.filter((entry) => entry.goalSource === "condition_matched").length;
  let goalLine =
    outcomes.reachedGoal === 0
      ? `0/${outcomes.total} recorded completions`
      : `${outcomes.reachedGoal}/${outcomes.total} reached the goal`;
  if (outcomes.reachedGoal > 0 && terminalCauses.some((entry) => entry.goalSource !== undefined)) {
    const count = `${outcomes.reachedGoal}/${outcomes.total}`;
    goalLine =
      completions.length !== outcomes.reachedGoal
        ? `${count} recorded completions (completion source unavailable)`
        : reported === outcomes.reachedGoal
          ? `${count} reported reaching the goal`
          : matched === outcomes.reachedGoal
            ? `${count} met a recorded completion condition`
            : `${count} recorded completions (${[
                reported > 0 ? `${reported} participant-reported` : undefined,
                matched > 0 ? `${matched} condition-matched` : undefined,
                outcomes.reachedGoal - reported - matched > 0
                  ? `${outcomes.reachedGoal - reported - matched} other or unavailable source`
                  : undefined,
              ]
                .filter(Boolean)
                .join(", ")})`;
  }
  return goalLine;
}

/** One line a stakeholder can read, with the denominator attached to every number. */
export function formatParticipantOutcomes(
  outcomes: ParticipantOutcomes,
  terminalCauses: readonly ParticipantOutcomeDetail[] = [],
): string {
  if (outcomes.total === 0) return "no participants reached a terminal state";
  const parts: string[] = [participantCompletionLine(outcomes, terminalCauses)];
  // Detail may explain a recorded outcome, but must never change its count or invent a match
  // between a tally and an incomplete set of traces.
  const append = (count: number, statuses: readonly ActorStatus[], fallback: string) => {
    if (count === 0) return;
    const matching = terminalCauses.filter((entry) => statuses.includes(entry.status));
    if (matching.length !== count) {
      parts.push(`${count} ${fallback}`);
      return;
    }
    const counts = new Map<string, number>();
    for (const entry of matching) {
      const description = entry.label === undefined ? fallback : `interrupted (${entry.label})`;
      counts.set(description, (counts.get(description) ?? 0) + 1);
    }
    for (const [description, n] of counts) parts.push(`${n} ${description}`);
  };
  append(outcomes.abandoned, ["abandoned"], "gave up");
  append(outcomes.ranOut, ["incomplete", "timed_out"], "interrupted (stop details unavailable)");
  // "blocked" covers an approval the run could not give AND a blocker the participant reported in
  // its own words (#476); the old "on an approval" read wrongly on a keyboard-first participant who
  // wrote "Blocked before diagram creation" about a mouse-only modal.
  if (outcomes.blocked > 0) parts.push(`${outcomes.blocked} blocked`);
  append(outcomes.harnessFailed, ["failed"], "lost to a harness failure");
  // Last, and separate, because it cuts across the outcomes rather than partitioning them: someone
  // can reach the goal and still have found the road there broken.
  if (outcomes.reportedFriction > 0) parts.push(`${outcomes.reportedFriction} reported friction`);
  return parts.join(", ");
}

/** Presentation details tolerate optional legacy actor payloads without changing their tallies. */
export function participantOutcomeDetails(
  streams: readonly { actor?: unknown; status?: unknown }[],
): ParticipantOutcomeDetail[] {
  return streams.flatMap((stream) => {
    if (!isRecord(stream.actor)) return [];
    const actor = stream.actor;
    const goalSource = cuaGoalSource(actor, stream.status);
    if (
      !["passed", "abandoned", "incomplete", "blocked", "timed_out", "failed"].includes(
        String(actor.status),
      )
    ) {
      return goalSource === "unavailable" ? [{ status: "passed" as const, goalSource }] : [];
    }
    const ending =
      Array.isArray(actor.items) && actor.items.every(isRecord)
        ? actorEnding(actor as unknown as ActorTrace)
        : undefined;
    return [
      {
        status: actor.status as ActorStatus,
        ...(ending === undefined ? {} : { label: ending.label }),
        ...(goalSource === undefined ? {} : { goalSource }),
      },
    ];
  });
}

/** Refresh a CUA completion claim from recorded traces, leaving original evidence and enums intact. */
export function withCuaReviewProvenance(
  review: ReviewSummary,
  streams: readonly { actor?: unknown; status?: unknown }[],
): ReviewSummary {
  const details = participantOutcomeDetails(streams);
  if (
    !isRecord(review.participants) ||
    ![
      "total",
      "reachedGoal",
      "abandoned",
      "ranOut",
      "blocked",
      "harnessFailed",
      "reportedFriction",
    ].every((key) =>
      isNonNegativeSafeInteger((review.participants as unknown as Record<string, unknown>)[key]),
    ) ||
    (review.participants.reachedGoal === 0
      ? !streams.some((stream) => isCuaTrace(stream.actor))
      : !details.some((entry) => entry.goalSource !== undefined))
  )
    return review;
  const outcomes = formatParticipantOutcomes(review.participants, details);
  // Preserve rerun context, participant narration and adapter-specific findings. Refreshing a
  // historical summary qualifies its old tally instead of silently discarding that context.
  const header = `Run gate: ${review.verdict}. Participants: ${outcomes}.${review.tasks ? ` Tasks: ${formatStudyTaskFunnel(review.tasks)}.` : ""}`;
  const prefix = `${header} Recorded summary: `;
  const recorded = review.summary.startsWith(prefix)
    ? review.summary.slice(prefix.length)
    : review.summary;
  const oldGoal = `${review.participants.reachedGoal}/${review.participants.total} reached the goal`;
  const qualified = recorded
    .split(oldGoal)
    .join(participantCompletionLine(review.participants, details));
  return {
    ...review,
    summary: `${prefix}${qualified}`,
    gaps:
      review.participants.reachedGoal === 0
        ? review.gaps
        : [...review.gaps.filter((gap) => gap !== CUA_COMPLETION_NOTE), CUA_COMPLETION_NOTE],
  };
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

export interface VerifyResult {
  schema: typeof VERIFY_SCHEMA;
  ok: boolean;
  /** Only present when source evidence verifies but derived analysis failed the public-safety scan. */
  recordingOk?: boolean;
  cwd: string;
  run: string;
  bundlePath?: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
  }>;
  shareSafety: {
    status: "share_ready" | "local_only" | "blocked";
    reasons: Array<{
      code:
        | "VERIFY_FAILED"
        | "PUBLIC_SAFETY_FINDINGS"
        | "ANALYSIS_UNVERIFIED"
        | "RAW_SCREENSHOTS"
        | "CONTINUOUS_MEDIA"
        | "REAL_COMMUNICATIONS";
      message: string;
    }>;
  };
  // Advisory postures the operator must see (e.g. raw full-fidelity screenshots) that never
  // flip ok: overriding a default is supported, but ok: true must not read as "share-ready".
  warnings: string[];
  error?: {
    code: "HUMANISH_RUN_NOT_FOUND" | "HUMANISH_INVALID_RUN_BUNDLE";
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

export interface RunCleanupHooks {
  /** @deprecated Ignored. Stored provider ids are not authority to load or mutate a provider. */
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  cleanupAdapterResources?: (ctx: {
    cwd: string;
    runDir: string;
    bundle: RunBundle;
  }) => Promise<CleanupAdapterResult[]>;
  now?: () => Date;
}

export interface RunsResult {
  schema: typeof RUNS_SCHEMA;
  ok: boolean;
  cwd: string;
  runs: Array<{
    runId: string;
    createdAt: string | null;
    mode: string | null;
    path: string;
  }>;
  latest: string | null;
  error?: {
    code: "HUMANISH_RUNS_UNAVAILABLE";
    message: string;
  };
}

export interface DoctorResult {
  schema: typeof DOCTOR_SCHEMA;
  ok: boolean;
  cwd: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
    /**
     * ADDITIVE + OPTIONAL. `false` means the check never ran — the directory could not be read, so
     * there is nothing to report about it either way. Absent means it ran and `ok` is its verdict.
     *
     * It exists because a failed check and an unrun one used to render identically, and the unrun
     * rows carried the SUCCESS text: a participant read `missing package.json: package.json is
     * present and safe to read` off a real screen (labs/tui-self-study.yaml).
     */
    checked?: boolean;
  }>;
}

interface RunPointer {
  schema: "humanish.latest-run.v1";
  runId: string;
  path: string;
  updatedAt: string;
}

const CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA = "humanish.codex-app-server-trace.projected.v1";

const BROWSER_APP_DEFAULT_TIMEOUT_MS = 300_000;

const builtinPersona = {
  id: "builtin-synthetic-new-user",
  name: "Built-in Synthetic New User",
  source: "builtin:synthetic-new-user",
  sourceDigest: "builtin",
};

const builtinScenario = {
  id: "builtin-first-run-smoke",
  title: "Built-in First-Run Smoke",
  goal: "Create a public-safe dry-run contract bundle from built-in defaults.",
  source: "builtin:first-run-smoke",
  sourceDigest: "builtin",
};

/**
 * The synthetic/local backends. The body runs inside a status scope so that returning from it —
 * by any of its exits, including the fail-closed ones — finalizes whatever status records it
 * opened. See `withRunStatusScope`.
 */
export async function runDryRun(options: RunOptions): Promise<RunResult> {
  return withRunStatusScope(() => runDryRunInScope(options));
}

async function runDryRunInScope(options: RunOptions): Promise<RunResult> {
  const cwd = path.resolve(options.cwd);
  const cwdError = await validateCwd(cwd);
  const warnings: string[] = [];

  if (cwdError) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: cwdError,
    };
  }

  const simCount = normalizeSimCount(options.appUrl ? (options.simCount ?? 2) : options.simCount);
  if (simCount === null) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "HUMANISH_INVALID_SIM_COUNT",
        message: "--sims must be a positive integer.",
      },
    };
  }

  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(cwd), cwd);

  if (options.appUrl !== undefined) {
    if (options.dryRun) {
      return {
        schema: "humanish.run-result.v1",
        ok: false,
        cwd,
        warnings,
        error: {
          code: "HUMANISH_APP_URL_OPTION_CONFLICT",
          message: "Use --app-url for a live browser app proof; remove --dry-run.",
        },
      };
    }

    if (simCount > 2) {
      return {
        schema: "humanish.run-result.v1",
        ok: false,
        cwd,
        warnings,
        error: {
          code: "HUMANISH_INVALID_SIM_COUNT",
          message: "--sims must be 1 or 2 when --app-url is used.",
        },
      };
    }

    return runBrowserAppProof({ ...options, appUrl: options.appUrl, cwd, projectRoot, simCount });
  }

  if (!options.dryRun) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "HUMANISH_LIVE_RUN_UNIMPLEMENTED",
        message:
          "Only run --dry-run is implemented here. Use --app-url for a live browser capture, or run a lab for a live study.",
      },
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId =
    options.runId ?? `dryrun-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const packageName = await readPackageName(projectRoot);
  const humanishSource = (await implicitProjectDirectoryExists(projectRoot, "humanish"))
    ? "present"
    : "missing";
  const source = await buildRunSource({ cwd, capturedAt: createdAt, humanishSource, packageName });
  const selection = await loadDryRunSelection(projectRoot, humanishSource);
  await assertPreparedSelectedOutputDirectory(projectRoot);
  const runPaths = await prepareRunArtifactPaths(cwd, runId);
  // Identity + liveness on disk (#455): uniform across every route, so a reader classifies any
  // run from one small file instead of parsing bundles.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: options.dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab }),
  });
  const artifactRoot = runPaths.relativeRunRoot;

  if (humanishSource === "missing") {
    warnings.push(
      "Committed humanish/ source was not found; using built-in synthetic dry-run defaults.",
    );
  }
  warnings.push(...selection.warnings);

  const observerFixtures = buildSyntheticObserverFixtures({
    createdAt,
    personaId: selection.persona.id,
    scenarioId: selection.scenario.id,
    simCount,
  });

  const bundle: RunBundle = {
    schema: RUN_BUNDLE_SCHEMA,
    runId,
    mode: "dry-run",
    simCount,
    createdAt,
    cwd,
    artifactRoot,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    source,
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: `Synthetic dry-run contract bundle created with ${simCount} sim${simCount === 1 ? "" : "s"}.`,
      },
      {
        at: createdAt,
        event: "persona.selected",
        message: "Selected public-safe synthetic persona.",
      },
      {
        at: createdAt,
        event: "scenario.selected",
        message: "Selected public-safe first-run scenario.",
      },
      {
        at: createdAt,
        event: "review.skeleton.created",
        message: "Created review skeleton without claiming product proof.",
      },
    ],
    simulations: observerFixtures.simulations,
    streams: observerFixtures.streams,
    events: observerFixtures.events,
    redaction: {
      status: "passed",
      notes: "Dry-run bundle contains synthetic contract proof only.",
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson",
    },
    review: createReviewSummary(),
    feedbackCandidates: [],
  };

  await writeRunBundleArtifacts(runPaths, bundle, runStatus);
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify(
      {
        schema: "humanish.latest-run.v1",
        runId,
        path: artifactRoot,
        updatedAt: createdAt,
      } satisfies RunPointer,
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    schema: "humanish.run-result.v1",
    ok: true,
    runId,
    mode: "dry-run",
    simCount,
    cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: runPaths.relativeLatestPointer,
    warnings,
  };
}

async function runBrowserAppProof(
  options: RunOptions & {
    appUrl: string;
    cwd: string;
    projectRoot: PreparedSelectedOutputDirectory;
    simCount: number;
  },
): Promise<RunResult> {
  const warnings: string[] = [];
  const appUrl = normalizeLocalAppUrl(options.appUrl);
  if (!appUrl) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_INVALID_APP_URL",
        message: "--app-url must be an http(s) loopback URL such as http://127.0.0.1:5173.",
      },
    };
  }

  const browserCommand = await resolveBrowserCommand();
  if (!browserCommand) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_BROWSER_APP_CAPTURE_FAILED",
        message:
          "No Chrome/Chromium browser command was found. Set HUMANISH_BROWSER_COMMAND to a browser binary that supports --headless and --screenshot.",
      },
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId =
    options.runId ?? `browser-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const packageName = await readPackageName(options.projectRoot);
  const humanishSource = (await implicitProjectDirectoryExists(options.projectRoot, "humanish"))
    ? "present"
    : "missing";
  const source = await buildRunSource({
    cwd: options.cwd,
    capturedAt: createdAt,
    humanishSource,
    packageName,
  });
  const selection = await loadDryRunSelection(options.projectRoot, humanishSource);
  await assertPreparedSelectedOutputDirectory(options.projectRoot);
  const runPaths = await prepareRunArtifactPaths(options.cwd, runId);
  // Identity + liveness on disk (#455): uniform across every route, so a reader classifies any
  // run from one small file instead of parsing bundles.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: options.dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab }),
  });
  const artifactRoot = runPaths.relativeRunRoot;
  if (selection.browserJourneyFailure) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings: [...warnings, ...selection.warnings],
      error: {
        code: "HUMANISH_BROWSER_APP_CAPTURE_FAILED",
        message: selection.browserJourneyFailure,
      },
    };
  }

  const browserJourney = selection.browserJourney ?? builtinBrowserPersonaJourney();
  if (humanishSource === "missing") {
    warnings.push(
      "Committed humanish/ source was not found; using built-in synthetic browser-app defaults.",
    );
  }
  if (!selection.browserJourney) {
    warnings.push(
      "No executable browser scenario manifest was found; using built-in browser persona two-step journey.",
    );
  }
  warnings.push(...selection.warnings);

  await prepareContainedOutputDirectory(runPaths, "screenshots");
  await prepareContainedOutputDirectory(runPaths, "traces");

  const surfaces = browserSurfaces.slice(0, options.simCount);
  const captures = await Promise.all(
    surfaces.map((surface) =>
      captureBrowserSurface({
        absoluteArtifactRoot: runPaths,
        appUrl,
        browserCommand,
        browserJourney,
        surface,
        timeoutMs: options.timeoutMs ?? BROWSER_APP_DEFAULT_TIMEOUT_MS,
      }),
    ),
  );
  await validatePreparedRunArtifactPaths(runPaths);
  const completedAt = new Date().toISOString();
  const events = buildBrowserAppEvents({ appUrl, captures, createdAt });
  const allPassed = captures.every((capture) => capture.ok);
  const review = createBrowserAppReviewSummary({ appUrl, browserJourney, captures });
  const bundle: RunBundle = {
    schema: RUN_BUNDLE_SCHEMA,
    runId,
    mode: "live",
    simCount: captures.length,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    source,
    persona: {
      id: selection.persona.id,
      name: selection.persona.name,
      source: selection.persona.source,
      sourceDigest: selection.persona.sourceDigest,
    },
    scenario: {
      id: browserJourney.scenarioId,
      title: browserJourney.scenarioTitle,
      goal: browserJourney.goal,
      source: browserJourney.source,
      sourceDigest: browserJourney.sourceDigest,
    },
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: `Live browser persona proof created for ${appUrl}.`,
      },
      {
        at: createdAt,
        event: "app.url.accepted",
        message: "Accepted public-safe loopback app URL for browser persona journey.",
      },
      {
        at: completedAt,
        event: "review.created",
        message: allPassed
          ? "Created review from desktop/mobile browser persona step evidence."
          : "Created review with missing or blocked browser persona step evidence.",
      },
    ],
    simulations: captures.map((capture, index) => {
      const simId = `browser-${capture.surface.id}`;
      const streamId = `${simId}-stream`;
      return {
        id: simId,
        index: index + 1,
        personaId: selection.persona.id,
        scenarioId: browserJourney.scenarioId,
        status: capture.ok ? "passed" : "blocked",
        streamKind: "browser",
        mode: "browser-sim",
        progress: 100,
        currentStep: capture.ok
          ? `${capture.surface.label} completed ${capture.steps.length} persona steps`
          : `${capture.surface.label} journey blocked`,
        summary: capture.reason,
        streamIds: [streamId],
        startedAt: createdAt,
        updatedAt: capture.capturedAt,
      };
    }),
    streams: captures.map((capture) => {
      const simId = `browser-${capture.surface.id}`;
      const streamId = `${simId}-stream`;
      // Never reference a screenshot the producer did not write (artifact-reference.ts).
      // A blocked capture whose evidence IS the failure carries no surface screenshot, so
      // we omit the embed URL + ui.screenshotUrl and keep the stream present with its
      // blocked status — instead of claiming an artifact that verify would fail closed on.
      // A capture that claims success but is missing its screenshot still keeps the
      // reference so missingLocalEvidenceArtifacts can catch the broken producer.
      const surfaceScreenshot = hasWrittenScreenshot(capture) ? capture.screenshotPath : undefined;
      const screenshotUrl = surfaceScreenshot ? `../${surfaceScreenshot}` : undefined;
      return {
        id: streamId,
        simId,
        kind: "browser",
        label: capture.surface.label,
        status: capture.ok ? "passed" : "blocked",
        transport: "snapshot",
        updatedAt: capture.capturedAt,
        embed: screenshotUrl
          ? { kind: "screenshot", url: screenshotUrl, title: capture.surface.label }
          : {
              kind: "placeholder",
              title: `${capture.surface.label} (blocked — no screenshot captured)`,
            },
        viewport: capture.surface.viewport,
        ui: {
          appStatus: capture.ok ? "running" : "blocked",
          appUrl,
          route: appUrl,
          intent: browserJourney.goal,
          ...(screenshotUrl ? { screenshotUrl } : {}),
          state: capture.reason,
          visualStatus: capture.ok ? "visible" : "blocked",
        },
        completion: {
          checkedAt: capture.capturedAt,
          exitCode: capture.ok ? 0 : 1,
          reason: capture.reason,
          status: capture.ok ? "passed" : "blocked",
        },
        artifacts: [
          { label: "run bundle", path: "run.json", kind: "bundle" },
          { label: "review", path: "review.md", kind: "review" },
          { label: "event log", path: "events.ndjson", kind: "events" },
          { label: `${capture.surface.id} browser trace`, path: capture.tracePath, kind: "trace" },
          // Per-step screenshot artifacts only for steps whose screenshot was actually
          // written; blocked-not-executed steps recorded no path and claim nothing.
          ...capture.steps.flatMap((step) => {
            const stepScreenshot = artifactReferenceIfWritten(
              step.screenshotPath,
              hasWrittenScreenshot(step),
            );
            return stepScreenshot
              ? [
                  {
                    label: `${capture.surface.id} ${step.id} screenshot`,
                    path: stepScreenshot,
                    kind: "screenshot" as const,
                  },
                ]
              : [];
          }),
        ],
      } satisfies RunStream;
    }),
    events,
    redaction: {
      status: "passed",
      notes:
        "Browser persona proof stores loopback app URLs, screenshots, and generated traces only; secret-like text is rejected by verify.",
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson",
    },
    review,
    feedbackCandidates: [],
  };

  await writeRunBundleArtifacts(runPaths, bundle, runStatus);
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify(
      {
        schema: "humanish.latest-run.v1",
        runId,
        path: artifactRoot,
        updatedAt: completedAt,
      } satisfies RunPointer,
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    schema: "humanish.run-result.v1",
    ok: allPassed,
    runId,
    mode: "live",
    simCount: captures.length,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: runPaths.relativeLatestPointer,
    warnings,
    ...(allPassed
      ? {}
      : {
          error: {
            code: "HUMANISH_BROWSER_APP_CAPTURE_FAILED" as const,
            message: review.summary,
          },
        }),
  };
}

function buildBrowserAppEvents(args: {
  appUrl: string;
  captures: BrowserSurfaceCapture[];
  createdAt: string;
}): RunEvent[] {
  const events: RunEvent[] = [
    {
      id: "event-001",
      at: args.createdAt,
      level: "info",
      type: "browser-persona.run.created",
      message: "Created live browser persona proof run against a loopback URL.",
    },
  ];

  args.captures.forEach((capture) => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: capture.capturedAt,
      level: capture.ok ? "info" : "warn",
      type: capture.ok ? "browser-persona.journey.passed" : "browser-persona.journey.blocked",
      message: `${capture.surface.id}: ${capture.reason}`,
      simId: `browser-${capture.surface.id}`,
      streamId: `browser-${capture.surface.id}-stream`,
    });
    for (const step of capture.steps) {
      events.push({
        id: `event-${String(events.length + 1).padStart(3, "0")}`,
        at: step.completedAt,
        level: step.status === "passed" ? "info" : "warn",
        type:
          step.status === "passed" ? "browser-persona.step.passed" : "browser-persona.step.blocked",
        message: `${capture.surface.id} ${step.id}: ${step.reason}`,
        simId: `browser-${capture.surface.id}`,
        streamId: `browser-${capture.surface.id}-stream`,
      });
    }
  });

  return events;
}

function createBrowserAppReviewSummary(args: {
  appUrl: string;
  browserJourney: BrowserPersonaJourney;
  captures: BrowserSurfaceCapture[];
}): ReviewSummary {
  const passed = args.captures.filter((capture) => capture.ok).length;
  const allPassed = passed === args.captures.length;
  const usedBuiltinFallback = args.browserJourney.source.startsWith("builtin:");
  return {
    schema: REVIEW_SCHEMA,
    verdict: allPassed ? "pass" : "blocked",
    summary: allPassed
      ? `Completed ${passed}/${args.captures.length} live browser persona journey${args.captures.length === 1 ? "" : "s"} from ${args.appUrl} using ${args.browserJourney.scenarioId}.`
      : `Completed ${passed}/${args.captures.length} live browser persona journeys from ${args.appUrl} using ${args.browserJourney.scenarioId}; at least one required journey was blocked.`,
    gaps: [
      usedBuiltinFallback
        ? "This proof used the built-in two-step fallback because no executable browser scenario manifest was found."
        : `This proof used executable browser steps from ${args.browserJourney.source}.`,
      "Only loopback app URLs are accepted so generated bundles do not preserve private external targets.",
      ...args.captures
        .filter((capture) => !capture.ok)
        .map((capture) => `${capture.surface.id}: ${capture.reason}`),
    ],
  };
}

function buildSyntheticObserverFixtures(args: {
  createdAt: string;
  personaId: string;
  scenarioId: string;
  simCount: number;
}): {
  events: RunEvent[];
  simulations: RunSimulation[];
  streams: RunStream[];
} {
  const templates = [
    {
      kind: "ui" as const,
      mode: "browser-sim" as const,
      label: "UI journey",
      currentStep: "Route and viewport contract captured",
      summary:
        "Browser lane reserved for VNC playback, screenshots, route state, and interaction trace.",
      tail: "open target app\nresolve first-run route\ncapture viewport state\nrecord interaction trace",
      viewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
    },
    {
      kind: "terminal" as const,
      mode: "cli-sim" as const,
      label: "CLI actor",
      currentStep: "Command transcript contract captured",
      summary:
        "CLI lane reserved for command-by-command persona runs with stdout/stderr and artifact links.",
      // Every command in a shipped sample tail must be one the CLI actually accepts. This one
      // advertised a `--scenario` flag on `run` for months. That flag has never existed, and a
      // computer-use participant hit it in the first Observer it ever saw (#516).
      // tests/shipped-command-strings.test.ts now checks this against the real command table.
      tail: "$ humanish doctor\nok target cwd\nok humanish source\n$ humanish run first-run\ncontract proof emitted",
      viewport: undefined,
    },
    {
      kind: "tui" as const,
      mode: "tui-sim" as const,
      label: "TUI actor",
      currentStep: "Terminal UI frame contract captured",
      summary:
        "TUI lane reserved for PTY bytes, ANSI rendering, focus replay, and optional assisted attach.",
      tail: "\u001b[2mHumanish TUI frame\u001b[0m\n> persona: skeptical-power-user\n> scenario: onboarding-regression\nstatus: awaiting live PTY transport",
      viewport: undefined,
    },
    {
      kind: "codex-ui" as const,
      mode: "codex-app-sim" as const,
      label: "Codex UI",
      currentStep: "App-server embed contract captured",
      summary:
        "Codex UI lane reserved for app-server sessions that can be watched beside terminal evidence.",
      tail: "codex-app-server session contract\nstate: not_connected\nembed: pending provider URL\nreceipts: planned",
      viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    },
  ];

  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [
    {
      id: "event-000",
      at: args.createdAt,
      level: "info",
      type: "observer.contract.created",
      message: "Created public-safe observer stream contract.",
    },
  ];

  for (let index = 0; index < args.simCount; index += 1) {
    const template = templates[index % templates.length];
    if (!template) {
      throw new Error("Synthetic observer template missing.");
    }
    const simId = `sim-${String(index + 1).padStart(2, "0")}`;
    const streamId = `${simId}-${template.kind}`;
    const status: RunSimulationStatus = "contract_proof_only";

    simulations.push({
      id: simId,
      index: index + 1,
      personaId: args.personaId,
      scenarioId: args.scenarioId,
      status,
      streamKind: template.kind,
      mode: template.mode,
      progress: 100,
      currentStep: template.currentStep,
      summary: template.summary,
      streamIds: [streamId],
      startedAt: args.createdAt,
      updatedAt: args.createdAt,
    });

    streams.push({
      id: streamId,
      simId,
      kind: template.kind,
      label: template.label,
      status,
      transport: streamTransport(template.kind),
      updatedAt: args.createdAt,
      embed: {
        kind: template.kind === "terminal" || template.kind === "tui" ? "terminal" : "placeholder",
        title: template.label,
      },
      ...(template.viewport ? { viewport: template.viewport } : {}),
      terminal: {
        title: template.label,
        format: template.kind === "tui" ? "ansi" : "plain",
        stdin: "disabled",
        tail: template.tail,
      },
      ...(template.kind === "ui" || template.kind === "codex-ui"
        ? {
            ui: {
              route: template.kind === "ui" ? "/first-run" : "/codex/session",
              intent: template.summary,
              state: "contract-only",
            },
          }
        : {}),
      ...(template.kind === "codex-ui"
        ? {
            codex: {
              provider: "codex-app-server" as const,
              state: "not_connected" as const,
              contract:
                "Observer accepts an app-server embed URL, session id, status feed, terminal receipt feed, and artifact links.",
            },
          }
        : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" },
        { label: "review", path: "review.md", kind: "review" },
        { label: "event log", path: "events.ndjson", kind: "events" },
      ],
    });

    events.push(
      {
        id: `event-${String(index + 1).padStart(3, "0")}-a`,
        at: args.createdAt,
        level: "info",
        type: "sim.contract.ready",
        message: `${template.label} stream contract ready.`,
        simId,
        streamId,
      },
      {
        id: `event-${String(index + 1).padStart(3, "0")}-b`,
        at: args.createdAt,
        level: "warn",
        type: "sim.live-substrate.missing",
        message:
          "No live actor launched in dry-run mode; observer lane is ready for real substrate evidence.",
        simId,
        streamId,
      },
    );
  }

  return { events, simulations, streams };
}

function streamTransport(kind: RunStreamKind): RunStream["transport"] {
  if (kind === "tui") return "pty";
  if (kind === "codex-ui") return "app-server";
  if (kind === "ui" || kind === "browser") return "polling";
  return "snapshot";
}

/**
 * Strip ANSI/control noise from a captured terminal transcript into stable, scannable text.
 * Pure (no IO). Exported so the terminal-product lane (src/routes/terminal/lab.ts) normalizes its
 * captured exec stream EXACTLY as the local-actor lanes do — the verdict-nonce scorer is only
 * sound against the same normalization the marker is matched on, so the logic must not diverge.
 */
export function normalizeLocalActorTranscript(transcript: string): string {
  return transcript
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[78=>]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Extract the per-run verdict from a normalized transcript: the agent must print exactly
 * `HUMANISH_ACTOR_VERDICT=<status> HUMANISH_ACTOR_NONCE=<nonce>`, and the nonce is mandatory so a
 * bare marker (echoed or replayed from untrusted text) can never forge a verdict. Pure (no IO).
 * Exported so the terminal-product lane scores its in-sandbox `codex exec` run by the SAME marker
 * — divergent verdict logic would let the two lanes disagree about what "passed" means.
 */
type ActorVerdict = "passed" | "blocked" | "failed";

export function extractLocalActorVerdict(
  transcript: string,
  verdictNonce: string,
): ActorVerdict | null {
  const compactTranscript = transcript.replace(/\s+/g, "");
  // The per-run nonce is mandatory: a bare HUMANISH_ACTOR_VERDICT=<status>
  // marker echoed by an actor (or replayed from untrusted text) must never
  // satisfy verdict extraction.
  const match = new RegExp(
    `HUMANISH_ACTOR_VERDICT=(passed|blocked|failed)HUMANISH_ACTOR_NONCE=${escapeRegExp(verdictNonce)}`,
    "i",
  ).exec(compactTranscript);
  if (!match) {
    return null;
  }

  return match[1]?.toLowerCase() as ActorVerdict;
}

function normalizeSimCount(value: number | undefined): number | null {
  if (value === undefined) {
    return 1;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    return null;
  }

  return value;
}

export async function verifyRun(cwdInput: string, runInput: string): Promise<VerifyResult> {
  const cwd = path.resolve(cwdInput);
  let runPaths: PreparedRunArtifactPaths | null;
  try {
    runPaths = await resolveRunPath(cwd, runInput);
  } catch {
    return invalidRunStorageVerifyResult(cwd, runInput);
  }
  return verifyPreparedRun(cwd, runInput, runPaths);
}

function invalidRunStorageVerifyResult(cwd: string, runInput: string): VerifyResult {
  return {
    schema: VERIFY_SCHEMA,
    ok: false,
    cwd,
    run: runInput,
    checks: [
      {
        name: "run storage containment",
        ok: false,
        message:
          "run storage must contain only identity-bound directories and single-link regular files",
      },
    ],
    shareSafety: {
      status: "blocked",
      reasons: [{ code: "VERIFY_FAILED", message: "Run storage failed containment validation." }],
    },
    warnings: [],
    error: {
      code: "HUMANISH_INVALID_RUN_BUNDLE",
      message: "Run storage failed containment validation.",
    },
  };
}

async function verifyPreparedRun(
  cwd: string,
  runInput: string,
  runPaths: PreparedRunArtifactPaths | null,
): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];

  if (!runPaths) {
    return {
      schema: VERIFY_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      checks,
      shareSafety: {
        status: "blocked",
        reasons: [
          {
            code: "VERIFY_FAILED",
            message: `Run not found: ${runInput}`,
          },
        ],
      },
      warnings: [],
      error: {
        code: "HUMANISH_RUN_NOT_FOUND",
        message: `Run not found: ${runInput}`,
      },
    };
  }

  const bundlePath = path.join(runPaths.absoluteRunRoot, "run.json");
  const bundle = await readRunJsonIfExists(runPaths, "run.json");
  const cleanupJson = await readRunJsonIfExists(runPaths, "cleanup.json");
  const reviewJson = await readRunJsonIfExists(runPaths, "review.json");
  const reviewMarkdown = await readRunTextIfExists(runPaths, "review.md");

  checks.push({
    name: "run.json exists",
    ok: bundle !== null,
    message: bundle === null ? "run.json missing" : "run.json present",
  });
  checks.push({
    name: "run schema",
    ok: isRecord(bundle) && bundle.schema === RUN_BUNDLE_SCHEMA,
    message: "run bundle schema is humanish.run-bundle.v1",
  });
  checks.push({
    name: "run bundle shape",
    ok: isRunBundle(bundle),
    message:
      "run bundle must include source, persona, scenario, lifecycle, simulations, streams, events, artifacts, review, and feedback candidates",
  });
  checks.push({
    name: "redaction passed",
    ok: isRecord(bundle) && isRecord(bundle.redaction) && bundle.redaction.status === "passed",
    message: "redaction status must be passed",
  });
  checks.push({
    name: "review artifacts exist",
    ok: reviewJson !== null && reviewMarkdown !== null,
    message: "review.json and review.md must exist",
  });
  const derivedPublicSafetyFindings: string[] = [];
  const publicSafetyFindings = await scanRunPublicSafetyArtifacts(
    runPaths,
    derivedPublicSafetyFindings,
    new Set(
      isRunBundle(bundle)
        ? bundle.streams.flatMap((stream) => (stream.recording ? [stream.recording.path] : []))
        : [],
    ),
  );
  // JSON escapes can hide a sensitive value from the byte scan while the
  // decoded recording exposes it to Observer, feedback, or analysis input.
  if (
    publicSafetyFindings.length < 50 &&
    bundle !== null &&
    containsSensitivePattern(JSON.stringify(bundle))
  ) {
    publicSafetyFindings.push("sensitive decoded run.json");
  }
  checks.push({
    name: "public-safety scan",
    ok: publicSafetyFindings.length === 0,
    message:
      publicSafetyFindings.length === 0
        ? "run text artifacts and public-proof paths must not match known secret or browser-profile patterns"
        : `public-safety findings: ${publicSafetyFindings.slice(0, 5).join(", ")}`,
  });
  const missingEvidenceArtifacts = isRunBundle(bundle)
    ? await missingLocalEvidenceArtifacts(runPaths, bundle)
    : [];
  const invalidEvidenceReferences = isRunBundle(bundle) ? invalidRunEvidenceReferences(bundle) : [];
  checks.push({
    name: "local evidence artifacts exist",
    ok: missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0,
    message:
      missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0
        ? "referenced local screenshot/trace/log/filesystem artifacts are present"
        : invalidEvidenceReferences.length > 0
          ? `invalid evidence artifact references: ${invalidEvidenceReferences.join(", ")}`
          : `missing local evidence artifacts: ${missingEvidenceArtifacts.join(", ")}`,
  });
  const terminalProductFindings = isRunBundle(bundle)
    ? await validateTerminalProductEvidence(runPaths, bundle)
    : [];
  checks.push({
    name: "terminal-product evidence",
    ok: terminalProductFindings.length === 0,
    message:
      terminalProductFindings.length === 0
        ? "live terminal-product streams either are absent or carry the substrate/cleanup/interventions/cost ledgers + a ledger-derived no-spend proof + redacted terminal evidence, with proven teardown and known spend within the declared cap"
        : `terminal-product findings: ${terminalProductFindings.join(", ")}`,
  });
  const codexAppServerFindings = isRunBundle(bundle)
    ? await validateCodexAppServerEvidence(runPaths, bundle)
    : [];
  checks.push({
    name: "codex app-server evidence",
    ok: codexAppServerFindings.length === 0,
    message:
      codexAppServerFindings.length === 0
        ? "live Codex app-server streams either are absent or include valid redacted trace evidence"
        : `codex app-server findings: ${codexAppServerFindings.join(", ")}`,
  });
  const noEngagementFindings = isRunBundle(bundle) ? noEngagementActorFindings(bundle) : [];
  checks.push({
    name: "actor engagement",
    ok: noEngagementFindings.length === 0,
    message:
      noEngagementFindings.length === 0
        ? "live actor traces that claim goal_satisfied carry at least one action or message"
        : `no-engagement findings: ${noEngagementFindings.join(", ")} — a hollow run is not credible evidence`,
  });
  const actorVerdictFindings = isRunBundle(bundle) ? actorVerdictConsistencyFindings(bundle) : [];
  checks.push({
    name: "actor verdict consistency",
    ok: actorVerdictFindings.length === 0,
    message:
      actorVerdictFindings.length === 0
        ? "live pass verdicts do not hide failed, blocked, or timed-out actor traces"
        : `actor verdict findings: ${actorVerdictFindings.join(", ")}`,
  });
  const stateFindings = isRunBundle(bundle) ? subjectStateFindings(bundle) : [];
  checks.push({
    name: "subject state provenance",
    ok: stateFindings.length === 0,
    message:
      stateFindings.length === 0
        ? "subject state claims match the recorded seed/external evidence (or the subject block is honestly absent)"
        : `subject state findings: ${stateFindings.join(", ")}`,
  });
  const sharedWorldFindings = isRunBundle(bundle) ? sharedWorldEvidenceFindings(bundle) : [];
  checks.push({
    name: "shared-world evidence",
    ok: sharedWorldFindings.length === 0,
    message:
      sharedWorldFindings.length === 0
        ? "live shared-world runs either are absent or carry a well-formed alternating timeline (cp-baseline → turn → cp), single-plane provenance, digest-only checkpoints, the mandatory attributionLimits, and a checkpoint delta on a passed run"
        : `shared-world findings: ${sharedWorldFindings.join(", ")}`,
  });
  checks.push({
    name: "cleanup receipt",
    ok: cleanupJson === null || (isCleanupResult(cleanupJson) && cleanupJson.ok),
    message:
      cleanupJson === null
        ? "cleanup receipt not present; cleanup was not requested"
        : isCleanupResult(cleanupJson) && cleanupJson.ok
          ? "cleanup receipt is present and successful"
          : "cleanup receipt is present but malformed or failed",
  });
  const rerunFindings = isRunBundle(bundle) ? rerunLineageFindings(bundle) : [];
  checks.push({
    name: "rerun lineage",
    ok: rerunFindings.length === 0,
    message:
      rerunFindings.length === 0
        ? "rerun bundles either are absent or link selected lanes to prior lane status and a fan-out rerun event"
        : `rerun lineage findings: ${rerunFindings.join(", ")}`,
  });
  // Cost is ADVISORY on magnitude, FAIL-CLOSED on labeling/provenance (claims match mechanism).
  // Absence PASSES (fail-open on display); a claimed dollar figure without its ratesAsOf date +
  // source, or a total that does not match its known lines, FAILS. Magnitude is never inspected —
  // a correctly-labeled huge estimate still passes.
  const costFindings = isRunBundle(bundle) ? costLabelingFindings(bundle) : [];
  checks.push({
    name: "cost estimate labeling",
    ok: costFindings.length === 0,
    message:
      costFindings.length === 0
        ? "cost figures are absent, or every claimed estimate carries its ratesAsOf date + source and the total matches its known lines (estimates never presented as exact)"
        : `cost labeling findings: ${costFindings.join(", ")}`,
  });

  const recordingOk = checks.every((check) => check.ok);
  if (derivedPublicSafetyFindings.length > 0)
    checks.push({
      name: "derived analysis public-safety scan",
      ok: false,
      message:
        "Derived analysis contains sensitive text or unsafe artifact paths; sharing is blocked, original recording remains independently verifiable.",
    });
  const ok = checks.every((check) => check.ok);
  const warnings = isRunBundle(bundle)
    ? [
        ...rawScreenshotPostureWarnings(bundle),
        ...undeclaredSubjectStateWarnings(bundle),
        ...desktopGeometryWarnings(bundle),
      ]
    : [];
  const shareSafety = isRunBundle(bundle)
    ? buildShareSafety({ ok, bundle, publicSafetyFindings })
    : {
        status: "blocked" as const,
        reasons: [
          {
            code: "VERIFY_FAILED" as const,
            message: "Run bundle failed verification.",
          },
        ],
      };

  // Interpretation validity is independent of run validity. Keep recordings usable,
  // while refusing to silently promote stale or malformed derived text into sharing.
  const analysis = await loadStudyAnalysis(runPaths);
  const analysisSharing = studyAnalysisSharingProblems(analysis);
  const executionHistory = await listStudyAnalysisExecutions(runPaths);
  if (
    analysisSharing.unverified ||
    analysisSharing.sensitive ||
    executionHistory.warnings.length > 0
  ) {
    warnings.push(
      "Some study analysis or correction records could not be validated against current evidence.",
    );
    shareSafety.reasons.push({
      code: "ANALYSIS_UNVERIFIED",
      message:
        "Derived analysis or corrections need review against the current evidence before sharing.",
    });
    if (analysisSharing.sensitive) shareSafety.status = "blocked";
    else if (shareSafety.status === "share_ready") shareSafety.status = "local_only";
  }

  return {
    schema: VERIFY_SCHEMA,
    ok,
    ...(!ok && recordingOk ? { recordingOk: true } : {}),
    cwd,
    run: runInput,
    bundlePath: path.relative(cwd, bundlePath),
    checks,
    shareSafety,
    warnings,
    ...(ok
      ? {}
      : {
          error: {
            code: "HUMANISH_INVALID_RUN_BUNDLE" as const,
            message: "Run bundle failed verification.",
          },
        }),
  };
}

export async function cleanupRun(
  cwdInput: string,
  runInput: string,
  hooks: RunCleanupHooks = {},
): Promise<CleanupResult> {
  const cwd = path.resolve(cwdInput);
  const checkedAt = (hooks.now ?? (() => new Date()))().toISOString();
  let resolved: PreparedRunArtifactPaths | null;
  try {
    resolved = await resolveRunPath(cwd, runInput);
  } catch {
    return {
      schema: CLEANUP_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      checkedAt,
      summary: { resources: 0, killed: 0, alreadyClean: 0, failed: 0, skipped: 0 },
      resources: [],
      adapterResults: [],
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: "Run storage failed containment validation.",
      },
    };
  }

  if (!resolved) {
    return {
      schema: CLEANUP_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      checkedAt,
      summary: { resources: 0, killed: 0, alreadyClean: 0, failed: 0, skipped: 0 },
      resources: [],
      adapterResults: [],
      warnings: [],
      error: {
        code: "HUMANISH_RUN_NOT_FOUND",
        message: `Run not found: ${runInput}`,
      },
    };
  }

  const runPaths = resolved;
  const bundlePath = path.join(runPaths.absoluteRunRoot, "run.json");
  const cleanupPath = path.join(runPaths.absoluteRunRoot, "cleanup.json");
  await prepareContainedOutputFile(runPaths, "cleanup.json");
  const bundleBytes = await readContainedRegularFile(runPaths, "run.json");
  let bundle: unknown = null;
  if (bundleBytes) {
    try {
      bundle = JSON.parse(bundleBytes.toString("utf8")) as unknown;
    } catch {
      bundle = null;
    }
  }

  if (!isRunBundle(bundle)) {
    return {
      schema: CLEANUP_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      bundlePath: path.relative(cwd, bundlePath),
      checkedAt,
      summary: { resources: 0, killed: 0, alreadyClean: 0, failed: 0, skipped: 0 },
      resources: [],
      adapterResults: [],
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: "Run bundle failed cleanup shape validation.",
      },
    };
  }

  const resources: CleanupResourceResult[] = [];
  const warnings: string[] = [];
  const providerResources = bundle.providerResources ?? [];

  for (const resource of providerResources) {
    if (resource.provider !== "e2b-desktop" || resource.kind !== "sandbox") {
      resources.push({
        provider: resource.provider,
        kind: resource.kind,
        id: resource.id,
        status: "skipped",
        message: "cleanup only supports e2b-desktop sandbox resources",
      });
      continue;
    }

    if (resource.status === "killed" || resource.cleanup?.killed === true) {
      resources.push({
        provider: resource.provider,
        kind: resource.kind,
        id: resource.id,
        status: "already_clean",
        message: "resource was already recorded as killed",
      });
      continue;
    }

    resources.push({
      provider: resource.provider,
      kind: resource.kind,
      id: resource.id,
      status: "failed",
      message: "automatic provider cleanup requires a verified resource lease",
    });
  }

  let adapterResults: CleanupAdapterResult[] = [];
  if (hooks.cleanupAdapterResources) {
    try {
      adapterResults = await hooks.cleanupAdapterResources({
        cwd,
        runDir: runPaths.physicalRunRoot,
        bundle,
      });
    } catch (error) {
      adapterResults = [
        {
          id: "adapter-cleanup",
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        },
      ];
    }
    await validatePreparedRunArtifactPaths(runPaths);
  }

  if (providerResources.length === 0 && adapterResults.length === 0) {
    warnings.push("Run bundle recorded no provider resource evidence; nothing to inspect.");
  }

  const summary = {
    resources: resources.length,
    killed: resources.filter((resource) => resource.status === "killed").length,
    alreadyClean: resources.filter((resource) => resource.status === "already_clean").length,
    failed:
      resources.filter((resource) => resource.status === "failed").length +
      adapterResults.filter((result) => !result.ok).length,
    skipped: resources.filter((resource) => resource.status === "skipped").length,
  };
  const ok = summary.failed === 0;
  const result: CleanupResult = {
    schema: CLEANUP_SCHEMA,
    ok,
    cwd: PUBLIC_TARGET_CWD,
    run: runInput,
    runId: bundle.runId,
    bundlePath: path.relative(cwd, bundlePath),
    cleanupPath: path.relative(cwd, cleanupPath),
    checkedAt,
    summary,
    resources,
    adapterResults,
    warnings,
  };
  await validatePreparedRunArtifactPaths(runPaths);
  await writeContainedOutputFile(
    runPaths,
    "cleanup.json",
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return result;
}

export async function loadRunBundle(
  cwdInput: string,
  runInput: string,
): Promise<{ bundle: RunBundle; bundlePath: string; runDir: string } | null> {
  const cwd = path.resolve(cwdInput);
  const runPaths = await resolveRunPath(cwd, runInput).catch(() => null);

  if (!runPaths) {
    return null;
  }

  return loadRunBundlePrepared(cwd, runPaths);
}

/** Internal continuity seam for callers that already bound one run identity. */
export async function loadRunBundlePrepared(
  cwdInput: string,
  runPaths: PreparedRunArtifactPaths,
): Promise<{ bundle: RunBundle; bundlePath: string; runDir: string } | null> {
  const cwd = path.resolve(cwdInput);
  await validatePreparedRunArtifactPaths(runPaths);
  const bundlePath = path.join(runPaths.absoluteRunRoot, "run.json");
  const bundle = await readRunJsonIfExists(runPaths, "run.json");

  if (!isRunBundle(bundle)) {
    return null;
  }

  return {
    bundle,
    bundlePath: path.relative(cwd, bundlePath),
    runDir: runPaths.absoluteRunRoot,
  };
}

/** Internal continuity seam for callers that already bound one run identity. */
export async function verifyRunPrepared(
  cwdInput: string,
  runInput: string,
  runPaths: PreparedRunArtifactPaths,
): Promise<VerifyResult> {
  const cwd = path.resolve(cwdInput);
  try {
    await validatePreparedRunArtifactPaths(runPaths);
  } catch {
    return invalidRunStorageVerifyResult(cwd, runInput);
  }
  return verifyPreparedRun(cwd, runInput, runPaths);
}

export async function listRuns(cwdInput: string): Promise<RunsResult> {
  const cwd = path.resolve(cwdInput);
  const runsRootPath = resolveRunsRoot(cwd);

  // ENOENT (no .humanish/runs yet) is a normal empty state: ok:true, no runs. Any
  // other readdir failure (e.g. permission denied) is a real I/O failure and must
  // not be swallowed into a false "no runs" report.
  let entries: string[];
  let runsRoot: import("./selected-output-paths.js").PreparedSelectedOutputDirectory | null = null;
  try {
    runsRoot = await bindExistingManagedHumanishOutputDirectory(cwd, "runs");
    entries = runsRoot ? await readdir(runsRoot.physicalPath) : [];
    if (runsRoot) {
      await assertPreparedSelectedOutputDirectory(runsRoot);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      entries = [];
    } else {
      return runsUnavailableResult(cwd, error);
    }
  }

  let latest: RunPointer | null;
  try {
    latest = runsRoot ? await readLatest(runsRoot) : null;
  } catch (error) {
    return runsUnavailableResult(cwd, error);
  }

  const runs = [];
  for (const entryName of entries) {
    if (entryName === "latest.json" || !isSafeRunIdSegment(entryName)) {
      continue;
    }
    const entryPath = path.join(runsRootPath, entryName);
    const entryStats = await lstat(entryPath, { bigint: true }).catch(() => null);
    if (!entryStats) {
      continue;
    }
    if (
      entryStats.isSymbolicLink() ||
      (!entryStats.isDirectory() && !entryStats.isFile()) ||
      (entryStats.isFile() && entryStats.nlink > 1n)
    ) {
      return runsUnavailableResult(cwd, new Error(`Unsafe Humanish runs entry: ${entryName}`));
    }
    if (!entryStats.isDirectory()) {
      continue;
    }
    let entryRunPaths: PreparedRunArtifactPaths;
    try {
      entryRunPaths = await bindExistingRunArtifactPaths(cwd, entryName);
    } catch (error) {
      return runsUnavailableResult(cwd, error);
    }
    if (runsRoot && entryRunPaths.physicalRunsRoot !== runsRoot.physicalPath) {
      return runsUnavailableResult(
        cwd,
        new Error("Humanish runs root changed physical destination."),
      );
    }
    const bundle = await readRunJsonIfExists(entryRunPaths, "run.json");
    runs.push({
      runId: entryName,
      createdAt: isRecord(bundle) && typeof bundle.createdAt === "string" ? bundle.createdAt : null,
      mode: isRecord(bundle) && typeof bundle.mode === "string" ? bundle.mode : null,
      path: path.join(RUNS_RELATIVE_ROOT, entryName),
    });
  }

  if (runsRoot) {
    try {
      await assertPreparedSelectedOutputDirectory(runsRoot);
    } catch (error) {
      return runsUnavailableResult(cwd, error);
    }
  }

  return {
    schema: RUNS_SCHEMA,
    ok: true,
    cwd,
    runs: runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    latest: latest?.runId ?? null,
  };
}

function runsUnavailableResult(cwd: string, error: unknown): RunsResult {
  return {
    schema: RUNS_SCHEMA,
    ok: false,
    cwd,
    runs: [],
    latest: null,
    error: {
      code: "HUMANISH_RUNS_UNAVAILABLE",
      message: redactText(error instanceof Error ? error.message : String(error)),
    },
  };
}

export async function readReview(
  cwdInput: string,
  runInput: string,
): Promise<VerifyResult | (ReviewSummary & { path: string; runId: string })> {
  const cwd = path.resolve(cwdInput);
  let runPaths: PreparedRunArtifactPaths | null;
  try {
    runPaths = await resolveRunPath(cwd, runInput);
  } catch {
    return invalidRunStorageVerifyResult(cwd, runInput);
  }
  const verified = await verifyPreparedRun(cwd, runInput, runPaths);

  if (!verified.ok || !verified.bundlePath) {
    return verified;
  }

  const review = runPaths ? await readRunJsonIfExists(runPaths, "review.json") : null;

  if (!isReviewSummary(review)) {
    return {
      ...verified,
      ok: false,
      error: {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: "review.json is missing or invalid.",
      },
    };
  }

  const bundle = runPaths ? await readRunJsonIfExists(runPaths, "run.json") : null;
  const projected =
    isRecord(bundle) && Array.isArray(bundle.streams)
      ? withCuaReviewProvenance(review, bundle.streams.filter(isRecord))
      : review;
  return {
    ...projected,
    path: path.relative(cwd, path.join(runPaths!.absoluteRunRoot, "review.json")),
    runId: path.basename(runPaths!.absoluteRunRoot),
  };
}

/**
 * Version 2.3.1 stopped holding a launched background command's event stream open. Version 2.3.2
 * also requires an e2b release whose background command handle supports sendStdin and closeStdin,
 * which the optional speech transport needs. On older releases the CLI could stay alive minutes
 * past a written result (#581, measured 2026-09-04 on 2.2.3: twelve minutes).
 */
export const DESKTOP_SDK_FLOOR = "2.3.2";

/** The advisory `doctor` attaches to an installed desktop SDK older than the floor, else undefined. */
export function desktopSdkAdvisory(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;
  const parse = (value: string): number[] =>
    value
      .split(".")
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10));
  const have = parse(version);
  const floor = parse(DESKTOP_SDK_FLOOR);
  if (have.length < 3 || have.some((part) => !Number.isFinite(part))) return undefined;
  const older =
    have[0]! < floor[0]! ||
    (have[0] === floor[0] &&
      (have[1]! < floor[1]! || (have[1] === floor[1] && have[2]! < floor[2]!)));
  return older
    ? `@e2b/desktop ${version} is older than ${DESKTOP_SDK_FLOOR}, the supported floor for background command cleanup and stdin handles (older releases could keep the CLI alive minutes past its result, #581). Update with \`npm i -D @e2b/desktop@latest\`.`
    : undefined;
}

/** The version of the @e2b/desktop that `import("@e2b/desktop")` resolves to from here, if readable. */
async function installedDesktopSdkVersion(): Promise<string | undefined> {
  try {
    const { createRequire } = await import("node:module");
    const manifest = createRequire(import.meta.url).resolve("@e2b/desktop/package.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export async function doctor(
  cwdInput: string,
  options: { lab?: string; env?: NodeJS.ProcessEnv; localAgents?: DetectLocalAgentsOptions } = {},
): Promise<DoctorResult> {
  const cwd = path.resolve(cwdInput);
  const cwdOk = await validateCwd(cwd)
    .then((error) => error === null)
    .catch(() => false);
  if (!cwdOk) {
    const checks = [
      {
        name: "target cwd",
        ok: false,
        message: "this directory does not exist, or humanish cannot read it",
      },
      {
        name: "package.json",
        ok: false,
        checked: false,
        message: "not checked — the target directory could not be read",
      },
      {
        name: "humanish source",
        ok: false,
        checked: false,
        message: "not checked — the target directory could not be read",
      },
      {
        name: "runtime ignore",
        ok: false,
        checked: false,
        message: "not checked — the target directory could not be read",
      },
    ];
    return { schema: DOCTOR_SCHEMA, ok: false, cwd, checks };
  }

  let projectRoot: PreparedSelectedOutputDirectory;
  try {
    projectRoot = await prepareSelectedOutputDirectory(path.dirname(cwd), cwd);
  } catch {
    const checks = [
      { name: "target cwd", ok: false, message: "target directory failed containment validation" },
      {
        name: "package.json",
        ok: false,
        checked: false,
        message: "not checked — containment validation failed first",
      },
      {
        name: "humanish source",
        ok: false,
        checked: false,
        message: "not checked — containment validation failed first",
      },
      {
        name: "runtime ignore",
        ok: false,
        checked: false,
        message: "not checked — containment validation failed first",
      },
    ];
    return { schema: DOCTOR_SCHEMA, ok: false, cwd, checks };
  }

  const safeCheck = async (check: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await check();
    } catch {
      return false;
    }
  };
  const env = options.env ?? process.env;
  const agents = await detectLocalAgents({ ...options.localAgents, env });
  const keyNames = new Set(["OPENAI_API_KEY", "E2B_API_KEY", "GH_TOKEN", "CODEX_API_KEY"]);
  let receivingKey: string | null = null;
  if (options.lab) {
    const { resolveLabManifest } = await import("../lab/discover.js");
    const resolved = await resolveLabManifest(cwd, options.lab);
    if (resolved.ok && resolved.config.comms?.email?.kind === "real") {
      const { receivingRequiredKey } = await import("../comms/setup.js");
      receivingKey = await receivingRequiredKey(cwd, resolved.config.comms.email.connection);
      if (receivingKey) keyNames.add(receivingKey);
    }
  }
  const probes = await probeKeySources([...keyNames], { cwd, env });
  const setup = options.lab
    ? await labSetupChecks({
        cwd,
        lab: options.lab,
        env,
        agents,
        keyPresent: (name) => probes.some((probe) => probe.name === name && probe.source !== null),
      })
    : undefined;
  const checks: DoctorResult["checks"] = [
    {
      name: "target cwd",
      ok: true,
      message: "target directory exists",
    },
    await (async () => {
      try {
        const contents = await readImplicitProjectFile(projectRoot, "package.json");
        return {
          name: "package.json",
          ok: true,
          message:
            contents === null
              ? "package.json is absent; it is optional for Humanish, so npm-script integration is skipped"
              : "package.json is present and safe to read",
        };
      } catch {
        return {
          name: "package.json",
          ok: false,
          message: "package.json could not be safely read",
        };
      }
    })(),
    {
      name: "humanish source",
      ok: await safeCheck(() => implicitProjectDirectoryExists(projectRoot, "humanish")),
      message: "committed humanish/ source directory is present and safe to read",
    },
    {
      name: "runtime ignore",
      ok: await safeCheck(
        async () =>
          (await readImplicitProjectFile(projectRoot, ".gitignore"))?.includes(".humanish/") ??
          false,
      ),
      message: ".gitignore safely contains .humanish/",
    },
    // The optional peer dep every live browser and terminal lane needs (#346). `npx -y humanish`
    // does not pull optional peers, so an adopter's FIRST live run used to fail on it — safely and
    // at $0, but as a burned first impression on the flagship path. Answering it here means the
    // readiness command actually answers readiness.
    await (async () => {
      const present = await safeCheck(async () => {
        try {
          await import("@e2b/desktop");
          return true;
        } catch {
          return false;
        }
      });
      const version = present ? await installedDesktopSdkVersion() : undefined;
      const advisory = desktopSdkAdvisory(version);
      return {
        name: "e2b desktop sdk",
        ok: present || setup?.desktop === false,
        message: present
          ? `optional peer @e2b/desktop ${version ?? "(version unread)"} is installed; provider access is not tested${advisory === undefined ? "" : `. ${advisory}`}`
          : setup?.desktop === false
            ? "optional peer @e2b/desktop is absent; not required by the selected route"
            : "optional peer @e2b/desktop is NOT installed — dry runs work, but any live desktop lane will fail closed. Install it with `npm i -D @e2b/desktop`.",
      };
    })(),
    // The stakeholder surface (#455). Reported as capability, never as a gate: the TUI is optional,
    // and `doctor` is itself mostly run by agents through a pipe, where a TTY requirement says
    // nothing about whether the PROJECT is ready. So this row is always ok.
    //
    // WHO IS READING decides the wording, and a real first-contact study
    // (labs/first-contact.yaml) is why. An agent evaluating humanish read
    // "`humanish tui` is available in an interactive terminal", correctly concluded it was not in
    // one, and dropped it — then wrote a report FOR A HUMAN that never mentioned the human
    // surface at all. Discovery worked; handoff did not. A capability described to a reader who
    // cannot use it has to be phrased as something to PASS ON, or it reads as "not for you" and
    // dies there.
    (() => {
      const supported = nodeSupportsTui();
      const bundlePresent = existsSync(tuiBundleUrl(new URL("../", import.meta.url).href));
      return {
        name: "terminal surface",
        ok: true,
        message: terminalSurfaceMessage({
          supported,
          bundlePresent,
          interactive: process.stdout.isTTY === true,
          nodeVersion: process.version,
        }),
      };
    })(),
    // The operator's own signed-in coding agent, reported as a CAPABILITY and never a gate: a
    // machine with none is not broken, it just needs a provider key. This row exists because
    // "go make an API key" is where most people trying humanish stop, and a developer very often
    // already has one of these signed in.
    ...(await (async () => {
      return [{ name: "local agents", ok: true, message: localAgentDoctorMessage(agents) }];
    })()),
    // Provider-key discovery (#436): which source supplies each live-run key, through the same
    // chain a live command resolves (env/--env-file, project overlay, vendor stores, the
    // humanish user store). Values never appear; sources and fill commands do.
    ...(await (async () => {
      return probes.map((probe) => {
        const present = probe.source !== null;
        const hint =
          probe.name === receivingKey
            ? `provide ${probe.name} through process env or --env-file`
            : probe.hint;
        // GH_TOKEN is needed only for private clone subjects, so its absence is informational.
        const required = setup
          ? setup.keys.includes(probe.name)
          : probe.name === "E2B_API_KEY" ||
            (probe.name === "OPENAI_API_KEY" &&
              !agents.some((agent) => agent.authStatus === "authenticated"));
        return {
          name: `key ${probe.name}`,
          ok: present || !required,
          message: present
            ? `supplied by ${probe.source}; presence only, validity not tested`
            : required
              ? `missing from every source — ${hint}`
              : `not required for ${setup ? "the selected participant route" : "every route"}; ${hint}`,
        };
      });
    })()),
    ...(setup?.checks ?? [
      {
        name: "setup route",
        ok: true,
        message:
          "General capabilities only. Use humanish doctor --lab <lab> for the selected participant's requirements and separate analysis readiness.",
      },
    ]),
  ];

  return {
    schema: DOCTOR_SCHEMA,
    ok: checks.every((check) => check.ok),
    cwd,
    checks,
  };
}

function createReviewSummary(): ReviewSummary {
  return {
    schema: REVIEW_SCHEMA,
    verdict: "contract_proof_only",
    summary:
      "Synthetic dry-run bundle was generated. This proves Humanish artifact plumbing, not product behavior.",
    gaps: [
      "No browser was launched.",
      "No product state was verified.",
      "No model, provider, or E2B substrate was used.",
    ],
  };
}

async function inspectImplicitProjectPath(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
) {
  const segments = relativePath.replace(/\\/g, "/").split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new Error("Implicit project path must be a non-empty relative path.");
  }
  await assertPreparedSelectedOutputDirectory(projectRoot);
  let current = projectRoot.physicalPath;
  for (const [index, segment] of segments.entries()) {
    assertSafeOutputPathSegment(segment, "Implicit project path segment");
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Implicit project path must not contain symbolic links: ${relativePath}`);
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(
        `Implicit project path must contain only regular files and directories: ${relativePath}`,
      );
    }
    if (stats.isFile() && stats.nlink > 1n) {
      throw new Error(`Implicit project files must be single-link regular files: ${relativePath}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`Implicit project path parent must be a directory: ${relativePath}`);
    }
    if (index === segments.length - 1) {
      await assertPreparedSelectedOutputDirectory(projectRoot);
      return stats;
    }
  }
  return null;
}

async function implicitProjectDirectoryExists(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<boolean> {
  const stats = await inspectImplicitProjectPath(projectRoot, relativePath);
  if (!stats) {
    return false;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Implicit project directory has the wrong type: ${relativePath}`);
  }
  return true;
}

async function readImplicitProjectFile(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<string | null> {
  const stats = await inspectImplicitProjectPath(projectRoot, relativePath);
  if (!stats) {
    return null;
  }
  if (!stats.isFile() || stats.nlink !== 1n) {
    throw new Error(`Implicit project file must be a single-link regular file: ${relativePath}`);
  }
  const bytes = await readContainedRegularFile(projectRoot, relativePath.replace(/\\/g, "/"));
  if (!bytes) {
    throw new Error(`Implicit project file changed while it was being read: ${relativePath}`);
  }
  return bytes.toString("utf8");
}

async function listImplicitProjectDirectory(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string,
): Promise<string[]> {
  if (!(await implicitProjectDirectoryExists(projectRoot, relativePath))) {
    return [];
  }
  const directory = path.join(
    projectRoot.physicalPath,
    ...relativePath.replace(/\\/g, "/").split("/"),
  );
  const names = await readdir(directory);
  await assertPreparedSelectedOutputDirectory(projectRoot);
  for (const name of names) {
    assertSafeOutputPathSegment(name, "Implicit project directory entry");
    await inspectImplicitProjectPath(projectRoot, `${relativePath.replace(/\\/g, "/")}/${name}`);
  }
  return names;
}

async function loadDryRunSelection(
  projectRoot: PreparedSelectedOutputDirectory,
  humanishSource: "present" | "missing",
): Promise<{
  browserJourney?: BrowserPersonaJourney;
  browserJourneyFailure?: string;
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (humanishSource === "missing") {
    return {
      persona: builtinPersona,
      resolvedPersona: parseResolvedPersona(
        {},
        { id: builtinPersona.id, name: builtinPersona.name },
      ),
      scenario: builtinScenario,
      warnings,
    };
  }

  const personaPath = "humanish/personas/synthetic-new-user.yaml";
  const scenarioPath = "humanish/scenarios/first-run-smoke.yaml";
  const personaText = await readImplicitProjectFile(projectRoot, personaPath);
  const scenarioText = await readImplicitProjectFile(projectRoot, scenarioPath);
  const browserJourneySelection = await loadBrowserPersonaJourneySelection(projectRoot);

  if (personaText === null) {
    warnings.push(`${personaPath} was not found; using built-in persona defaults.`);
  }

  if (scenarioText === null) {
    warnings.push(`${scenarioPath} was not found; using built-in scenario defaults.`);
  }

  let resolvedPersona: ResolvedPersona;
  if (personaText === null) {
    resolvedPersona = parseResolvedPersona(
      {},
      { id: builtinPersona.id, name: builtinPersona.name },
    );
  } else {
    const parsedPersona = parsePersonaYaml(personaText);
    if (parsedPersona.failed) {
      warnings.push(
        `${personaPath} could not be parsed as YAML; using built-in persona trait defaults.`,
      );
    }
    resolvedPersona = parseResolvedPersona(
      parsedPersona.value,
      {
        id: "synthetic-new-user",
        name: "Synthetic New User",
      },
      warnings,
    );
    resolvedPersona.sourceDigest = digestText(personaText ?? "");
  }

  return {
    ...(browserJourneySelection.journey ? { browserJourney: browserJourneySelection.journey } : {}),
    ...(browserJourneySelection.failure
      ? { browserJourneyFailure: browserJourneySelection.failure }
      : {}),
    persona:
      personaText === null
        ? builtinPersona
        : {
            id: readYamlScalar(personaText, "id") ?? "synthetic-new-user",
            name: readYamlScalar(personaText, "name") ?? "Synthetic New User",
            source: personaPath,
            sourceDigest: digestText(personaText),
          },
    resolvedPersona,
    scenario:
      scenarioText === null
        ? builtinScenario
        : {
            id: readYamlScalar(scenarioText, "id") ?? "first-run-smoke",
            title: readYamlScalar(scenarioText, "title") ?? "First-run smoke",
            goal:
              readYamlScalar(scenarioText, "goal") ?? "Run a public-safe first-run smoke scenario.",
            source: scenarioPath,
            sourceDigest: digestText(scenarioText),
          },
    warnings: [...warnings, ...browserJourneySelection.warnings],
  };
}

async function loadBrowserPersonaJourneySelection(
  projectRoot: PreparedSelectedOutputDirectory,
): Promise<{
  failure?: string;
  journey?: BrowserPersonaJourney;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const names = await listImplicitProjectDirectory(projectRoot, "humanish/scenarios");
  const files = names
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort((left, right) => {
      if (left === "first-run-smoke.yaml") return -1;
      if (right === "first-run-smoke.yaml") return 1;
      return left.localeCompare(right);
    });

  for (const name of files) {
    const relativePath = path.join("humanish", "scenarios", name);
    const text = await readImplicitProjectFile(projectRoot, relativePath);
    if (text === null) {
      continue;
    }
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch {
      return {
        failure: `${relativePath} could not be parsed as YAML; browser persona journey failed closed.`,
        warnings,
      };
    }

    const parsed = parseBrowserPersonaJourneyFromScenario({
      raw,
      relativePath,
      sourceDigest: digestText(text),
    });
    if (parsed.failure) {
      return {
        failure: parsed.failure,
        warnings,
      };
    }
    if (parsed.journey) {
      return {
        journey: parsed.journey,
        warnings,
      };
    }
  }

  return { warnings };
}

function renderReviewMarkdown(bundle: RunBundle): string {
  return `# Humanish Run Review

Run: ${bundle.runId}

Mode: ${bundle.mode}

Verdict: ${bundle.review.verdict}

${bundle.review.summary}

## Public-Safety

- Redaction: ${bundle.redaction.status}
- Notes: ${bundle.redaction.notes}

## Gaps

${bundle.review.gaps.map((gap) => `- ${gap}`).join("\n")}
`;
}

function readYamlScalar(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+?)\\s*$`, "m"));
  if (!match?.[1]) {
    return null;
  }

  return match[1].replace(/^["']|["']$/g, "");
}

function parsePersonaYaml(text: string): { value: unknown; failed: boolean } {
  try {
    return { value: parseYaml(text), failed: false };
  } catch {
    return { value: {}, failed: true };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve "latest" or an explicit run id to its prepared artifact paths. Exported for the
 *  reclaim command (#358), which must locate a run WITHOUT trusting anything but the managed dir. */
export async function resolveRunPath(
  cwd: string,
  runInput: string,
): Promise<PreparedRunArtifactPaths | null> {
  if (runInput === "latest") {
    const runsRoot = await bindExistingManagedHumanishOutputDirectory(cwd, "runs");
    if (!runsRoot) {
      return null;
    }
    const latest = await readLatest(runsRoot);
    const expected = latest ? resolveLatestRunDirectory(cwd, latest) : null;
    if (!latest || !expected) {
      return null;
    }
    const runPaths = await bindExistingRunArtifactPaths(cwd, latest.runId);
    if (
      runPaths.absoluteRunRoot !== expected ||
      runPaths.physicalRunsRoot !== runsRoot.physicalPath
    ) {
      throw new Error("Latest run pointer changed physical runs root.");
    }
    await assertPreparedSelectedOutputDirectory(runsRoot);
    return runPaths;
  }

  if (!isSafeRunIdSegment(runInput) || !(await resolveExistingRunDirectory(cwd, runInput))) {
    return null;
  }
  return bindExistingRunArtifactPaths(cwd, runInput);
}

async function readLatest(
  runsRoot: import("./selected-output-paths.js").PreparedSelectedOutputDirectory,
): Promise<RunPointer | null> {
  const latestPath = path.join(runsRoot.physicalPath, "latest.json");
  let latestStats;
  try {
    latestStats = await lstat(latestPath, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (latestStats.isSymbolicLink() || !latestStats.isFile() || latestStats.nlink !== 1n) {
    throw new Error("Latest run pointer must be a single-link regular file.");
  }
  const bytes = await readContainedRegularFile(runsRoot, "latest.json");
  if (!bytes) {
    throw new Error("Latest run pointer changed while it was being read.");
  }
  let latest: unknown;
  try {
    latest = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }

  return isRunPointer(latest) ? latest : null;
}

async function readPackageName(
  projectRoot: PreparedSelectedOutputDirectory,
): Promise<string | null> {
  const text = await readImplicitProjectFile(projectRoot, "package.json");
  if (text === null) {
    return null;
  }
  try {
    const packageJson = JSON.parse(text) as unknown;
    return isRecord(packageJson) && typeof packageJson.name === "string" ? packageJson.name : null;
  } catch {
    return null;
  }
}

async function readRunJsonIfExists(
  runPaths: PreparedRunArtifactPaths,
  ...segments: string[]
): Promise<unknown> {
  const text = await readRunTextIfExists(runPaths, ...segments);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readRunTextIfExists(
  runPaths: PreparedRunArtifactPaths,
  ...segments: string[]
): Promise<string | null> {
  const bytes = await readContainedRegularFile(runPaths, segments.join("/"));
  return bytes?.toString("utf8") ?? null;
}

async function readSafeRunArtifactBytes(
  runPaths: PreparedRunArtifactPaths,
  relativePath: string,
): Promise<Buffer | null> {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }
  return readContainedRegularFile(runPaths, normalized);
}

async function readSafeRunArtifactJson(
  runPaths: PreparedRunArtifactPaths,
  relativePath: string,
): Promise<unknown> {
  const bytes = await readSafeRunArtifactBytes(runPaths, relativePath);
  if (!bytes) {
    return null;
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

async function writeRunBundleArtifacts(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
  /** Pass ONLY when this write is the run's final one: the shared writer is also used for
   *  mid-run in-progress snapshots, and finalizing there would declare a live run finished (#455). */
  finalizeStatus?: RunStatusHandle,
): Promise<void> {
  const publicBundle: RunBundle = {
    ...bundle,
    cwd: PUBLIC_TARGET_CWD,
  };
  await writeContainedOutputFile(
    runPaths,
    "run.json",
    `${JSON.stringify(publicBundle, null, 2)}\n`,
    "utf8",
  );
  await finalizeStatus?.finish({
    ...(publicBundle.review?.verdict === undefined ? {} : { verdict: publicBundle.review.verdict }),
    ...(publicBundle.review?.participants === undefined
      ? {}
      : {
          participants: {
            total: publicBundle.review.participants.total,
            reachedGoal: publicBundle.review.participants.reachedGoal,
            ...(publicBundle.review.participants.reportedFriction === undefined
              ? {}
              : { reportedFriction: publicBundle.review.participants.reportedFriction }),
          },
        }),
    ...(publicBundle.cost?.estimatedTotalUsd === undefined
      ? {}
      : { estimatedCostUsd: publicBundle.cost.estimatedTotalUsd }),
  });
  await writeContainedOutputFile(
    runPaths,
    "review.json",
    `${JSON.stringify(publicBundle.review, null, 2)}\n`,
    "utf8",
  );
  await writeContainedOutputFile(runPaths, "review.md", renderReviewMarkdown(publicBundle), "utf8");
  await writeContainedOutputFile(
    runPaths,
    "events.ndjson",
    `${publicBundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await writeContainedOutputFile(
    runPaths,
    "observer/observer-data.json",
    `${JSON.stringify(buildObserverData(publicBundle), null, 2)}\n`,
    "utf8",
  );
}

async function missingLocalEvidenceArtifacts(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
): Promise<string[]> {
  const recordings = new Map(
    bundle.streams.flatMap((stream) =>
      stream.recording ? [[stream.recording.path, stream.recording] as const] : [],
    ),
  );
  const requiredPaths = new Map<string, { screenshot: boolean; allowEmpty: boolean }>();
  const addRequiredPath = (
    artifactPath: string,
    options: { screenshot?: boolean; allowEmpty?: boolean } = {},
  ): void => {
    const existing = requiredPaths.get(artifactPath);
    requiredPaths.set(artifactPath, {
      screenshot: Boolean(existing?.screenshot || options.screenshot),
      // Every consumer must permit emptiness: a terminal log cannot exempt the same path when
      // another stream, screenshot, or adapter also requires it as nonempty evidence.
      allowEmpty: options.allowEmpty === true && (existing?.allowEmpty ?? true),
    });
  };

  for (const stream of bundle.streams) {
    // A session that failed before output (or a silent terminal process) has a real zero-record
    // NDJSON stream. Both the embedded trace and its retained artifact must declare that fact.
    const emptyTerminalEvents =
      isZeroEventTerminalTrace(stream.actor) &&
      isZeroEventTerminalTrace(
        await readSafeRunArtifactJson(
          runPaths,
          stream.artifacts.find((artifact) => artifact.kind === "trace")?.path ?? "actor.json",
        ),
      );
    for (const artifact of stream.artifacts) {
      if (isLocalEvidenceArtifactPath(artifact.path)) {
        addRequiredPath(artifact.path, {
          screenshot: artifact.kind === "screenshot",
          allowEmpty:
            artifact.kind === "log" &&
            artifact.path === TERMINAL_EVENTS_FILE &&
            emptyTerminalEvents,
        });
      }
    }

    const embedPath = normalizeLocalEvidenceReference(
      stream.embed?.kind === "screenshot" ? stream.embed.url : undefined,
    );
    if (embedPath) {
      addRequiredPath(embedPath, { screenshot: true });
    }

    const uiScreenshotPath = normalizeLocalEvidenceReference(stream.ui?.screenshotUrl);
    if (uiScreenshotPath) {
      addRequiredPath(uiScreenshotPath, { screenshot: true });
    }

    if (
      stream.ui?.nestedObserverPath &&
      isLocalEvidenceArtifactPath(stream.ui.nestedObserverPath)
    ) {
      addRequiredPath(stream.ui.nestedObserverPath);
    }
    for (const reference of declaredActorScreenshotReferences(stream)) {
      if (isRunRootEvidenceReference(reference.path)) {
        addRequiredPath(reference.path, { screenshot: true });
      }
    }
  }

  for (const artifact of bundle.adapterArtifacts ?? []) {
    if (isLocalEvidenceArtifactPath(artifact.path)) {
      addRequiredPath(artifact.path, { screenshot: artifact.kind === "screenshot" });
    }
  }

  for (const candidate of bundle.feedbackCandidates ?? []) {
    for (const evidence of candidate.evidence) {
      if (isRunRootEvidenceReference(evidence.path)) {
        addRequiredPath(evidence.path, {
          screenshot: evidence.kind === "screenshot",
          // Feedback accepts an existing empty nonimage file. The conjunctive merge above
          // keeps any stricter stream, actor, or adapter requirement in force.
          allowEmpty: evidence.kind !== "screenshot",
        });
      }
    }
  }

  const missing: string[] = [];
  for (const [artifactPath, requirements] of requiredPaths) {
    const recording = recordings.get(artifactPath);
    if (recording) {
      const handle = await openContainedRegularFile(runPaths, artifactPath);
      try {
        if (!handle || (await handle.stat()).size !== recording.bytes) missing.push(artifactPath);
        else {
          const header = Buffer.alloc(12);
          const read = await handle.read(header, 0, header.length, 0);
          if (read.bytesRead !== header.length || header.toString("ascii", 4, 8) !== "ftyp")
            missing.push(`${artifactPath} (invalid MP4 header)`);
        }
      } finally {
        await handle?.close();
      }
      continue;
    }
    const bytes = await readSafeRunArtifactBytes(runPaths, artifactPath);
    if (!bytes || (bytes.length === 0 && !requirements.allowEmpty)) {
      missing.push(artifactPath);
      continue;
    }

    if (requirements.screenshot) {
      const imageError = screenshotEvidenceError(artifactPath, bytes);
      if (imageError) {
        missing.push(`${artifactPath} (${imageError})`);
      }
    }
  }

  return missing;
}

function isZeroEventTerminalTrace(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schema === ACTOR_TRACE_SCHEMA &&
    value.protocol === "terminal-exec" &&
    value.lane === "terminal" &&
    isRecord(value.counts) &&
    value.counts.terminalEvents === 0
  );
}

function declaredActorScreenshotReferences(
  stream: RunStream,
): Array<{ label: string; path: unknown; redaction: unknown }> {
  const references: Array<{ label: string; path: unknown; redaction: unknown }> = [];
  for (const field of ["actor", "liveActor"] as const) {
    const trace: unknown = stream[field];
    if (!isRecord(trace) || !Array.isArray(trace.items)) continue;
    trace.items.forEach((item: unknown, index: number) => {
      if (!isRecord(item) || !Object.hasOwn(item, "screenshotRef")) return;
      references.push({
        label: `${stream.id} ${field}.items[${index}].screenshotRef`,
        path: isRecord(item.screenshotRef) ? item.screenshotRef.path : undefined,
        redaction: isRecord(item.screenshotRef) ? item.screenshotRef.redaction : undefined,
      });
    });
  }
  return references;
}

function isRunRootEvidenceReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isLocalEvidenceArtifactPath(value) &&
    !path.win32.isAbsolute(value) &&
    !value.includes("\0") &&
    !/^[a-z][a-z\d+.-]*:/i.test(value)
  );
}

function invalidRunEvidenceReferences(bundle: RunBundle): string[] {
  const findings: string[] = [];
  if (path.isAbsolute(bundle.cwd)) {
    findings.push(`run bundle persists absolute cwd ${bundle.cwd}`);
  }
  const adapterArtifactKeys = new Set<string>();
  for (const artifact of bundle.adapterArtifacts ?? []) {
    const key = `${artifact.namespace}:${artifact.kind}:${artifact.path}`;
    if (adapterArtifactKeys.has(key)) {
      findings.push(
        `adapter artifact duplicate ${artifact.namespace}:${artifact.kind}:${artifact.path}`,
      );
    }
    adapterArtifactKeys.add(key);
    if (!isLocalEvidenceArtifactPath(artifact.path)) {
      findings.push(
        `adapter artifact ${artifact.namespace}:${artifact.kind} nonlocal artifact ${artifact.path}`,
      );
    }
  }
  for (const candidate of bundle.feedbackCandidates ?? []) {
    for (const evidence of candidate.evidence) {
      if (!isRunRootEvidenceReference(evidence.path)) {
        findings.push(
          `feedback candidate ${candidate.id} nonlocal evidence ${String(evidence.path)}`,
        );
      }
    }
  }
  for (const stream of bundle.streams) {
    const seen = new Set<string>();
    for (const artifact of stream.artifacts) {
      const key = `${artifact.kind}:${artifact.path}`;
      if (seen.has(key)) {
        findings.push(`${stream.id} duplicate artifact ${artifact.kind}:${artifact.path}`);
      }
      seen.add(key);
      if (!isLocalEvidenceArtifactPath(artifact.path)) {
        findings.push(`${stream.id} nonlocal artifact ${artifact.kind}:${artifact.path}`);
      }
    }

    if (
      stream.ui?.nestedObserverPath &&
      !isLocalEvidenceArtifactPath(stream.ui.nestedObserverPath)
    ) {
      findings.push(
        `${stream.id} nonlocal nested observer reference ${stream.ui.nestedObserverPath}`,
      );
    }
    if (
      stream.embed?.kind === "screenshot" &&
      stream.embed.url &&
      !normalizeLocalEvidenceReference(stream.embed.url)
    ) {
      findings.push(`${stream.id} nonlocal screenshot embed ${stream.embed.url}`);
    }
    if (stream.ui?.screenshotUrl && !normalizeLocalEvidenceReference(stream.ui.screenshotUrl)) {
      findings.push(`${stream.id} nonlocal screenshot reference ${stream.ui.screenshotUrl}`);
    }
    for (const reference of declaredActorScreenshotReferences(stream)) {
      if (!isRunRootEvidenceReference(reference.path)) {
        findings.push(`${reference.label} is malformed or nonlocal`);
      }
    }
  }
  return findings.slice(0, 50);
}

// The fixed artifact filenames the terminal-product lane (src/routes/terminal/lab.ts) persists.
// Kept in sync with TERMINAL_LEDGERS_ARTIFACT / TERMINAL_EVENTS_ARTIFACT / TERMINAL_TRANSCRIPT_ARTIFACT.
const TERMINAL_LEDGERS_FILE = "terminal-ledgers.json";
const TERMINAL_EVENTS_FILE = "terminal-events.ndjson";
const TERMINAL_TRANSCRIPT_FILE = "terminal-transcript.txt";

/**
 * Verifier for the terminal-product real-agent lane (issue #154, the in-sandbox command-scoped
 * key route). A LIVE terminal stream must carry the durable proof the safety contract requires,
 * and must FAIL CLOSED when any of it is missing — a blocked/failed agent run stays structurally
 * verifiable (the failure is the evidence) ONLY when the substrate/cleanup/interventions ledgers
 * are present; it must never become a hollow pass. Credential-shape leakage across every artifact
 * file is already caught by scanRunPublicSafetyArtifacts; this check enforces the STRUCTURAL
 * evidence + the proven-teardown invariant. Dry-run/contract bundles are exempt (mode !== live).
 */
async function validateTerminalProductEvidence(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
): Promise<string[]> {
  if (bundle.mode !== "live") {
    return [];
  }
  const findings: string[] = [];
  // Detect the terminal-PRODUCT lane by its unique actor-trace protocol ("terminal-exec"), NOT by
  // the broad stream.kind "terminal" — the existing local codex-exec/TUI lanes also use terminal
  // streams (with a different protocol) and must not be held to this lane's ledger contract.
  const terminalStreams = bundle.streams.filter(
    (stream) =>
      stream.actor?.protocol === "terminal-exec" && stream.status !== "contract_proof_only",
  );
  if (terminalStreams.length === 0) {
    return findings;
  }

  // The lane writes exactly one terminal run's ledgers/evidence at fixed paths in the run root.
  const ledgers = await readSafeRunArtifactJson(runPaths, TERMINAL_LEDGERS_FILE);
  if (!isRecord(ledgers) || ledgers.schema !== "humanish.terminal-ledgers.v1") {
    findings.push(`missing or malformed ${TERMINAL_LEDGERS_FILE} (humanish.terminal-ledgers.v1)`);
    return findings;
  }

  // Substrate lifecycle ledger: must record at least sandbox creation AND teardown.
  const lifecycle = Array.isArray(ledgers.lifecycle) ? ledgers.lifecycle : [];
  if (lifecycle.length === 0) {
    findings.push(
      "substrate lifecycle ledger is empty (expected create -> ready -> exec -> cleanup events)",
    );
  }

  // Command log: present (an array; empty is allowed only if the session never reached exec, which
  // the lifecycle/cleanup records still cover).
  if (!Array.isArray(ledgers.commandLog)) {
    findings.push("command log ledger is missing or not an array");
  }

  // Interventions ledger: must be PRESENT (an array). Empty is valid and expected (stdin disabled,
  // no assisted-input path) — but absent fails, so an assisted run can never masquerade as one
  // without an interventions record.
  if (!Array.isArray(ledgers.interventions)) {
    findings.push(
      "interventions ledger is missing (an empty array is required-present, not optional)",
    );
  }

  // Cleanup proof: the sandbox must be killed and proven reclaimed BY EXACT ID (remaining===0).
  // humanish never calls Sandbox.list to derive this field; a live run that cannot prove teardown
  // fails closed (remaining===1 still-present-unconfirmed, remaining===-1 kill(id) itself
  // failed -- the server-side kill-on-timeout is the backstop for both).
  const cleanup = isRecord(ledgers.cleanup) ? ledgers.cleanup : undefined;
  if (!cleanup) {
    findings.push("cleanup proof is missing");
  } else if (cleanup.killed !== true || cleanup.remaining !== 0) {
    findings.push(
      `cleanup not proven by id (killed=${String(cleanup.killed)}, remaining=${String(cleanup.remaining)}); a run that cannot prove sandbox teardown fails closed`,
    );
  }

  // The redacted exec-stream + normalized transcript artifacts must be WRITTEN (the producer
  // always writes them on the live path, even empty for a no-output blocked run — so absence is a
  // real evidence gap, while emptiness is legitimate and keeps blocked runs verifiable).
  if (!(await readSafeRunArtifactBytes(runPaths, TERMINAL_EVENTS_FILE))) {
    findings.push(`missing terminal event stream artifact (${TERMINAL_EVENTS_FILE})`);
  }
  if (!(await readSafeRunArtifactBytes(runPaths, TERMINAL_TRANSCRIPT_FILE))) {
    findings.push(`missing normalized terminal transcript artifact (${TERMINAL_TRANSCRIPT_FILE})`);
  }

  // The provider-neutral actor trace must be on the terminal lane with redaction passed.
  for (const stream of terminalStreams) {
    const traceArtifact = stream.artifacts.find((artifact) => artifact.kind === "trace");
    const tracePath = traceArtifact?.path ?? "actor.json";
    const trace = await readSafeRunArtifactJson(runPaths, tracePath);
    if (!isRecord(trace) || trace.lane !== "terminal") {
      findings.push(`${stream.id} missing terminal-lane actor trace`);
      continue;
    }
    if (!isRecord(trace.redaction) || trace.redaction.status !== "passed") {
      findings.push(`${stream.id} actor trace redaction status must be passed`);
    }
  }

  // --- SLICE 3: the cost ledger + no-spend proof must be present + internally honest. ---
  findings.push(...validateTerminalCostEvidence(ledgers));

  return findings;
}

// The four cost categories the no-spend proof + cost ledger reason over. Kept in sync with
// e2b-terminal-lab.ts COST_CATEGORIES (a missing category on either side is a finding).
const TERMINAL_COST_CATEGORIES = ["product", "media", "payment", "provider"] as const;

/**
 * Verifier for the SLICE-3 cost ledger + no-spend proof (issue #154's cost/no-spend asks). A LIVE
 * terminal-product bundle MUST carry both (fail closed if absent on a live run). The load-bearing
 * honesty check: the no-spend proof may NOT claim zero on a line the ledger marks `null`
 * (UNMEASURED) — a proof can never claim more than the ledger measured. And the observed KNOWN
 * spend may not exceed the declared cap (the proof's own maxUsd) — fail-closed, not advisory.
 * The null discipline is enforced here too: a present line's `usd` must be a number OR literally
 * null (never undefined/omitted), so "not measured" can never be silently dropped.
 */
function validateTerminalCostEvidence(ledgers: Record<string, unknown>): string[] {
  const findings: string[] = [];

  const cost = isRecord(ledgers.cost) ? ledgers.cost : undefined;
  if (!cost || cost.schema !== "humanish.terminal-cost-ledger.v1") {
    findings.push(
      "missing or malformed cost ledger (humanish.terminal-cost-ledger.v1) — a live terminal-product run must derive a cost ledger",
    );
    return findings;
  }
  const lines = isRecord(cost.lines) ? cost.lines : undefined;
  if (!lines) {
    findings.push("cost ledger has no lines block");
    return findings;
  }

  // The null discipline: every applicable category line must be PRESENT with `usd` as a number or
  // literally null. `undefined`/omitted is forbidden — that would silently lose the "not measured"
  // distinction. Track which categories the ledger marks null so the no-spend proof cannot lie about them.
  const nullCategories = new Set<string>();
  for (const category of TERMINAL_COST_CATEGORIES) {
    const line = isRecord(lines[category])
      ? (lines[category] as Record<string, unknown>)
      : undefined;
    if (!line || !("usd" in line)) {
      findings.push(
        `cost ledger line "${category}" is missing its usd field (unknowns must be explicit null, never omitted)`,
      );
      continue;
    }
    const usd = line.usd;
    if (usd === null) {
      nullCategories.add(category);
    } else if (typeof usd !== "number") {
      findings.push(
        `cost ledger line "${category}" usd must be a number or null (got ${typeof usd})`,
      );
    }
  }

  const proof = isRecord(ledgers.noSpendProof) ? ledgers.noSpendProof : undefined;
  if (!proof || proof.schema !== "humanish.terminal-no-spend-proof.v1") {
    findings.push(
      "missing or malformed no-spend proof (humanish.terminal-no-spend-proof.v1) — the no-spend proof must be derived from the ledger",
    );
    return findings;
  }

  // HONESTY CHECK: the no-spend proof must NOT claim zero on a line the ledger marks `null`. A
  // knownZeroLines entry that is actually unmeasured in the ledger means the proof claimed more than
  // it measured — fail closed.
  const knownZeroLines = Array.isArray(proof.knownZeroLines) ? proof.knownZeroLines : [];
  for (const category of knownZeroLines) {
    if (nullCategories.has(String(category))) {
      findings.push(
        `no-spend proof claims zero on line "${String(category)}" but the cost ledger marks it null (UNMEASURED); a proof may not claim zero on a line it did not measure`,
      );
    }
  }

  // FAIL-CLOSED CAP: observed KNOWN spend may not exceed the declared cap (the proof's maxUsd). The
  // ledger's knownTotalUsd is the measured spend; null lines do not count toward it (and the proof
  // reports them as unmeasured). A satisfied proof whose known total exceeds its cap is contradictory.
  const knownTotalUsd = typeof cost.knownTotalUsd === "number" ? cost.knownTotalUsd : Number.NaN;
  const maxUsd = typeof proof.maxUsd === "number" ? proof.maxUsd : null;
  if (maxUsd !== null && Number.isFinite(knownTotalUsd) && knownTotalUsd > maxUsd) {
    findings.push(
      `observed KNOWN spend ${knownTotalUsd} USD exceeds the declared cap maxUsd=${maxUsd}; the run must fail closed, not verify green`,
    );
  }
  // A proof that asserts `satisfied:true` while a known line is non-zero (knownNonZeroLines) is
  // self-contradictory — reject it (the proof's own derived state must be internally consistent).
  const knownNonZeroLines = Array.isArray(proof.knownNonZeroLines) ? proof.knownNonZeroLines : [];
  if (proof.satisfied === true && knownNonZeroLines.length > 0) {
    findings.push(
      `no-spend proof claims satisfied:true but reports known non-zero spend lines (${knownNonZeroLines.map(String).join(", ")})`,
    );
  }

  return findings;
}

async function validateCodexAppServerEvidence(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
): Promise<string[]> {
  if (bundle.mode !== "live") {
    return [];
  }

  const findings: string[] = [];
  const appServerStreams = bundle.streams.filter(
    (stream) =>
      stream.status !== "contract_proof_only" &&
      (stream.codex?.provider === "codex-app-server" ||
        stream.artifacts.some((artifact) => artifact.path.includes("codex-app-server"))),
  );

  for (const stream of appServerStreams) {
    if (stream.codex?.provider !== "codex-app-server") {
      findings.push(`${stream.id} missing first-class codex app-server metadata`);
    }
    if (
      stream.status === "running" ||
      stream.codex?.state === "connecting" ||
      stream.codex?.state === "running"
    ) {
      continue;
    }
    const traceArtifact = stream.artifacts.find(
      (artifact) => artifact.kind === "trace" && artifact.path.includes("codex-app-server"),
    );
    const eventsArtifact = stream.artifacts.find(
      (artifact) => artifact.kind === "events" && artifact.path.includes("codex-app-server"),
    );
    const logArtifact = stream.artifacts.find(
      (artifact) => artifact.kind === "log" && artifact.path.includes("codex-app-server"),
    );

    if (!traceArtifact) {
      findings.push(`${stream.id} missing codex app-server trace artifact`);
      continue;
    }

    const trace = await readSafeRunArtifactJson(runPaths, traceArtifact.path);
    if (
      !isRecord(trace) ||
      ![CODEX_APP_SERVER_TRACE_SCHEMA, CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA].includes(
        String(trace.schema),
      )
    ) {
      findings.push(
        `${stream.id} trace artifact must use ${CODEX_APP_SERVER_TRACE_SCHEMA} or ${CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA}`,
      );
    }
    if (!isRecord(trace) || !isRecord(trace.redaction) || trace.redaction.status !== "passed") {
      findings.push(`${stream.id} trace redaction status must be passed`);
    }
    if (!eventsArtifact) {
      findings.push(`${stream.id} missing codex app-server event envelope log`);
    }
    if (!logArtifact) {
      findings.push(`${stream.id} missing codex app-server transcript summary log`);
    }
  }

  return findings;
}

// Trace item kinds that show the actor DID something (drove UI, ran a command, called a tool,
// changed a file). reasoning/screenshot/plan/notice items are observation, not engagement.
const ACTION_BEARING_ACTOR_ITEM_KINDS = new Set([
  "ui_action",
  "command",
  "tool_call",
  "file_change",
]);

/**
 * Independent mirror of the producer-side no-engagement guard (cua-actor-lab.ts): a LIVE actor
 * trace claiming goal_satisfied while carrying zero action-bearing items AND zero message items
 * is a hollow run — the actor neither did nor said anything — and must not verify as evidence
 * (invariant 4: evidence verifies fail-closed). Live-vs-dry-run is judged exactly as the
 * producer judges it, from bundle.mode alone; dry-run/contract bundles legitimately carry no
 * actions and stay exempt. Engagement is accepted from EITHER surface — itemized trace items or
 * the producer's counts — because providers differ in what they itemize; the hollow-run
 * regression class (the 0.3.0–0.6.0 CUA parser bug) reports zero on both. The trace is read
 * defensively: isRunStream does not validate the actor seam, and verify must not throw on a
 * malformed one.
 */
function noEngagementActorFindings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live") {
    return [];
  }

  const findings: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    if (
      !isRecord(trace) ||
      trace.schema !== ACTOR_TRACE_SCHEMA ||
      trace.completionReason !== "goal_satisfied"
    ) {
      continue;
    }
    const items = Array.isArray(trace.items) ? trace.items : [];
    const counts = isRecord(trace.counts) ? trace.counts : {};
    const countOf = (key: string): number => {
      const value = counts[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    const engaged =
      countOf("actions") > 0 ||
      countOf("messages") > 0 ||
      hasStopWhenObservationEvidence(items, countOf("screenshots")) ||
      items.some(
        (item) =>
          isRecord(item) &&
          typeof item.kind === "string" &&
          (item.kind === "message" || ACTION_BEARING_ACTOR_ITEM_KINDS.has(item.kind)),
      );
    if (!engaged) {
      const provider = typeof trace.provider === "string" ? trace.provider : "unknown provider";
      findings.push(
        `${stream.id} live actor trace (${provider}) claims goal_satisfied with zero actions and zero messages`,
      );
    }
  }

  return findings;
}

function hasStopWhenObservationEvidence(items: unknown[], screenshotCount: number): boolean {
  const hasScreenshot =
    screenshotCount > 0 ||
    items.some(
      (item) =>
        isRecord(item) &&
        item.kind === "screenshot" &&
        isRecord(item.screenshotRef) &&
        typeof item.screenshotRef.path === "string" &&
        item.screenshotRef.path.length > 0,
    );
  if (!hasScreenshot) return false;
  // A matched stopWhen, or a declared dwell window that ended the session (#510): both are
  // structured, harness-owned completion, with frames behind them.
  return items.some(
    (item) =>
      isRecord(item) &&
      item.kind === "notice" &&
      item.status === "matched" &&
      typeof item.title === "string" &&
      (item.title.startsWith("stopWhen matched") || item.title === "dwell window complete"),
  );
}

function actorVerdictConsistencyFindings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live" || bundle.review.verdict !== "pass") {
    return [];
  }

  const findings: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    if (!isRecord(trace) || trace.schema !== ACTOR_TRACE_SCHEMA) {
      continue;
    }
    if (trace.status !== "passed") {
      const provider = typeof trace.provider === "string" ? trace.provider : "unknown provider";
      const reason = typeof trace.reason === "string" ? trace.reason : "no actor reason";
      findings.push(
        `${stream.id} live actor trace (${provider}) has status ${String(trace.status)} under a pass review verdict: ${reason}`,
      );
    }
  }

  return findings;
}

/**
 * redaction.screenshots: "raw" is the SUPPORTED local default (full-fidelity frames in
 * gitignored .humanish), not a verify failure — but ok: true must never read as "share-ready",
 * so verify surfaces the posture as a warning in both human and JSON output. Read defensively
 * for the same reason as noEngagementActorFindings.
 */
function rawScreenshotPostureWarnings(bundle: RunBundle): string[] {
  const rawStreamIds = rawScreenshotStreamIds(bundle);

  if (rawStreamIds.length === 0) {
    return [];
  }

  return [
    `Screenshots are FULL-FIDELITY (raw) on ${rawStreamIds.join(", ")} — supported for local use, NOT publish-safe as-is. Verify ok does not mean share-ready; set policies.redactScreenshots: true to blur a share-as-is bundle.`,
  ];
}

function rawScreenshotStreamIds(bundle: RunBundle): string[] {
  const rawStreamIds: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    const aggregateRaw =
      isRecord(trace) && isRecord(trace.redaction) && trace.redaction.screenshots === "raw";
    // Partial live traces have no final actor summary. An explicit raw frame must also
    // retain local-only posture, including when it contradicts an aggregate blur claim.
    const frameRaw = declaredActorScreenshotReferences(stream).some(
      (reference) => reference.redaction === "none",
    );
    if (aggregateRaw || frameRaw) {
      rawStreamIds.push(stream.id);
    }
  }
  return rawStreamIds;
}

/** Non-fatal hosted-desktop geometry disclosures, deduplicated across shared-screen streams. */
function desktopGeometryWarnings(bundle: RunBundle): string[] {
  return [...new Set(bundle.streams.flatMap((stream) => stream.desktopGeometry?.warnings ?? []))];
}

function buildShareSafety(args: {
  ok: boolean;
  bundle: RunBundle;
  publicSafetyFindings: string[];
}): VerifyResult["shareSafety"] {
  const reasons: VerifyResult["shareSafety"]["reasons"] = [];

  if (!args.ok) {
    reasons.push({
      code: "VERIFY_FAILED",
      message: "The run bundle is not valid enough to promote into public feedback.",
    });
  }

  if (args.publicSafetyFindings.length > 0) {
    reasons.push({
      code: "PUBLIC_SAFETY_FINDINGS",
      message:
        "Text artifacts or public-proof paths matched known secret, token, local-path, browser-profile, or hosted-substrate URL patterns.",
    });
  }

  if (args.bundle.publication !== undefined || args.bundle.commsReceiving !== undefined) {
    reasons.push({
      code: "REAL_COMMUNICATIONS",
      message:
        "This study used real email. Message content may appear in recordings, narration or analysis. Local review is supported; screenshot blurring does not make it public-safe.",
    });
  }
  if (args.bundle.streams.some((stream) => stream.recording !== undefined)) {
    reasons.push({
      code: "CONTINUOUS_MEDIA",
      message:
        "Continuous screen/audio recordings are retained for local review. Screenshot redaction does not redact this media.",
    });
  }
  const rawStreamIds = rawScreenshotStreamIds(args.bundle);
  if (rawStreamIds.length > 0) {
    reasons.push({
      code: "RAW_SCREENSHOTS",
      message: `Full-fidelity screenshots are present on ${rawStreamIds.join(", ")}. This is valid local evidence, but not share-ready as-is.`,
    });
  }

  if (
    reasons.some(
      (reason) => reason.code === "VERIFY_FAILED" || reason.code === "PUBLIC_SAFETY_FINDINGS",
    )
  ) {
    return { status: "blocked", reasons };
  }

  if (reasons.length > 0) {
    return { status: "local_only", reasons };
  }

  return { status: "share_ready", reasons: [] };
}

// The promptDigest convention: sha256 hex, first 16 chars. A "seeded" record without a real
// digest cannot pin "same recipe" across bundles, so verify treats it as a hollow claim.
const COMMAND_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
// Env var NAME shape (mirrors lab-config's ENV_NAME_PATTERN). externalEnvNames must hold
// NAMES only — a value sneaking into the list trips this check (a free secret tripwire).
const SUBJECT_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * The `subject state provenance` check (invariant 5 + invariant 4): a bundle's subject CLAIM
 * must match its recorded evidence. Bundles without a subject block (all pre-existing and
 * non-cua bundles) pass untouched. Live-vs-dry-run is judged from bundle.mode, exactly like
 * noEngagementActorFindings. Covers both the state story (seed/external) and, for the
 * local-tree route, the archive content pin.
 */
function subjectStateFindings(bundle: RunBundle): string[] {
  const subject = bundle.subject;
  if (subject === undefined) {
    return [];
  }

  const findings: string[] = [];
  const state = subject.state;
  const seed = state.seed ?? [];
  const live = bundle.mode === "live";

  // Local-tree fail-closed pin: a LIVE local-tree subject must carry a well-formed archive
  // digest -- a dirty tree cannot be commit-pinned, so archiveSha256 is the only content pin
  // this route has. Mirrors the seeded-on-dry-run discriminator immediately below: judged by
  // bundle.mode, never by the presence/shape of other fields. Never echoes the malformed value
  // (it could itself be a leaked value, same discipline as the externalEnvNames check below).
  if (live && subject.source === "local-tree") {
    // Note: a malformed-but-present string is already rejected upstream by the
    // isRunSubjectProvenance shape gate, so in practice this branch fires for the
    // MISSING case; the pattern re-check stays as defense in depth for callers
    // that bypass the schema gate.
    const pin = (subject as { archiveSha256?: unknown }).archiveSha256;
    if (typeof pin !== "string" || !ARCHIVE_SHA256_PATTERN.test(pin)) {
      findings.push(
        "subject.source is local-tree on a live run but archiveSha256 is missing or malformed (a local-tree subject must carry a well-formed 64-hex archive digest)",
      );
    }
  }

  // Marker-independent rule: a passed LIVE run can never ride on a seed step that did not
  // complete ok (closes the hollow-seeded × unpinned hole — an unpinned bundle still carries
  // its seed records, and a failed migration must not hide behind the external marker).
  if (live && bundle.review.verdict === "pass" && seed.some((record) => record.ok !== true)) {
    findings.push(
      "review verdict is pass but a recorded seed step did not complete ok — a passed live run cannot carry failed or unexecuted state steps",
    );
  }

  switch (state.provenance) {
    case "seeded": {
      if (!live) {
        findings.push(
          'state marker "seeded" on a dry-run bundle — a contract bundle cannot claim executed state',
        );
      }
      if (seed.length === 0) {
        findings.push('state marker "seeded" with zero seed step records is a hollow state claim');
      }
      for (const record of seed) {
        if (!COMMAND_DIGEST_PATTERN.test(record.commandDigest)) {
          findings.push(`seed step "${record.name}" lacks a sha256-16 commandDigest`);
        }
        if (live && record.ok !== true) {
          findings.push(`state marker "seeded" but step "${record.name}" did not complete ok`);
        }
      }
      break;
    }
    case "unpinned": {
      const externalEnvNames = state.externalEnvNames ?? [];
      if (externalEnvNames.length === 0) {
        findings.push(
          'state marker "unpinned" requires non-empty externalEnvNames (the declaration must name the external channel)',
        );
      }
      for (const name of externalEnvNames) {
        if (!SUBJECT_ENV_NAME_PATTERN.test(name)) {
          // Deliberately does NOT echo the entry: a malformed entry may BE a value.
          findings.push(
            "externalEnvNames carries an entry that is not an env var NAME shape (values must never appear in evidence)",
          );
        }
      }
      break;
    }
    case "declared-not-run": {
      if (live && bundle.review.verdict === "pass") {
        findings.push(
          'a passed live run cannot claim its declared seed steps did not run (state marker "declared-not-run")',
        );
      }
      break;
    }
    case "undeclared":
      break;
    case "external-public": {
      // #164 phase 2: an operator-declared, operator-owned public deployment humanish neither
      // provisioned nor seeded. There is no in-sandbox state story — a seed record or an external
      // channel here would contradict the "no subject sandbox" invariant of this plane class.
      if (subject.source !== "app-url") {
        findings.push(
          'state marker "external-public" requires subject.source "app-url" — the external-public plane is a real public deployment, not a clone/local-tree subject',
        );
      }
      if (seed.length > 0) {
        findings.push(
          'state marker "external-public" cannot carry seed step records — the external-public plane is neither provisioned nor seeded by the harness',
        );
      }
      if ((state.externalEnvNames ?? []).length > 0) {
        findings.push(
          'state marker "external-public" cannot carry externalEnvNames — the plane is operator-owned, not an uncontrolled external channel',
        );
      }
      break;
    }
    default:
      findings.push("unknown subject state provenance marker");
  }

  return findings;
}

function rerunLineageFindings(bundle: RunBundle): string[] {
  const rerun = bundle.rerun;
  if (!rerun) {
    return [];
  }

  const findings: string[] = [];
  const selectedLaneIds = rerun.selectedLaneIds;
  const selectedSet = new Set(selectedLaneIds);
  const previousLaneIds = rerun.previous.map((entry) => entry.laneId);
  const previousSet = new Set(previousLaneIds);
  const currentLaneIds = bundle.streams.map((stream) => stream.laneId);
  const currentConcreteLaneIds = currentLaneIds.filter(
    (laneId): laneId is string => typeof laneId === "string" && laneId.trim().length > 0,
  );
  const currentSet = new Set(currentConcreteLaneIds);

  if (selectedSet.size !== selectedLaneIds.length) {
    findings.push("selectedLaneIds contains duplicate lane ids");
  }
  if (previousSet.size !== previousLaneIds.length) {
    findings.push("previous contains duplicate lane ids");
  }
  if (currentConcreteLaneIds.length !== bundle.streams.length) {
    findings.push("every rerun stream must carry a laneId");
  }
  for (const laneId of selectedLaneIds) {
    if (!previousSet.has(laneId)) {
      findings.push(`selected lane ${laneId} is missing prior status`);
    }
    if (!currentSet.has(laneId)) {
      findings.push(`selected lane ${laneId} is missing from current streams`);
    }
  }
  for (const laneId of previousLaneIds) {
    if (!selectedSet.has(laneId)) {
      findings.push(`previous lane ${laneId} was not selected`);
    }
  }
  for (const laneId of currentConcreteLaneIds) {
    if (!selectedSet.has(laneId)) {
      findings.push(`current stream lane ${laneId} was not selected`);
    }
  }
  if (!bundle.events.some((event) => event.type === "cua-lab.fanout.rerun")) {
    findings.push("missing cua-lab.fanout.rerun event");
  }

  return findings;
}

/**
 * Verify the LABELING/provenance of any cost figure a bundle CLAIMS — never its magnitude. Returns
 * [] (pass) unless a dollar claim lacks its provenance (invariant 6) or a total misreports its
 * known lines. ABSENCE always passes (fail-open on display, discipline #3): a bundle with no cost,
 * a null estimate, or a lane without estimatedCost is fine. A NON-NULL figure must carry its
 * ratesAsOf date + source; a NUMBER total must equal round6(sum of ONLY the non-null lines) and a
 * null line may never be coerced to 0. A null estimate must be declared honestly (a reason + null
 * ratesAsOf), mirroring the terminal no-spend proof's null-discipline.
 */
function costLabelingFindings(bundle: RunBundle): string[] {
  const findings: string[] = [];
  if (contradictsAccountBilling(bundle.streams, bundle.cost))
    findings.push("Run cost lines contradict account billing identity");

  const cost = bundle.cost;
  if (cost) {
    if (cost.schema !== "humanish.run-cost-summary.v1") {
      findings.push(
        `run cost summary schema is ${String(cost.schema)}, expected humanish.run-cost-summary.v1`,
      );
    }
    let knownSum = 0;
    let anyKnown = false;
    for (const [index, line] of (cost.breakdown ?? []).entries()) {
      if (line.estimatedCostUsd === null) {
        continue;
      }
      anyKnown = true;
      knownSum += line.estimatedCostUsd;
      if (typeof line.ratesAsOf !== "string" || line.ratesAsOf.length === 0) {
        findings.push(
          `cost breakdown line ${index} (${line.kind}) claims $${line.estimatedCostUsd} without a ratesAsOf date`,
        );
      }
      if (typeof line.source !== "string" || line.source.length === 0) {
        findings.push(
          `cost breakdown line ${index} (${line.kind}) claims $${line.estimatedCostUsd} without a pricing source`,
        );
      }
    }
    if (cost.estimatedTotalUsd !== null) {
      if (typeof cost.ratesAsOf !== "string" || cost.ratesAsOf.length === 0) {
        findings.push(
          "run cost summary claims a number estimatedTotalUsd without a ratesAsOf date",
        );
      }
      if (round6(cost.estimatedTotalUsd) !== round6(knownSum)) {
        findings.push(
          `run cost estimatedTotalUsd ${cost.estimatedTotalUsd} does not equal the sum of its known breakdown lines (${round6(knownSum)})`,
        );
      }
    } else if (anyKnown) {
      // Every-line-null is the only honest null total; a null total beside a known line hides spend.
      findings.push(
        "run cost estimatedTotalUsd is null but a breakdown line carries a known (non-null) cost",
      );
    }
  }

  for (const stream of bundle.streams) {
    for (const actor of [stream.actor, stream.liveActor]) {
      if (actor?.executionProfile !== undefined) {
        if (!validActorExecutionProfile(actor.executionProfile))
          findings.push("Invalid actor execution profile");
        if (!validActorProviderRequests(actor.providerRequests))
          findings.push("Invalid account participant request receipts");
        if (
          actor.historyTurnsOmitted !== undefined &&
          (!Number.isSafeInteger(actor.historyTurnsOmitted) || actor.historyTurnsOmitted < 0)
        )
          findings.push("Invalid participant history omission count");
        if (
          actor.executionProfile?.billing === "account-unknown" &&
          (typeof actor.estimatedCost?.estimatedCostUsd === "number" ||
            actor.tokenUsage?.costUsd !== undefined)
        )
          findings.push("Account participant dollars must remain unknown");
      }
    }
    const estimate = stream.actor?.estimatedCost;
    if (!estimate) {
      continue;
    }
    const laneLabel = stream.laneId ?? stream.id;
    if (estimate.schema !== "humanish.actor-estimated-cost.v1") {
      findings.push(
        `lane ${laneLabel} actor estimatedCost schema is ${String(estimate.schema)}, expected humanish.actor-estimated-cost.v1`,
      );
    }
    if (estimate.estimatedCostUsd !== null) {
      if (typeof estimate.ratesAsOf !== "string" || estimate.ratesAsOf.length === 0) {
        findings.push(
          `lane ${laneLabel} claims a model-token cost $${estimate.estimatedCostUsd} without a ratesAsOf date`,
        );
      }
      if (typeof estimate.source !== "string" || estimate.source.length === 0) {
        findings.push(
          `lane ${laneLabel} claims a model-token cost $${estimate.estimatedCostUsd} without a pricing source`,
        );
      }
    } else {
      // Declared-absent honesty (invariant 5): a null estimate must say WHY and carry null ratesAsOf.
      if (estimate.reason === undefined) {
        findings.push(`lane ${laneLabel} records a null cost estimate without a reason`);
      }
      if (estimate.ratesAsOf !== null) {
        findings.push(
          `lane ${laneLabel} records a null cost estimate but carries a non-null ratesAsOf`,
        );
      }
    }
  }

  return findings;
}

// SEQUENTIAL: the three disclosures a sequential shared-world bundle MUST pin (verify fails closed
// if any is absent — omission overclaims): sequential turns only, no concurrency/races handled, and
// a checkpoint delta is attributed to the TURN it followed, not a specific action (correlation).
const MANDATORY_ATTRIBUTION_LIMITS = [
  "sequential-only",
  "no-concurrent-races",
  "delta-attributed-to-turn-not-action",
] as const;

// CONCURRENT (#164 phase 2, FIX-5): the REQUIRED set (all must be present) AND a FORBIDDEN set (any
// present == a sequential claim leaking into a concurrent bundle == overclaim). verify needs BOTH
// checks — presence-only would let an incoherent union pass.
const CONCURRENT_REQUIRED_LIMITS = [
  "concurrent",
  "best-effort-causal-attribution",
  "non-deterministic-shared-state",
  "window-and-snapshot-granularity",
  "contention-observed-not-proven-safe",
  "state-change-not-isolated-to-actors",
] as const;
const CONCURRENT_FORBIDDEN_LIMITS = ["sequential-only", "no-concurrent-races"] as const;

// EXTERNAL-PUBLIC plane class (#164 phase 2): the honest-downgrade required set. Keeps the concurrent
// family (an honest ceiling) AND adds the mandatory disclosures for a plane the harness does NOT own:
// the operator-attested (not harness-controlled) target, the ABSENCE of a synthetic attestation (you
// cannot claim synthetic on a real site), the ABSENCE of an authoritative shared-state proof (no
// in-sandbox filesystem to digest), and concurrency evidenced by temporal co-occupancy ONLY. Verify
// FAILS CLOSED if any is missing (an absent honest-downgrade limit overclaims) — invariant 5.
const EXTERNAL_PUBLIC_EXTRA_LIMITS = [
  "external-public-plane",
  "operator-attested-target-not-harness-controlled",
  "no-synthetic-attestation",
  "no-authoritative-shared-state-proof",
  "concurrency-by-temporal-co-occupancy-only",
] as const;
// Any seeded/synthetic limit on this class is a getHost claim leaking onto a real public site — forbid
// it alongside the sequential family. (A synthetic attestation on a plane the harness did not seed is a lie.)
const EXTERNAL_PUBLIC_FORBIDDEN_LIMITS = [
  "sequential-only",
  "no-concurrent-races",
  "seeded",
  "synthetic",
] as const;

// A shared-world checkpoint record persists DIGEST-ONLY: exactly these keys, nothing value-shaped.
const SHARED_WORLD_CHECKPOINT_KEYS = new Set(["kind", "name", "digest", "deltaFromPrev"]);
// CONCURRENT stateSeries record is DIGEST-ONLY too (FIX-7): permit ONLY a numeric timestamp + the
// sha256-16 digest; any other key is a value-shaped leak / a smuggled per-delta→actor field.
const SHARED_WORLD_STATESERIES_KEYS = new Set(["timestamp", "digest"]);

/**
 * The `shared-world evidence` check (#164; invariant 4 + invariant 6): a LIVE shared-world bundle's
 * interaction CLAIM must match its recorded timeline + plane provenance, and its attribution
 * ceiling must be pinned. Mirrors validateTerminalProductEvidence: live-only (dry-run contract
 * bundles are skipped, exactly like the other live-only checks). Fail-closed on every overclaim.
 */
function sharedWorldEvidenceFindings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live") {
    return bundle.sharedWorld?.skippedTail === undefined
      ? []
      : ["skippedTail requires a live executed interruption"];
  }
  const sw = bundle.sharedWorld;
  if (!sw) {
    // A live bundle that DECLARES shared-world attribution but carries no evidence block is a
    // hollow claim — fail closed. (Absent attributionClass + absent block == an ordinary bundle.)
    return bundle.attributionClass === "shared-world"
      ? ["attributionClass is shared-world but the sharedWorld evidence block is missing"]
      : [];
  }
  // FIX-8: dispatch on topologyMode FIRST; unknown/missing → fail closed.
  const topologyMode = (sw as { topologyMode?: unknown }).topologyMode;
  if (topologyMode !== "sequential" && sw.skippedTail !== undefined) {
    return ["skippedTail is only valid on sequential shared-world evidence"];
  }
  if (topologyMode === "sequential") {
    return sequentialSharedWorldFindings(bundle, sw);
  }
  if (topologyMode === "concurrent") {
    return concurrentSharedWorldFindings(bundle, sw);
  }
  return [
    'sharedWorld.topologyMode must be "sequential" or "concurrent" (missing/unknown → fail closed)',
  ];
}

/** Common shape findings shared by both topologyMode branches. */
function sharedWorldCommonFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = [];
  if (sw.schema !== SHARED_WORLD_SCHEMA) {
    findings.push(`sharedWorld.schema must be ${String(SHARED_WORLD_SCHEMA)}`);
  }
  if (bundle.attributionClass !== "shared-world") {
    findings.push("a sharedWorld evidence block requires attributionClass: shared-world");
  }
  const plane = sw.plane;
  if (
    !isRecord(plane) ||
    typeof plane.seedDigest !== "string" ||
    !COMMAND_DIGEST_PATTERN.test(plane.seedDigest)
  ) {
    findings.push("sharedWorld.plane.seedDigest must be a sha256-16 value");
  }
  if (isRecord(plane) && Array.isArray(plane.envNames)) {
    for (const name of plane.envNames) {
      if (typeof name !== "string" || !SUBJECT_ENV_NAME_PATTERN.test(name)) {
        // Does NOT echo the entry: a malformed entry may BE a value.
        findings.push(
          "sharedWorld.plane.envNames carries an entry that is not an env var NAME shape (values must never appear in evidence)",
        );
      }
    }
  }
  return findings;
}

/** Validate the declared suffix against the executed prefix and existing participant evidence. */
function sequentialSkippedTailFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
  sequence: string[],
  turns: Record<string, unknown>[],
): string[] {
  const failures: string[] = [];
  const reject = (message: string): void => {
    failures.push(`skippedTail: ${message}`);
  };
  const tail: unknown = sw.skippedTail;
  if (
    !isRecord(tail) ||
    !Array.isArray(tail.roles) ||
    tail.roles.length === 0 ||
    !tail.roles.every(isRecord)
  ) {
    return ["skippedTail: a nonempty declared role suffix is required"];
  }
  const roster = [...turns, ...tail.roles];
  if (
    !Number.isSafeInteger(sw.roleCount) ||
    sw.roleCount < 1 ||
    roster.length !== sw.roleCount ||
    bundle.simCount !== sw.roleCount ||
    bundle.simulations.length !== sw.roleCount ||
    bundle.streams.length !== sw.roleCount ||
    sequence.length !== turns.length ||
    turns.length === 0
  ) {
    reject(
      "executed prefix and blocked suffix must account for every declared simulation and stream",
    );
  }
  for (const key of ["roleId", "simId", "streamId"] as const) {
    const ids = roster.map((role) => role[key]);
    if (
      ids.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(ids).size !== ids.length
    ) {
      reject(`declared ${key} values must be nonempty and unique`);
    }
  }
  if (tail.afterRoleId !== sequence.at(-1) || tail.afterRoleId !== turns.at(-1)?.roleId) {
    reject("blocker must be the immediately preceding executed role");
  }
  if (bundle.review.verdict === "pass")
    reject("blocked participants cannot accompany a passed run review");
  roster.forEach((role, index) => {
    const sim = bundle.simulations[index],
      stream = bundle.streams[index];
    if (
      !sim ||
      !stream ||
      sim.index !== index + 1 ||
      role.simId !== sim.id ||
      role.streamId !== stream.id ||
      stream.simId !== sim.id ||
      sim.streamIds.length !== 1 ||
      sim.streamIds[0] !== stream.id
    ) {
      reject("ordered role, simulation and stream identities must agree");
      return;
    }
    const roleEvents = bundle.events.filter(
      (event) => event.simId === sim.id && event.streamId === stream.id,
    );
    if (index < turns.length) {
      if (
        !stream.actor &&
        !roleEvents.some((event) => event.type === "shared-world.session.error")
      ) {
        reject("an executed role needs an actor or an explicit attempted-session error");
      }
      return;
    }
    if (
      sim.status !== "blocked" ||
      stream.status !== "blocked" ||
      stream.actor !== undefined ||
      stream.liveActor !== undefined ||
      stream.embed?.kind !== "placeholder" ||
      stream.ui?.actorStatus !== undefined ||
      stream.ui?.screenshotUrl !== undefined ||
      stream.artifacts.some(
        (artifact) => artifact.kind === "trace" || artifact.kind === "screenshot",
      ) ||
      typeof sim.currentStep !== "string" ||
      sim.currentStep.length === 0 ||
      stream.ui?.state !== sim.currentStep
    ) {
      reject("an unstarted role must be blocked with a reason and no actor, trace or screenshot");
    }
    const sessionEvents = roleEvents.filter((event) =>
      event.type.startsWith("shared-world.session."),
    );
    if (sessionEvents.length !== 1 || sessionEvents[0]?.type !== "shared-world.session.blocked") {
      reject("each unstarted role needs exactly one blocked session event");
    }
  });
  const predecessor = bundle.streams[turns.length - 1];
  const actor = predecessor?.actor;
  if (tail.cause === "session_error") {
    if (
      !predecessor ||
      !bundle.events.some(
        (event) =>
          event.type === "shared-world.session.error" &&
          event.simId === predecessor.simId &&
          event.streamId === predecessor.id,
      )
    ) {
      reject("session_error requires the predecessor's explicit orchestration error");
    }
  } else if (tail.cause === "harness_error") {
    if (actor?.completionReason !== "harness_error")
      reject("harness_error must match the predecessor actor");
  } else if (tail.cause === "usage_unreported") {
    if (
      !actor ||
      !(
        actor.interactionUsageIncomplete === true ||
        actor.debrief?.usageReported === false ||
        actor.estimatedCost?.estimatedCostUsd === null
      )
    )
      reject("usage_unreported requires recorded unavailable usage");
  } else if (tail.cause === "study_spend_limit") {
    const estimates = bundle.streams
      .slice(0, turns.length)
      .map((stream) => stream.actor?.estimatedCost?.estimatedCostUsd);
    const allKnown =
      estimates.every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      ) &&
      bundle.streams
        .slice(0, turns.length)
        .every(
          (stream) =>
            stream.actor?.interactionUsageIncomplete !== true &&
            stream.actor?.debrief?.usageReported !== false,
        );
    const sum = estimates.reduce<number>((total, value) => total + (value ?? 0), 0);
    if (
      !allKnown ||
      typeof tail.maxTotalUsd !== "number" ||
      !Number.isFinite(tail.maxTotalUsd) ||
      tail.maxTotalUsd < 0 ||
      typeof tail.estimatedTotalUsd !== "number" ||
      !Number.isFinite(tail.estimatedTotalUsd) ||
      tail.estimatedTotalUsd !== sum ||
      !(sum > tail.maxTotalUsd)
    ) {
      reject(
        "study_spend_limit requires known prefix estimates exceeding the recorded finite threshold",
      );
    }
  } else {
    reject("a supported typed interruption cause is required");
  }
  if (
    tail.cause !== "study_spend_limit" &&
    (tail.maxTotalUsd !== undefined || tail.estimatedTotalUsd !== undefined)
  ) {
    reject("budget figures require a measured study_spend_limit cause");
  }
  return failures;
}

/**
 * SEQUENTIAL branch (the PoC #164): the alternating timeline must be well-formed, single-plane,
 * digest-only, and carry the sequential attributionLimits. FIX-8: a sequential bundle must NOT
 * carry concurrent fields (laneWindows).
 */
function sequentialSharedWorldFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);
  // Read the raw record so an injected value-shaped field on a checkpoint is visible (the typed
  // view would hide unexpected keys).
  const rawTimeline: unknown[] = Array.isArray((sw as { timeline?: unknown }).timeline)
    ? (sw as { timeline: unknown[] }).timeline
    : [];
  if (!Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push("a sequential shared-world bundle must carry a timeline");
  }
  if (Array.isArray((sw as { laneWindows?: unknown }).laneWindows)) {
    findings.push(
      "a sequential shared-world bundle must NOT carry concurrent laneWindows (topologyMode mismatch)",
    );
  }
  const sequence = Array.isArray(sw.sequence) ? sw.sequence : [];

  // Attribution ceiling: every mandatory limit MUST be present (omission overclaims → fail).
  const limits = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  for (const required of MANDATORY_ATTRIBUTION_LIMITS) {
    if (!limits.includes(required)) {
      findings.push(
        `attributionLimits is missing the mandatory disclosure "${required}" — an absent ceiling overclaims`,
      );
    }
  }

  const checkpoints = rawTimeline.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.kind === "checkpoint",
  );
  const turns = rawTimeline.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.kind === "turn",
  );

  // Historical full-execution bundles keep the original equality rule. A shorter executed
  // prefix requires explicit blocked-tail evidence, never an inference from absent actors.
  if (sw.skippedTail !== undefined) {
    findings.push(...sequentialSkippedTailFindings(bundle, sw, sequence, turns));
  } else if (!(sequence.length === sw.roleCount && turns.length === sw.roleCount)) {
    findings.push(
      `phantom/dropped role: sequence length (${sequence.length}), roleCount (${sw.roleCount}), and timeline turn count (${turns.length}) must all match`,
    );
  }

  // Timeline well-formed: starts with cp-baseline, strictly alternates checkpoint → turn →
  // checkpoint, ends on a checkpoint, and turn order == sequence.
  if (rawTimeline.length === 0) {
    findings.push("timeline is empty");
  } else {
    const first = rawTimeline[0];
    if (!isRecord(first) || first.kind !== "checkpoint" || first.name !== "cp-baseline") {
      findings.push('timeline must start with the "cp-baseline" checkpoint');
    }
    const last = rawTimeline[rawTimeline.length - 1];
    if (!isRecord(last) || last.kind !== "checkpoint") {
      findings.push("timeline must end on a checkpoint");
    }
    rawTimeline.forEach((entry, index) => {
      const expected = index % 2 === 0 ? "checkpoint" : "turn";
      if (!isRecord(entry) || entry.kind !== expected) {
        findings.push(
          `timeline must strictly alternate checkpoint → turn → checkpoint (index ${index} is not a ${expected})`,
        );
      }
    });
    if (rawTimeline.length !== 1 + 2 * turns.length) {
      findings.push(
        "timeline length must be 1 baseline checkpoint + 2 entries (turn + checkpoint) per role",
      );
    }
  }
  turns.forEach((turn, index) => {
    if (turn.roleId !== sequence[index]) {
      findings.push(
        `turn order does not match the declared sequence at position ${index} (turn "${String(turn.roleId)}" vs sequence "${String(sequence[index])}")`,
      );
    }
    if (sw.skippedTail !== undefined) {
      const checkpoint = rawTimeline[index * 2 + 2];
      if (!isRecord(checkpoint) || checkpoint.name !== `cp-after-${String(turn.roleId)}`) {
        findings.push(
          "skippedTail: each after-checkpoint must belong to its executed role, never an unstarted seat",
        );
      }
    }
  });

  // Checkpoints: digest is sha256-16 and the record carries NO value-shaped field (digest-only).
  for (const checkpoint of checkpoints) {
    const name = typeof checkpoint.name === "string" ? checkpoint.name : "(unnamed)";
    if (typeof checkpoint.digest !== "string" || !COMMAND_DIGEST_PATTERN.test(checkpoint.digest)) {
      findings.push(
        `checkpoint "${name}" digest is not a sha256-16 value (a value-shaped checkpoint field is rejected)`,
      );
    }
    for (const key of Object.keys(checkpoint)) {
      if (!SHARED_WORLD_CHECKPOINT_KEYS.has(key)) {
        findings.push(
          `checkpoint "${name}" carries an unexpected field "${key}" — checkpoints persist digest-only`,
        );
      }
    }
  }

  // Turns: simId/streamId resolve to a real sim/stream.
  for (const turn of turns) {
    const roleId = typeof turn.roleId === "string" ? turn.roleId : "(unnamed)";
    if (!bundle.simulations.some((sim) => sim.id === turn.simId)) {
      findings.push(`turn "${roleId}" references unknown simId "${String(turn.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === turn.streamId)) {
      findings.push(`turn "${roleId}" references unknown streamId "${String(turn.streamId)}"`);
    }
  }

  // Single-plane provenance: every turn shares ONE (commit, seedDigest), matching sharedWorld.plane.
  // (plane.seedDigest + plane.envNames shape are checked in sharedWorldCommonFindings.)
  const plane = sw.plane;
  const planeKeys = new Set(
    turns.map((turn) => `${String(turn.commit ?? "")}::${String(turn.seedDigest ?? "")}`),
  );
  if (planeKeys.size > 1) {
    findings.push(
      "turns reference divergent plane provenance (commit/seedDigest) — a shared-world run drives ONE plane",
    );
  }
  if (isRecord(plane)) {
    for (const turn of turns) {
      if (
        String(turn.seedDigest ?? "") !== String(plane.seedDigest ?? "") ||
        String(turn.commit ?? "") !== String(plane.commit ?? "")
      ) {
        const roleId = typeof turn.roleId === "string" ? turn.roleId : "(unnamed)";
        findings.push(`turn "${roleId}" plane provenance diverges from sharedWorld.plane`);
        break;
      }
    }
  }

  // The delta-on-pass gate: a PASSED shared-world run MUST show at least one checkpoint delta —
  // otherwise the roles never interacted through shared state and the claim is hollow.
  if (
    bundle.review.verdict === "pass" &&
    !checkpoints.some((checkpoint) => checkpoint.deltaFromPrev === true)
  ) {
    findings.push(
      "review verdict is pass but no checkpoint shows deltaFromPrev — the interaction is hollow (no observed shared-state change)",
    );
  }

  return findings;
}

/**
 * CONCURRENT branch (#164 phase 2): N personas drove ONE getHost-exposed plane at once. Verify
 * fail-closed: the shape (laneWindows + stateSeries + outcomes, NO timeline — FIX-8); the
 * corrected required + forbidden attributionLimits (FIX-5); the harness-minted getHost target every
 * actor drove (FIX-2); the synthetic-subject provenance gate (FIX-3); digest-only state series with
 * the allowed-keys tripwire (FIX-7); single-plane provenance; and the concurrency-on-pass gate
 * (genuine overlap + a state delta AT/AFTER an overlap start — FIX-6).
 */
function concurrentSharedWorldFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  // The PLANE-class discriminator (#164 phase 2). Absent == the historical provisioned-getHost plane
  // (byte-stable). EVERY getHost-specific assertion (hostDigest, exposure: synthetic, seeded
  // provenance, state-delta on pass) is gated on this — it never leaks onto the external-public class,
  // and the external-public assertions never leak onto getHost.
  const planeClass = (sw as { planeClass?: unknown }).planeClass;
  if (planeClass === "external-public") {
    return externalPublicConcurrentFindings(bundle, sw);
  }
  if (planeClass !== undefined && planeClass !== "provisioned-getHost") {
    return [
      ...sharedWorldCommonFindings(bundle, sw),
      `sharedWorld.planeClass must be "provisioned-getHost" or "external-public" (got "${String(planeClass)}")`,
    ];
  }
  return provisionedGetHostConcurrentFindings(bundle, sw);
}

/**
 * PROVISIONED-getHost concurrent branch (the historical plane; #164 phase 2): a clone/local-tree
 * subject served + getHost-exposed in-sandbox — the harness MINTED the host, so it asserts the
 * synthetic-seeded attestation, the harness-minted host identity, and an authoritative in-sandbox
 * checkpoint state-delta on pass. UNCHANGED from the pre-external-public verify (byte-stable).
 */
function provisionedGetHostConcurrentFindings(
  bundle: RunBundle,
  sw: SharedWorldEvidence,
): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);

  // FIX-8: shape coherence — concurrent carries laneWindows/stateSeries/outcomes, NOT a timeline.
  if (Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push(
      "a concurrent shared-world bundle must NOT carry a sequential timeline (topologyMode mismatch)",
    );
  }
  const laneWindows = Array.isArray(sw.laneWindows)
    ? (sw.laneWindows as unknown[]).filter(isRecord)
    : null;
  const stateSeries = Array.isArray(sw.stateSeries)
    ? (sw.stateSeries as unknown[]).filter(isRecord)
    : null;
  const outcomes = Array.isArray(sw.outcomes) ? (sw.outcomes as unknown[]).filter(isRecord) : null;
  if (laneWindows === null)
    findings.push("a concurrent shared-world bundle must carry laneWindows");
  if (stateSeries === null)
    findings.push("a concurrent shared-world bundle must carry stateSeries");
  if (outcomes === null) findings.push("a concurrent shared-world bundle must carry outcomes");
  if (laneWindows === null || stateSeries === null || outcomes === null) {
    return findings; // can't reason further without the core series
  }

  // FIX-5: required limits all present AND forbidden limits all absent.
  const limits = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  for (const required of CONCURRENT_REQUIRED_LIMITS) {
    if (!limits.includes(required)) {
      findings.push(
        `attributionLimits is missing the mandatory concurrent disclosure "${required}" — an absent ceiling overclaims`,
      );
    }
  }
  for (const forbidden of CONCURRENT_FORBIDDEN_LIMITS) {
    if (limits.includes(forbidden)) {
      findings.push(
        `attributionLimits carries the forbidden disclosure "${forbidden}" — a concurrent run cannot claim a sequential guarantee`,
      );
    }
  }

  // Phantom/dropped role: laneWindows + outcomes each cover exactly roleCount (actors are
  // INDEPENDENT — none are blocked by another, so all N produce a window + outcome).
  if (laneWindows.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: laneWindows count (${laneWindows.length}) must equal roleCount (${sw.roleCount})`,
    );
  }
  if (outcomes.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: outcomes count (${outcomes.length}) must equal roleCount (${sw.roleCount})`,
    );
  }

  // laneWindows: numeric well-ordered windows; sim/stream resolve; route-host digest present.
  for (const window of laneWindows) {
    const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
    const startedAt = window.startedAt;
    const endedAt = window.endedAt;
    if (typeof startedAt !== "number" || typeof endedAt !== "number" || !(startedAt <= endedAt)) {
      findings.push(`laneWindow "${roleId}" must carry numeric startedAt <= endedAt on one clock`);
    }
    if (
      typeof window.routeHostDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(window.routeHostDigest)
    ) {
      findings.push(
        `laneWindow "${roleId}" must record a sha256-16 routeHostDigest of the host it drove`,
      );
    }
    if (!bundle.simulations.some((sim) => sim.id === window.simId)) {
      findings.push(`laneWindow "${roleId}" references unknown simId "${String(window.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === window.streamId)) {
      findings.push(
        `laneWindow "${roleId}" references unknown streamId "${String(window.streamId)}"`,
      );
    }
  }

  // FIX-2: the harness-minted getHost target. plane.hostDigest present (sha256-16) + every actor's
  // routeHostDigest equals it (every actor drove EXACTLY the harness-minted host — invariant 2).
  const plane: Record<string, unknown> = isRecord(sw.plane) ? sw.plane : {};
  const hostDigest = typeof plane.hostDigest === "string" ? plane.hostDigest : undefined;
  if (!hostDigest || !COMMAND_DIGEST_PATTERN.test(hostDigest)) {
    findings.push(
      "sharedWorld.plane.hostDigest (sha256-16 of the harness-minted getHost origin) is required on the concurrent route",
    );
  } else {
    for (const window of laneWindows) {
      const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
      if (typeof window.routeHostDigest === "string" && window.routeHostDigest !== hostDigest) {
        findings.push(
          `laneWindow "${roleId}" drove a host that differs from the harness-minted plane.hostDigest (invariant 2)`,
        );
      }
    }
  }

  // FIX-3: synthetic-subject provenance gate (a getHost URL is internet-reachable; real/external
  // data behind it is the hazard). Author attestation + a seeded provenance check.
  if (plane.exposure !== "synthetic") {
    findings.push(
      'sharedWorld.plane.exposure must be "synthetic" — the getHost route requires the author attestation that the subject is synthetic seeded data (author-trust + provenance gate, not a no-real-data guarantee)',
    );
  }
  if (bundle.subject?.state.provenance !== "seeded") {
    findings.push(
      `the concurrent getHost route requires subject.state.provenance == "seeded" (got "${bundle.subject?.state.provenance ?? "absent"}") — external/unpinned/undeclared data behind an internet-reachable URL is rejected`,
    );
  }

  // Single-plane provenance: every laneWindow shares ONE (commit, seedDigest) matching plane.
  const planeKeys = new Set(
    laneWindows.map(
      (window) => `${String(window.commit ?? "")}::${String(window.seedDigest ?? "")}`,
    ),
  );
  if (planeKeys.size > 1) {
    findings.push(
      "laneWindows reference divergent plane provenance (commit/seedDigest) — a concurrent run drives ONE plane",
    );
  }
  for (const window of laneWindows) {
    if (
      String(window.seedDigest ?? "") !== String(plane.seedDigest ?? "") ||
      String(window.commit ?? "") !== String(plane.commit ?? "")
    ) {
      const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
      findings.push(`laneWindow "${roleId}" plane provenance diverges from sharedWorld.plane`);
      break;
    }
  }

  // FIX-7: stateSeries is DIGEST-ONLY with the allowed-keys tripwire (no per-delta→actor field).
  for (const snapshot of stateSeries) {
    if (typeof snapshot.timestamp !== "number") {
      findings.push("a stateSeries snapshot must carry a numeric timestamp");
    }
    if (typeof snapshot.digest !== "string" || !COMMAND_DIGEST_PATTERN.test(snapshot.digest)) {
      findings.push(
        "a stateSeries snapshot digest is not a sha256-16 value (a value-shaped field is rejected)",
      );
    }
    for (const key of Object.keys(snapshot)) {
      if (!SHARED_WORLD_STATESERIES_KEYS.has(key)) {
        findings.push(
          `a stateSeries snapshot carries an unexpected field "${key}" — the series is digest-only (no per-delta attribution)`,
        );
      }
    }
  }

  // The concurrency-on-pass gate (FIX-6): a PASSED concurrent run MUST show genuine overlap (≥2
  // laneWindows overlapping in time) AND a stateSeries delta whose timestamp is AT/AFTER the start
  // of an overlap interval — otherwise it was not actually concurrent, or the world never changed
  // under contention (a hollow concurrent claim).
  if (bundle.review.verdict === "pass") {
    const overlapStarts: number[] = [];
    for (let i = 0; i < laneWindows.length; i += 1) {
      for (let j = i + 1; j < laneWindows.length; j += 1) {
        const a = laneWindows[i]!;
        const b = laneWindows[j]!;
        const aStart = a.startedAt as number;
        const aEnd = a.endedAt as number;
        const bStart = b.startedAt as number;
        const bEnd = b.endedAt as number;
        if (
          typeof aStart === "number" &&
          typeof aEnd === "number" &&
          typeof bStart === "number" &&
          typeof bEnd === "number" &&
          aStart < bEnd &&
          bStart < aEnd
        ) {
          overlapStarts.push(Math.max(aStart, bStart));
        }
      }
    }
    if (overlapStarts.length === 0) {
      findings.push(
        "review verdict is pass but no two laneWindows overlap in time — the run was not actually concurrent",
      );
    } else {
      const earliestOverlapStart = Math.min(...overlapStarts);
      const sorted = [...stateSeries]
        .map((snapshot) => ({
          timestamp: snapshot.timestamp as number,
          digest: String(snapshot.digest),
        }))
        .filter((snapshot) => typeof snapshot.timestamp === "number")
        .sort((x, y) => x.timestamp - y.timestamp);
      let deltaInWindow = false;
      for (let i = 1; i < sorted.length; i += 1) {
        if (
          sorted[i]!.digest !== sorted[i - 1]!.digest &&
          sorted[i]!.timestamp >= earliestOverlapStart
        ) {
          deltaInWindow = true;
          break;
        }
      }
      if (!deltaInWindow) {
        findings.push(
          "review verdict is pass but no stateSeries delta occurs at/after an overlap interval start — the shared world did not change under concurrent load (hollow concurrent claim)",
        );
      }
    }
  }

  return findings;
}

/**
 * EXTERNAL-PUBLIC concurrent branch (#164 phase 2): N seats drove ONE real operator-owned public
 * deployment at once. The honest evidence class for a plane the harness does NOT own. Verify
 * fail-closed on the honest DOWNGRADES (asserted-absent, never silently dropped): provenance is
 * "external-public" (NOT seeded), exposure is ABSENT (claiming synthetic on a real site is a lie),
 * plane control is operator-attested (publicOriginDigest, not a harness-minted hostDigest), there is
 * NO authoritative shared-state proof (stateSeries omitted — option A), and concurrency is proven by
 * temporal co-occupancy ONLY (relaxed concurrency-on-pass: ≥2 overlapping windows, no state delta).
 * Every getHost-only claim (exposure: synthetic / plane.hostDigest / seeded / synthetic limit)
 * appearing here FAILS CLOSED.
 */
function externalPublicConcurrentFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);

  // Shape coherence: concurrent carries laneWindows + outcomes, NOT a timeline. stateSeries is
  // deliberately OMITTED on this class (no in-sandbox filesystem to authoritatively digest).
  if (Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push(
      "an external-public concurrent bundle must NOT carry a sequential timeline (topologyMode mismatch)",
    );
  }
  const laneWindows = Array.isArray(sw.laneWindows)
    ? (sw.laneWindows as unknown[]).filter(isRecord)
    : null;
  const outcomes = Array.isArray(sw.outcomes) ? (sw.outcomes as unknown[]).filter(isRecord) : null;
  if (laneWindows === null)
    findings.push("an external-public concurrent bundle must carry laneWindows");
  if (outcomes === null) findings.push("an external-public concurrent bundle must carry outcomes");
  // Option A: NO authoritative shared-state proof — a non-empty stateSeries would falsely imply the
  // harness digested the plane's backend state (it cannot; there is no in-sandbox filesystem).
  const stateSeries = (sw as { stateSeries?: unknown }).stateSeries;
  if (Array.isArray(stateSeries) && stateSeries.length > 0) {
    findings.push(
      "an external-public concurrent bundle must NOT carry a stateSeries — the harness cannot authoritatively digest a real public plane's backend state (no in-sandbox filesystem); concurrency is proven by temporal co-occupancy, not a state series",
    );
  }
  if (laneWindows === null || outcomes === null) {
    return findings; // can't reason further without the core series
  }

  // Attribution ceiling: the concurrent family AND every external-public honest-downgrade disclosure
  // must be present; the sequential family + any seeded/synthetic limit must be absent.
  const limits = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  for (const required of [...CONCURRENT_REQUIRED_LIMITS, ...EXTERNAL_PUBLIC_EXTRA_LIMITS]) {
    if (!limits.includes(required)) {
      findings.push(
        `attributionLimits is missing the mandatory external-public disclosure "${required}" — an absent honest-downgrade ceiling overclaims`,
      );
    }
  }
  for (const forbidden of EXTERNAL_PUBLIC_FORBIDDEN_LIMITS) {
    if (limits.includes(forbidden)) {
      findings.push(
        `attributionLimits carries the forbidden disclosure "${forbidden}" — the external-public plane cannot claim a sequential guarantee or a seeded/synthetic attestation on a real site`,
      );
    }
  }

  // Phantom/dropped role: laneWindows + outcomes each cover exactly roleCount.
  if (laneWindows.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: laneWindows count (${laneWindows.length}) must equal roleCount (${sw.roleCount})`,
    );
  }
  if (outcomes.length !== sw.roleCount) {
    findings.push(
      `phantom/dropped role: outcomes count (${outcomes.length}) must equal roleCount (${sw.roleCount})`,
    );
  }

  // laneWindows: numeric well-ordered windows; sim/stream resolve; route-host digest present.
  for (const window of laneWindows) {
    const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
    if (
      typeof window.startedAt !== "number" ||
      typeof window.endedAt !== "number" ||
      !((window.startedAt as number) <= (window.endedAt as number))
    ) {
      findings.push(`laneWindow "${roleId}" must carry numeric startedAt <= endedAt on one clock`);
    }
    if (
      typeof window.routeHostDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(window.routeHostDigest)
    ) {
      findings.push(
        `laneWindow "${roleId}" must record a sha256-16 routeHostDigest of the origin it reached`,
      );
    }
    if (!bundle.simulations.some((sim) => sim.id === window.simId)) {
      findings.push(`laneWindow "${roleId}" references unknown simId "${String(window.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === window.streamId)) {
      findings.push(
        `laneWindow "${roleId}" references unknown streamId "${String(window.streamId)}"`,
      );
    }
  }

  // Plane identity (the honest analog of invariant 2, WEAKER + disclosed): the convergence proof is
  // about what the seats OBSERVED, not what was DECLARED. plane.publicOriginDigest is the OBSERVED
  // origin the seats converged on; verify requires every seat's CDP-OBSERVED routeHostDigest to agree
  // on ONE origin, and that publicOriginDigest BE that origin. Convergence on one observed origin proves
  // inter-seat co-location — NOT harness control of the plane. IMPORTANT: operator OWNERSHIP rests on
  // the subject.publicTarget.authorized attestation + the declared appUrl, NOT on digest equality — a
  // normal cross-origin redirect (apex->www, http->https) makes the observed origin differ from the
  // DECLARED one, which is expected and must NEVER fail verify (declaredOriginDigest is evidence-only).
  const plane: Record<string, unknown> = isRecord(sw.plane) ? sw.plane : {};
  const publicOriginDigest =
    typeof plane.publicOriginDigest === "string" ? plane.publicOriginDigest : undefined;
  if (!publicOriginDigest || !COMMAND_DIGEST_PATTERN.test(publicOriginDigest)) {
    findings.push(
      "sharedWorld.plane.publicOriginDigest (sha256-16 of the OBSERVED origin the seats converged on) is required on the external-public plane class",
    );
  }
  // The observed origins across seats must agree on exactly ONE (that agreement IS the convergence).
  const observedOrigins = laneWindows
    .map((window) =>
      typeof window.routeHostDigest === "string" ? window.routeHostDigest : undefined,
    )
    .filter((digest): digest is string => digest !== undefined);
  const distinctObserved = [...new Set(observedOrigins)];
  if (distinctObserved.length > 1) {
    findings.push(
      `the seats did not converge on ONE OBSERVED origin — distinct observed origin digests: ${distinctObserved.join(", ")}`,
    );
  } else if (
    publicOriginDigest &&
    distinctObserved.length === 1 &&
    distinctObserved[0] !== publicOriginDigest
  ) {
    findings.push(
      `sharedWorld.plane.publicOriginDigest (${publicOriginDigest}) must equal the single OBSERVED origin the seats converged on (${distinctObserved[0]})`,
    );
  }
  // declaredOriginDigest is recorded for evidence ONLY. Validate its shape when present, but NEVER
  // assert it equals the observed origin — a cross-origin redirect is normal and expected.
  if (
    plane.declaredOriginDigest !== undefined &&
    (typeof plane.declaredOriginDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(plane.declaredOriginDigest))
  ) {
    findings.push(
      "sharedWorld.plane.declaredOriginDigest, when present, must be a sha256-16 digest of the operator-declared origin (evidence-only; not asserted equal to the observed origin)",
    );
  }

  // INVERT the getHost gate: exposure MUST be absent (claiming synthetic on a real site is a lie) and
  // the harness-minted hostDigest MUST be absent (the harness minted no host here).
  if (plane.exposure !== undefined) {
    findings.push(
      'sharedWorld.plane.exposure must be ABSENT on the external-public plane class — the harness neither provisioned nor exposed the plane, so it cannot attest "synthetic" on a real site',
    );
  }
  if (plane.hostDigest !== undefined) {
    findings.push(
      "sharedWorld.plane.hostDigest must be ABSENT on the external-public plane class — a harness-minted host identity is a getHost claim; this plane is operator-attested, not harness-minted",
    );
  }
  // Provenance is the NEW external-public marker — NOT seeded (nothing was seeded), NOT unpinned.
  if (bundle.subject?.state.provenance !== "external-public") {
    findings.push(
      `the external-public plane class requires subject.state.provenance == "external-public" (got "${bundle.subject?.state.provenance ?? "absent"}") — a seeded/unpinned/undeclared claim on an operator-owned public deployment is dishonest`,
    );
  }
  if (bundle.subject?.source !== "app-url") {
    findings.push(
      'the external-public plane class requires subject.source == "app-url" — the plane is a real public deployment, not a provisioned subject',
    );
  }

  // Single-plane provenance: every laneWindow shares ONE (commit, seedDigest) matching plane. commit
  // is absent on this class (nothing cloned); seedDigest is the constant empty-recipe digest.
  const planeKeys = new Set(
    laneWindows.map(
      (window) => `${String(window.commit ?? "")}::${String(window.seedDigest ?? "")}`,
    ),
  );
  if (planeKeys.size > 1) {
    findings.push(
      "laneWindows reference divergent plane provenance (commit/seedDigest) — a shared-world run drives ONE plane",
    );
  }
  for (const window of laneWindows) {
    if (
      String(window.seedDigest ?? "") !== String(plane.seedDigest ?? "") ||
      String(window.commit ?? "") !== String(plane.commit ?? "")
    ) {
      const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
      findings.push(`laneWindow "${roleId}" plane provenance diverges from sharedWorld.plane`);
      break;
    }
  }

  // The lobby-convergence proof (optional-but-strong): if present it must be a sha256-16 digest of the
  // shared /lobby/CODE path all seats converged on (digest-only; the raw CODE never lands).
  const lobbyConvergenceDigest = (sw as { lobbyConvergenceDigest?: unknown })
    .lobbyConvergenceDigest;
  if (
    lobbyConvergenceDigest !== undefined &&
    (typeof lobbyConvergenceDigest !== "string" ||
      !COMMAND_DIGEST_PATTERN.test(lobbyConvergenceDigest))
  ) {
    findings.push(
      "sharedWorld.lobbyConvergenceDigest must be a sha256-16 digest (digest-only; the raw lobby code never lands)",
    );
  }

  // The RELAXED concurrency-on-pass gate: a PASSED external-public run MUST show genuine temporal
  // co-occupancy (≥2 laneWindows overlapping in time). There is NO state-delta requirement — the
  // observed co-occupancy of one declared origin (plus the optional lobby convergence) carries the
  // "they shared a world" claim, disclosed as concurrency-by-temporal-co-occupancy-only.
  if (bundle.review.verdict === "pass") {
    let overlap = false;
    for (let i = 0; i < laneWindows.length && !overlap; i += 1) {
      for (let j = i + 1; j < laneWindows.length; j += 1) {
        const a = laneWindows[i]!;
        const b = laneWindows[j]!;
        const aStart = a.startedAt as number;
        const aEnd = a.endedAt as number;
        const bStart = b.startedAt as number;
        const bEnd = b.endedAt as number;
        if (
          typeof aStart === "number" &&
          typeof aEnd === "number" &&
          typeof bStart === "number" &&
          typeof bEnd === "number" &&
          aStart < bEnd &&
          bStart < aEnd
        ) {
          overlap = true;
          break;
        }
      }
    }
    if (!overlap) {
      findings.push(
        "review verdict is pass but no two laneWindows overlap in time — the external-public run was not actually concurrent (concurrency is proven by temporal co-occupancy on this class)",
      );
    }
  }

  return findings;
}

/**
 * Advisory (never flips ok): a LIVE clone bundle whose subject env is provisioned while its
 * state story is undeclared probably points at state the lab does not control. Emitted at
 * most ONCE per bundle (the subject block is bundle-level, never per stream). GITHUB_TOKEN
 * is mechanically excluded: the harness consumes that name for clone auth — it carries no
 * state implication.
 */
function undeclaredSubjectStateWarnings(bundle: RunBundle): string[] {
  const subject = bundle.subject;
  if (subject === undefined || bundle.mode !== "live" || subject.source !== "clone") {
    return [];
  }
  if (subject.state.provenance !== "undeclared") {
    return [];
  }
  const stateRelevantEnvNames = (subject.envNames ?? []).filter((name) => name !== "GITHUB_TOKEN");
  if (stateRelevantEnvNames.length === 0) {
    return [];
  }
  return [
    `Subject env is provisioned (${stateRelevantEnvNames.join(", ")}) but no state story is declared; if any name points at external state, declare subject.state.external (recorded UNPINNED) or seed in-sandbox state with subject.state.seed.`,
  ];
}

const riskyPublicArtifactPathSegments = new Set([
  ".git",
  "Cookies",
  "Login Data",
  "Local Storage",
  "Preferences",
  "Secure Preferences",
  "profiles",
]);

async function scanRunPublicSafetyArtifacts(
  runPaths: PreparedRunArtifactPaths,
  derivedFindings: string[],
  recordingPaths: Set<string>,
): Promise<string[]> {
  const findings: string[] = [];
  await validatePreparedRunArtifactPaths(runPaths);
  await scanRunPublicSafetyDirectory(runPaths, "", findings, derivedFindings, recordingPaths);
  await validatePreparedRunArtifactPaths(runPaths);
  return findings;
}

async function scanRunPublicSafetyDirectory(
  runPaths: PreparedRunArtifactPaths,
  relativeDirectory: string,
  findings: string[],
  derivedFindings: string[],
  recordingPaths: Set<string>,
): Promise<void> {
  // Each authority has its own finding budget. Derived files must never consume
  // the source scan's budget and make an unscanned recording appear verified.
  if (findings.length >= 50 && derivedFindings.length >= 50) {
    return;
  }

  const current = relativeDirectory
    ? path.join(runPaths.physicalRunRoot, ...relativeDirectory.split("/"))
    : runPaths.physicalRunRoot;
  const entries = await readdir(current).catch(() => []);
  for (const entryName of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entryName}` : entryName;
    const stats = await lstat(path.join(current, entryName), { bigint: true }).catch(() => null);
    const selectedFindings =
      !stats?.isDirectory() &&
      (relativePath === "observer/study-analysis.json" || isStudyAnalysisRecordPath(relativePath))
        ? derivedFindings
        : findings;
    if (isRiskyPublicArtifactPath(relativePath) || containsSensitivePattern(relativePath)) {
      if (selectedFindings.length < 50)
        selectedFindings.push(`risky artifact path ${relativePath}`);
    }

    if (
      !stats ||
      stats.isSymbolicLink() ||
      (!stats.isDirectory() && !stats.isFile()) ||
      (stats.isFile() && stats.nlink > 1n)
    ) {
      if (selectedFindings.length < 50)
        selectedFindings.push(`unsafe artifact leaf ${relativePath}`);
      continue;
    }

    if (stats.isDirectory()) {
      // A directory named analysis.json is not an owned record. Its children
      // can contain source evidence even after derived findings are saturated.
      await scanRunPublicSafetyDirectory(
        runPaths,
        relativePath,
        findings,
        derivedFindings,
        recordingPaths,
      );
      continue;
    }

    if (selectedFindings.length >= 50) continue;

    if (path.extname(relativePath).toLowerCase() === ".mp4" && !recordingPaths.has(relativePath)) {
      selectedFindings.push(`unregistered continuous media ${relativePath}`);
    }
    if (!shouldScanTextArtifact(relativePath)) {
      continue;
    }

    const bytes = await readSafeRunArtifactBytes(runPaths, relativePath);
    const text = bytes?.toString("utf8") ?? null;
    if (text !== null && containsSensitivePattern(text)) {
      selectedFindings.push(`sensitive text ${relativePath}`);
    }
  }
}

function isRiskyPublicArtifactPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => riskyPublicArtifactPathSegments.has(segment));
}

function shouldScanTextArtifact(relativePath: string): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  return ![".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".tgz", ".gz", ".zip"].includes(
    extension,
  );
}

function isLocalEvidenceArtifactPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return (
    value.length > 0 &&
    !/^\[[a-z0-9._-]+\]$/i.test(normalized) &&
    !path.isAbsolute(normalized) &&
    !normalized.includes("://") &&
    !normalized.startsWith("..") &&
    !normalized.split("/").includes("..") &&
    !isRiskyPublicArtifactPath(normalized)
  );
}

function normalizeLocalEvidenceReference(value: string | undefined): string | null {
  if (!value || value.includes("://") || path.isAbsolute(value)) {
    return null;
  }

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("../")) {
    return isLocalEvidenceArtifactPath(normalized.slice(3)) ? normalized.slice(3) : null;
  }

  return isLocalEvidenceArtifactPath(normalized) ? normalized : null;
}

async function validateCwd(cwd: string): Promise<RunResult["error"] | null> {
  try {
    const stats = await stat(cwd);

    if (!stats.isDirectory()) {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd is not a directory: ${cwd}`,
      };
    }

    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd does not exist: ${cwd}`,
      };
    }

    throw error;
  }
}

function containsSensitivePattern(text: string): boolean {
  return containsSensitive(text);
}

function isRunBundle(value: unknown): value is RunBundle {
  return (
    isRecord(value) &&
    value.schema === RUN_BUNDLE_SCHEMA &&
    (value.commsReceiving === undefined || isCommsReceivingEvidence(value.commsReceiving)) &&
    (value.publication === undefined ||
      (isRecord(value.publication) &&
        Array.isArray(value.publication.restrictions) &&
        value.publication.restrictions.length === 1 &&
        value.publication.restrictions[0] === "real-communications")) &&
    typeof value.runId === "string" &&
    (value.mode === "dry-run" || value.mode === "live") &&
    isPositiveSafeInteger(value.simCount) &&
    typeof value.createdAt === "string" &&
    value.cwd === PUBLIC_TARGET_CWD &&
    typeof value.artifactRoot === "string" &&
    isRunSource(value.source) &&
    isPersonaSummary(value.persona) &&
    isScenarioSummary(value.scenario) &&
    Array.isArray(value.lifecycle) &&
    value.lifecycle.every(isLifecycleEvent) &&
    Array.isArray(value.simulations) &&
    value.simulations.length === value.simCount &&
    value.simulations.every(isRunSimulation) &&
    Array.isArray(value.streams) &&
    value.streams.every(isRunStream) &&
    hasConsistentSimulationStreams(value.simulations, value.streams) &&
    Array.isArray(value.events) &&
    value.events.every(isRunEvent) &&
    isRunArtifactIndex(value.artifacts) &&
    isRecord(value.review) &&
    isReviewSummary(value.review) &&
    isRecord(value.redaction) &&
    value.redaction.status === "passed" &&
    Array.isArray(value.feedbackCandidates) &&
    value.feedbackCandidates.every(isRunFeedbackCandidate) &&
    // Optional and additive: pre-existing bundles (and non-cua backends) carry no subject
    // block; when present it must be well-shaped (semantics are the verify check's job).
    (value.subject === undefined || isRunSubjectProvenance(value.subject)) &&
    (value.desktopBrowser === undefined || isDesktopBrowserEvidence(value.desktopBrowser)) &&
    (value.rerun === undefined || isRunRerunLineage(value.rerun)) &&
    // Optional + additive shared-world fields (#164). Tolerant SHAPE guard only — the interaction
    // semantics (timeline well-formedness, single-plane, delta-on-pass) are the verify check's job.
    (value.attributionClass === undefined ||
      value.attributionClass === "isolated" ||
      value.attributionClass === "shared-world") &&
    (value.sharedWorld === undefined || isSharedWorldEvidence(value.sharedWorld)) &&
    // Optional, adapter-namespaced product score (the extension seam). When present, validate only
    // its SHAPE; core never reads the adapter's `data` payload.
    (value.adapterScore === undefined || isRunAdapterScore(value.adapterScore)) &&
    // Optional + additive scorer provenance (#316). Tolerated-absent so pre-#316 and library-caller
    // bundles still verify; when present it must be well-shaped.
    (value.scorerProvenance === undefined || isRunScorerProvenance(value.scorerProvenance)) &&
    (value.adapterArtifacts === undefined ||
      (Array.isArray(value.adapterArtifacts) &&
        value.adapterArtifacts.every(isRunAdapterArtifact))) &&
    (value.providerResources === undefined ||
      (Array.isArray(value.providerResources) &&
        value.providerResources.every(isRunProviderResource)))
  );
}

function isRunProviderResource(value: unknown): value is RunProviderResource {
  return (
    isRecord(value) &&
    value.schema === "humanish.provider-resource.v1" &&
    value.provider === "e2b-desktop" &&
    value.kind === "sandbox" &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    value.owner === "humanish" &&
    (value.status === "running" || value.status === "killed" || value.status === "unknown") &&
    (value.simId === undefined || typeof value.simId === "string") &&
    (value.streamId === undefined || typeof value.streamId === "string") &&
    (value.laneId === undefined || typeof value.laneId === "string") &&
    (value.createdAt === undefined || typeof value.createdAt === "string") &&
    (value.cleanup === undefined ||
      (isRecord(value.cleanup) &&
        typeof value.cleanup.killed === "boolean" &&
        typeof value.cleanup.reason === "string"))
  );
}

function isCleanupResult(value: unknown): value is CleanupResult {
  return (
    isRecord(value) &&
    value.schema === CLEANUP_SCHEMA &&
    typeof value.ok === "boolean" &&
    typeof value.cwd === "string" &&
    typeof value.run === "string" &&
    typeof value.checkedAt === "string" &&
    (value.runId === undefined || typeof value.runId === "string") &&
    (value.bundlePath === undefined || typeof value.bundlePath === "string") &&
    (value.cleanupPath === undefined || typeof value.cleanupPath === "string") &&
    isRecord(value.summary) &&
    isNonNegativeSafeInteger(value.summary.resources) &&
    isNonNegativeSafeInteger(value.summary.killed) &&
    isNonNegativeSafeInteger(value.summary.alreadyClean) &&
    isNonNegativeSafeInteger(value.summary.failed) &&
    isNonNegativeSafeInteger(value.summary.skipped) &&
    Array.isArray(value.resources) &&
    value.resources.every(isCleanupResourceResult) &&
    Array.isArray(value.adapterResults) &&
    value.adapterResults.every(isCleanupAdapterResult) &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string")
  );
}

function isCleanupResourceResult(value: unknown): value is CleanupResourceResult {
  return (
    isRecord(value) &&
    value.provider === "e2b-desktop" &&
    value.kind === "sandbox" &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    (value.status === "killed" ||
      value.status === "already_clean" ||
      value.status === "failed" ||
      value.status === "skipped") &&
    typeof value.message === "string"
  );
}

function isCleanupAdapterResult(value: unknown): value is CleanupAdapterResult {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.ok === "boolean" &&
    typeof value.message === "string"
  );
}

function isRunRerunLineage(value: unknown): value is RunRerunLineage {
  return (
    isRecord(value) &&
    typeof value.sourceRunId === "string" &&
    value.sourceRunId.trim().length > 0 &&
    Array.isArray(value.selectedLaneIds) &&
    value.selectedLaneIds.length > 0 &&
    value.selectedLaneIds.every(
      (laneId) => typeof laneId === "string" && laneId.trim().length > 0,
    ) &&
    Array.isArray(value.previous) &&
    value.previous.length > 0 &&
    value.previous.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.laneId === "string" &&
        entry.laneId.trim().length > 0 &&
        (entry.streamId === undefined || typeof entry.streamId === "string") &&
        typeof entry.status === "string" &&
        entry.status.trim().length > 0 &&
        (entry.reason === undefined || typeof entry.reason === "string") &&
        (entry.actorStatus === undefined || typeof entry.actorStatus === "string") &&
        (entry.completionReason === undefined || typeof entry.completionReason === "string"),
    )
  );
}

function isDesktopBrowserEvidence(value: unknown): value is RunBundle["desktopBrowser"] {
  return (
    isRecord(value) &&
    (value.requested === "default" ||
      value.requested === "chrome" ||
      value.requested === "chromium" ||
      value.requested === "firefox") &&
    (value.resolved === undefined || typeof value.resolved === "string")
  );
}

/** Short lowercase-hex content digest (digestText default is 12 chars; tolerate longer future digests). */
const SCORER_DIGEST_PATTERN = /^[a-f0-9]{12,64}$/;

/** Shape guard for RunScorerProvenance (#316), mirroring isRunSubjectProvenance: tolerated-absent in
 *  isRunBundle, well-shaped when present. Semantics (does the digest still match the file) are not a
 *  verify concern — the block is core-stamped evidence of what was loaded, not a re-execution proof. */
function isRunScorerProvenance(value: unknown): value is RunScorerProvenance {
  return (
    isRecord(value) &&
    value.schema === "humanish.scorer-provenance.v1" &&
    typeof value.ref === "string" &&
    value.ref.trim().length > 0 &&
    typeof value.digest === "string" &&
    SCORER_DIGEST_PATTERN.test(value.digest) &&
    (value.source === "manifest" || value.source === "cli-flag") &&
    Array.isArray(value.exports) &&
    value.exports.length > 0 &&
    value.exports.every(
      (name) => name === "score" || name === "deriveFeedback" || name === "deriveArtifacts",
    )
  );
}

function isRunAdapterScore(value: unknown): value is RunAdapterScore {
  return (
    isRecord(value) &&
    value.schema === "humanish.adapter-score.v1" &&
    typeof value.namespace === "string" &&
    value.namespace.trim().length > 0 &&
    (value.status === "pass" || value.status === "partial" || value.status === "fail") &&
    typeof value.score === "number" &&
    Number.isFinite(value.score) &&
    typeof value.summary === "string" &&
    (value.data === undefined || isRecord(value.data))
  );
}

/**
 * Tolerant SHAPE guard for the shared-world evidence block (#164). Validates required fields +
 * types but TOLERATES extra keys (additive): the strict value-shape/timeline checks are
 * sharedWorldEvidenceFindings' job (an injected value-shaped checkpoint field must pass the shape
 * guard so verify can catch it fail-closed, not silently bounce off isRunBundle).
 */
function isSharedWorldEvidence(value: unknown): value is SharedWorldEvidence {
  if (!isRecord(value)) return false;
  if (value.schema !== SHARED_WORLD_SCHEMA) return false;
  if (value.topology !== "shared-world") return false;
  if (!isNonNegativeSafeInteger(value.roleCount)) return false;
  const plane = value.plane;
  if (!isRecord(plane)) return false;
  if (plane.commit !== undefined && typeof plane.commit !== "string") return false;
  if (typeof plane.seedDigest !== "string") return false;
  if (!(Array.isArray(plane.envNames) && plane.envNames.every((name) => typeof name === "string")))
    return false;
  if (plane.hostDigest !== undefined && typeof plane.hostDigest !== "string") return false;
  if (plane.exposure !== undefined && typeof plane.exposure !== "string") return false;
  if (plane.publicOriginDigest !== undefined && typeof plane.publicOriginDigest !== "string")
    return false;
  if (plane.declaredOriginDigest !== undefined && typeof plane.declaredOriginDigest !== "string")
    return false;
  if (value.planeClass !== undefined && typeof value.planeClass !== "string") return false;
  if (
    value.lobbyConvergenceDigest !== undefined &&
    typeof value.lobbyConvergenceDigest !== "string"
  )
    return false;
  if (
    !(
      Array.isArray(value.attributionLimits) &&
      value.attributionLimits.every((limit) => typeof limit === "string")
    )
  )
    return false;
  // Tolerant: validate the TYPE of each present field only (the coherence + topologyMode dispatch
  // are validateSharedWorldEvidence's job — an injected value-shaped field must pass this guard so
  // verify catches it fail-closed). A bundle must carry at least one of the two shapes.
  if (
    value.sequence !== undefined &&
    !(Array.isArray(value.sequence) && value.sequence.every((id) => typeof id === "string"))
  )
    return false;
  if (
    value.timeline !== undefined &&
    !(Array.isArray(value.timeline) && value.timeline.every(isSharedWorldTimelineEntry))
  )
    return false;
  if (
    value.laneWindows !== undefined &&
    !(Array.isArray(value.laneWindows) && value.laneWindows.every(isSharedWorldLaneWindow))
  )
    return false;
  if (
    value.stateSeries !== undefined &&
    !(Array.isArray(value.stateSeries) && value.stateSeries.every(isSharedWorldStateSnapshot))
  )
    return false;
  if (
    value.outcomes !== undefined &&
    !(Array.isArray(value.outcomes) && value.outcomes.every(isSharedWorldOutcome))
  )
    return false;
  if (value.timeline === undefined && value.laneWindows === undefined) return false;
  return true;
}

function isSharedWorldTimelineEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "checkpoint") {
    return (
      typeof value.name === "string" &&
      typeof value.digest === "string" &&
      typeof value.deltaFromPrev === "boolean"
    );
  }
  if (value.kind === "turn") {
    return (
      typeof value.roleId === "string" &&
      typeof value.simId === "string" &&
      typeof value.streamId === "string" &&
      typeof value.seedDigest === "string" &&
      (value.commit === undefined || typeof value.commit === "string")
    );
  }
  return false;
}

// Tolerant shape guards for the CONCURRENT series (extra keys tolerated — the digest-only /
// allowed-keys tripwires are validateSharedWorldEvidence's strict job).
function isSharedWorldLaneWindow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.roleId === "string" &&
    (value.actorType === undefined || typeof value.actorType === "string") &&
    (value.surface === undefined || typeof value.surface === "string") &&
    (value.caseGroup === undefined || typeof value.caseGroup === "string") &&
    typeof value.simId === "string" &&
    typeof value.streamId === "string" &&
    typeof value.startedAt === "number" &&
    typeof value.endedAt === "number" &&
    typeof value.verdict === "string" &&
    typeof value.routeHostDigest === "string" &&
    typeof value.seedDigest === "string" &&
    (value.commit === undefined || typeof value.commit === "string")
  );
}

function isSharedWorldStateSnapshot(value: unknown): boolean {
  return isRecord(value) && typeof value.timestamp === "number" && typeof value.digest === "string";
}

function isSharedWorldOutcome(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.roleId === "string" &&
    (value.actorType === undefined || typeof value.actorType === "string") &&
    (value.surface === undefined || typeof value.surface === "string") &&
    (value.caseGroup === undefined || typeof value.caseGroup === "string") &&
    typeof value.simId === "string" &&
    typeof value.streamId === "string" &&
    typeof value.status === "string" &&
    typeof value.ok === "boolean"
  );
}

// The local-tree archive content pin: sha256 hex, full 64 chars (NOT the repo's 16-char
// display-digest convention -- this value is the provenance pin itself, persisted in full).
const ARCHIVE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isRunSubjectProvenance(value: unknown): value is RunSubjectProvenance {
  if (!isRecord(value)) return false;
  if (value.source !== "clone" && value.source !== "app-url" && value.source !== "local-tree")
    return false;
  if (value.repo !== undefined && typeof value.repo !== "string") return false;
  if (value.commit !== undefined && typeof value.commit !== "string") return false;
  if (
    value.archiveSha256 !== undefined &&
    (typeof value.archiveSha256 !== "string" || !ARCHIVE_SHA256_PATTERN.test(value.archiveSha256))
  ) {
    return false;
  }
  if (value.dirty !== undefined && typeof value.dirty !== "boolean") return false;
  if (
    value.envNames !== undefined &&
    !(Array.isArray(value.envNames) && value.envNames.every((name) => typeof name === "string"))
  ) {
    return false;
  }
  const state = value.state;
  if (!isRecord(state)) return false;
  if (
    state.provenance !== "seeded" &&
    state.provenance !== "unpinned" &&
    state.provenance !== "declared-not-run" &&
    state.provenance !== "undeclared" &&
    state.provenance !== "external-public"
  ) {
    return false;
  }
  if (
    state.seed !== undefined &&
    !(Array.isArray(state.seed) && state.seed.every(isRunSubjectStateStepRecord))
  ) {
    return false;
  }
  if (
    state.externalEnvNames !== undefined &&
    !(
      Array.isArray(state.externalEnvNames) &&
      state.externalEnvNames.every((name) => typeof name === "string")
    )
  ) {
    return false;
  }
  return true;
}

function isRunSubjectStateStepRecord(value: unknown): value is RunSubjectStateStepRecord {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.when === "before-build" ||
      value.when === "before-start" ||
      value.when === "after-ready") &&
    typeof value.commandDigest === "string" &&
    (value.ok === undefined || typeof value.ok === "boolean") &&
    (value.exitCode === undefined || typeof value.exitCode === "number") &&
    (value.timedOut === undefined || typeof value.timedOut === "boolean") &&
    (value.durationMs === undefined || typeof value.durationMs === "number")
  );
}

function isRunSource(value: unknown): value is RunBundle["source"] {
  return (
    isRecord(value) &&
    (typeof value.packageName === "string" || value.packageName === null) &&
    (value.humanishSource === "present" || value.humanishSource === "missing") &&
    isCapturedGitState(value.git)
  );
}

function isCapturedGitState(value: unknown): value is CapturedGitState {
  return (
    isRecord(value) &&
    value.schema === GIT_STATE_SCHEMA &&
    (value.status === "clean" ||
      value.status === "dirty" ||
      value.status === "missing" ||
      value.status === "unavailable") &&
    typeof value.capturedAt === "string" &&
    isRecord(value.head) &&
    (isSafeGitShortSha(value.head.shortSha) || value.head.shortSha === null) &&
    (value.head.refState === "attached" ||
      value.head.refState === "detached" ||
      value.head.refState === "unborn" ||
      value.head.refState === "unknown") &&
    isRecord(value.changes) &&
    isNonNegativeSafeInteger(value.changes.staged) &&
    isNonNegativeSafeInteger(value.changes.unstaged) &&
    isNonNegativeSafeInteger(value.changes.untracked) &&
    isNonNegativeSafeInteger(value.changes.total) &&
    typeof value.note === "string" &&
    SAFE_GIT_NOTES.has(value.note)
  );
}

function isPersonaSummary(value: unknown): value is RunBundle["persona"] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.source === "string" &&
    typeof value.sourceDigest === "string"
  );
}

function isScenarioSummary(value: unknown): value is RunBundle["scenario"] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.goal === "string" &&
    typeof value.source === "string" &&
    typeof value.sourceDigest === "string"
  );
}

function isLifecycleEvent(value: unknown): value is RunBundle["lifecycle"][number] {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    typeof value.event === "string" &&
    typeof value.message === "string"
  );
}

function isRunSimulation(value: unknown): value is RunSimulation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isPositiveSafeInteger(value.index) &&
    typeof value.personaId === "string" &&
    typeof value.scenarioId === "string" &&
    isRunSimulationStatus(value.status) &&
    isRunStreamKind(value.streamKind) &&
    (value.mode === "browser-sim" ||
      value.mode === "cli-sim" ||
      value.mode === "tui-sim" ||
      value.mode === "codex-app-sim") &&
    typeof value.progress === "number" &&
    typeof value.currentStep === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.streamIds) &&
    value.streamIds.every((streamId) => typeof streamId === "string") &&
    typeof value.startedAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRunStream(value: unknown): value is RunStream {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.simId === "string" &&
    isRunStreamKind(value.kind) &&
    typeof value.label === "string" &&
    isRunSimulationStatus(value.status) &&
    (value.transport === "snapshot" ||
      value.transport === "polling" ||
      value.transport === "sse" ||
      value.transport === "pty" ||
      value.transport === "app-server") &&
    typeof value.updatedAt === "string" &&
    (value.assignment === undefined || isRunParticipantAssignment(value.assignment)) &&
    (value.viewport === undefined || isRunViewport(value.viewport)) &&
    (value.desktopGeometry === undefined || isRunDesktopGeometry(value.desktopGeometry)) &&
    (value.recording === undefined || isRunDesktopRecording(value.recording)) &&
    hasConsistentStreamGeometry(value) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isRunStreamArtifact) &&
    hasConsistentRecordingArtifact(value.recording, value.artifacts)
  );
}

function hasConsistentRecordingArtifact(
  recording: RunDesktopRecording | undefined,
  artifacts: RunStream["artifacts"],
): boolean {
  const files = artifacts.filter((artifact) => artifact.kind === "recording");
  return recording ? files.length === 1 && files[0]!.path === recording.path : files.length === 0;
}

function isRunDesktopRecording(value: unknown): value is RunDesktopRecording {
  if (
    !isRecord(value) ||
    value.schema !== "humanish.desktop-recording.v1" ||
    typeof value.path !== "string" ||
    !isLocalEvidenceArtifactPath(value.path) ||
    !/^recordings\/[-A-Za-z0-9_.]+\/desktop\.mp4$/.test(value.path)
  )
    return false;
  const { schema: _schema, path: _path, ...metadata } = value;
  return desktopRecordingMetadataSchema.safeParse(metadata).success;
}

function isRunParticipantAssignment(value: unknown): value is RunParticipantAssignment {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "mission" || key === "focus" || key === "tasks") &&
    typeof value.mission === "string" &&
    (value.focus === undefined || typeof value.focus === "string") &&
    (value.tasks === undefined ||
      (Array.isArray(value.tasks) &&
        value.tasks.every(
          (task) =>
            isRecord(task) &&
            Object.keys(task).every((key) => key === "id" || key === "goal") &&
            typeof task.id === "string" &&
            typeof task.goal === "string",
        )))
  );
}

function isRunViewport(value: unknown): value is NonNullable<RunStream["viewport"]> {
  return (
    isRecord(value) &&
    isPositiveFiniteNumber(value.width) &&
    isPositiveFiniteNumber(value.height) &&
    (value.deviceScaleFactor === undefined || isPositiveFiniteNumber(value.deviceScaleFactor)) &&
    (value.isMobile === undefined || typeof value.isMobile === "boolean")
  );
}

function isRunDesktopGeometry(value: unknown): value is RunDesktopGeometry {
  if (!isRecord(value) || !isRecord(value.screen) || !isMeasuredSize(value.screen.requested)) {
    return false;
  }
  const verified = value.screen.verified;
  if (verified !== undefined) {
    if (!isRecord(verified)) return false;
    const source = verified.source;
    if (!isMeasuredSize(verified) || source !== "xdpyinfo") return false;
  }
  const declared = value.screen.declared;
  if (declared !== undefined) {
    if (!isRecord(declared)) return false;
    // read before isMeasuredSize narrows `declared` to {width, height}
    const preset = declared.preset;
    if (!isMeasuredSize(declared) || typeof preset !== "string") return false;
  }
  const browserWindow = value.browserWindow;
  if (
    browserWindow !== undefined &&
    (!isRecord(browserWindow) ||
      !isFiniteNumber(browserWindow.x) ||
      !isFiniteNumber(browserWindow.y) ||
      !isPositiveFiniteNumber(browserWindow.width) ||
      !isPositiveFiniteNumber(browserWindow.height) ||
      (browserWindow.source !== "cdp" &&
        browserWindow.source !== "xdotool" &&
        browserWindow.source !== "xwininfo"))
  ) {
    return false;
  }
  const viewport = value.viewport;
  if (
    !(
      viewport === undefined ||
      (isRecord(viewport) &&
        isPositiveFiniteNumber(viewport.width) &&
        isPositiveFiniteNumber(viewport.height) &&
        isPositiveFiniteNumber(viewport.deviceScaleFactor) &&
        viewport.source === "cdp")
    )
  )
    return false;
  return (
    value.warnings === undefined ||
    (Array.isArray(value.warnings) &&
      value.warnings.every((warning) => typeof warning === "string" && warning.length > 0))
  );
}

function hasConsistentStreamGeometry(value: Record<string, unknown>): boolean {
  if (value.desktopGeometry === undefined) return true;
  if (!isRunDesktopGeometry(value.desktopGeometry)) return false;
  const measured = value.desktopGeometry.viewport;
  if (measured === undefined) return value.viewport === undefined;
  if (!isRunViewport(value.viewport)) return false;
  return (
    value.viewport.width === measured.width &&
    value.viewport.height === measured.height &&
    value.viewport.deviceScaleFactor === measured.deviceScaleFactor
  );
}

function isMeasuredSize(value: unknown): value is { width: number; height: number } {
  return (
    isRecord(value) && isPositiveFiniteNumber(value.width) && isPositiveFiniteNumber(value.height)
  );
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRunStreamArtifact(value: unknown): value is RunStream["artifacts"][number] {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    typeof value.path === "string" &&
    (value.kind === "bundle" ||
      value.kind === "review" ||
      value.kind === "observer" ||
      value.kind === "events" ||
      value.kind === "screenshot" ||
      value.kind === "trace" ||
      value.kind === "log" ||
      value.kind === "filesystem" ||
      value.kind === "recording")
  );
}

function isRunAdapterArtifact(value: unknown): value is RunAdapterArtifact {
  return (
    isRecord(value) &&
    value.schema === "humanish.adapter-artifact.v1" &&
    typeof value.namespace === "string" &&
    value.namespace.trim().length > 0 &&
    typeof value.label === "string" &&
    value.label.trim().length > 0 &&
    typeof value.path === "string" &&
    value.path.trim().length > 0 &&
    isLocalEvidenceArtifactPath(value.path) &&
    (value.kind === "state" ||
      value.kind === "review" ||
      value.kind === "log" ||
      value.kind === "trace" ||
      value.kind === "screenshot" ||
      value.kind === "filesystem" ||
      value.kind === "summary") &&
    typeof value.note === "string" &&
    value.note.trim().length > 0
  );
}

function isRunEvent(value: unknown): value is RunEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.at === "string" &&
    (value.level === "info" || value.level === "warn" || value.level === "error") &&
    typeof value.type === "string" &&
    typeof value.message === "string"
  );
}

function isRunArtifactIndex(value: unknown): value is RunBundle["artifacts"] {
  return (
    isRecord(value) &&
    typeof value.run === "string" &&
    typeof value.reviewJson === "string" &&
    typeof value.reviewMarkdown === "string" &&
    typeof value.observerData === "string" &&
    typeof value.events === "string"
  );
}

function isRunFeedbackCandidate(value: unknown): value is RunFeedbackCandidate {
  return (
    isRecord(value) &&
    value.schema === "humanish.feedback-candidate.v1" &&
    typeof value.id === "string" &&
    typeof value.run_id === "string" &&
    (typeof value.stream_id === "string" || value.stream_id === undefined) &&
    typeof value.adapter_id === "string" &&
    typeof value.scenario_id === "string" &&
    typeof value.persona_id === "string" &&
    isFeedbackActor(value.actor) &&
    isFeedbackSubstrate(value.substrate) &&
    isFeedbackFailureOwner(value.failure_owner) &&
    typeof value.summary === "string" &&
    typeof value.expected === "string" &&
    typeof value.actual === "string" &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isRunFeedbackEvidence) &&
    isRecord(value.redaction) &&
    value.redaction.status === "passed" &&
    typeof value.redaction.notes === "string" &&
    typeof value.idempotency_key === "string" &&
    isFeedbackNextState(value.proposed_next_state) &&
    Array.isArray(value.acceptance_proof) &&
    value.acceptance_proof.every((item) => typeof item === "string") &&
    // Optional, adapter-namespaced product-noun block: when present, validate only its SHAPE
    // (a non-empty namespace + a data record). Core never inspects the keys inside `data`.
    (value.adapter === undefined || isFeedbackAdapterBlock(value.adapter))
  );
}

function isFeedbackAdapterBlock(
  value: unknown,
): value is NonNullable<RunFeedbackCandidate["adapter"]> {
  return (
    isRecord(value) &&
    typeof value.namespace === "string" &&
    value.namespace.trim().length > 0 &&
    isRecord(value.data)
  );
}

function isRunFeedbackEvidence(value: unknown): value is RunFeedbackCandidate["evidence"][number] {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    !path.isAbsolute(value.path) &&
    !value.path.includes("://") &&
    !value.path.includes("..") &&
    (value.kind === "review" ||
      value.kind === "state" ||
      value.kind === "log" ||
      value.kind === "trace" ||
      value.kind === "screenshot" ||
      value.kind === "filesystem") &&
    typeof value.note === "string"
  );
}

function hasConsistentSimulationStreams(simulations: unknown[], streams: unknown[]): boolean {
  const simIds = new Set<string>();
  const expectedStreamSimIds = new Map<string, string>();
  const streamById = new Map<string, RunStream>();

  for (const simulation of simulations) {
    if (!isRunSimulation(simulation)) {
      return false;
    }

    simIds.add(simulation.id);
    for (const streamId of simulation.streamIds) {
      if (expectedStreamSimIds.has(streamId)) {
        return false;
      }

      expectedStreamSimIds.set(streamId, simulation.id);
    }
  }

  for (const stream of streams) {
    if (!isRunStream(stream) || !simIds.has(stream.simId) || streamById.has(stream.id)) {
      return false;
    }

    const expectedSimId = expectedStreamSimIds.get(stream.id);
    if (expectedSimId === undefined || stream.simId !== expectedSimId) {
      return false;
    }

    streamById.set(stream.id, stream);
  }

  return streamById.size === expectedStreamSimIds.size;
}

function isRunSimulationStatus(value: unknown): value is RunSimulationStatus {
  return (
    value === "queued" ||
    value === "preparing" ||
    value === "running" ||
    value === "passed" ||
    // Participant outcomes (docs/principles/three-roles.md). This runtime allowlist is the actual
    // gate — the TS union alone does not validate a bundle read back from disk.
    value === "abandoned" ||
    value === "incomplete" ||
    value === "complete" ||
    value === "blocked" ||
    value === "timed_out" ||
    value === "failed" ||
    value === "contract_proof_only"
  );
}

function isRunStreamKind(value: unknown): value is RunStreamKind {
  return (
    value === "ui" ||
    value === "browser" ||
    value === "terminal" ||
    value === "tui" ||
    value === "codex-ui" ||
    value === "artifact" ||
    value === "summary"
  );
}

function isSafeGitShortSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,12}$/.test(value);
}

function isFeedbackActor(value: unknown): value is RunFeedbackCandidate["actor"] {
  return (
    value === "codex-tui" ||
    value === "codex-exec" ||
    value === "codex-app-server" ||
    value === "computer-use" ||
    value === "synthetic-dry-run" ||
    value === "unknown"
  );
}

function isFeedbackSubstrate(value: unknown): value is RunFeedbackCandidate["substrate"] {
  return (
    value === "e2b-desktop" ||
    value === "local-desktop" ||
    value === "e2b-terminal" ||
    value === "local-filesystem" ||
    value === "codex-app-server" ||
    value === "unknown"
  );
}

function isFeedbackFailureOwner(value: unknown): value is RunFeedbackCandidate["failure_owner"] {
  return (
    value === "harness" ||
    value === "target-app" ||
    value === "actor" ||
    value === "environment" ||
    value === "unknown"
  );
}

function isFeedbackNextState(value: unknown): value is RunFeedbackCandidate["proposed_next_state"] {
  return (
    value === "watch" ||
    value === "adapter-hardening" ||
    value === "target-app-setup" ||
    value === "actor-auth" ||
    value === "setup-quality-review" ||
    value === "study-quality-review"
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isReviewSummary(value: unknown): value is ReviewSummary {
  return (
    isRecord(value) &&
    value.schema === REVIEW_SCHEMA &&
    (value.verdict === "contract_proof_only" ||
      value.verdict === "pass" ||
      value.verdict === "fail" ||
      value.verdict === "blocked" ||
      value.verdict === "timed_out") &&
    typeof value.summary === "string" &&
    Array.isArray(value.gaps) &&
    value.gaps.every((gap) => typeof gap === "string")
  );
}

function isRunPointer(value: unknown): value is RunPointer {
  return (
    isRecord(value) &&
    value.schema === "humanish.latest-run.v1" &&
    typeof value.runId === "string" &&
    typeof value.path === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
