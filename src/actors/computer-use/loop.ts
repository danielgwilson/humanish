import { CuaProviderError } from "./provider-error.js";
import { runActionBatch } from "./loop/actions.js";
import { advanceBackstop, startBackstop, type BackstopStep } from "./loop/backstop.js";
import { requestDebrief } from "./loop/debrief.js";
import * as stops from "./loop/ending.js";
import { declaredOutcomeOf, type Stop } from "./loop/ending.js";
import { DesktopObserver } from "./loop/observation.js";
import { retryAfterOutputLimit } from "./loop/output-limit.js";
import { requestTurn } from "./loop/provider-call.js";
import { LoopSession } from "./loop/session.js";
import { spendStop, unknownSpendStop } from "./loop/spend.js";
import { accountBillingConflicts } from "./loop/usage.js";
import { loopResult, notice } from "./loop/trace.js";
import type {
  CuaLoopOptions,
  CuaLoopResult,
  CuaObservation,
  CuaSafetyCheck,
  CuaTurn,
  CuaTurnRequest,
} from "./loop/types.js";

export type {
  CuaAction,
  CuaExecutor,
  CuaLiveMetadata,
  CuaLoopOptions,
  CuaLoopResult,
  CuaObservation,
  CuaProvider,
  CuaSafetyCheck,
  CuaSpendGate,
  CuaTurn,
  CuaTurnRequest,
} from "./loop/types.js";
export { describeCuaAction } from "./loop/actions.js";
export { stableProgressKey } from "./loop/backstop.js";
export { validClosingReport } from "./loop/debrief.js";

// The computer-use (CUA) loop: drive a model over a desktop turn by turn, observe the screen, act,
// and stop at a natural endpoint or an unambiguous friction signal. The model sits behind the
// CuaProvider port and the desktop behind the CuaExecutor port, so the loop runs against fakes with
// no key and no spend.
//
// Stopping follows the abandonment decision in docs/architecture/actor-contract.md. The
// participant decides when it is done, and returning no further action ends the session. A harness
// backstop force-ends only an idle streak (turns with no material action) or a no-progress streak
// (turns that repeat a recent action on an unchanged screen). There is no turn cap. The hard stops
// are the wall-clock timeoutMs and any declared spend, adapter or token limit (loop/ending.ts).
// Every provider and desktop call is raced against the deadline (loop/race.ts), and the abort
// signal is checked before each action, so a hung port cannot stall the loop and a cancel cannot
// actuate the desktop.
//
// Layout: this file is the driver. src/actors/computer-use/loop/ holds the parts: the port types,
// the session state, provider calls, observation, action dispatch, the backstop fold, the Stop
// value every ending produces, the debrief request and the trace projection.

/** What the next provider request carries forward from the turns before it. */
interface Conversation {
  previousResponseId: string | undefined;
  previousExecution: CuaTurnRequest["previousExecution"];
  // Acks granted for the previous turn's safety checks. They must ride the
  // NEXT request (the one carrying that call's computer_call_output), so they
  // are staged here rather than written onto the request already sent.
  acknowledgedSafetyChecks: CuaSafetyCheck[] | undefined;
  contextHint: string | undefined;
}

/**
 * Drive the loop to one explicit completion and return its CuaLoopResult: status, completion
 * reason, public reason and ActorTrace. Model-authored text passes through redactNarration before
 * it is recorded; screenshots are persisted raw unless redactScreenshots is set.
 */
export async function runComputerUseLoop(options: CuaLoopOptions): Promise<CuaLoopResult> {
  refuseAccountBilledCaps(options);
  const session = new LoopSession(options);
  const conversation: Conversation = {
    previousResponseId: undefined,
    previousExecution: undefined,
    acknowledgedSafetyChecks: undefined,
    contextHint: undefined,
  };
  let stop: Stop;
  try {
    stop = session.conclude(await runTurns(session, conversation));
  } catch (error) {
    stop = session.conclude(stops.stopForError(session, error));
  }
  // A structured stop earns the debrief even if recording its evidence then failed.
  const debrief =
    session.debriefTrigger === undefined
      ? undefined
      : await requestDebrief(session, conversation, session.debriefTrigger);
  return loopResult(session, stop, debrief);
}

/**
 * Observe, then turn after turn: ask the provider, vet the reply, act, observe again and fold
 * the result into the backstop. Every exit returns the Stop that ends the session; errors thrown
 * from a port end it through stopForError. Bounded by wall-clock and the friction backstops,
 * never a turn count.
 */
async function runTurns(session: LoopSession, conversation: Conversation): Promise<Stop> {
  const observer = new DesktopObserver(session);
  const opening = await observer.checkpoint(0);
  if ("stop" in opening) return opening.stop;
  let { observation } = opening;
  if (opening.hint !== undefined) conversation.contextHint = opening.hint;
  let backstop = startBackstop(observation);
  let turnNumber = 0;
  // A request whose reply was cut off by the output limit, to be sent once more.
  let resend: CuaTurnRequest | undefined;
  for (;;) {
    const halt = haltBeforeTurn(session);
    if (halt !== undefined) return halt;

    turnNumber += 1;
    const retrying = resend !== undefined;
    const request = resend ?? nextRequest(session, conversation, observation);
    resend = undefined;
    session.phase = `requesting provider turn ${turnNumber}`;
    const reply = await requestTurn(session, request, turnNumber);
    if ("stop" in reply) return reply.stop;
    const { turn } = reply;
    const cutOff = retryAfterOutputLimit(session, turn, turnNumber, retrying);
    if (cutOff === "retry") {
      recordNarration(session, turn, turnNumber, "interrupted");
      resend = request;
      continue;
    }
    if (cutOff !== undefined) return cutOff;
    recordTurn(session, conversation, observer, request, turn);

    const refused = stopBeforeActing(session, turn, turnNumber);
    if (refused !== undefined) return refused;
    forwardNarration(session, turn);
    const overBudget = spendStop(session);
    if (overBudget !== undefined) return overBudget;
    recordNarration(session, turn, turnNumber, "completed");
    const blocked = reviewSafetyChecks(session, conversation, turn);
    if (blocked !== undefined) return blocked;
    if (turn.done || turn.actions.length === 0) {
      // The declared outcome is kept even if redacting the participant's summary fails.
      session.declaredOutcome = declaredOutcomeOf(turn);
      const ended = stops.participantEnded(turn, session.declaredOutcome, (text) =>
        session.redactNarration(text),
      );
      await observer.observeFinalTasks(turnNumber);
      return ended;
    }

    const batch = await runActionBatch(session, turn.actions);
    conversation.previousExecution = batch.execution;
    const checkpoint = await observer.checkpoint(turnNumber);
    if ("stop" in checkpoint) return checkpoint.stop;
    observation = checkpoint.observation;

    const step = advanceBackstop(
      backstop,
      { actions: turn.actions, observation, heardNewSpeech: observer.heardNewSpeech },
      { idleSteps: session.idleSteps, noProgressSteps: session.noProgressSteps },
    );
    backstop = step.backstop;
    const stalled = applyBackstop(session, conversation, step, [checkpoint.hint, batch.hint]);
    if (stalled !== undefined) return stalled;
    const unknownSpend = unknownSpendStop(session);
    if (unknownSpend !== undefined) return unknownSpend;
  }
}

/**
 * Count the turn's idle and no-progress flags, stage every hint for the next request, and stop
 * when a streak tripped. The
 * turn's own hints (a dwell window, a rejected action) come first, then the backstop's nudges.
 */
function applyBackstop(
  session: LoopSession,
  conversation: Conversation,
  step: BackstopStep,
  turnHints: ReadonlyArray<string | undefined>,
): Stop | undefined {
  if (step.idle) session.trace.bump("idleTurns");
  if (!step.progressed) session.trace.bump("noProgressTurns");
  const hints = [...turnHints.filter((hint): hint is string => hint !== undefined), ...step.hints];
  if (hints.length > 0) conversation.contextHint = hints.join(" ");
  return step.tripReason === undefined ? undefined : stops.gaveUp(session, step.tripReason);
}

function refuseAccountBilledCaps(options: CuaLoopOptions): void {
  if (accountBillingConflicts(options.provider, options)) {
    throw new CuaProviderError("request_rejected", {
      dispatched: false,
      usageComplete: false,
      cleanup: "confirmed",
    });
  }
}

function haltBeforeTurn(session: LoopSession): Stop | undefined {
  if (session.signal?.aborted) return stops.harnessAborted;
  if (session.remaining() < 0) return stops.timeLimit(session);
  return undefined;
}

/** Build the next request; the context hint and safety acknowledgements ride it once. */
function nextRequest(
  session: LoopSession,
  conversation: Conversation,
  observation: CuaObservation,
): CuaTurnRequest {
  const request: CuaTurnRequest = {
    instructions: session.settings.instructions,
    observation,
    ...(session.provider.requestPolicy !== "fail_closed" ||
    conversation.previousExecution === undefined
      ? {}
      : { previousExecution: conversation.previousExecution }),
  };
  if (conversation.previousResponseId !== undefined)
    request.previousResponseId = conversation.previousResponseId;
  if (conversation.contextHint !== undefined) request.contextHint = conversation.contextHint;
  if (conversation.acknowledgedSafetyChecks !== undefined)
    request.acknowledgedSafetyChecks = conversation.acknowledgedSafetyChecks;
  conversation.contextHint = undefined;
  conversation.acknowledgedSafetyChecks = undefined;
  return request;
}

function recordTurn(
  session: LoopSession,
  conversation: Conversation,
  observer: DesktopObserver,
  request: CuaTurnRequest,
  turn: CuaTurn,
): void {
  const hint = request.contextHint;
  if (hint)
    session.trace.record("notice", () => ({
      title: "Participant context hint",
      text: session.redactNarration(hint),
      lifecycle: "completed",
    }));
  session.trace.bump("turns");
  observer.speechDelivered();
  conversation.previousResponseId = turn.responseId ?? conversation.previousResponseId;
  session.lastResponseId = turn.responseId ?? session.lastResponseId;
  session.usage.record(turn, "interaction");
}

/** Stops for a reply that must not be acted on: account billing, interruption, unknown usage. */
function stopBeforeActing(
  session: LoopSession,
  turn: CuaTurn,
  turnNumber: number,
): Stop | undefined {
  const { overRunBudget } = session.settings;
  if (accountBillingConflicts(session.provider, session.settings)) return stops.accountBilledCaps;
  if (turn.interruption !== undefined) {
    // Preserve usage and partial narration of an interrupted response. Its usage still counts
    // toward the study budget; when that exhausts it, sibling lanes stop, so this trace says why.
    const runBudgetStop = overRunBudget?.(session.usage.forCap());
    recordNarration(session, turn, turnNumber, "interrupted");
    if (runBudgetStop != null) {
      session.trace.record("notice", () =>
        notice("warn", "study budget reached during an interrupted response", runBudgetStop),
      );
    }
    return stops.providerInterrupted(turn.interruption);
  }
  if (session.requiresUsage && session.usage.unavailableForCap()) {
    session.usage.markUnreported();
    return stops.usageUnreported;
  }
  return undefined;
}

/** Hand the turn's narration to the onMessage hook; see CuaLoopOptions.onMessage. */
function forwardNarration(session: LoopSession, turn: CuaTurn): void {
  const { onMessage } = session.settings;
  const narration = [turn.reasoning, turn.message]
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
  if (narration.length > 0) onMessage?.(narration);
}

function recordNarration(
  session: LoopSession,
  turn: CuaTurn,
  turnNumber: number,
  response: "completed" | "interrupted",
): void {
  const interrupted = response === "interrupted";
  const prefix = interrupted ? "incomplete " : "";
  const status = interrupted ? { status: "warn" } : {};
  const { reasoning, message } = turn;
  if (reasoning) {
    session.trace.record("reasoning", () => ({
      lifecycle: "completed",
      ...status,
      title: `${prefix}reasoning turn ${turnNumber}`,
      text: session.redactNarration(reasoning),
    }));
    session.trace.bump("reasonings");
  }
  if (message) {
    session.trace.record("message", () => ({
      lifecycle: "completed",
      ...status,
      title: `${prefix}message turn ${turnNumber}`,
      text: session.redactNarration(message),
    }));
    session.trace.bump("messages");
  }
}

/** Unacknowledged safety checks pause the run; acknowledged ones ride the next request. */
function reviewSafetyChecks(
  session: LoopSession,
  conversation: Conversation,
  turn: CuaTurn,
): Stop | undefined {
  if (turn.pendingSafetyChecks.length === 0) return undefined;
  const { acknowledgeSafetyChecks } = session;
  const acks = acknowledgeSafetyChecks(turn.pendingSafetyChecks);
  if (acks === null || acks.length === 0) {
    return stops.blockedOnSafetyChecks(
      session.settings.redaction.redactText(
        turn.pendingSafetyChecks.map((check) => check.code).join(", "),
      ),
    );
  }
  conversation.acknowledgedSafetyChecks = acks;
  return undefined;
}
