import { classifyCuaAction } from "../../affordance.js";
import type { ActorWatch } from "../../contract.js";
import {
  commandFailureInfo,
  isCommandExitError,
  isFailedTyping,
} from "../../../substrates/command-failure.js";
import {
  ComputerUseExecutorError,
  isComputerUseExecutorError,
  type CuaRejectionReason,
} from "../executor-error.js";
import {
  CuaAbortError,
  CuaDeadlineError,
  CuaStallError,
  raceCallBound,
  raceSessionDeadline,
  requestScope,
} from "./race.js";
import { readEvidence } from "./frames.js";
import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";
import type {
  CuaAction,
  CuaActionAcknowledgement,
  CuaActionResult,
  CuaTurn,
  CuaTurnRequest,
} from "./types.js";
import { planWait } from "../wait.js";

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
    case "triple_click":
      return `triple-click (${action.x}, ${action.y})`;
    case "mouse_down":
    case "mouse_up": {
      const at = action.x === undefined ? "" : ` (${action.x}, ${action.y})`;
      return `${action.kind === "mouse_down" ? "mouse down" : "mouse up"} ${action.button ?? "left"}${at}`;
    }
    case "hold_keys":
      return `hold ${action.keys.join("+")} ${action.ms}ms`;
    case "read_pointer":
      return "read pointer";
    case "zoom": {
      const { x, y, width, height } = action.region;
      return `zoom ${width}x${height} at (${x}, ${y})`;
    }
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
        case "triple_click":
          return `triple_click@${bucket(action.x)},${bucket(action.y)}${held}`;
        case "mouse_down":
        case "mouse_up":
          return `${action.kind}:${action.button ?? "left"}@${action.x === undefined ? "pointer" : `${bucket(action.x)},${bucket(action.y ?? 0)}`}`;
        case "hold_keys":
          return `hold_keys:${action.keys.join("+")}`;
        case "read_pointer":
          return "read_pointer";
        case "zoom":
          return `zoom@${bucket(action.region.x)},${bucket(action.region.y)}`;
      }
    })
    .join("|");
}

/**
 * Screenshots, waits and the reads (`read_pointer`, `zoom`) only look or pause and send no input;
 * every other action is the participant acting. A read is watched and backstopped as a
 * screenshot is.
 */
function isIdleAction(action: CuaAction): boolean {
  switch (action.kind) {
    case "screenshot":
    case "wait":
    case "read_pointer":
    case "zoom":
      return true;
    default:
      return false;
  }
}

export function isIdleTurn(actions: readonly CuaAction[]): boolean {
  return actions.every(isIdleAction);
}

/** The point a pointer action pressed at, for the Observer's pins; absent for the rest. */
function pressedAt(action: CuaAction): { x: number; y: number } | undefined {
  switch (action.kind) {
    case "click":
    case "double_click":
    case "triple_click":
      return { x: action.x, y: action.y };
    case "mouse_down":
    case "mouse_up":
      return action.x === undefined || action.y === undefined
        ? undefined
        : { x: action.x, y: action.y };
    default:
      return undefined;
  }
}

type ExecutionStatus = CuaActionAcknowledgement["status"];

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
  /**
   * Guidance for the next request, set when the loop shortened a wait or a pre-dispatch rejection
   * stopped the batch.
   */
  readonly hint: string | undefined;
  /** An action of the batch other than a wait, screenshot or read may have reached the desktop. */
  readonly sent: boolean;
  /**
   * A screenshot within the batch captured the screen. A watch runs before the batch, so its last
   * look is then older than a frame the participant was shown, and the next screen is observed
   * afresh.
   */
  readonly captured: boolean;
}

/**
 * The waits of a turn the loop watched in place of sending them to the desktop (watch.ts): the
 * part of the watch each wait covered, in order, and the `watch` field of the wait during which
 * the watch ended.
 */
export interface WatchedWaits {
  readonly ms: readonly number[];
  readonly endedOn: number;
  readonly watch: ActorWatch;
  /** The session ended during the watch, so the turn's screenshot actions are not sent. */
  readonly sessionEnded: boolean;
}

/** What the participant can do about a rejection whose reason the executor named. */
const REJECTION_REMEDIES: Readonly<Record<CuaRejectionReason, string>> = Object.freeze({
  extra_tab:
    "It was rejected because more than one browser tab is open: typing works only while the study's original tab is the only tab. Switch to the other tab and close it, keep the study's original tab open, then type again.",
});

const FAILED_TYPING_HINT =
  "Your typing did not finish, and the field may hold part of the text. Check the screen before you type again.";

function rejectedActionHint(title: string, remedy: string | undefined): string {
  return `Your action (${title}) was rejected before dispatch. No input from that action or the rest of its batch was sent.${remedy === undefined ? "" : ` ${remedy}`} Choose your next action from the fresh screenshot; do not assume the rejected action succeeded.`;
}

/** Record a wait the loop shortened, and return the participant's note about it. */
function recordShortenedWait(session: LoopSession, title: string, requestedMs: number): string {
  const ms = session.waits.maxWaitMs;
  session.trace.record("notice", () =>
    notice(
      "warn",
      "wait shortened",
      `action: ${title}; requested: ${requestedMs}ms; waited: ${ms}ms, the longest one wait action lasts (actor.maxWaitMs); the session continued`,
    ),
  );
  return `Your wait of ${requestedMs}ms was shortened to ${ms}ms, the longest one wait action lasts. To keep waiting, send another wait.`;
}

/**
 * Dispatch one turn's actions in order, then acknowledge its rejected proposal, which the
 * provider could not map, at the position after them. A declared pre-dispatch rejection stops the
 * batch and leaves the desktop usable; a failed desktop command skips its action, and also stops
 * the batch for a provider with `batchFailure: "halt"`; any other failure ends the session. The
 * waits of a watched turn (`watched`) already ran: each is recorded with the part of the watch it
 * covered and nothing is sent for it. When that watch ended the session, the
 * turn's screenshots are acknowledged as not dispatched and not recorded.
 */
export async function runActionBatch(
  session: LoopSession,
  turn: Pick<CuaTurn, "actions" | "rejectedProposal">,
  watched?: WatchedWaits,
): Promise<ActionBatch> {
  const { actions, rejectedProposal } = turn;
  const execution: ActionBatch["execution"] = { actions: [] };
  const { actionHistory, trace } = session;
  const notes: string[] = [];
  const hint = (): string | undefined => (notes.length === 0 ? undefined : notes.join(" "));
  const attemptsBefore = trace.counts.materialActions;
  const framesBefore = session.screenshotFrames;
  const done = (): ActionBatch => ({
    execution,
    hint: hint(),
    sent: trace.counts.materialActions > attemptsBefore,
    captured: session.screenshotFrames > framesBefore,
  });
  const halting = session.provider.batchFailure === "halt";
  // The provider's model takes the batch to have stopped at the skipped action at `index`.
  const haltAfter = (index: number, title: string): ActionBatch => {
    const remaining = actions.length - index - 1;
    leaveUndispatched(execution, index + 1, actions.length);
    if (remaining > 0)
      trace.record("notice", () =>
        notice(
          "warn",
          "batch halted after a skipped action",
          session.redactNarration(
            `action: ${title}; remaining batch actions not dispatched: ${remaining}`,
          ),
        ),
      );
    return done();
  };
  const idleTurn = isIdleTurn(actions);
  // A screenshot is sent only where the provider shows its frame (CuaProvider.batchScreenshots).
  const sendsScreenshot = (index: number): boolean =>
    session.provider.batchScreenshots === "frame" && index < actions.length - 1;
  let waits = 0;
  for (const [index, requested] of actions.entries()) {
    if (session.signal?.aborted) throw new CuaAbortError();
    if (watched?.sessionEnded === true && requested.kind !== "wait") {
      execution.actions.push({ index, status: "not_dispatched" });
      continue;
    }
    const waitIndex = requested.kind === "wait" ? waits++ : undefined;
    const watchedMs = waitIndex === undefined ? undefined : watched?.ms[waitIndex];
    const wait =
      requested.kind === "wait" && watchedMs === undefined
        ? planWait(session.waits, requested.ms, idleTurn)
        : undefined;
    const action: CuaAction =
      watchedMs !== undefined
        ? { kind: "wait", ms: watchedMs }
        : wait === undefined
          ? requested
          : { kind: "wait", ms: wait.ms };
    const title = describeCuaAction(action);
    if (wait?.shortenedFromMs !== undefined)
      notes.push(recordShortenedWait(session, title, wait.shortenedFromMs));
    actionHistory.lastActionTitle = title;
    actionHistory.recentActionTitles.push(title);
    if (actionHistory.recentActionTitles.length > RECENT_ACTION_TITLES)
      actionHistory.recentActionTitles.shift();
    trace.bump("actions");
    // Classify before execute, mirroring counts.actions: the record is of what the actor
    // chose, so an action that then fails to actuate is still a record of the route
    // it reached for.
    actionHistory.affordances.push(classifyCuaAction(action));
    session.phase = `executing ${title}`;
    let status: ExecutionStatus;
    let result: CuaActionResult | undefined;
    try {
      ({ status, result } =
        watchedMs === undefined && !(action.kind === "screenshot" && !sendsScreenshot(index))
          ? await dispatchAction(session, action, title, wait?.steps)
          : { status: "completed", result: undefined });
    } catch (error) {
      const failedCommand = isCommandExitError(error) || isFailedTyping(error);
      const declared = isComputerUseExecutorError(error)
        ? error.disposition
        : failedCommand
          ? "skipped"
          : undefined;
      if (declared !== undefined) execution.actions.push({ index, status: declared });
      countAttempt(session, action, title, declared);
      if (
        isComputerUseExecutorError(error) &&
        error.code === "action_rejected" &&
        error.disposition === "not_dispatched"
      ) {
        // Later actions may depend on this one (type, then submit). Return
        // their full acknowledgement list and let a fresh observation decide.
        leaveUndispatched(execution, index + 1, actions.length);
        const { reason } = error;
        trace.record("notice", () =>
          notice(
            "warn",
            "action rejected before dispatch",
            session.redactNarration(
              `action: ${title}; code: action_rejected; disposition: not_dispatched;${reason === undefined ? "" : ` reason: ${reason};`} remaining batch actions not dispatched: ${actions.length - index - 1}`,
            ),
          ),
        );
        notes.push(
          rejectedActionHint(title, reason === undefined ? undefined : REJECTION_REMEDIES[reason]),
        );
        return done();
      }
      if (isComputerUseExecutorError(error) || !failedCommand) throw error;
      // A skipped action changes nothing on screen (a failed type at most leaves part of its
      // text), so a run that repeats a failing action makes no progress and ends through the
      // no-progress backstop (gave_up), also when the participant is held to its scheduled end
      // (backstop.ts consecutiveUnsent).
      recordCommandFailure(session, title, error);
      if (isFailedTyping(error)) notes.push(FAILED_TYPING_HINT);
      if (halting) return haltAfter(index, title);
      continue;
    }
    execution.actions.push({ index, status, ...(result === undefined ? {} : { result }) });
    countAttempt(session, action, title, status);
    const coord = pressedAt(action);
    const read = await readEvidence(session, action, result);
    trace.record("ui_action", () => ({
      lifecycle: "completed",
      title,
      ...read,
      ...(action.kind === "speak" ? { text: session.redactNarration(action.text) } : {}),
      // Structured pin coordinates, exactly the presses the Observer
      // pins render: recorded fact instead of a title re-parse downstream.
      ...(coord === undefined ? {} : { coord }),
      ...(watched !== undefined && waitIndex === watched.endedOn ? { watch: watched.watch } : {}),
      ...(requested.kind === "wait" && requested.ms !== undefined ? { namedMs: requested.ms } : {}),
    }));
    if (status === "skipped" && halting) return haltAfter(index, title);
  }
  if (rejectedProposal !== undefined) {
    const index = actions.length;
    const title = `action ${index + 1} of the batch`;
    execution.actions.push({ index, status: "not_dispatched" });
    trace.record("notice", () =>
      notice(
        "warn",
        "action rejected before dispatch",
        session.redactNarration(
          `action: ${title}; rejected by the participant's provider; reason: ${rejectedProposal.reason}`,
        ),
      ),
    );
    notes.push(rejectedActionHint(title, rejectedProposal.reason));
  }
  return done();
}

/** Acknowledge every action of the batch from position `from` on as not dispatched. */
function leaveUndispatched(
  execution: ActionBatch["execution"],
  from: number,
  length: number,
): void {
  for (let index = from; index < length; index++)
    execution.actions.push({ index, status: "not_dispatched" });
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

/** How one dispatched action ended, with what it read. */
interface Dispatched {
  readonly status: "completed" | "skipped";
  readonly result: CuaActionResult | undefined;
}

/**
 * Execute one action. Idle actions only look: a `wait` that hangs inside the SDK has
 * in effect waited, so a stalled one is skipped with a notice, its remaining steps are not sent,
 * and it loses nothing the participant chose. An action is recorded as completed only after every
 * desktop call it takes resolves. A wait is sent as `waitSteps`, its planWait steps.
 */
async function dispatchAction(
  session: LoopSession,
  action: CuaAction,
  title: string,
  waitSteps: readonly number[] | undefined,
): Promise<Dispatched> {
  if (!isIdleAction(action))
    return { status: "completed", result: await executeAction(session, action, title) };
  const calls: CuaAction[] = waitSteps?.map((ms) => ({ kind: "wait", ms })) ?? [action];
  try {
    let result: CuaActionResult | undefined;
    for (const call of calls) {
      if (session.signal?.aborted) throw new CuaAbortError();
      const boundMs = session.observationTimeoutMs + (call.kind === "wait" ? (call.ms ?? 0) : 0);
      result = await executeAction(session, call, title, boundMs);
    }
    return { status: "completed", result };
  } catch (error) {
    if (!(error instanceof CuaStallError)) throw error;
    session.trace.record("notice", () =>
      notice(
        "warn",
        "observation action stalled; skipped",
        `${error.what} produced nothing within ${error.afterMs}ms; the desktop was not asked again and the next screenshot decides`,
      ),
    );
    return { status: "skipped", result: undefined };
  }
}

/**
 * What a read action returned, when it is the result that action reads. Anything else an executor
 * returns, such as a value an executor written before results passes along, is dropped.
 */
function readResult(action: CuaAction, returned: unknown): CuaActionResult | undefined {
  if (typeof returned !== "object" || returned === null) return undefined;
  const value = returned as Partial<Record<"kind" | "x" | "y" | "screenshot", unknown>>;
  if (action.kind === "read_pointer" && value.kind === "pointer")
    return Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y)
      ? { kind: "pointer", x: value.x as number, y: value.y as number }
      : undefined;
  if (
    (action.kind === "zoom" || action.kind === "screenshot") &&
    value.kind === "frame" &&
    Buffer.isBuffer(value.screenshot)
  )
    return { kind: "frame", screenshot: value.screenshot };
  return undefined;
}

/** Execute one action and return what it read (readResult). */
async function executeAction(
  session: LoopSession,
  action: CuaAction,
  title: string,
  boundMs?: number,
): Promise<CuaActionResult | undefined> {
  const { signal } = session;
  const scope = requestScope(signal);
  try {
    const pending = session.executor.execute(action, scope.signal);
    const returned =
      boundMs === undefined
        ? await raceSessionDeadline(pending, session.remaining(), signal)
        : await raceCallBound(
            `idle action ${title}`,
            pending,
            session.remaining(),
            boundMs,
            signal,
          );
    return readResult(action, returned);
  } catch (error) {
    if (error instanceof CuaStallError && session.executor.stallRecovery === "fail_closed") {
      throw new ComputerUseExecutorError("deadline_exceeded", "outcome_uncertain");
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
