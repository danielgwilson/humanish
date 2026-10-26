import { closingReportSchema } from "../closing-report.js";
import { ComputerUseProviderError } from "./provider-error.js";
import { runActionBatch } from "./loop/actions.js";
import {
  advanceBackstop,
  repeatsPastLimit,
  startBackstop,
  type Backstop,
  type BackstopStep,
} from "./loop/backstop.js";
import { clockEndStop, clockHint, heldToScheduledEnd } from "./loop/clock.js";
import { requestDebrief } from "./loop/debrief.js";
import * as stops from "./loop/ending.js";
import { declaredOutcomeOf, type Stop } from "./loop/ending.js";
import { notCollected, recordImpressions } from "./loop/impressions.js";
import { DesktopObserver } from "./loop/observation.js";
import { retryAfterOutputLimit } from "./loop/output-limit.js";
import { requestTurn } from "./loop/provider-call.js";
import { LoopSession } from "./loop/session.js";
import { spendStop, unknownSpendStop } from "./loop/spend.js";
import { accountBillingConflicts } from "./loop/usage.js";
import { loopResult, notice } from "./loop/trace.js";
import { IdleWatcher } from "./loop/watch.js";
import type {
  CuaLoopOptions,
  CuaLoopResult,
  LoopRunOptions,
  LoopTaps,
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
  ParticipantClock,
} from "./loop/types.js";
export { describeCuaAction } from "./loop/actions.js";
export { stableProgressKey } from "./loop/backstop.js";
export { IMPRESSIONS_ASK } from "./loop/impressions.js";

// The computer-use (CUA) loop: drive a model over a desktop turn by turn, observe the screen, act,
// and stop at a natural endpoint or an unambiguous friction signal. The model sits behind the
// CuaProvider port and the desktop behind the CuaExecutor port, so the loop runs against fakes with
// no key and no spend.
//
// Stopping follows the abandonment decision in docs/architecture/actor-contract.md. The
// participant decides when it is done, and returning no further action ends the session. A harness
// backstop force-ends only an idle streak (turns with no material action) or a no-progress streak
// (turns that repeat a recent action on an unchanged screen); the no-progress streak does not end
// a participant held to its scheduled end (loop/backstop.ts). There is no turn cap. The hard stops
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
  // next request (the one carrying that call's computer_call_output), so they
  // are staged here rather than written onto the request already sent.
  acknowledgedSafetyChecks: CuaSafetyCheck[] | undefined;
  contextHint: string | undefined;
  /** The participant tried to end its session before its scheduled end; the next request says so. */
  askedToEnd: boolean;
}

/**
 * Drive the loop to one explicit completion and return its CuaLoopResult: status, completion
 * reason, public reason and ActorTrace. Model-authored text passes through redactNarration before
 * it is recorded; screenshots are persisted raw unless redactScreenshots is set.
 */
export async function runComputerUseLoop(options: CuaLoopOptions): Promise<CuaLoopResult> {
  refuseRemovedOptions(options);
  return runComputerUseLoopWithTaps(options);
}

/** What 0.109.0 removed from CuaLoopOptions, and what a caller does instead. */
const REMOVED_OPTIONS: Readonly<Record<keyof LoopTaps, string>> = {
  onObservedUrl: "Wrap the executor's `observe` and read `url` from each observation it returns.",
  onMessage:
    "Wrap the provider's `nextTurn` and read `reasoning` and `message` from each turn it returns.",
  onScreenshot:
    "Wrap the executor's `observe` and read `screenshot` from each observation it returns.",
};

/** A JavaScript caller still passing a removed option gets an error, not a hook that never fires. */
function refuseRemovedOptions(options: CuaLoopOptions): void {
  for (const [name, replacement] of Object.entries(REMOVED_OPTIONS)) {
    if ((options as unknown as Record<string, unknown>)[name] !== undefined) {
      throw new TypeError(`runComputerUseLoop: ${name} was removed in 0.109.0. ${replacement}`);
    }
  }
}

/**
 * runComputerUseLoop with the external-public handoff's taps (LoopTaps), which the public
 * options no longer carry. The actor's entry.
 */
export async function runComputerUseLoopWithTaps(options: LoopRunOptions): Promise<CuaLoopResult> {
  refuseAccountBilledCaps(options);
  const session = new LoopSession(options);
  const conversation: Conversation = {
    previousResponseId: undefined,
    previousExecution: undefined,
    acknowledgedSafetyChecks: undefined,
    contextHint: undefined,
    askedToEnd: false,
  };
  let stop: Stop;
  try {
    stop = session.conclude(await runTurns(session, conversation));
  } catch (error) {
    stop = session.conclude(stops.stopForError(session, error));
  }
  session.streak.close();
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
  const watcher = new IdleWatcher(session, observer);
  const opening = await observer.checkpoint(0);
  if ("stop" in opening) return opening.stop;
  let { observation } = opening;
  if (opening.hint !== undefined) conversation.contextHint = opening.hint;
  let backstop = startBackstop(observation);
  let turnNumber = 0;
  // A request whose reply was cut off by the output limit, to be sent once more.
  let resend: CuaTurnRequest | undefined;
  for (;;) {
    const halt = haltBeforeTurn(session, observation);
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
    if (stops.endsSession(turn) && heldToScheduledEnd(session)) {
      const held = keepWorking(session, conversation, backstop, observation);
      if ("stop" in held) return held.stop;
      backstop = held.backstop;
      continue;
    }
    if (stops.endsSession(turn)) {
      const report = closingReportSchema.safeParse(turn.closingReport).data;
      // The declared outcome is kept even if redacting the participant's summary fails.
      session.declaredOutcome = declaredOutcomeOf(turn, report, turn.message);
      const ended = stops.participantEnded(turn, session.declaredOutcome, (text) =>
        session.redactNarration(text),
      );
      // A provider that can ask for impressions alone does so after the session, like a debrief.
      if (report?.impressions !== undefined || session.provider.requestImpressions === undefined) {
        session.impressions =
          report === undefined
            ? notCollected("the participant ended the session without a structured closing account")
            : recordImpressions(session, report.impressions);
      }
      await observer.observeFinalTasks(turnNumber);
      return session.impressions === undefined
        ? { ...ended, debriefTrigger: { kind: "participant_end", observation } }
        : ended;
    }

    const limits = { idleSteps: session.idleSteps, noProgressSteps: session.noProgressSteps };
    const repeat = repeatsPastLimit(backstop, turn.actions, limits) && heldToScheduledEnd(session);
    const waited = repeat ? undefined : await watcher.watch(turnNumber, observation, turn.actions);
    const batch = await runActionBatch(session, turn, waited?.waits);
    const watched = repeat
      ? await watcher.watchAfterRepeat(turnNumber, observation, batch.sent)
      : waited;
    conversation.previousExecution = batch.execution;
    // An earlier reply's unknown usage still stops the session before its closing request.
    if (watched?.stop !== undefined) {
      // The repeat was sent before its watch ended the session, so its streak counts it.
      if (repeat) session.streak.fold(backstop.consecutiveNoProgress + 1);
      return unknownSpendStop(session) ?? watched.stop;
    }
    const checkpoint = await observer.checkpoint(turnNumber, watched?.observation);
    if ("stop" in checkpoint) return checkpoint.stop;
    observation = checkpoint.observation;

    const step = advanceBackstop(
      backstop,
      {
        actions: turn.actions,
        observation,
        heardNewSpeech: observer.heardNewSpeech,
        sent: batch.sent,
        waitingIsTheTask: heldToScheduledEnd(session),
        screenChanged:
          watched?.wake === "changed" ||
          watched?.wake === "speech" ||
          watched?.wake === "condition",
      },
      limits,
    );
    backstop = step.backstop;
    const stalled = applyBackstop(session, conversation, step, [
      watched?.hint,
      checkpoint.hint,
      batch.hint,
    ]);
    // A turn that reached the participant's end is that end, never the backstop's.
    if (stalled !== undefined) return clockEndStop(session, observation) ?? stalled;
    const unknownSpend = unknownSpendStop(session);
    if (unknownSpend !== undefined) return unknownSpend;
  }
}

/**
 * A participant with a scheduled end that ended its own session before the end keeps going: the
 * next request tells it the time left. The turn took no action, so it counts toward the idle
 * backstop, which ends a participant that only keeps trying to stop.
 */
function keepWorking(
  session: LoopSession,
  conversation: Conversation,
  backstop: Backstop,
  observation: CuaObservation,
): { backstop: Backstop } | { stop: Stop } {
  session.trace.record("notice", () =>
    notice(
      "warn",
      "participant ended before its scheduled end",
      "The participant ended its session before its scheduled end, so the session continues and the participant is told the time left.",
    ),
  );
  conversation.askedToEnd = true;
  // The turn executed nothing, so the next request acknowledges nothing.
  conversation.previousExecution = undefined;
  const step = advanceBackstop(
    backstop,
    { actions: [], observation, heardNewSpeech: false, sent: false },
    { idleSteps: session.idleSteps, noProgressSteps: session.noProgressSteps },
  );
  const stalled = applyBackstop(session, conversation, step, []);
  return stalled === undefined ? { backstop: step.backstop } : { stop: stalled };
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
  session.streak.fold(step.backstop.consecutiveNoProgress);
  const hints = [...turnHints.filter((hint): hint is string => hint !== undefined), ...step.hints];
  if (hints.length > 0) conversation.contextHint = hints.join(" ");
  return step.tripReason === undefined ? undefined : stops.gaveUp(session, step.tripReason);
}

function refuseAccountBilledCaps(options: CuaLoopOptions): void {
  if (accountBillingConflicts(options.provider, options)) {
    throw new ComputerUseProviderError("request_rejected", {
      dispatched: false,
      usageComplete: false,
      cleanup: "confirmed",
    });
  }
}

/**
 * The stops checked before every provider request. The spend caps are checked here as well as
 * after each reply, because a sibling participant can exhaust the study budget while this one acts.
 */
function haltBeforeTurn(session: LoopSession, observation: CuaObservation): Stop | undefined {
  if (session.signal?.aborted) return stops.harnessAborted;
  return (
    clockEndStop(session, observation) ??
    (session.remaining() < 0 ? stops.timeLimit(session) : undefined) ??
    spendStop(session)
  );
}

/**
 * Build the next request; the context hint and safety acknowledgements ride it once. The
 * participant's clock text rides every request, after any other hint.
 */
function nextRequest(
  session: LoopSession,
  conversation: Conversation,
  observation: CuaObservation,
): CuaTurnRequest {
  const clock = clockHint(session.settings.clock, session.now, conversation.askedToEnd);
  conversation.askedToEnd = false;
  if (clock !== undefined)
    conversation.contextHint =
      conversation.contextHint === undefined ? clock : `${conversation.contextHint} ${clock}`;
  const request: CuaTurnRequest = {
    instructions: session.settings.instructions,
    observation,
    ...(conversation.previousExecution === undefined
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
    // toward the study budget; when that exhausts it, sibling participants stop, so this trace says why.
    const runBudgetStop = overRunBudget?.(session.usage.forCap());
    recordNarration(session, turn, turnNumber, "interrupted");
    if (runBudgetStop != null) {
      session.trace.record("notice", () =>
        notice("warn", "study budget reached during an interrupted response", runBudgetStop),
      );
    }
    return turn.interruption === "refused"
      ? stops.providerRefused(turn.refusalCategory, (text) => session.redactNarration(text))
      : stops.providerInterrupted(turn.interruption);
  }
  if (session.requiresUsage && session.usage.unavailableForCap()) {
    session.usage.markUnreported();
    return stops.usageUnreported;
  }
  return undefined;
}

/** Hand the turn's narration to the onMessage tap; see LoopTaps.onMessage. */
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
      turn.pendingSafetyChecks.length,
    );
  }
  conversation.acknowledgedSafetyChecks = acks;
  return undefined;
}
