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

/** A captured desktop state: the raw frame plus a coarse signature for progress. */
export interface CuaObservation {
  /** Raw PNG bytes of the current desktop. Redacted by the engine before persisting. */
  screenshot: Buffer;
  /**
   * A coarse, quantized signature of the visible UI used for no-progress
   * detection. Two observations with the same signature are "no progress". The
   * executor owns how it is computed (url, title, quantized scroll, focused
   * element, visible controls, etc.).
   */
  stateSignature: string;
}

export interface CuaTurnRequest {
  /** Persona + task instruction, sent as the system-level steer (first turn). */
  instructions: string;
  /** The latest observation for the model to react to. */
  observation: CuaObservation;
  /** Opaque continuation handle from the previous turn (provider-specific). */
  previousResponseId?: string;
  /** Safety checks the harness chose to acknowledge, passed back to the model. */
  acknowledgedSafetyChecks?: string[];
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
  pendingSafetyChecks: string[];
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
   * list proceeds; returning null/[] pauses the run (blocked_approval). Default:
   * pause on any safety check (fail-closed; real approval policy wires in later).
   */
  acknowledgeSafetyChecks?: (checks: string[]) => string[] | null;
  /** Persist a redacted screenshot, returning the ref path recorded in the trace. */
  writeScreenshot?: (name: string, bytes: Buffer) => Promise<string>;
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
    case "harness_error":
      return "failed";
  }
}

// Distinct error classes so the loop can tell a deadline/abort apart from a real
// adapter failure when raceSettle rejects.
class CuaDeadlineError extends Error {}
class CuaAbortError extends Error {}

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
    writeScreenshot = async (name) => `screenshots/${name}`
  } = options;
  const noProgressRecoverySteps = Math.min(Math.max(1, noProgressSteps - 1), 3);

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

  const recordScreenshot = async (frame: Buffer, label: string): Promise<void> => {
    const redacted = await redaction.redactScreenshot(frame, { label });
    const path = await writeScreenshot(`${label}.png`, redacted.buffer);
    items.push({
      id: nextId("screenshot"),
      kind: "screenshot",
      lifecycle: "completed",
      title: label,
      screenshotRef: { path, redaction: redacted.method }
    });
    bump("screenshots");
  };

  let completionReason: ActorCompletionReason = "goal_satisfied";
  let reason = "computer-use loop completed";

  try {
    let observation = await raceSettle(executor.observe(), remaining(), signal);
    await recordScreenshot(observation.screenshot, "turn-00-start");

    let previousResponseId: string | undefined;
    let consecutiveIdle = 0;
    // One canonical "no progress" signal: turns that did not change the UI state
    // signature (idle or not). The nudge, the stop threshold, and the reason all
    // key off this counter, and it catches alternating idle/no-progress stalls
    // that two separate counters would let slip past every backstop but the clock.
    let consecutiveNoProgress = 0;
    let lastSignature = observation.stateSignature;
    let contextHint: string | undefined;

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
      contextHint = undefined;

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
          text: redaction.redactText(turn.reasoning)
        });
        bump("reasonings");
      }
      if (turn.message) {
        items.push({
          id: nextId("message"),
          kind: "message",
          lifecycle: "completed",
          title: `message turn ${turnNumber}`,
          text: redaction.redactText(turn.message)
        });
        bump("messages");
      }

      if (turn.pendingSafetyChecks.length > 0) {
        const acks = acknowledgeSafetyChecks(turn.pendingSafetyChecks);
        if (acks === null || acks.length === 0) {
          // Safety-check categories are provider-defined enums (e.g.
          // "malicious_instructions"), not free text; record them (redacted for
          // defense-in-depth) so the evidence shows WHY the run paused.
          const checks = redaction.redactText(turn.pendingSafetyChecks.join(", "));
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
        request.acknowledgedSafetyChecks = acks;
      }

      if (turn.done || turn.actions.length === 0) {
        completionReason = "goal_satisfied";
        const summary = turn.message?.trim();
        reason = summary
          ? redaction.redactText(summary)
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
      await recordScreenshot(observation.screenshot, `turn-${turnNumber.toString().padStart(2, "0")}`);

      const progressed = observation.stateSignature !== lastSignature;
      lastSignature = observation.stateSignature;

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
    if (error instanceof CuaDeadlineError) {
      completionReason = "timed_out";
      reason = `wall-clock deadline reached after ${timeoutMs}ms`;
    } else if (error instanceof CuaAbortError) {
      completionReason = "harness_error";
      reason = "run aborted by the harness";
    } else {
      completionReason = "actor_error";
      reason = redaction.redactText(`computer-use loop error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const completedAtMs = now();
  const status = statusForCompletion(completionReason);
  const ids: ActorTrace["ids"] = {};
  if (provider.version !== undefined) ids.model = provider.version;
  // responseId is provider-authored and opaque; redact for defense-in-depth.
  if (lastResponseId !== undefined) ids.turnId = redaction.redactText(lastResponseId);

  const trace: ActorTrace = {
    schema: ACTOR_TRACE_SCHEMA,
    provider: provider.id,
    ...(provider.version === undefined ? {} : { providerVersion: provider.version }),
    protocol: "cua-loop",
    lane: "computer-use",
    persona,
    redaction: {
      status: "passed",
      screenshots: counts.screenshots && counts.screenshots > 0 ? "blurred" : "n/a",
      notes:
        counts.screenshots && counts.screenshots > 0
          ? `${counts.screenshots} screenshot(s) redacted to blurred thumbnails via RedactionHooks`
          : "no screenshots captured"
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
