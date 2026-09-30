import { classifyCuaAction } from "../../affordance.js";
import { commandFailureInfo, isCommandExitError } from "../../../substrates/command-failure.js";
import { CuaExecutorError, isCuaExecutorError } from "../executor-error.js";
import { CuaAbortError, CuaDeadlineError, CuaStallError, raceBounded, raceSettle } from "./race.js";
import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";
import type { CuaAction, CuaTurnRequest } from "./types.js";

// The participant's actions: their public labels, what counts as a material action, and how one
// turn's batch is dispatched to the desktop.

/** Click/scroll coordinates are bucketed to this many pixels before fingerprinting, so a one-pixel
 *  jitter between two otherwise identical clicks still reads as the same attempt. */
const ACTION_FINGERPRINT_BUCKET = 24;
const RECENT_ACTION_TITLES = 8;

/** The label suffix for a pointer action's held keys: key names, never typed text. */
function holding(action: CuaAction): string {
  return "heldKeys" in action && action.heldKeys?.length
    ? ` holding ${action.heldKeys.join("+")}`
    : "";
}

/** A public-safe one-line action label. Never includes raw typed text. */
export function describeCuaAction(action: CuaAction): string {
  return describeAction(action) + holding(action);
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
 * A public-safe fingerprint of ONE turn's actions, used only in memory to tell "trying the same
 * thing again" from "trying something new" (#383).
 *
 * Never includes typed text or key contents — a `type` contributes its LENGTH, exactly as
 * describeCuaAction does, so this can never become a keylogger. Coordinates are bucketed so that
 * re-clicking the same control counts as a repeat while moving to a different control does not.
 */
export function actionFingerprint(actions: readonly CuaAction[]): string {
  const bucket = (value: number): number => Math.round(value / ACTION_FINGERPRINT_BUCKET);
  return actions
    .map((action) => {
      // A shift-click and a plain click on one control are different attempts.
      const held =
        "heldKeys" in action && action.heldKeys?.length ? `+${action.heldKeys.join("+")}` : "";
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
  /** The action a pre-dispatch rejection stopped the batch at. */
  readonly rejectedActionTitle: string | undefined;
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
  const { activity, trace } = session;
  for (const [index, action] of actions.entries()) {
    if (session.signal?.aborted) throw new CuaAbortError();
    const title = describeCuaAction(action);
    activity.lastActionTitle = title;
    activity.recentActionTitles.push(title);
    if (activity.recentActionTitles.length > RECENT_ACTION_TITLES)
      activity.recentActionTitles.shift();
    trace.bump("actions");
    // Classify BEFORE execute, mirroring counts.actions: the record is of what the actor
    // CHOSE, so an action that then fails to actuate is still an honest record of the route
    // it reached for.
    activity.affordances.push(classifyCuaAction(action));
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
        return { execution, rejectedActionTitle: title };
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
      // Structured pin coordinates (#441), exactly the click classes the Observer
      // pins render — recorded fact instead of a title re-parse downstream.
      ...(action.kind === "click" || action.kind === "double_click"
        ? { coord: { x: action.x, y: action.y } }
        : {}),
    }));
  }
  return { execution, rejectedActionTitle: undefined };
}

function countAttempt(
  session: LoopSession,
  action: CuaAction,
  title: string,
  status: ExecutionStatus | undefined,
): void {
  if (!isMaterialAttempt(action, status)) return;
  session.activity.lastMaterialActionTitle = title;
  session.trace.counts.materialActions += 1;
}

/**
 * Execute one action. Observation actions only look (#480): a `wait` that hangs inside the SDK
 * has, by definition, waited, so a stalled one is skipped with a notice and loses nothing the
 * participant chose. A failed action is recorded as completed only after execute() resolves (#248).
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
  const idleBound = session.observationTimeoutMs + (action.kind === "wait" ? (action.ms ?? 0) : 0);
  try {
    await executeAction(session, action, title, idleBound);
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
  idleBound?: number,
): Promise<void> {
  const { signal } = session;
  const actionController = new AbortController();
  const onAbort = (): void => actionController.abort();
  if (signal?.aborted) actionController.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const pending = session.executor.execute(action, actionController.signal);
    if (idleBound === undefined) await raceSettle(pending, session.remaining(), signal);
    else await raceBounded(`idle action ${title}`, pending, session.remaining(), idleBound, signal);
  } catch (error) {
    if (error instanceof CuaStallError && session.executor.stallRecovery === "fail_closed") {
      throw new CuaExecutorError("deadline_exceeded", "outcome_uncertain");
    }
    if (error instanceof CuaDeadlineError || error instanceof CuaAbortError) {
      // The loop's deadline/abort may win before the executor can report whether its
      // write reached the desktop. Cancellation alone does not establish rollback.
      session.activity.interruptedActionOutcome = true;
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
    signal?.removeEventListener("abort", onAbort);
    // A deadline also closes async executor preparation, so a late pointer read
    // cannot actuate after the loop stopped waiting for this action.
    actionController.abort();
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
