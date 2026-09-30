import { CuaProviderError } from "./provider-error.js";
import { runActionBatch } from "./loop/actions.js";
import { advanceBackstop, startBackstop, type BackstopStep } from "./loop/backstop.js";
import { requestClosingAccount } from "./loop/closing.js";
import {
  accountBilledCaps,
  blockedOnSafetyChecks,
  declaredOutcomeOf,
  gaveUp,
  harnessAborted,
  nonFiniteEstimate,
  participantEnded,
  providerInterrupted,
  spendLimit,
  stopForError,
  studySpendLimit,
  timeLimit,
  usageUnreported,
  type Stop,
} from "./loop/ending.js";
import { DesktopObserver } from "./loop/observation.js";
import { requestTurn } from "./loop/provider-call.js";
import { LoopSession } from "./loop/session.js";
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
  CuaTurn,
  CuaTurnRequest,
} from "./loop/types.js";
export { actionFingerprint, describeCuaAction } from "./loop/actions.js";
export { stableProgressKey } from "./loop/backstop.js";
export { validClosingReport } from "./loop/closing.js";
export { declaredOutcomeFromClosingLine } from "./loop/ending.js";
export { statusForCompletionReason } from "./loop/trace.js";

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
//
// Layout: this file is the driver. src/actors/computer-use/loop/ holds the parts: the port types,
// the session state, provider calls, observation, action dispatch, the backstop fold, the Stop
// value every ending produces, the closing request and the trace projection.

/** What the next provider request carries forward from the turns before it. */
interface Conversation {
  previousResponseId: string | undefined;
  previousExecution: CuaTurnRequest["previousExecution"];
  // Acks granted for the previous turn's safety checks. They must ride the
  // NEXT request (the one carrying that call's computer_call_output), so they
  // are staged here rather than written onto the request already sent.
  pendingAcks: CuaSafetyCheck[] | undefined;
  contextHint: string | undefined;
}

/**
 * Drive the computer-use loop to a single explicit completion and return an
 * ActorTrace. Every screenshot is redacted through the injected RedactionHooks
 * before its ref is recorded, so the trace is public-safe by construction.
 */
export async function runComputerUseLoop(options: CuaLoopOptions): Promise<CuaLoopResult> {
  refuseAccountBilledCaps(options);
  const session = new LoopSession(options);
  const conversation: Conversation = {
    previousResponseId: undefined,
    previousExecution: undefined,
    pendingAcks: undefined,
    contextHint: undefined,
  };
  let stop: Stop;
  try {
    stop = session.conclude(await runTurns(session, conversation));
  } catch (error) {
    stop = session.conclude(stopForError(error, session));
  }
  // A structured stop earns the closing request even if recording its evidence then failed.
  const debrief =
    session.closing === undefined
      ? undefined
      : await requestClosingAccount(
          session,
          {
            previousResponseId: conversation.previousResponseId,
            previousExecution: conversation.previousExecution,
            acknowledgedSafetyChecks: conversation.pendingAcks,
          },
          session.closing,
        );
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
  for (;;) {
    const halt = haltBeforeTurn(session);
    if (halt !== undefined) return halt;

    const turnNumber = session.trace.counts.turns + 1;
    const request = nextRequest(session, conversation, observation);
    session.phase = `requesting provider turn ${turnNumber}`;
    const reply = await requestTurn(session, request, turnNumber);
    if ("stop" in reply) return reply.stop;
    const { turn } = reply;
    acceptTurn(session, conversation, observer, request, turn);

    const refused = refuseTurn(session, turn, turnNumber);
    if (refused !== undefined) return refused;
    shareNarration(session, turn);
    const overBudget = spendStop(session);
    if (overBudget !== undefined) return overBudget;
    recordNarration(session, turn, turnNumber, false);
    const blocked = reviewSafetyChecks(session, conversation, turn);
    if (blocked !== undefined) return blocked;
    if (turn.done || turn.actions.length === 0) {
      // The declared outcome is kept even if redacting the participant's summary fails.
      session.declaredOutcome = declaredOutcomeOf(turn);
      const ended = participantEnded(turn, session.declaredOutcome, (text) =>
        session.redactNarration(text),
      );
      await observer.observeClosingTasks(turnNumber);
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
      session,
    );
    backstop = step.backstop;
    const stalled = applyBackstop(session, conversation, step, [
      checkpoint.hint,
      batch.rejectedActionTitle === undefined
        ? undefined
        : `Your action (${batch.rejectedActionTitle}) was rejected before dispatch. No input from that action or the rest of its batch was sent. Choose your next action from the fresh screenshot; do not assume the rejected action succeeded.`,
    ]);
    if (stalled !== undefined) return stalled;
  }
}

/**
 * Count the turn, stage every hint for the next request, and stop when a streak tripped. The
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
  return step.gaveUp === undefined ? undefined : gaveUp(session, step.gaveUp);
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
  if (session.signal?.aborted) return harnessAborted;
  if (session.now() - session.startedAtMs > session.timeoutMs) return timeLimit(session);
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
  if (conversation.pendingAcks !== undefined)
    request.acknowledgedSafetyChecks = conversation.pendingAcks;
  conversation.contextHint = undefined;
  conversation.pendingAcks = undefined;
  return request;
}

function acceptTurn(
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
  session.usage.record(turn);
}

/** Stops for a reply that must not be acted on: account billing, interruption, unknown usage. */
function refuseTurn(session: LoopSession, turn: CuaTurn, turnNumber: number): Stop | undefined {
  const { overRunBudget } = session.settings;
  if (accountBillingConflicts(session.provider, session.settings)) return accountBilledCaps;
  if (turn.interruption !== undefined) {
    // Preserve usage and partial narration of an interrupted response. Its usage still counts
    // toward the study budget; when that exhausts it, sibling lanes stop, so this trace says why.
    const studyStop = overRunBudget?.(session.usage.running());
    recordNarration(session, turn, turnNumber, true);
    if (studyStop != null) {
      session.trace.record("notice", () =>
        notice("warn", "study budget reached during an interrupted response", studyStop),
      );
    }
    return providerInterrupted(turn.interruption);
  }
  if (session.requiresUsage && session.usage.unavailableForCap()) {
    session.usage.markUnreported();
    return usageUnreported;
  }
  return undefined;
}

/**
 * RUNTIME-ONLY: hand the model's narration back so the concurrent host-first barrier can read the
 * lobby code the host states after creating the lobby (CDP url-read is unreliable). Raw text stays
 * in memory; only an extracted code is used (and only as a digest).
 */
function shareNarration(session: LoopSession, turn: CuaTurn): void {
  const { onMessage } = session.settings;
  const narration = [turn.reasoning, turn.message]
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
  if (narration.length > 0) onMessage?.(narration);
}

/**
 * FAIL-CLOSED spend cap (runaway-retry guard). Checked beside the wall-clock stop and BEFORE the
 * next provider request, so a model stuck retrying cannot keep spending: the moment the running
 * estimate crosses maxUsd the loop stops with a terminal, non-harness-error stop. A null estimate
 * cannot trip it (preflight guaranteed a rate). The study budget (#299) is checked next.
 */
function spendStop(session: LoopSession): Stop | undefined {
  const { maxUsd, overRunBudget, estimateTurnCostUsd } = session.settings;
  if (maxUsd !== undefined && estimateTurnCostUsd) {
    const running = estimateTurnCostUsd(session.usage.running());
    if (running !== null && !Number.isFinite(running)) return nonFiniteEstimate;
    if (running !== null && running > maxUsd) return spendLimit(session, running, maxUsd);
  }
  if (overRunBudget) {
    const runStop = overRunBudget(session.usage.running());
    if (runStop !== null) return studySpendLimit(runStop);
  }
  return undefined;
}

function recordNarration(
  session: LoopSession,
  turn: CuaTurn,
  turnNumber: number,
  interrupted: boolean,
): void {
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
    return blockedOnSafetyChecks(
      session.settings.redaction.redactText(
        turn.pendingSafetyChecks.map((check) => check.code).join(", "),
      ),
    );
  }
  conversation.pendingAcks = acks;
  return undefined;
}
