import type { ExternalHandoff } from "../external-handoff.js";
import type { HeardSpeech } from "../speech.js";
import type {
  ActorCapabilities,
  ActorConversation,
  ActorExecutionProfile,
  ActorPersonaRef,
  ActorSessionResult,
  ActorTokenUsage,
  ActorTrace,
  ActorTraceItem,
  ParticipantClosingReport,
  ParticipantDeclaredOutcome,
  ParticipantImpression,
  ProviderRequestReceipt,
} from "../../contract.js";
import type { RedactionHooks } from "../../../evidence/redaction.js";
import type { DwellWindow, StopWhen } from "../../stop-conditions.js";
import type { StudyTask } from "../../../study/tasks.js";
import type { ReasoningEffort } from "../../reasoning-effort.js";

/** The participant's clock: its local time zone and its end, on the loop's clock. */
export interface ParticipantClock {
  readonly timeZone?: string;
  /**
   * When the session ends. `kind` is `scheduled_end` when absent: the participant is held to the
   * end and may not end its session before it. A `session_cap` is the latest the session lasts:
   * the participant may end it sooner.
   */
  readonly end?: {
    readonly atMs: number;
    readonly windDownMs: number;
    readonly kind?: "scheduled_end" | "session_cap";
  };
}

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
  | { kind: "screenshot" }
  /** Three left clicks at one point, as a person selects a line or paragraph. */
  | { kind: "triple_click"; x: number; y: number; heldKeys?: string[] }
  /**
   * Press (`mouse_down`) or release (`mouse_up`) one button, left by default: where the pointer
   * is, or at (x, y) after a move there. Give both coordinates or neither. A press with no release
   * leaves the button down for the participant's next actions, as a person holding it would.
   */
  | { kind: "mouse_down"; button?: "left" | "right" | "middle"; x?: number; y?: number }
  | { kind: "mouse_up"; button?: "left" | "right" | "middle"; x?: number; y?: number }
  /**
   * Hold `keys` (one key or a chord, named as for `keypress`) down for `ms`, then release them.
   * At most CUA_WAIT_LIMITS.stepMs, the longest one desktop call carries.
   */
  | { kind: "hold_keys"; keys: string[]; ms: number }
  /** Read where the pointer is. The position comes back as a `pointer` CuaActionResult. */
  | { kind: "read_pointer" }
  /**
   * Look closer at a region of the screen: a capture taken when the action runs, cropped to
   * `region` at the desktop's own pixels. The crop comes back as a `frame` CuaActionResult.
   */
  | { kind: "zoom"; region: CuaRegion };

/** A rectangle of the desktop in whole pixels, from its top-left corner. */
export interface CuaRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What an action read from the desktop, returned by CuaExecutor.execute and passed to the provider
 * in that action's acknowledgement. Every action that returns data answers through this union.
 */
export type CuaActionResult =
  /** `read_pointer`: the pointer position in desktop pixels. */
  | { kind: "pointer"; x: number; y: number }
  /** `zoom`: PNG bytes of the region, captured when the action ran. */
  | { kind: "frame"; screenshot: Buffer };

/** A captured desktop state: the (optional) frame plus a coarse signature for progress. */
export interface CuaObservation {
  /**
   * Raw PNG bytes of the current desktop. Optional: a state-driven executor omits it, and the loop
   * persists no screenshot that turn (counts.screenshots stays 0 and redaction.screenshots reads
   * "n/a"). A provider with requiresFrame needs it; see CuaProvider.requiresFrame.
   */
  screenshot?: Buffer;
  /**
   * A coarse, quantized signature of the visible UI used for no-progress
   * detection. Two observations with the same signature are "no progress". The
   * executor owns how it is computed (url, title, quantized scroll, focused
   * element, visible controls, etc.). Required: it is the progress key when appState is absent.
   */
  stateSignature: string;
  /**
   * Structured app state (e.g. a window.app.getState() projection). When present, friction
   * detection prefers a stable, deterministic, sorted-key JSON projection of it
   * (stableProgressKey) as the progress key, so route/turn/modal deltas drive progress more
   * reliably than a quantized screenshot signature can on a pixel-dense UI.
   *
   * Runtime-only: appState is never copied into a trace item, reason, id or count; only the
   * in-memory progress key is derived from it. A structured blob has no detectable secret shape
   * (the published-evidence scan catches only secret-shaped patterns), so it is handled like
   * stateSignature, which is never written as text either. Persisting it would need a stringified
   * projection through redaction.redactText and the run's scrubText, with its fields capped or
   * allowlisted, since pattern and literal redaction cannot sanitize an arbitrary blob.
   */
  appState?: Record<string, unknown>;
  /**
   * Optional browser state captured by an executor that can inspect the driven browser
   * deterministically (for example via Chrome DevTools Protocol). These fields drive stopWhen and
   * progress decisions. The loop never persists the raw URL, title or text: persisting arbitrary
   * DOM text would make private-data leakage too easy. From the URL it records only the page's
   * origin and redacted path (`page` on screenshot items, `finalPage`; src/evidence/trace-page.ts).
   */
  url?: string;
  /**
   * The page's vertical scroll offset (window.scrollY), when the executor can read it. Scroll
   * position is state: inside a scroll-pinned section the viewport stays visually fixed
   * while the participant advances, so the frame hash alone reads "no change". Runtime-only like
   * url and text: it feeds the progress key, bucketed, and is never persisted.
   */
  scrollY?: number;
  title?: string;
  text?: string;
  /** Finalized speech captured from the participant's speaker sink. */
  heardSpeech?: HeardSpeech[];
  /**
   * Links the browser handed to another app since the previous observation, oldest first. The
   * desktop opens no app for them; the loop records each and tells the participant on its next turn.
   */
  externalHandoffs?: readonly ExternalHandoff[];
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

/**
 * What the desktop did with one action of the provider's last batch. `completed`: the desktop
 * acknowledged the input. `skipped`: its desktop command failed, or an observation action
 * stalled. `not_dispatched`: no input was sent, because the action was rejected before dispatch,
 * came after a rejected action or a halting skipped one, or the session ended first.
 * `outcome_uncertain`: the loop stopped waiting before the desktop answered. An acknowledgement
 * is never proof the app did what the participant meant.
 */
export interface CuaActionAcknowledgement {
  /** The action's position in its batch, from 0. */
  index: number;
  status: "completed" | "skipped" | "not_dispatched" | "outcome_uncertain";
  /**
   * What a completed `read_pointer` or `zoom` read from the desktop. Absent for every other action,
   * and for a read whose executor returned no result of its kind.
   */
  result?: CuaActionResult;
}

export interface CuaTurnRequest {
  /**
   * One acknowledgement per position of the provider's last batch, on every request after a turn
   * that acted. A provider whose model expects an answer to each action it called answers each
   * from these, and keeps state such as the pointer position only for completed actions.
   */
  previousExecution?: { actions: CuaActionAcknowledgement[] };
  /** Persona + task instruction, sent as the system-level steer (first turn). */
  instructions: string;
  /** The latest observation for the model to react to. */
  observation: CuaObservation;
  /** Opaque continuation handle from the previous turn (provider-specific). */
  previousResponseId?: string;
  /** Safety checks the harness chose to acknowledge, passed back to the model. */
  acknowledgedSafetyChecks?: CuaSafetyCheck[];
  /**
   * Harness guidance for this request: a backstop nudge, a dwell-window note, a rejected-action
   * note, or the closing-report instruction.
   */
  contextHint?: string;
}

/**
 * Passed to nextTurn when a spend cap is declared. A provider that sends a request again after a
 * dispatched attempt failed without a reply (its transport threw) calls beforeResend first. The
 * loop books that attempt at its worst case and throws when the charge does not fit under the
 * cap; the provider lets the error propagate and sends nothing more.
 */
export interface CuaSpendGate {
  beforeResend(): void;
}

export interface CuaTurn {
  /**
   * Set on a turn from a continuing request: a single-dispatch request that returned actions and
   * is still open. No receipt or usage is settled yet; the loop books both when it settles.
   */
  providerRequestPending?: true;
  providerRequest?: ProviderRequestReceipt;
  /** Continuation handle for the next turn. */
  responseId?: string;
  /** Model chain-of-thought summary, if the provider surfaces it. */
  reasoning?: string;
  /** Natural-language message (often the final summary on completion). */
  message?: string;
  /** Actions to perform this turn. Empty, with no `rejectedProposal`, means the model is done. */
  actions: CuaAction[];
  /**
   * A proposal of this reply that the provider could not turn into an action: an action name it
   * has no action for, or a proposal missing what its action needs, such as a click with no
   * coordinates while the pointer position is not known. It takes batch position `actions.length`:
   * the provider maps the reply's proposals in order and stops there. The loop runs `actions`,
   * acknowledges this position `not_dispatched`, gives the participant `reason` on its next
   * request and goes on, so a reply with a rejected proposal never ends the session. The provider
   * answers any later proposal of the reply as not dispatched itself.
   */
  rejectedProposal?: {
    /** One sentence the participant can act on. The trace records it redacted. */
    reason: string;
  };
  /** Safety checks the provider flagged this turn. Non-empty pauses the run. */
  pendingSafetyChecks: CuaSafetyCheck[];
  /** Token accounting for this turn, if available. */
  usage?: {
    input?: number;
    output?: number;
    cachedInput?: number;
    cacheWriteInput?: number;
    /** The processing tier that served this request, when the session asked for one. */
    serviceTier?: string;
    /** Per model inference inside this provider interaction. */
    turns?: Array<{
      input?: number;
      output?: number;
      cachedInput?: number;
      cacheWriteInput?: number;
      serviceTier?: string;
    }>;
  };
  /**
   * What the trace should say about this reply that no other field carries, each recorded as a
   * warning notice with its text redacted: for example a reply billed at a tier or in a region the
   * rate table does not price.
   */
  notices?: ReadonlyArray<{ readonly title: string; readonly text: string }>;
  /** True when the model reported a natural endpoint (no further action). */
  done: boolean;
  /**
   * Explicit provider interruption, independent of actions or participant intent. `refused`: the
   * provider declined the request under its usage policy in a reply it billed, so its usage counts.
   */
  interruption?: "output_limit" | "token_limit" | "incomplete" | "unexpected_status" | "refused";
  /** The provider's category for a `refused` reply, when it names one; recorded redacted. */
  refusalCategory?: string;
  /** The participant's own word for how it ended, when its reply format carries one. */
  outcome?: ParticipantDeclaredOutcome;
  /** Present only for an accepted structured closing account. */
  closingReport?: ParticipantClosingReport;
  /** Present only for an accepted impressions-only closing reply. */
  impressions?: ParticipantImpression[];
  /**
   * Set on a closing reply that was not the JSON its request asked for, when the provider's next
   * closing request would ask for it more strictly. The loop may then call the same closing method
   * once more, after the checks the first request passed and with a time bound of its own.
   */
  closingRetry?: true;
}

/** The model side of the loop. Self-describes its identity and capabilities. */
export interface CuaProvider {
  /** Single dispatch; the promise includes owned request cleanup. No stall retry. */
  readonly requestPolicy?: "fail_closed";
  /**
   * What an action the desktop skipped (its command failed, or an observation action stalled) does
   * to the rest of its batch. Absent: the batch goes on with the next action. `halt`, for a model
   * that takes a batch to stop at its first failure: no later action of the batch is sent, and
   * each is acknowledged `not_dispatched`.
   */
  readonly batchFailure?: "halt";
  readonly executionProfile?: ActorExecutionProfile | undefined;
  readonly historyTurnsOmitted?: number;
  /** How the conversation was carried between requests, for the trace. */
  readonly conversation?: ActorConversation;
  readonly id: string;
  readonly version?: string | undefined;
  /**
   * The request settings this provider will actually send, for the trace to record. `version` says
   * which model; this says how it was asked to run. Optional: a provider with no such settings
   * records none, and absence stays absence rather than becoming a default nobody chose.
   */
  readonly modelSettings?: {
    readonly reasoningEffort: ReasoningEffort;
    readonly maxOutputTokens?: number;
    /** The processing tier every request asks for; absent asks for none. */
    readonly serviceTier?: "fast";
  };
  readonly capabilities: ActorCapabilities;
  /**
   * True when nextTurn needs `observation.screenshot` (a model that reasons over pixels). A
   * provider that reasons over pixels must set it: the loop then ends a session whose executor
   * returns no frame as `harness_error`, where the provider would otherwise fail on a blank frame.
   * It defaults to false, so a vision provider that omits it gets no such guard; see
   * docs/architecture/state-driven-executor.md.
   */
  readonly requiresFrame?: boolean;
  /**
   * True when a reply cut off by the output-token limit (`interruption: "output_limit"`) leaves
   * the provider's conversation where it was, so asking again sends the same request. The loop
   * then asks once more instead of ending the session. Absent means the session ends there.
   */
  readonly outputLimitRetry?: boolean;
  /** Latched uncertainty from hidden interactive attempts (for example, a transport retry).
   *  A later success or pre-dispatch refusal cannot make earlier unreported usage complete.
   *  Attempts reported through a CuaSpendGate, and attempts aborted while one was given, are
   *  the loop's to account for and are left out. */
  readonly interactionUsageIncomplete?: boolean;
  /** Latest known usage of the continuing request. Used only for runtime spend guards. */
  readonly pendingRequestUsage?: CuaTurn["usage"];
  nextTurn(req: CuaTurnRequest, signal: AbortSignal, spend?: CuaSpendGate): Promise<CuaTurn>;
  /**
   * Optional read-only closing report. Implementations must disable tools and send one request per
   * call, with no retries of their own; a second request is the loop's call (`closingRetry`).
   */
  debrief?: ((req: CuaTurnRequest, signal: AbortSignal) => Promise<CuaTurn>) | undefined;
  /**
   * Optional read-only request for impressions only, after the participant ended the session
   * itself without them. Its turn carries `impressions`. Same rules as `debrief`.
   */
  requestImpressions?: ((req: CuaTurnRequest, signal: AbortSignal) => Promise<CuaTurn>) | undefined;
  /** Release the participant's model resources. Idempotent; reject if cleanup is unconfirmed. */
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
   * before dispatching after async preparation. Wrappers must forward it and its result.
   * Cancellation does not imply an already-dispatched desktop operation can be stopped. An action
   * that reads the desktop (`read_pointer`, `zoom`) resolves with what it read; every other
   * action resolves with nothing.
   */
  execute(action: CuaAction, signal?: AbortSignal): Promise<CuaActionResult | void>;
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
   * Per-attempt bound on the provider call, so a hung request is told apart from a
   * participant still thinking. A stalled turn is retried once with a notice; a second stall ends
   * the participant as harness_error.
   */
  turnTimeoutMs?: number;
  /**
   * Per-call bound on observation work: executor.observe() and the idle actions (`wait`,
   * `screenshot`), whose only job is to look. A `wait` adds its own ms to the bound. A stalled
   * observe is retried once; a stalled idle action is skipped with a notice.
   */
  observationTimeoutMs?: number;
  /** Injected clock (ms). Lets tests drive deadlines deterministically. */
  now: () => number;
  /**
   * Cancellation. Checked before each turn, each action, each dwell frame and each look of a
   * watched turn, and raced against every provider and desktop call and each pause of a watch.
   */
  signal?: AbortSignal;
  /** Idle streak (no material action) that trips the backstop. Default 24. */
  idleSteps?: number;
  /**
   * No-progress streak that trips the backstop. Default 20. It does not end a participant held to
   * its scheduled end: from this many repeats on, the screen is watched after each further one that
   * follows a turn with no progress.
   */
  noProgressSteps?: number;
  /**
   * The longest one `wait` action lasts, in ms: the study's actor.maxWaitMs. In a turn with another
   * action a longer wait is shortened to it, the trace records a `wait shortened` notice, and the
   * participant is told on its next request; a wait longer than one desktop call carries is sent in
   * steps. A turn that only waits or takes screenshots is watched instead (loop/watch.ts): it first
   * lasts its waits' lengths, the named ones together up to this or, when it is not set, 600000,
   * and each further such turn in a row that ends with no change lasts twice as long, up to that
   * or the turn's own length. A whole number from 1000 to 3600000; any other value throws a
   * RangeError before the session starts. Default 120000, or 30000 when the executor is speechEnabled, for one wait sent to the
   * desktop, and 600000 for a watch.
   */
  maxWaitMs?: number;
  /**
   * How long a `wait` that names no duration lasts, in ms, when its turn only waits or takes
   * screenshots: the study's actor.idleWaitMs. It is also the shortest such a turn is watched for,
   * and how often the loop looks at the screen while it is watched, at most every 30000 ms when the
   * executor is speechEnabled. After an action in the same turn such a wait lasts 500 ms. A whole
   * number from 1000 to 600000 and no longer than an explicit maxWaitMs; any other value throws a
   * RangeError before the session starts. Default 5000. The session never applies more than its
   * maxWaitMs, and the trace records the applied lengths as `waitSettings`.
   */
  idleWaitMs?: number;
  /**
   * If the model flags safety checks, decide which to acknowledge. Returning the
   * list proceeds (the acks are echoed back on the next turn's request); returning
   * null/[] pauses the run (blocked_approval). Default: pause on any safety check.
   */
  acknowledgeSafetyChecks?: (checks: CuaSafetyCheck[]) => CuaSafetyCheck[] | null;
  /**
   * Redact (blur+downscale) persisted screenshots. Default `false`: full-fidelity frames are
   * retained, because the common case is a developer watching a sim of their own app locally
   * (gitignored .humanish), where blur destroys the core deliverable. Set true for unowned
   * subjects or when the bundle is meant to be shared as-is. The frame sent to the provider is
   * always full-resolution regardless (the model must see the screen to act); this flag only
   * governs what is persisted. Publish-safety belongs at the publish boundary (commit scan / redactScreenshots), not capture.
   */
  redactScreenshots?: boolean;
  /**
   * Extra literal scrub for known provisioned values (which have no detectable "shape", so
   * pattern redaction cannot catch them), composed before redactText on every model-authored
   * text item (reasoning, message, completion summary) and the loop error. The route passes the
   * env-value scrubber here so a value the model narrates can never land raw in the trace.
   * Default: identity (the loop is shape-only on its own).
   */
  scrubText?: (text: string) => string;
  /** Persist a screenshot (raw or redacted per redactScreenshots), returning the trace ref path. */
  writeScreenshot?: (name: string, bytes: Buffer) => Promise<string>;
  /**
   * Deterministic harness-owned success guards. Evaluated after the initial observation, after
   * every post-action observation and at each look while a turn is watched, before another model
   * turn is requested. This keeps a participant from wandering after the product already reached an
   * app-visible endpoint.
   */
  stopWhen?: StopWhen;
  /**
   * A declared observation window: once its condition matches (or after the first
   * observation when it has none) the loop holds the page for the window, captures a frame on the
   * cadence, takes no action and requests no model turn, then hands control back or ends. Runs at
   * most once per session and never past the session budget.
   */
  dwell?: DwellWindow;
  /**
   * Injected pause for the dwell window's cadence and the looks of a watched turn; tests advance
   * their clock through it.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * What each turn tells the participant about the time (loop/clock.ts). With `timeZone`, a time zone
   * name, every request carries the local time. With `end`, from `end.atMs - end.windDownMs`
   * every request names the end time (in `timeZone`, else UTC) and the minutes left, and at
   * `end.atMs`, read on `now`, the loop asks for the closing report and ends the session with
   * stop cause `end.kind` (`scheduled_end` when absent).
   */
  clock?: ParticipantClock;
  /**
   * The study's declared protocol: discrete tasks whose completion is corroborated by the
   * same observations stopWhen reads, on the same cadence. The tracker never influences the loop's
   * control flow: a completed task list does not stop a session (that is stopWhen's job); it only
   * records the funnel that lands on the trace. The participant-facing halves of these tasks are
   * already in `instructions` (composed upstream); the loop reads only the `success` criteria,
   * which never reach the prompt.
   */
  tasks?: readonly StudyTask[];
  /**
   * Spend cap in USD. When set, the loop stops with budget_reached as soon as the running
   * estimated spend crosses it, before the next provider turn. Absent means uncapped. maxUsd: 0
   * can still permit one model request before its reported spend trips the check. Enforcement
   * needs an estimate, so humanish refuses a cap on an unpriced model at preflight.
   */
  maxUsd?: number;
  /**
   * Injected pure cost estimator (keeps the loop free of the operator rate table and makes the
   * cap deterministic in tests). Given running (input, output) token totals, returns the
   * estimated USD, or null when unpriceable. Only consulted when `maxUsd` is set. The loop calls it
   * after each reply and again before each provider request, the first included, when every total
   * is 0 and the usage has no `turns`. An estimate of zero usage above `maxUsd` therefore stops the
   * session before its first request. A null estimate mid-run cannot trip the cap; preflight
   * already guaranteed a rate exists, so a null here is a vanished-rate harness condition, not a
   * silent uncapped pass.
   */
  estimateTurnCostUsd?: (usage: ActorTokenUsage) => number | null;
  /**
   * Run-level spend guard: called with this participant's running usage at each point the
   * per-participant cap is checked, after each reply and before each provider request. The first
   * call comes before the first request, with every total at 0 and no `turns`. How many calls a
   * turn makes depends on the loop's checks, so a guard should decide from the usage it is given
   * and the ledger it reads. Returns a human-readable reason when the study's shared budget is
   * exhausted, else null. On a non-null return the loop stops with `budget_reached` regardless of
   * material progress: a study-level stop is a recruiting decision hitting its limit, not this
   * participant's runaway, so it never reads as `gave_up`.
   */
  overRunBudget?: (usage: ActorTokenUsage) => string | null;
  /**
   * Stricter handling of unknown usage under a declared cap. Every capped session already stops
   * before its next request once a request's usage is unknown and unbounded, and resends a lost
   * request only when its worst case fits under the cap. With this option a reply with missing
   * usage is not acted on, and any failed request stops the session. A library option: no
   * built-in route sets it.
   */
  requireReportedUsageForSpendCap?: boolean;
  /**
   * Trace snapshot for a watcher: the redacted items recorded so far, with the running
   * usage so a run can be priced in flight. Called after each checkpoint's screenshot (the initial
   * observation and every acted turn, so a flush never shows an action without the frame before
   * it), after each dwell frame, when a watched turn starts watching, and after a closing request. The array is a fresh copy; its items
   * are the objects the final trace persists. Not awaited, so a slow flush cannot stall a turn.
   * Default: no-op.
   */
  onTrace?: (
    items: readonly ActorTraceItem[],
    usage: ActorTokenUsage,
    metadata?: CuaLiveMetadata,
  ) => void;
}

/**
 * The runtime-only taps the external-public shared-world handoff (src/routes/shared-world/handoff.ts)
 * reads the lobby code through. Internal: 0.109.0 removed them from CuaLoopOptions, and a library
 * caller wraps the executor's `observe` or the provider's `nextTurn` instead.
 */
export interface LoopTaps {
  /**
   * Runtime-only URL tap: called with `observation.url` for each observation a turn may receive
   * (the initial one, each post-action one and the one after a dwell window) and each look while a
   * turn is watched. The loop never persists the raw URL. Default: no-op.
   *
   * Built-in caller: the external-public shared-world handoff (src/routes/shared-world/handoff.ts)
   * latches the host participant's lobby URL and checks that each follower reached the same lobby.
   */
  onObservedUrl?: (url: string | undefined) => void;
  /**
   * Runtime-only narration tap: called with the turn's reasoning and message text, joined by a
   * newline, once per completed turn before the loop acts on it. An interrupted reply, or one cut
   * off by the output limit, is not passed. The trace records its own redacted copy; this raw text
   * stays in memory. Default: no-op.
   *
   * Built-in caller: the external-public handoff scans the host's narration for the lobby code,
   * because the E2B desktop's CDP URL read behind onObservedUrl is unreliable.
   */
  onMessage?: (text: string) => void;
  /**
   * Runtime-only frame tap: called with each raw frame a turn may receive and each dwell-window
   * frame, before any redaction. Of a watched turn's looks, only the one that ended the watch is a
   * frame a turn receives. The buffer stays in memory; screenshot persistence is separate and
   * follows redactScreenshots. Not awaited. Default: no-op.
   *
   * Built-in caller: the external-public handoff reads the lobby code off each participant's own
   * frame until that participant has one: the host's latch, or a follower's convergence observation.
   */
  onScreenshot?: (frame: Buffer) => void;
}

/**
 * The loop's options inside humanish: the public ones, the handoff's taps, the page switch and the
 * checkpoint tap.
 */
export type LoopRunOptions = CuaLoopOptions &
  LoopTaps & {
    /**
     * Whether screenshot items and the trace carry the observed page (`page`, `finalPage`).
     * Default true. The shared-world route passes false: its observed URLs land in the bundle only
     * as digests (docs/architecture/external-public-shared-world.md).
     */
    recordPages?: boolean;
    /**
     * Runtime-only checkpoint tap: called with the turn's number after its checkpoint screenshot
     * item (turn-03) is recorded, and again after its after-dwell item (turn-03-after-dwell),
     * before the turn's stop checks. A held turn and a reply cut off by the output limit take no
     * checkpoint, so they never reach it. Default: no-op.
     *
     * Built-in caller: the hosted E2B desktop pairs the number with the time of the browser-state
     * read that screenshot came after, and its network log numbers requests by those pairs.
     */
    onCheckpoint?: (turnNumber: number) => void;
  };

export type CuaLiveMetadata = Pick<
  ActorTrace,
  "executionProfile" | "providerRequests" | "historyTurnsOmitted"
>;

/** What runComputerUseLoop returns; the public name for an actor session result. */
export type CuaLoopResult = ActorSessionResult;
