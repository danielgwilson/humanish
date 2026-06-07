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
// no material action) or a no-progress streak (non-idle actions that do not
// change the UI). The only hard runaway guard is the wall-clock timeoutMs. There
// is intentionally no maxSteps cap: turns are a terrible proxy for "stop".

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
    case "turn_completed":
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
    let observation = await executor.observe();
    await recordScreenshot(observation.screenshot, "turn-00-start");

    let previousResponseId: string | undefined;
    let consecutiveIdle = 0;
    let consecutiveNoProgressCalls = 0;
    let consecutiveNoProgressObservations = 0;
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

      const turn = await provider.nextTurn(request, signal ?? new AbortController().signal);
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
          items.push({
            id: nextId("approval"),
            kind: "approval",
            lifecycle: "completed",
            status: "blocked",
            title: `safety check: ${turn.pendingSafetyChecks.length} pending`
          });
          completionReason = "blocked_approval";
          reason = `paused on ${turn.pendingSafetyChecks.length} model safety check(s); not acknowledged`;
          break;
        }
        request.acknowledgedSafetyChecks = acks;
      }

      if (turn.done || turn.actions.length === 0) {
        completionReason = "goal_satisfied";
        reason = turn.message
          ? redaction.redactText(turn.message)
          : "model reported a natural endpoint with no further action";
        break;
      }

      const idleThisTurn = isIdleTurn(turn.actions);
      for (const action of turn.actions) {
        items.push({
          id: nextId("ui_action"),
          kind: "ui_action",
          lifecycle: "completed",
          title: describeCuaAction(action)
        });
        bump("actions");
        await executor.execute(action);
      }

      observation = await executor.observe();
      await recordScreenshot(observation.screenshot, `turn-${turnNumber.toString().padStart(2, "0")}`);

      const progressed = observation.stateSignature !== lastSignature;
      lastSignature = observation.stateSignature;

      consecutiveIdle = idleThisTurn ? consecutiveIdle + 1 : 0;
      if (idleThisTurn) bump("idleTurns");
      consecutiveNoProgressObservations = progressed ? 0 : consecutiveNoProgressObservations + 1;
      consecutiveNoProgressCalls = !idleThisTurn && !progressed ? consecutiveNoProgressCalls + 1 : 0;
      if (!idleThisTurn && !progressed) bump("noProgressTurns");

      // Recovery nudge before the backstop trips: tell the model it is stuck.
      if (
        consecutiveNoProgressObservations >= noProgressRecoverySteps &&
        consecutiveNoProgressCalls < noProgressSteps
      ) {
        contextHint =
          `No visible progress for ${consecutiveNoProgressObservations} step(s). ` +
          "Try a different visible control, scroll within a panel, or stop with a final summary.";
      }

      if (consecutiveIdle >= idleSteps) {
        completionReason = "gave_up";
        reason = `gave up: ${consecutiveIdle} consecutive turns with no material UI action (only screenshot/wait)`;
        break;
      }
      if (consecutiveNoProgressCalls >= noProgressSteps) {
        completionReason = "gave_up";
        reason = `gave up: ${consecutiveNoProgressCalls} consecutive actions with no change to the UI state`;
        break;
      }
    }
  } catch (error) {
    completionReason = "actor_error";
    reason = redaction.redactText(`computer-use loop error: ${error instanceof Error ? error.message : String(error)}`);
  }

  const completedAtMs = now();
  const status = statusForCompletion(completionReason);
  const ids: ActorTrace["ids"] = {};
  if (provider.version !== undefined) ids.model = provider.version;
  if (lastResponseId !== undefined) ids.turnId = lastResponseId;

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
