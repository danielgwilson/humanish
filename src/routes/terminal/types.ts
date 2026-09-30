import {
  type AutomaticAnalysisHooks,
  type AutomaticAnalysisResult,
} from "../../analysis/automatic-completion.js";
import type {
  ActorCompletionReason,
  ActorRuntimeProvenance,
  ActorStatus,
  ActorTrace,
} from "../../actors/contract.js";
import { type RunLabProvenance } from "../../run/status.js";
import type { CostCategory } from "../../run/terminal-contract.js";
import type { RunScope } from "../../run/run.js";
import type { LabConfig, LabScenarioCaps } from "../../lab/types.js";
import { type E2BDesktopModule } from "../../substrates/e2b/sdk.js";
import { renderObserver, type ObserverResult } from "../../observer/render.js";
import {
  type RunAdapterScore,
  type RunBundle,
  type RunFeedbackCandidate,
  type RunScorerProvenance,
} from "../../run/bundle.js";
import { TERMINAL_AGENT_NOT_IMPLEMENTED_CODE } from "../../actors/terminal-agent.js";

/** Provider-neutral metadata constant: the lane's non-secret tag (mirrors CUA_ACTOR_LAB_PROVIDER_METADATA). */
export const TERMINAL_PRODUCT_LAB_PROVIDER_METADATA = {
  mode: "terminal-product-lab",
  tool: "humanish",
} as const;

/** The in-sandbox working directory for the agent (a scratch dir; nothing is cloned into it). */
export const SANDBOX_WORKDIR = "/home/user/study";

/** A packed npm tarball is a couple of MB; the cap is generous and exists so a mis-set path cannot
 *  stream something enormous into a sandbox. */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

// Server-side reclamation buffer past the codex command's own wall-clock (caps.maxMinutes) kill.
export const SANDBOX_TIMEOUT_BUFFER_MS = 5 * 60_000;

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// The product's own setup command (subject.product.install) gets a finite deadline.
export const PRODUCT_SETUP_TIMEOUT_MS = 300_000;

// How much of a captured stream / log tail rides a (redacted) message field.
export const TAIL_CHARS = 2000;

// Hard cap on the retained event-stream + transcript size, so a runaway agent cannot balloon the
// bundle. Redaction runs PRE-truncation so a cut can never split a secret past the scrubber.
export const MAX_TRANSCRIPT_BYTES = 512 * 1024;

export const TERMINAL_PRODUCT_LAB_SCHEMA = "humanish.terminal-lab-result.v1";

/**
 * The read-only evidence a thin adapter's scorer/feedback hook sees (the layer-6 extension seam,
 * issue #154 acceptance #8). It is the FULLY-ASSEMBLED, redacted, verifiable evidence — the live run
 * bundle, the provider-neutral actor trace, and the persisted ledgers (substrate/command/
 * interventions/cleanup/cost/no-spend). Every member is an EXPORTED public type, so a thin adapter
 * types against `import("humanish")` alone — never a deep `src/` import. The adapter reads this
 * to score the product attempt and derive feedback; it cannot mutate core's evidence (the lane
 * attaches only the namespaced `RunAdapterScore` it returns + the feedback candidates it derives).
 */
export interface TerminalProductScoringContext {
  /** The assembled live run bundle (already redacted/scrubbed + verifiable). Read-only to the adapter. */
  bundle: RunBundle;
  /** The provider-neutral actor trace for the in-sandbox agent session. */
  trace: ActorTrace;
  /** The persisted terminal-product ledgers (lifecycle/command/interventions/cleanup/cost/no-spend). */
  ledgers: TerminalLedgers;
  /**
   * The FULL normalized transcript of the in-sandbox agent session — scrubbed (literal known
   * values) then redacted (shape patterns) AT THE SOURCE, capped at MAX_TRANSCRIPT_BYTES, and
   * byte-identical to the persisted terminal-transcript.txt artifact. The trace's transcriptTail
   * is a ~2KB projection of this; a scorer needs the whole session so a rubric can find
   * command-tier evidence anywhere in it, not only in the tail window (#341).
   */
  transcript: string;
  /** The studied product name (public-safe). */
  product: string;
  /** The lab id (the run's scenario scope). */
  labId: string;
  /** The run id (for building namespaced idempotency keys + evidence pointers). */
  runId: string;
}

/**
 * Library-level hooks: the DI seams that drive the full live path against a fake sandbox + mock
 * CLI at zero spend. The deterministic merge-gate test wires loadModule (a fake @e2b/desktop
 * module) + env (the operator key source) + now (an injected clock); the live rung uses none of
 * them (it loads the real module and reads the real environment).
 */
export interface TerminalProductLabHooks {
  /** Lazy-load the E2B module (tests inject a fake; default loadE2BDesktopModule). */
  loadModule?: () => Promise<E2BDesktopModule>;
  /**
   * The operator environment the lane reads the runtime key from (and from which it asserts no
   * banned credential is requested). Defaults to process.env. The runtime key is injected ONLY
   * into command-scoped `codex` env or an external header transform — NEVER Sandbox.create envs (the credential
   * boundary); tests plant a fake key here and assert it never reaches metadata/global env/artifacts.
   */
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock for deterministic timestamps + wall-clock arithmetic (tests only). */
  now?: () => number;
  /**
   * Optional cost-ledger seam. Core has no product/media/payment spend signal, so it populates only
   * the provider line from trace tokenUsage when present. Tests and adapters can inject KNOWN spend
   * lines; absent signals retain the null-discipline default.
   */
  costProbe?: (context: {
    tokenCostUsd?: number;
  }) => Partial<Record<"product" | "media" | "payment" | "provider", CostLine>> | undefined;
  /**
   * THE LAYER-6 EXTENSION SEAM (issue #154 acceptance #8: "product-adapter hooks WITHOUT forking
   * core"). A thin in-repo/out-of-tree adapter registers a product scorer here. The lane calls it
   * (when provided) over the fully-assembled evidence and attaches the returned, ADAPTER-NAMESPACED
   * `RunAdapterScore` to `bundle.adapterScore` WITHOUT core knowing any product noun (the score is
   * namespaced + its component breakdown rides in `data`). When NO scorer is given, the default
   * mission-based verdict (`review`) is unchanged. This is the SEAM the adopter's scorecard plugs
   * into — NOT a built-in product scorer (that lives in the adopter's repo).
   */
  score?: (ctx: TerminalProductScoringContext) => RunAdapterScore | Promise<RunAdapterScore>;
  /**
   * Companion seam: derive product-feedback candidates from the same assembled evidence. The lane
   * appends the returned candidates to `bundle.feedbackCandidates`. The adapter records its
   * product-specific concepts (public CLI command observed, hosted success-or-blocker, feedback id,
   * media/job ids, no-spend proof, defection/friction risk) under each candidate's ADAPTER-NAMESPACED
   * `adapter` block — never as core enums (issue #154's "record product-specific concepts as
   * NON-core nouns" list). The candidates must still satisfy core's feedback-candidate shape (which
   * the bundle verifier enforces), so a malformed adapter candidate fails closed.
   */
  deriveFeedback?: (
    ctx: TerminalProductScoringContext,
  ) => RunFeedbackCandidate[] | Promise<RunFeedbackCandidate[]>;
}

export interface RunTerminalProductLabOptions {
  automaticAnalysis?: AutomaticAnalysisHooks;
  /** Which manifest produced this run (#455); threaded into the status record + bundle. */
  lab?: RunLabProvenance;
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  hooks?: TerminalProductLabHooks;
  /**
   * Present ONLY when the scorer hooks were CONFIG-DECLARED and loaded by the CLI (#316). Its presence
   * is the "declared" marker: a config-declared terminal scorer returning status:"fail" FLIPS
   * bundle.review.verdict (like the browser routes), and one that throws becomes a visible review.gaps
   * entry. A LIBRARY caller passing `hooks` directly leaves this ABSENT and keeps today's purely
   * additive terminal behavior (verdict unchanged). Core-computed, never adopter-supplied.
   */
  scorerProvenance?: RunScorerProvenance;
}

export interface TerminalProductLabResult extends AutomaticAnalysisResult {
  schema: typeof TERMINAL_PRODUCT_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or the live session reached a terminal verdict
   *  without a harness error + cleanup was proven). The agent's pass/fail is evidence, not the
   *  lab's exit code. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the session. */
  actor: string;
  /** The studied product name (public-safe). */
  product: string;
  dryRun: boolean;
  runId: string;
  /** Live-only: the in-sandbox agent session verdict (omitted on dry-run / pre-session failure). */
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
  };
  /** Live-only: the sandbox lifecycle proof (the key/auth value is NEVER surfaced here). */
  sandbox?: {
    sandboxId: string;
    killed: boolean;
    /** BY-ID proof (never a re-list): 0 = confirmed reclaimed, 1 = still present (unconfirmed),
     *  -1 = kill(id) itself failed or was unavailable. See TerminalLedgers["cleanup"]. */
    remaining: number;
  };
  /** Live-only: the spend ledger surfaced on the result — unknowns are null, never guessed.
   *  Lets a programmatic caller read spend without parsing the bundle. */
  cost?: {
    knownTotalUsd: number;
    fullyMeasured: boolean;
    /** Per-category USD: a known number, or null = NOT MEASURED (never coerced to 0). */
    lines: Record<"product" | "media" | "payment" | "provider", number | null>;
  };
  /** Live-only: the no-spend proof DERIVED from the ledger. */
  noSpend?: {
    satisfied: boolean;
    maxUsd: number | null;
    knownZeroLines: string[];
    unmeasuredLines: string[];
  };
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "HUMANISH_LAB_ANALYSIS_INVALID"
      | "HUMANISH_LAB_TASKS_UNSUPPORTED"
      | "HUMANISH_LAB_OPTION_CONFLICT"
      | "HUMANISH_LAB_OPTION_UNSUPPORTED"
      | "HUMANISH_TERMINAL_LAB_FAILED"
      | "HUMANISH_TERMINAL_LAB_ACTOR_UNSUPPORTED"
      | "HUMANISH_TERMINAL_LAB_SUBJECT_INVALID"
      | "HUMANISH_TERMINAL_LAB_KEYPLACEMENT_INVALID"
      | "HUMANISH_TERMINAL_LAB_RUNTIME_AUTH_MISSING"
      | "HUMANISH_TERMINAL_LAB_CAPS_MISSING"
      | "HUMANISH_TERMINAL_LAB_UNPRICED_CAP"
      | "HUMANISH_TERMINAL_LAB_CAPS_EXCEEDED"
      | "HUMANISH_TERMINAL_LAB_CREDENTIAL_DENIED"
      | "HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN"
      | "HUMANISH_RUN_ID_IN_USE"
      | typeof TERMINAL_AGENT_NOT_IMPLEMENTED_CODE;
    message: string;
  };
}

// ===========================================================================
// LIVE PATH
// ===========================================================================

/** Substrate lifecycle ledger entry (create/readiness/exec/cleanup events with timestamps). */
export interface LifecycleRecord {
  at: string;
  event: string;
  /** Redacted+scrubbed before persisting (it never carries a secret, but the harness never trusts that). */
  message: string;
}

/** Command-log ledger entry: which command ran, with what exit/duration (NEVER its env values). */
export interface CommandLogRecord {
  at: string;
  /** A public-safe label for the command (e.g. "codex-exec"); the full argv is bound by digest only. */
  label: string;
  /** sha256-12 of the exact command string — pins "same recipe" without persisting it. */
  commandDigest: string;
  /** The env var NAMES injected command-scoped (values NEVER persisted) — the credential evidence. */
  envNames: string[];
  exitCode?: number;
  timedOut?: boolean;
  durationMs: number;
}

/** One redacted terminal output event (the append-only NDJSON stream). */
export interface TerminalEventRecord {
  at: string;
  stream: "stdout" | "stderr";
  /** ALREADY scrubbed (literal known values) THEN redacted (shape patterns) at the source. */
  chunk: string;
}

/**
 * One operator intervention (assisted-input event). The current route ships NO assisted-input
 * path, so this ledger is ALWAYS empty — but always PRESENT (the safety contract: empty-present is
 * the contract, an absent ledger fails verify). A future assisted path can fill this shape.
 */
export interface InterventionRecord {
  at: string;
  kind: "stdin";
  /** Redacted+scrubbed digest of the injected input (never the raw bytes). */
  inputDigest: string;
}

/**
 * One cost line of the spend ledger. THE NULL DISCIPLINE (issue #154, the cost/no-spend asks):
 * three distinct states are crisply modeled and NEVER conflated —
 *   - `usd: 0`     => KNOWN to be zero. A measured-and-zero spend (we metered this category and it
 *                     billed nothing). The no-spend proof may legitimately assert this is zero.
 *   - `usd: null`  => NOT MEASURED. This run carries no spend signal for the category. `null` is
 *                     written explicitly (never undefined-omitted, never guessed to 0). The no-spend
 *                     proof must list this line as UNMEASURED and must NOT claim it is zero.
 *   - line ABSENT  => NOT APPLICABLE to this lane/run (n/a). The line simply does not appear in
 *                     `lines`. (The current route emits all four lines, so absence is reserved for
 *                     future lanes that genuinely have no such category.)
 * `null` vs missing-key is the load-bearing distinction: a missing key means "this category does not
 * exist for this run"; a present key with `null` means "this category exists but we did not measure
 * it". A no-spend proof that claimed zero on a `null` line would claim more than it measured.
 */
export interface CostLine {
  /** known zero (0) | not measured (null). The key is ALWAYS present when the line is applicable. */
  usd: number | null;
  /** Optional billable-unit count, same discipline: a known count, or null = not measured. */
  count?: number | null;
  /** How this line's value was established (provenance for the verifier + the human reviewer). */
  source:
    | "provider-token-usage"
    | "no-spend-signal"
    | "operator-cap"
    | "unmeasured"
    /** Tokens were COUNTED but no rate could price them, so `usd` stays null while the note
     *  carries the measured token totals (#531). Distinct from "unmeasured", which means no
     *  signal at all. */
    | "unpriced-token-usage";
  /** A short, public-safe note (never a secret value). */
  note: string;
}

/**
 * The spend ledger (a block of `TerminalLedgers`). The no-spend PROOF is DERIVED from this — never
 * asserted independently. Every applicable category appears as a line; unknowns are `null`.
 */
export interface TerminalCostLedger {
  schema: "humanish.terminal-cost-ledger.v1";
  /** USD currency unit (recorded explicitly so a future multi-currency lane is unambiguous). */
  currency: "usd";
  lines: Record<CostCategory, CostLine>;
  /** Sum of the KNOWN (non-null) lines. null lines contribute NOTHING and are NOT guessed as 0. */
  knownTotalUsd: number;
  /** True when every applicable line is measured (no null). When false, knownTotalUsd is a LOWER
   *  bound, not the full spend — the no-spend proof says so honestly. */
  fullyMeasured: boolean;
}

/**
 * The no-spend proof, DERIVED from the cost ledger (issue #154: "derived from a ledger, not
 * asserted"). It is honest about what it knows: it lists the KNOWN-zero lines it can vouch for and,
 * separately, the UNMEASURED (null) lines it CANNOT vouch for. `satisfied` is true only when every
 * KNOWN line is zero (a known non-zero line fails it); but a proof with unmeasured lines explicitly
 * says it could not measure them — it never claims zero on a line the ledger marks null.
 */
export interface NoSpendProof {
  schema: "humanish.terminal-no-spend-proof.v1";
  /** The maxUsd cap this proof was evaluated against (the no-spend scenario declares maxUsd: 0). */
  maxUsd: number | null;
  /** True iff every KNOWN (measured) line is <= maxUsd (for a no-spend run, == 0). */
  satisfied: boolean;
  /** Categories the ledger MEASURED and found at (known) zero — the proof CAN vouch for these. */
  knownZeroLines: CostCategory[];
  /** Categories the ledger measured with a known NON-zero spend (these break `satisfied`). */
  knownNonZeroLines: CostCategory[];
  /** Categories the ledger marks `null` (NOT MEASURED). The proof explicitly lists these and does
   *  NOT claim they are zero — it claims only that this run could not measure them. */
  unmeasuredLines: CostCategory[];
  /** Sum of the known lines (== 0 for a satisfied no-spend run). */
  knownTotalUsd: number;
  /** Human-readable honesty statement covering both what is proven and what is unmeasured. */
  statement: string;
}

/** The persisted terminal-product ledgers artifact (substrate lifecycle + command log + interventions + cleanup + cost). */
export interface TerminalLedgers {
  schema: "humanish.terminal-ledgers.v1";
  runtime?: ActorRuntimeProvenance;
  lifecycle: LifecycleRecord[];
  commandLog: CommandLogRecord[];
  /** ALWAYS present; ALWAYS empty while no assisted-input path ships — the safety contract. */
  interventions: InterventionRecord[];
  cleanup: {
    /** True when exact-id kill resolved, including the startup guard's acquired-instance kill
     *  (found-and-killed or already gone both prove absence; see `remaining`/`reason`). */
    killed: boolean;
    /** BY-ID proof, NEVER derived from Sandbox.list: 0 = confirmed reclaimed (kill(id) RESOLVED
     *  -- returned true "found and killed" OR false "404, exact id already gone" -- and, when the
     *  SDK exposes it, getInfo(id) did not report a live sandbox); 1 = getInfo(id) still reports
     *  this exact sandbox running/paused (NOT reclaimed); -1 = kill(id) itself failed, threw, or
     *  was unavailable (the server-side kill-on-timeout is the backstop). */
    remaining: number;
    /** Honest, human-readable statement of which by-id signal produced `remaining`. */
    reason: string;
  };
  /** The spend ledger. Unknowns are `null`, never guessed; the no-spend proof
   *  below is DERIVED from it. */
  cost: TerminalCostLedger;
  /** The no-spend proof DERIVED from `cost`. Never an independent assertion. */
  noSpendProof: NoSpendProof;
}

export interface RunLiveTerminalSessionArgs {
  options: RunTerminalProductLabOptions;
  cwd: string;
  config: LabConfig;
  descriptorId: string;
  product: NonNullable<LabConfig["subject"]["product"]>;
  /** The live caps planTerminalLab required. */
  caps: LabScenarioCaps & { maxUsd: number; maxMinutes: number };
  warnings: string[];
  failed: (
    code: NonNullable<TerminalProductLabResult["error"]>["code"],
    message: string,
    extras?: { actor?: string; product?: string },
  ) => TerminalProductLabResult;
  /** The lab's run scope; the live session starts its run in it. */
  scope: RunScope;
}
