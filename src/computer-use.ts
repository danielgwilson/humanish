import {
  ACTOR_TRACE_SCHEMA,
  type ActorCapabilities,
  type ActorCompletionReason,
  type ActorPersonaRef,
  type ActorStatus,
  type ActorTrace,
  type ActorTraceItem
} from "./actor-contract.js";
import type { RedactionHooks } from "./redaction.js";
import {
  evaluateStopWhen,
  type StopConditionMatch,
  type StopWhen
} from "./stop-conditions.js";

// The computer-use (CUA) loop engine.
//
// This is a public-safe re-derivation of the proven loop semantics from a
// private single-actor reference implementation: drive a model over a real
// desktop turn by turn, observe the screen, act, and stop on a NATURAL endpoint
// or an unambiguous friction signal. It is deliberately provider- and
// substrate-agnostic: the model lives behind a CuaProvider port and the desktop
// behind a CuaExecutor port, so the engine is fully testable with fakes (no key,
// no spend, no SDK). The real OpenAI Responses provider and E2B desktop executor
// land behind these ports in a following slice.
//
// Stopping (Daniel 2026-06-06, decision locked in actor-contract.md): abandonment
// is persona-judged PRIMARY (the model decides it reached a natural endpoint and
// returns no further action -> goal_satisfied) with a harness-corroborated
// BACKSTOP that force-ends only on unambiguous pathology. The backstop is
// friction/progress-based, NEVER a turn budget: an idle streak (turns that take
// no material action) or a no-progress streak (turns that do not change the UI
// state). There is intentionally no maxSteps cap: turns are a terrible proxy for
// "stop". The only count-free hard stop is the wall-clock timeoutMs, and it is
// enforced as a deadline race on EVERY model and desktop await (raceSettle), so a
// hung provider or executor call cannot stall the loop forever; the abort signal
// is likewise honored before each action so a cancel cannot actuate the desktop.

export type CuaAction =
  | { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "double_click"; x: number; y: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: string[] }
  | { kind: "drag"; path: Array<{ x: number; y: number }> }
  | { kind: "wait"; ms?: number }
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
  title?: string;
  text?: string;
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
  usage?: { input?: number; output?: number };
  /** True when the model reported a natural endpoint (no further action). */
  done: boolean;
}

/** The model side of the loop. Self-describes its identity and capabilities. */
export interface CuaProvider {
  readonly id: string;
  readonly version?: string;
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
  nextTurn(req: CuaTurnRequest, signal: AbortSignal): Promise<CuaTurn>;
}

/** The desktop side of the loop. */
export interface CuaExecutor {
  /** Capture the current desktop frame and its state signature. */
  observe(): Promise<CuaObservation>;
  /** Perform one action against the desktop. */
  execute(action: CuaAction): Promise<void>;
}

export interface CuaLoopOptions {
  instructions: string;
  provider: CuaProvider;
  executor: CuaExecutor;
  persona: ActorPersonaRef;
  redaction: RedactionHooks;
  /** Hard wall-clock runaway guard. The only count-free hard stop. */
  timeoutMs: number;
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
   * (gitignored .mimetic), where blur destroys the core deliverable. Set true for unowned
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
}

export interface CuaLoopResult {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  trace: ActorTrace;
}

const DEFAULT_IDLE_STEPS = 6;
const DEFAULT_NO_PROGRESS_STEPS = 8;

function isIdleAction(action: CuaAction): boolean {
  return action.kind === "screenshot" || action.kind === "wait";
}

function isIdleTurn(actions: CuaAction[]): boolean {
  return actions.length === 0 || actions.every(isIdleAction);
}

// Caps for stableProgressKey. The progress key is a coarse turn-over-turn comparison input,
// not a faithful serialization, so it bounds depth, breadth, string length, and total output —
// a huge or deeply nested appState can never blow up the comparison or the trace logging in
// tests. The values are deliberately generous (real route/turn/modal projections are tiny) but
// finite.
const STABLE_KEY_MAX_DEPTH = 6;
const STABLE_KEY_MAX_KEYS = 64;
const STABLE_KEY_MAX_ARRAY = 64;
const STABLE_KEY_MAX_STRING = 256;
const STABLE_KEY_MAX_TOTAL = 8192;

/**
 * A deterministic, bounded, sorted-key projection of an appState object, used as the friction
 * loop's progress key. Two structurally-equal states (regardless of key insertion order) map
 * to the SAME string, so key reordering can never fabricate a progress delta; two different
 * states map to different strings (within the caps).
 *
 * Correctness-load-bearing: it MUST NOT throw on a cyclic or huge input. Cycles are detected
 * with a seen-set (a back-edge degrades to the marker "[Circular]"); depth, key count, array
 * length, string length, and total output length are all capped so an adversarial or merely
 * large appState degrades to a bounded value rather than crashing the loop. Pure: it never
 * mutates the input. (See docs/architecture/state-driven-executor.md.)
 */
export function stableProgressKey(appState: Record<string, unknown>): string {
  const seen = new Set<unknown>();
  let truncated = false;
  const encode = (value: unknown, depth: number): string => {
    if (truncated) return '"…"';
    if (value === null) return "null";
    const type = typeof value;
    if (type === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : `"${String(value)}"`;
    if (type === "boolean") return value ? "true" : "false";
    if (type === "bigint") return `"${(value as bigint).toString()}"`;
    if (type === "string") {
      const s = value as string;
      return JSON.stringify(s.length > STABLE_KEY_MAX_STRING ? `${s.slice(0, STABLE_KEY_MAX_STRING)}…` : s);
    }
    if (type === "function" || type === "symbol" || type === "undefined") return `"[${type}]"`;
    // object or array
    if (depth >= STABLE_KEY_MAX_DEPTH) return '"[MaxDepth]"';
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const cap = Math.min(value.length, STABLE_KEY_MAX_ARRAY);
        const parts: string[] = [];
        for (let i = 0; i < cap; i += 1) {
          parts.push(encode(value[i], depth + 1));
          if (truncated) break;
        }
        if (value.length > STABLE_KEY_MAX_ARRAY) parts.push('"…"');
        return `[${parts.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const cap = Math.min(keys.length, STABLE_KEY_MAX_KEYS);
      const parts: string[] = [];
      for (let i = 0; i < cap; i += 1) {
        const key = keys[i] as string;
        parts.push(`${JSON.stringify(key)}:${encode(record[key], depth + 1)}`);
        if (truncated) break;
      }
      if (keys.length > STABLE_KEY_MAX_KEYS) parts.push('"…":"…"');
      return `{${parts.join(",")}}`;
    } finally {
      // Leave the set so sibling subtrees that legitimately repeat a shared reference still
      // serialize once per occurrence-path without false "Circular" hits across siblings.
      seen.delete(value);
    }
  };
  let out = encode(appState, 0);
  if (out.length > STABLE_KEY_MAX_TOTAL) {
    truncated = true;
    out = `${out.slice(0, STABLE_KEY_MAX_TOTAL)}…`;
  }
  return out;
}

/** The friction progress key: a stable projection of appState when present, else stateSignature. */
function progressKeyOf(observation: CuaObservation): string {
  return observation.appState !== undefined ? stableProgressKey(observation.appState) : observation.stateSignature;
}

/** A public-safe one-line action label. Never includes raw typed text. */
export function describeCuaAction(action: CuaAction): string {
  switch (action.kind) {
    case "click":
      return `click (${action.x}, ${action.y})`;
    case "double_click":
      return `double-click (${action.x}, ${action.y})`;
    case "move":
      return `move (${action.x}, ${action.y})`;
    case "scroll":
      return `scroll (${action.dx}, ${action.dy}) at (${action.x}, ${action.y})`;
    case "type":
      return `type [${action.text.length} chars]`;
    case "keypress":
      return `keypress ${action.keys.join("+")}`;
    case "drag":
      return `drag ${action.path.length} points`;
    case "wait":
      return action.ms === undefined ? "wait" : `wait ${action.ms}ms`;
    case "screenshot":
      return "screenshot";
  }
}

function statusForCompletion(reason: ActorCompletionReason): ActorStatus {
  switch (reason) {
    case "goal_satisfied":
    case "turn_completed": // turn_completed is a Codex-lane reason; this loop emits goal_satisfied
      return "passed";
    case "timed_out":
      return "timed_out";
    case "blocked_approval":
      return "blocked";
    case "gave_up":
    case "actor_error":
    case "step_failed": // step_failed is the scripted-browser lane's reason; this loop never emits it
    case "harness_error":
      return "failed";
  }
}

// Distinct error classes so the loop can tell a deadline/abort apart from a real
// adapter failure when raceSettle rejects.
class CuaDeadlineError extends Error {}
class CuaAbortError extends Error {}
// Internal control-flow signal: the per-turn frame guard already set completionReason/reason
// to a structured harness_error; this just unwinds the loop without being misread as an adapter
// failure in the catch block (it carries no message to persist).
class CuaFrameGuardStop extends Error {}
// Internal control-flow signal for deterministic harness stop conditions that match before the
// model is asked for another turn. completionReason/reason are already set by the caller.
class CuaStopWhenStop extends Error {}

const neverAbort: AbortSignal = new AbortController().signal;

/**
 * Wait on a port promise, but stop waiting if the wall-clock budget runs out or
 * the caller aborts. The underlying promise may still settle later (a promise
 * cannot be force-cancelled); we simply stop blocking the loop on it. An
 * already-settled promise always wins, so a fast op is never spuriously failed.
 */
function raceSettle<T>(promise: Promise<T>, remainingMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new CuaAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      apply();
    };
    const onAbort = (): void => finish(() => reject(new CuaAbortError()));
    const timer = setTimeout(() => finish(() => reject(new CuaDeadlineError())), Math.max(0, remainingMs));
    if (typeof timer.unref === "function") timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

/**
 * Drive the computer-use loop to a single explicit completion and return an
 * ActorTrace. Every screenshot is redacted through the injected RedactionHooks
 * before its ref is recorded, so the trace is public-safe by construction.
 */
export async function runComputerUseLoop(options: CuaLoopOptions): Promise<CuaLoopResult> {
  const {
    instructions,
    provider,
    executor,
    persona,
    redaction,
    timeoutMs,
    now,
    signal,
    idleSteps = DEFAULT_IDLE_STEPS,
    noProgressSteps = DEFAULT_NO_PROGRESS_STEPS,
    acknowledgeSafetyChecks = () => null,
    redactScreenshots = false,
    scrubText = (text) => text,
    writeScreenshot = async (name) => `screenshots/${name}`,
    stopWhen
  } = options;
  const noProgressRecoverySteps = Math.min(Math.max(1, noProgressSteps - 1), 3);
  // Model-authored narration: literal-scrub known provisioned values, THEN pattern-redact.
  // A value the model transcribes (a DB password it read on screen) has no shape, so redactText
  // alone cannot catch it — the lab's scrubKnownValues, injected as scrubText, closes that.
  const redactNarration = (text: string): string => redaction.redactText(scrubText(text));

  const startedAtMs = now();
  const remaining = (): number => timeoutMs - (now() - startedAtMs);
  const items: ActorTraceItem[] = [];
  const counts: Record<string, number> = {
    turns: 0,
    actions: 0,
    screenshots: 0,
    reasonings: 0,
    messages: 0,
    idleTurns: 0,
    noProgressTurns: 0
  };
  let seq = 0;
  let usageInput = 0;
  let usageOutput = 0;
  let sawUsage = false;
  let lastResponseId: string | undefined;

  const nextId = (kind: string): string => `${kind}-${(seq += 1).toString().padStart(3, "0")}`;
  const bump = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  // Whether any observation this run surfaced structured appState (a non-vision/state executor).
  // RUNTIME-ONLY signal: used solely to self-describe in redaction.notes that app state drove
  // progress detection and was NOT written to the trace — the appState itself never persists.
  let observedAppState = false;

  // Guarded screenshot persistence: a non-vision executor returns an observation with no
  // screenshot, and the loop persists none that turn (counts.screenshots stays 0 → the existing
  // "n/a" branch resolves redaction.screenshots). No Buffer.alloc(0) ever reaches disk.
  const maybeRecordScreenshot = async (observation: CuaObservation, label: string): Promise<void> => {
    const frame = observation.screenshot;
    if (frame === undefined) return;
    // Default: persist the raw frame (full fidelity, local-only). redactScreenshots flips to the
    // publish-safe blurred thumbnail. Either way the bytes the model already saw were raw.
    const { bytes, method } = redactScreenshots
      ? await redaction.redactScreenshot(frame, { label }).then((r) => ({ bytes: r.buffer, method: r.method }))
      : { bytes: frame, method: "none" as const };
    const path = await writeScreenshot(`${label}.png`, bytes);
    items.push({
      id: nextId("screenshot"),
      kind: "screenshot",
      lifecycle: "completed",
      title: label,
      screenshotRef: { path, redaction: method }
    });
    bump("screenshots");
  };

  const matchedStopWhen = (observation: CuaObservation): StopConditionMatch | undefined =>
    evaluateStopWhen(stopWhen, {
      ...(observation.url === undefined ? {} : { url: observation.url }),
      ...(observation.text === undefined ? {} : { text: observation.text }),
      ...(observation.appState === undefined ? {} : { appState: observation.appState })
    });

  let completionReason: ActorCompletionReason = "goal_satisfied";
  let reason = "computer-use loop completed";
  let stopConditionMatch: StopConditionMatch | undefined;

  // A vision provider against a screenshot-less observation is a fail-closed harness error, not
  // a silent crash: record it and break. Returns true when the run must stop. (The provider sets
  // requiresFrame; a state-reasoning provider omits it.)
  const frameGuardTripped = (observation: CuaObservation): boolean => {
    if (provider.requiresFrame === true && observation.screenshot === undefined) {
      completionReason = "harness_error";
      reason = `provider ${provider.id} requires a screenshot frame but the executor returned an observation with no screenshot (vision provider against a state-only executor)`;
      return true;
    }
    return false;
  };

  // Loop-local state. Declared here (before the try) so the initial observe + the per-turn
  // frame guard can fail closed cleanly while these still scope across the loop.
  let previousResponseId: string | undefined;
  let consecutiveIdle = 0;
  // One canonical "no progress" signal: turns that did not change the UI state
  // signature (idle or not). The nudge, the stop threshold, and the reason all
  // key off this counter, and it catches alternating idle/no-progress stalls
  // that two separate counters would let slip past every backstop but the clock.
  let consecutiveNoProgress = 0;
  let lastSignature = "";
  let contextHint: string | undefined;
  // Acks granted for the previous turn's safety checks. They must ride the
  // NEXT request (the one carrying that call's computer_call_output), so they
  // are staged here rather than written onto the request already sent.
  let pendingAcks: CuaSafetyCheck[] | undefined;
  try {
    let observation = await raceSettle(executor.observe(), remaining(), signal);
    if (observation.appState !== undefined) observedAppState = true;
    // Fail closed BEFORE the first turn if a vision provider got a screenshot-less observation.
    if (frameGuardTripped(observation)) throw new CuaFrameGuardStop();
    await maybeRecordScreenshot(observation, "turn-00-start");
    stopConditionMatch = matchedStopWhen(observation);
    if (stopConditionMatch) {
      completionReason = "goal_satisfied";
      reason = stopWhenReason(stopConditionMatch);
      items.push(stopWhenTraceItem(nextId("notice"), stopConditionMatch, redactNarration));
      throw new CuaStopWhenStop();
    }
    // The progress key prefers a stable appState projection (route/turn/modal deltas drive
    // progress) and falls back to the executor's stateSignature — so a state executor with a
    // constant signature still registers progress, and a vision executor behaves exactly as before.
    lastSignature = progressKeyOf(observation);

    // Bounded by wall-clock and the friction backstops, never a turn count.
    for (;;) {
      if (signal?.aborted) {
        completionReason = "harness_error";
        reason = "run aborted by the harness";
        break;
      }
      if (now() - startedAtMs > timeoutMs) {
        completionReason = "timed_out";
        reason = `wall-clock deadline reached after ${timeoutMs}ms`;
        break;
      }

      const turnNumber = (counts.turns ?? 0) + 1;
      const request: CuaTurnRequest = { instructions, observation };
      if (previousResponseId !== undefined) request.previousResponseId = previousResponseId;
      if (contextHint !== undefined) request.contextHint = contextHint;
      if (pendingAcks !== undefined) request.acknowledgedSafetyChecks = pendingAcks;
      contextHint = undefined;
      pendingAcks = undefined;

      const turn = await raceSettle(provider.nextTurn(request, signal ?? neverAbort), remaining(), signal);
      bump("turns");
      previousResponseId = turn.responseId ?? previousResponseId;
      lastResponseId = turn.responseId ?? lastResponseId;
      if (turn.usage) {
        sawUsage = true;
        usageInput += turn.usage.input ?? 0;
        usageOutput += turn.usage.output ?? 0;
      }
      if (turn.reasoning) {
        items.push({
          id: nextId("reasoning"),
          kind: "reasoning",
          lifecycle: "completed",
          title: `reasoning turn ${turnNumber}`,
          text: redactNarration(turn.reasoning)
        });
        bump("reasonings");
      }
      if (turn.message) {
        items.push({
          id: nextId("message"),
          kind: "message",
          lifecycle: "completed",
          title: `message turn ${turnNumber}`,
          text: redactNarration(turn.message)
        });
        bump("messages");
      }

      if (turn.pendingSafetyChecks.length > 0) {
        const acks = acknowledgeSafetyChecks(turn.pendingSafetyChecks);
        if (acks === null || acks.length === 0) {
          // Safety-check categories are provider-defined enums (e.g.
          // "malicious_instructions"), not free text; record them (redacted for
          // defense-in-depth) so the evidence shows WHY the run paused.
          const checks = redaction.redactText(turn.pendingSafetyChecks.map((check) => check.code).join(", "));
          items.push({
            id: nextId("approval"),
            kind: "approval",
            lifecycle: "completed",
            status: "blocked",
            title: `safety check: ${checks}`
          });
          completionReason = "blocked_approval";
          reason = `paused on model safety check(s): ${checks}; not acknowledged`;
          break;
        }
        pendingAcks = acks;
      }

      if (turn.done || turn.actions.length === 0) {
        completionReason = "goal_satisfied";
        const summary = turn.message?.trim();
        reason = summary
          ? redactNarration(summary)
          : "model reported a natural endpoint with no further action";
        break;
      }

      const idleThisTurn = isIdleTurn(turn.actions);
      for (const action of turn.actions) {
        if (signal?.aborted) throw new CuaAbortError();
        items.push({
          id: nextId("ui_action"),
          kind: "ui_action",
          lifecycle: "completed",
          title: describeCuaAction(action)
        });
        bump("actions");
        await raceSettle(executor.execute(action), remaining(), signal);
      }

      if (signal?.aborted) throw new CuaAbortError();
      observation = await raceSettle(executor.observe(), remaining(), signal);
      if (observation.appState !== undefined) observedAppState = true;
      // Per-turn fail-closed vision guard: a vision provider can never reason over a missing frame.
      if (frameGuardTripped(observation)) break;
      await maybeRecordScreenshot(observation, `turn-${turnNumber.toString().padStart(2, "0")}`);
      stopConditionMatch = matchedStopWhen(observation);
      if (stopConditionMatch) {
        completionReason = "goal_satisfied";
        reason = stopWhenReason(stopConditionMatch);
        items.push(stopWhenTraceItem(nextId("notice"), stopConditionMatch, redactNarration));
        break;
      }

      // Progress prefers the stable appState projection; a state executor with a constant
      // stateSignature still registers progress when its appState changed (and vice versa).
      const progressKey = progressKeyOf(observation);
      const progressed = progressKey !== lastSignature;
      lastSignature = progressKey;

      consecutiveIdle = idleThisTurn ? consecutiveIdle + 1 : 0;
      if (idleThisTurn) bump("idleTurns");
      consecutiveNoProgress = progressed ? 0 : consecutiveNoProgress + 1;
      if (!progressed) bump("noProgressTurns");

      // Recovery nudge before the backstop trips: tell the model it is stuck.
      if (consecutiveNoProgress >= noProgressRecoverySteps && consecutiveNoProgress < noProgressSteps) {
        contextHint =
          `No visible progress for ${consecutiveNoProgress} step(s). ` +
          "Try a different visible control, scroll within a panel, or stop with a final summary.";
      }

      if (consecutiveIdle >= idleSteps) {
        completionReason = "gave_up";
        reason = `gave up: ${consecutiveIdle} consecutive turns with no material UI action (only screenshot/wait)`;
        break;
      }
      if (consecutiveNoProgress >= noProgressSteps) {
        completionReason = "gave_up";
        reason = `gave up: ${consecutiveNoProgress} consecutive turns with no change to the UI state`;
        break;
      }
    }
  } catch (error) {
    if (error instanceof CuaFrameGuardStop || error instanceof CuaStopWhenStop) {
      // completionReason/reason were already set by the frame guard or stopWhen guard.
    } else if (error instanceof CuaDeadlineError) {
      completionReason = "timed_out";
      reason = `wall-clock deadline reached after ${timeoutMs}ms`;
    } else if (error instanceof CuaAbortError) {
      completionReason = "harness_error";
      reason = "run aborted by the harness";
    } else {
      completionReason = "actor_error";
      reason = redactNarration(`computer-use loop error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const completedAtMs = now();
  const status = statusForCompletion(completionReason);
  const ids: ActorTrace["ids"] = {};
  if (provider.version !== undefined) ids.model = provider.version;
  // responseId is provider-authored and opaque; redact for defense-in-depth.
  if (lastResponseId !== undefined) ids.turnId = redaction.redactText(lastResponseId);

  const screenshotNote = !(counts.screenshots && counts.screenshots > 0)
    ? "no screenshots captured"
    : redactScreenshots
      ? `${counts.screenshots} screenshot(s) redacted to blurred thumbnails via RedactionHooks`
      : `${counts.screenshots} full-fidelity screenshot(s) retained for local use — NOT redacted for publishing; set redactScreenshots to blur a share-as-is bundle`;
  // Self-describing artifact (invariant 6): when a non-vision executor surfaced structured app
  // state, the trace declares HOW it handled that surface — app state drove progress detection
  // each turn and was NOT written to the trace (it is a runtime-only progress input, like
  // stateSignature). The appState itself never appears anywhere in this bundle.
  const notes = observedAppState
    ? `${screenshotNote}. App state was observed each turn to drive progress detection (a state-driven executor) and was NOT written to the trace — it is a runtime-only progress input, never persisted as evidence in this slice.`
    : screenshotNote;

  const trace: ActorTrace = {
    schema: ACTOR_TRACE_SCHEMA,
    provider: provider.id,
    ...(provider.version === undefined ? {} : { providerVersion: provider.version }),
    protocol: "cua-loop",
    lane: "computer-use",
    persona,
    redaction: {
      status: "passed",
      screenshots: !(counts.screenshots && counts.screenshots > 0)
        ? "n/a"
        : redactScreenshots
          ? "blurred"
          : "raw",
      notes
    },
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - startedAtMs,
    status,
    completionReason,
    reason,
    ids,
    counts,
    items,
    ...(sawUsage ? { tokenUsage: { input: usageInput, output: usageOutput, total: usageInput + usageOutput } } : {}),
    capabilities: provider.capabilities
  };

  return { status, completionReason, reason, trace };
}

function stopWhenReason(match: StopConditionMatch): string {
  return `stopWhen matched ${match.id} (${match.kinds.join("+")})`;
}

function stopWhenTraceItem(
  id: string,
  match: StopConditionMatch,
  redactNarration: (text: string) => string
): ActorTraceItem {
  return {
    id,
    kind: "notice",
    lifecycle: "completed",
    status: "matched",
    title: `stopWhen matched: ${match.id}`,
    text: redactNarration(
      `Harness stop condition matched rule ${match.id} using ${match.kinds.join(", ")}. Raw observed URL/text/appState were runtime-only and were not persisted.`
    )
  };
}
