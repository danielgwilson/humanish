import type { CommsReceivingEvidence } from "../comms/receiving-types.js";
import { captureGitState, type CapturedGitState } from "./git-state.js";
import type { SharedWorldEvidence } from "./shared-world-evidence.js";
import type { RunLabProvenance } from "./status.js";
import type { RunSimulationStatus, RunStream, RunStreamKind } from "./streams.js";

export const RUN_BUNDLE_SCHEMA = "humanish.run-bundle.v1";

export const REVIEW_SCHEMA = "humanish.review.v1";

export const PUBLIC_TARGET_CWD = "[target-cwd]";

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
 * adapter attach product/state proof outputs to the humanish evidence packet
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
   * null-discipline the terminal cost ledger already ships. Absent on pre-existing bundles and
   * dry runs; a live run that spends nothing records an explicit zero with no lines. Every dollar figure here is an ESTIMATE,
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
  /** Sum of the KNOWN (non-null) lines; null iff every applicable line is null; 0 with no lines
   *  for a spend-free run. */
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

export const CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA =
  "humanish.codex-app-server-trace.projected.v1";
