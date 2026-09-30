import type { HeardSpeech } from "../speech.js";
import type {
  ActorCapabilities,
  ActorExecutionProfile,
  ActorCompletionReason,
  ActorPersonaRef,
  ActorStatus,
  ActorTokenUsage,
  ActorTrace,
  ActorTraceItem,
  ParticipantClosingReport,
  ParticipantDeclaredOutcome,
  ProviderRequestReceipt,
} from "../../contract.js";
import type { RedactionHooks } from "../../../evidence/redaction.js";
import type { DwellWindow, StopWhen } from "../../stop-conditions.js";
import type { LabTask } from "../../../lab/tasks.js";
import type { ReasoningEffort } from "../../reasoning-effort.js";

// The ports of the computer-use loop: the model behind CuaProvider, the desktop behind
// CuaExecutor, and the options and result of runComputerUseLoop. src/actors/computer-use/loop.ts
// re-exports every name here; import them from there.

/**
 * One desktop action. `heldKeys` on a pointer action are held down for the whole action and
 * released after it, named as the provider sent them (for example `SHIFT` for a shift-click). An
 * executor that cannot hold them refuses the action before dispatch; it never runs the action
 * without them.
 */
export type CuaAction =
  | {
      kind: "click";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      heldKeys?: string[];
    }
  | { kind: "double_click"; x: number; y: number; heldKeys?: string[] }
  | { kind: "move"; x: number; y: number; heldKeys?: string[] }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number; heldKeys?: string[] }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: string[] }
  | { kind: "drag"; path: Array<{ x: number; y: number }>; heldKeys?: string[] }
  | { kind: "wait"; ms?: number }
  | { kind: "speak"; text: string }
  | { kind: "screenshot" };

/** A captured desktop state: the (optional) frame plus a coarse signature for progress. */
export interface CuaObservation {
  /**
   * Raw PNG bytes of the current desktop. Redacted by the engine before persisting.
   * OPTIONAL: a non-vision (state-driven) executor omits it, and the loop persists no
   * screenshot that turn (counts.screenshots stays 0 → redaction.screenshots resolves to
   * "n/a", no Buffer.alloc(0) ever reaches disk). A VISION provider REQUIRES it — see
   * CuaProvider.requiresFrame, which trips a per-turn fail-closed harness_error when a frame
   * is required but absent.
   */
  screenshot?: Buffer;
  /**
   * A coarse, quantized signature of the visible UI used for no-progress
   * detection. Two observations with the same signature are "no progress". The
   * executor owns how it is computed (url, title, quantized scroll, focused
   * element, visible controls, etc.). STILL REQUIRED — the canonical fallback progress key
   * when appState is absent.
   */
  stateSignature: string;
  /**
   * Structured app state (e.g. a window.app.getState() projection). When present, friction
   * detection prefers a stable, deterministic, sorted-key JSON projection of it
   * (stableProgressKey) as the progress key, so route/turn/modal deltas drive progress more
   * reliably than a quantized screenshot signature can on a pixel-dense UI.
   *
   * RUNTIME-ONLY in this slice: appState is NEVER copied into any ActorTraceItem, reason, id,
   * or count, and is NEVER persisted to the trace — only the in-memory progress key is derived
   * from it and discarded. A structured app blob has no detectable secret "shape" (the
   * published-evidence scan catches only secret-shaped patterns), so it is treated exactly like
   * stateSignature, which is itself never written as text. A future "appState in evidence"
   * slice must route a stringified projection through redaction.redactText (and the lab's
   * scrubText) AND cap/whitelist fields before persisting — pattern+literal redaction alone
   * cannot sanitize an arbitrary blob.
   */
  appState?: Record<string, unknown>;
  /**
   * Optional browser state captured by an executor that can inspect the driven browser
   * deterministically (for example via Chrome DevTools Protocol). These fields are runtime-only:
   * they may drive stopWhen and progress decisions, but the loop never persists raw URL/title/text
   * into the trace. Persisting arbitrary DOM text would make private-data leakage too easy.
   */
  url?: string;
  /**
   * The page's vertical scroll offset (window.scrollY), when the executor can read it. Scroll
   * position IS state (#393): inside a scroll-pinned (scrollytelling) section the viewport stays
   * visually fixed while the participant advances, so the frame hash reads "no change" and the
   * no-progress backstop ended working reading sessions as gave_up. Runtime-only, like url/text —
   * it feeds the progress key (bucketed) and is never persisted.
   */
  scrollY?: number;
  title?: string;
  text?: string;
  /** Finalized speech captured from the participant's speaker sink. */
  heardSpeech?: HeardSpeech[];
}

/**
 * A safety check the model raised. The triple is preserved verbatim from the
 * wire: providers match acknowledgements on `id`, so fabricating or collapsing
 * these fields would break the proceed path.
 */
export interface CuaSafetyCheck {
  /** Wire id the provider matches acknowledgements on. */
  id: string;
  /** Provider-defined category code (e.g. "malicious_instructions"). */
  code: string;
  /** Human-readable explanation from the model. */
  message: string;
}

export interface CuaTurnRequest {
  /** Host input acknowledgments for the preceding proposal, never proof of app success. */
  previousExecution?: {
    actions: Array<{
      index: number;
      status: "completed" | "skipped" | "not_dispatched" | "outcome_uncertain";
    }>;
  };
  /** Persona + task instruction, sent as the system-level steer (first turn). */
  instructions: string;
  /** The latest observation for the model to react to. */
  observation: CuaObservation;
  /** Opaque continuation handle from the previous turn (provider-specific). */
  previousResponseId?: string;
  /** Safety checks the harness chose to acknowledge, passed back to the model. */
  acknowledgedSafetyChecks?: CuaSafetyCheck[];
  /** A nudge injected by the backstop before it trips, summarizing the stall. */
  contextHint?: string;
}

export interface CuaTurn {
  /** This action proposal yielded from a provider request that remains active. No receipt or usage is settled yet. */
  providerRequestPending?: true;
  providerRequest?: ProviderRequestReceipt;
  /** Continuation handle for the next turn. */
  responseId?: string;
  /** Model chain-of-thought summary, if the provider surfaces it. */
  reasoning?: string;
  /** Natural-language message (often the final summary on completion). */
  message?: string;
  /** Actions to perform this turn. Empty means the model is done. */
  actions: CuaAction[];
  /** Safety checks the provider flagged this turn. Non-empty pauses the run. */
  pendingSafetyChecks: CuaSafetyCheck[];
  /** Token accounting for this turn, if available. */
  usage?: {
    input?: number;
    output?: number;
    cachedInput?: number;
    cacheWriteInput?: number;
    /** Per model inference inside this provider interaction. */
    turns?: Array<{
      input?: number;
      output?: number;
      cachedInput?: number;
      cacheWriteInput?: number;
    }>;
  };
  /** True when the model reported a natural endpoint (no further action). */
  done: boolean;
  /** Explicit provider interruption, independent of actions or participant intent. */
  interruption?: "output_limit" | "token_limit" | "incomplete" | "unexpected_status";
  /** The participant's own word for how it ended, when its reply format carries one (#570). */
  outcome?: ParticipantDeclaredOutcome;
  /** Present only for an accepted structured closing account. */
  closingReport?: ParticipantClosingReport;
}

/** The model side of the loop. Self-describes its identity and capabilities. */
export interface CuaProvider {
  /** Single dispatch; the promise includes owned request cleanup. No stall retry. */
  readonly requestPolicy?: "fail_closed";
  readonly executionProfile?: ActorExecutionProfile | undefined;
  readonly historyTurnsOmitted?: number;
  readonly id: string;
  readonly version?: string | undefined;
  /**
   * The request settings this provider will actually send, for the trace to record. `version` says
   * WHICH model; this says how it was asked to run. Optional: a provider with no such settings
   * records none, and absence stays absence rather than becoming a default nobody chose.
   */
  readonly modelSettings?: {
    readonly reasoningEffort: ReasoningEffort;
    readonly maxOutputTokens?: number;
  };
  readonly capabilities: ActorCapabilities;
  /**
   * True when nextTurn requires `observation.screenshot` to be present (a VISION model that
   * reasons over pixels). The OpenAI computer-use provider sets this; a state-reasoning
   * provider omits it (defaults falsey).
   *
   * PROVIDER-AUTHORING CONTRACT: a vision provider MUST set `requiresFrame: true`. The loop
   * uses it to convert what would otherwise be a silent blank-frame crash into a structured
   * per-turn fail-closed `harness_error` when a screenshot-less executor is paired with a
   * vision provider. Default-false is a known third-party-author footgun this slice accepts
   * (only one vision provider exists today) but records — see
   * docs/architecture/state-driven-executor.md.
   */
  readonly requiresFrame?: boolean;
  /** Latched uncertainty from hidden interactive attempts (for example, a transport retry).
   *  A later success or pre-dispatch refusal cannot make earlier unreported usage complete. */
  readonly interactionUsageIncomplete?: boolean;
  /** Latest known usage for the active, unsettled request. Used only for runtime spend guards. */
  readonly pendingRequestUsage?: CuaTurn["usage"];
  nextTurn(req: CuaTurnRequest, signal: AbortSignal): Promise<CuaTurn>;
  /** Optional read-only closing report. Implementations must disable tools and make no retries. */
  debrief?: ((req: CuaTurnRequest, signal: AbortSignal) => Promise<CuaTurn>) | undefined;
  /** Release lane-owned model resources. Idempotent; reject if cleanup is unconfirmed. */
  close?(): Promise<void>;
}

/** The desktop side of the loop. */
export interface CuaExecutor {
  /**
   * A transport that cannot safely retry or skip an unacknowledged request opts out of
   * legacy observation/idle stall recovery. Wrappers must preserve this value.
   */
  readonly stallRecovery?: "fail_closed";
  /** True only when this executor can play a `speak` action into the participant microphone. */
  readonly speechEnabled?: boolean;
  /** Capture the current desktop frame and its state signature. */
  observe(): Promise<CuaObservation>;
  /**
   * Perform one action. The optional signal ends with this action's loop wait; honor it
   * before dispatching after async preparation. Wrappers must forward it. Cancellation
   * does not imply an already-dispatched desktop operation can be stopped.
   */
  execute(action: CuaAction, signal?: AbortSignal): Promise<void>;
}

export interface CuaLoopOptions {
  instructions: string;
  provider: CuaProvider;
  executor: CuaExecutor;
  persona: ActorPersonaRef;
  redaction: RedactionHooks;
  /** Hard wall-clock runaway guard. The only count-free hard stop. */
  timeoutMs: number;
  /**
   * Per-turn bound on the provider call (#469). Without it a single hung HTTP request was
   * indistinguishable from "the participant is still thinking" and cost the lane its whole
   * remaining budget: three lanes of one run stalled within seven seconds of each other and were
   * closed 36 minutes later as budget_reached with nothing in the trace to say why. A stalled
   * turn is retried once with a notice; a second stall ends the lane as harness_error, named.
   */
  turnTimeoutMs?: number;
  /**
   * Per-call bound on observation work (#480): executor.observe(), and the idle actions
   * (`wait`, `screenshot`, `move`) whose only job is to look. A default `wait` hung for ~90 s
   * inside the desktop SDK and ended a lane as actor_error after twelve turns of ordinary work.
   * A stalled observe is retried once; a stalled idle action is skipped with a notice.
   */
  observationTimeoutMs?: number;
  /** Injected clock (ms). Lets tests drive deadlines deterministically. */
  now: () => number;
  /** Cancellation. The loop checks it each turn and after each action batch. */
  signal?: AbortSignal;
  /** Idle streak (no material action) that trips the backstop. Default 6. */
  idleSteps?: number;
  /** Non-idle no-progress streak that trips the backstop. Default 8. */
  noProgressSteps?: number;
  /**
   * If the model flags safety checks, decide which to acknowledge. Returning the
   * list proceeds (the acks are echoed back on the next turn's request); returning
   * null/[] pauses the run (blocked_approval). Default: pause on any safety check
   * (fail-closed; real approval policy wires in later).
   */
  acknowledgeSafetyChecks?: (checks: CuaSafetyCheck[]) => CuaSafetyCheck[] | null;
  /**
   * Redact (blur+downscale) persisted screenshots. Default FALSE — full-fidelity frames are
   * retained, because the common case is a developer watching a sim of their OWN app locally
   * (gitignored .humanish), where blur destroys the core deliverable. Set true for unowned
   * subjects or when the bundle is meant to be shared as-is. The frame sent to the PROVIDER is
   * always full-resolution regardless (the model must see the screen to act); this flag only
   * governs what is PERSISTED. Publish-safety belongs at the publish boundary (commit scan / redactScreenshots), not capture.
   */
  redactScreenshots?: boolean;
  /**
   * Extra literal scrub for KNOWN provisioned values (which have no detectable "shape", so
   * pattern redaction cannot catch them), composed BEFORE redactText on every model-authored
   * text item (reasoning, message, completion summary) and the loop error. The lab passes the
   * env-value scrubber here so a value the MODEL narrates can never land raw in the trace.
   * Default: identity (the loop is shape-only on its own).
   */
  scrubText?: (text: string) => string;
  /** Persist a screenshot (raw or redacted per redactScreenshots), returning the trace ref path. */
  writeScreenshot?: (name: string, bytes: Buffer) => Promise<string>;
  /**
   * Deterministic harness-owned success guards. Evaluated after the initial observation and after
   * every post-action observation, before another model turn is requested. This keeps a lane from
   * wandering after the product already reached an app-visible endpoint.
   */
  stopWhen?: StopWhen;
  /**
   * A declared observation window (#510): once its condition matches (or after the first
   * observation when it has none) the loop holds the page for the window, captures a frame on the
   * cadence, takes no action and requests no model turn, then hands control back or ends. Runs at
   * most once per session and never past the session budget.
   */
  dwell?: DwellWindow;
  /** Injected pause for the dwell window's cadence; tests advance their clock through it. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The lab's declared protocol (#414): discrete tasks whose completion is corroborated by the
   * same observations stopWhen reads, on the same cadence. The tracker never influences the loop's
   * control flow — a completed task list does not stop a session (that is stopWhen's job); it only
   * records the funnel that lands on the trace. The participant-facing halves of these tasks are
   * already IN `instructions` (composed upstream); the loop reads only the `success` criteria,
   * which never reach the prompt.
   */
  tasks?: readonly LabTask[];
  /**
   * FAIL-CLOSED spend cap (USD). When set, the loop aborts (completionReason "budget_reached")
   * the moment the running ESTIMATED spend crosses it, BEFORE the next provider turn — the
   * runaway-retry-loop guard. Absent = uncapped (the historical CUA behavior). maxUsd: 0 can
   * still permit a model request before its reported positive spend trips the check. Enforcement needs a measurable estimate, so
   * the lab refuses a cap on an unpriced model at PREFLIGHT rather than running uncapped.
   */
  maxUsd?: number;
  /**
   * Injected PURE per-turn cost estimator (keeps the loop free of the operator rate table and
   * makes the cap deterministic in tests). Given running (input, output) token totals, returns the
   * estimated USD, or null when unpriceable. Only consulted when `maxUsd` is set. A null estimate
   * mid-run cannot trip the cap — preflight already guaranteed a rate exists, so a null here is a
   * vanished-rate harness condition, not a silent uncapped pass.
   */
  estimateTurnCostUsd?: (usage: ActorTokenUsage) => number | null;
  /**
   * RUN-LEVEL spend guard (#299): called with this lane's running usage each turn, at the same
   * point the per-lane cap is checked. Returns a human-readable reason when the STUDY's shared
   * budget is exhausted, else null. On a non-null return the loop stops with `budget_reached`
   * regardless of material progress — a study-level stop is a recruiting decision hitting its
   * limit, not this participant's runaway, so it never reads as `gave_up`.
   */
  overRunBudget?: (usage: ActorTokenUsage) => string | null;
  /** Fail closed on unavailable request usage when a spend cap is declared. A library option: no
   * built-in route enables it, and absent preserves their existing behavior. */
  requireReportedUsageForSpendCap?: boolean;
  /**
   * RUNTIME-ONLY observed-URL callback (#164 handoff crux): invoked with `observation.url` right
   * after EVERY executor.observe() (the initial observe and each post-action observe), so the
   * orchestrator can watch a seat's live `location.href` mid-run WITHOUT the loop ever persisting it.
   * The URL is the same runtime-only field documented on CuaObservation.url (never written to the
   * trace); this callback keeps that hygiene — it only hands the value back in memory. Used by the
   * concurrent shared-world barrier to latch a host seat's `/lobby/CODE` URL. Default: no-op.
   */
  onObservedUrl?: (url: string | undefined) => void;
  /**
   * RUNTIME-ONLY per-turn actor-narration callback: invoked with the model's own reasoning+message
   * text each turn. The concurrent shared-world host-first barrier scans it for the lobby code the
   * host states after creating the lobby — a CDP-INDEPENDENT path to the same code, because the
   * E2B-desktop Chrome CDP url-read the onObservedUrl path relies on is unreliable in practice. Like
   * onObservedUrl this is in-memory only; the barrier extracts a code and persists only a digest.
   * Default: no-op.
   */
  onMessage?: (text: string) => void;
  /**
   * RUNTIME-ONLY per-turn raw-frame callback: invoked with the same full-fidelity screenshot Buffer
   * the vision provider already sends to OpenAI that turn (never the redacted/persisted copy). The
   * concurrent shared-world host-first barrier vision-reads the lobby code straight off the host's
   * waiting-room frame — the robust CDP-INDEPENDENT relay, since the code is rendered on screen even
   * when the CDP url-read fails and even when the host never narrates it. The frame Buffer is in-memory
   * only here (this hook never persists it; the loop's own screenshot persistence is separate and
   * governed by redactScreenshots). Fire-and-forget (never awaited by the loop). Default: no-op.
   */
  onScreenshot?: (frame: Buffer) => void;
  /**
   * Per-turn trace snapshot callback (#441): invoked with the redacted trace items recorded so
   * far — once after the initial observation and once at the end of every turn (after that
   * turn's screenshot lands, so a flush never shows an action without the frame that preceded
   * it). The array is a fresh copy each call; items are already redaction-clean (they are the
   * same objects the final trace persists). Fire-and-forget: the loop never awaits the
   * receiver, so a slow disk flush can never stall a turn. Default: no-op.
   */
  /** Per-turn trace snapshot, with the RUNNING usage so a watcher can price a run in flight. */
  onTrace?: (
    items: readonly ActorTraceItem[],
    usage: ActorTokenUsage,
    metadata?: CuaLiveMetadata,
  ) => void;
}

export type CuaLiveMetadata = Pick<
  ActorTrace,
  "executionProfile" | "providerRequests" | "historyTurnsOmitted"
>;

export interface CuaLoopResult {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  trace: ActorTrace;
}
