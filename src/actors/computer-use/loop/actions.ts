import { classifyCuaAction } from "../../affordance.js";
import { commandFailureInfo, isCommandExitError } from "../../../substrates/command-failure.js";
import { CuaExecutorError, isCuaExecutorError } from "../executor-error.js";
import {
  CuaAbortError,
  CuaDeadlineError,
  CuaStallError,
  raceCallBound,
  raceSessionDeadline,
  requestScope,
} from "./race.js";
import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";
import type { CuaAction, CuaTurnRequest } from "./types.js";

// The participant's actions: their public labels, what counts as a material action, and how one
// turn's batch is dispatched to the desktop.

/** Click/scroll coordinates are bucketed to this many pixels before fingerprinting, so a one-pixel
 *  jitter between two otherwise identical clicks still reads as the same attempt. */
const ACTION_FINGERPRINT_BUCKET = 24;
const RECENT_ACTION_TITLES = 8;

/** The keys a pointer action holds down: key names, never typed text. */
function heldKeysOf(action: CuaAction): readonly string[] {
  return "heldKeys" in action && action.heldKeys !== undefined ? action.heldKeys : [];
}

/** The label suffix for a pointer action's held keys. */
function heldKeysSuffix(action: CuaAction): string {
  const keys = heldKeysOf(action);
  return keys.length > 0 ? ` holding ${keys.join("+")}` : "";
}

/** A public-safe one-line action label. Never includes raw typed text. */
export function describeCuaAction(action: CuaAction): string {
  return describeAction(action) + heldKeysSuffix(action);
}

function describeAction(action: CuaAction): string {
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
    case "speak":
      return `speak [${action.text.length} chars]`;
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

/**
 * A public-safe fingerprint of one turn's actions, used only in memory to tell "trying the same
 * thing again" from "trying something new".
 *
 * Never includes typed text or key contents: a `type` contributes its length, exactly as
 * describeCuaAction does, so this can never become a keylogger. Coordinates are bucketed so that
 * re-clicking the same control counts as a repeat while moving to a different control does not.
 */
export function actionFingerprint(actions: readonly CuaAction[]): string {
  const bucket = (value: number): number => Math.round(value / ACTION_FINGERPRINT_BUCKET);
  return actions
    .map((action) => {
      // A shift-click and a plain click on one control are different attempts.
      const keys = heldKeysOf(action);
      const held = keys.length > 0 ? `+${keys.join("+")}` : "";
      switch (action.kind) {
        case "click":
        case "double_click":
        case "move":
          return `${action.kind}@${bucket(action.x)},${bucket(action.y)}${held}`;
        case "scroll":
          return `scroll@${bucket(action.x)},${bucket(action.y)}:${Math.sign(action.dx)},${Math.sign(action.dy)}${held}`;
        case "type":
          return `type:${action.text.length}`;
        case "speak":
          return `speak:${action.text.length}`;
        case "keypress":
          return `keypress:${action.keys.join("+")}`;
        case "drag":
          return `drag:${action.path.length}${held}`;
        case "wait":
          return "wait";
        case "screenshot":
          return "screenshot";
      }
    })
    .join("|");
}

/** Screenshots and waits only look; every other action is the participant acting. */
function isIdleAction(action: CuaAction): boolean {
  return action.kind === "screenshot" || action.kind === "wait";
}

export function isIdleTurn(actions: readonly CuaAction[]): boolean {
  return actions.every(isIdleAction);
}

type ExecutionStatus = NonNullable<
  CuaTurnRequest["previousExecution"]
>["actions"][number]["status"];

/**
 * The material-action rule: a non-idle action counts once the desktop may have received it. An
 * action the executor declared not dispatched, or a desktop command that failed and was skipped,
 * is not progress. An action whose outcome is unknown (the loop stopped waiting, or it failed
 * without a declaration) counts as an attempt. `status` is undefined when no acknowledgement was
 * returned.
 */
function isMaterialAttempt(action: CuaAction, status: ExecutionStatus | undefined): boolean {
  return !isIdleAction(action) && status !== "skipped" && status !== "not_dispatched";
}

export interface ActionBatch {
  /** Host input acknowledgements for the provider's next request. */
  readonly execution: NonNullable<CuaTurnRequest["previousExecution"]>;
  /** Guidance for the next request, set when a pre-dispatch rejection stopped the batch. */
  readonly hint: string | undefined;
}

function rejectedActionHint(title: string): string {
  return `Your action (${title}) was rejected before dispatch. No input from that action or the rest of its batch was sent. Choose your next action from the fresh screenshot; do not assume the rejected action succeeded.`;
}

/**
 * Dispatch one turn's actions in order. A declared pre-dispatch rejection stops the batch and
 * leaves the desktop usable; a failed desktop command skips its action; any other failure ends
 * the session.
 */
export async function runActionBatch(
  session: LoopSession,
  actions: readonly CuaAction[],
): Promise<ActionBatch> {
  const execution: ActionBatch["execution"] = { actions: [] };
  const { actionHistory, trace } = session;
  for (const [index, action] of actions.entries()) {
    if (session.signal?.aborted) throw new CuaAbortError();
    const title = describeCuaAction(action);
    actionHistory.lastActionTitle = title;
    actionHistory.recentActionTitles.push(title);
    if (actionHistory.recentActionTitles.length > RECENT_ACTION_TITLES)
      actionHistory.recentActionTitles.shift();
    trace.bump("actions");
    // Classify before execute, mirroring counts.actions: the record is of what the actor
    // chose, so an action that then fails to actuate is still an honest record of the route
    // it reached for.
    actionHistory.affordances.push(classifyCuaAction(action));
    session.phase = `executing ${title}`;
    let status: ExecutionStatus;
    try {
      status = await dispatchAction(session, action, title);
    } catch (error) {
      const declared = isCuaExecutorError(error)
        ? error.disposition
        : isCommandExitError(error)
          ? "skipped"
          : undefined;
      if (declared !== undefined) execution.actions.push({ index, status: declared });
      countAttempt(session, action, title, declared);
      if (
        isCuaExecutorError(error) &&
        error.code === "action_rejected" &&
        error.disposition === "not_dispatched"
      ) {
        // Later actions may depend on this one (type, then submit). Return
        // their full acknowledgement list and let a fresh observation decide.
        for (let later = index + 1; later < actions.length; later++) {
          execution.actions.push({ index: later, status: "not_dispatched" });
        }
        trace.record("notice", () =>
          notice(
            "warn",
            "action rejected before dispatch",
            session.redactNarration(
              `action: ${title}; code: action_rejected; disposition: not_dispatched; remaining batch actions not dispatched: ${actions.length - index - 1}`,
            ),
          ),
        );
        return { execution, hint: rejectedActionHint(title) };
      }
      if (isCuaExecutorError(error) || !isCommandExitError(error)) throw error;
      // A skipped action changes nothing on screen, so a persistently-failing run makes no
      // progress and still terminates honestly via the idle/no-progress backstop (gave_up),
      // never a silent actor_error and never an infinite loop.
      recordCommandFailure(session, title, error);
      continue;
    }
    execution.actions.push({ index, status });
    countAttempt(session, action, title, status);
    trace.record("ui_action", () => ({
      lifecycle: "completed",
      title,
      ...(action.kind === "speak" ? { text: session.redactNarration(action.text) } : {}),
      // Structured pin coordinates, exactly the click classes the Observer
      // pins render: recorded fact instead of a title re-parse downstream.
      ...(action.kind === "click" || action.kind === "double_click"
        ? { coord: { x: action.x, y: action.y } }
        : {}),
    }));
  }
  return { execution, hint: undefined };
}

function countAttempt(
  session: LoopSession,
  action: CuaAction,
  title: string,
  status: ExecutionStatus | undefined,
): void {
  if (!isMaterialAttempt(action, status)) return;
  session.actionHistory.lastMaterialActionTitle = title;
  session.trace.counts.materialActions += 1;
}

/**
 * Execute one action. Idle actions only look: a `wait` that hangs inside the SDK has in
 * effect waited, so a stalled one is skipped with a notice and loses nothing the participant
 * chose. An action is recorded as completed only after execute() resolves.
 */
async function dispatchAction(
  session: LoopSession,
  action: CuaAction,
  title: string,
): Promise<"completed" | "skipped"> {
  if (!isIdleAction(action)) {
    await executeAction(session, action, title);
    return "completed";
  }
  const boundMs = session.observationTimeoutMs + (action.kind === "wait" ? (action.ms ?? 0) : 0);
  try {
    await executeAction(session, action, title, boundMs);
    return "completed";
  } catch (error) {
    if (!(error instanceof CuaStallError)) throw error;
    session.trace.record("notice", () =>
      notice(
        "warn",
        "observation action stalled; skipped",
        `${error.what} produced nothing within ${error.afterMs}ms; the desktop was not asked again and the next screenshot decides`,
      ),
    );
    return "skipped";
  }
}

async function executeAction(
  session: LoopSession,
  action: CuaAction,
  title: string,
  boundMs?: number,
): Promise<void> {
  const { signal } = session;
  const scope = requestScope(signal);
  try {
    const pending = session.executor.execute(action, scope.signal);
    if (boundMs === undefined) await raceSessionDeadline(pending, session.remaining(), signal);
    else await raceCallBound(`idle action ${title}`, pending, session.remaining(), boundMs, signal);
  } catch (error) {
    if (error instanceof CuaStallError && session.executor.stallRecovery === "fail_closed") {
      throw new CuaExecutorError("deadline_exceeded", "outcome_uncertain");
    }
    if (error instanceof CuaDeadlineError || error instanceof CuaAbortError) {
      // The loop's deadline/abort may win before the executor can report whether its
      // write reached the desktop. Cancellation alone does not establish rollback.
      session.actionHistory.interruptedActionOutcome = true;
      session.trace.record("notice", () =>
        notice(
          "warn",
          "action outcome uncertain",
          session.redactNarration(
            `action: ${title}; disposition: outcome_uncertain; the loop stopped waiting before execution was acknowledged; the action was not retried`,
          ),
        ),
      );
    }
    throw error;
  } finally {
    // A deadline also closes async executor preparation, so a late pointer read
    // cannot actuate after the loop stopped waiting for this action.
    scope.end();
  }
}

function recordCommandFailure(session: LoopSession, title: string, error: unknown): void {
  const { exitCode, stderrTail } = commandFailureInfo(error);
  session.trace.record("notice", () =>
    notice(
      "error",
      "action skipped: desktop command failed",
      // Public-safe: describeCuaAction never includes raw typed text, the exit code is a number,
      // and the tail is only the substrate's own stderr (tailed+whitespace-collapsed); the whole
      // line is still run through redactNarration (scrubKnownValues + pattern redaction).
      session.redactNarration(
        [
          `action: ${title}`,
          exitCode === undefined ? undefined : `exit code: ${exitCode}`,
          stderrTail.length > 0 ? `stderr: ${stderrTail}` : undefined,
        ]
          .filter(Boolean)
          .join("; "),
      ),
    ),
  );
}
