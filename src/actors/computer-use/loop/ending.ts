import type {
  ActorCompletionReason,
  ActorStopCause,
  ParticipantDeclaredOutcome,
} from "../../contract.js";
import type { StopConditionMatch } from "../../stop-conditions.js";
import { isCuaExecutorError } from "../executor-error.js";
import { isCuaPromptRefusedError, isCuaProviderError } from "../provider-error.js";
import { CuaAbortError, CuaDeadlineError } from "./race.js";
import type { LoopSession } from "./session.js";
import { notice, type Evidence } from "./trace.js";
import type { CuaObservation, CuaProvider, CuaTurn } from "./types.js";

// How a loop session ends. Every ending is one Stop value: the completion reason, its public
// reason text, the structured cause when there is one, the trace evidence to record, and whether
// the stop earns a read-only debrief request. LoopSession.conclude commits a stop where it is
// decided.

/** A harness-observed completion after which the participant is asked for a debrief. */
export interface DebriefTrigger {
  readonly kind: "stop_when" | "dwell";
  /** The final observation, already captured; the debrief request sends it without observing. */
  readonly observation: CuaObservation;
}

export interface Stop {
  readonly completionReason: ActorCompletionReason;
  readonly reason: string;
  readonly stopCause?: ActorStopCause;
  /** Trace evidence for this stop, recorded when the stop is concluded. */
  readonly evidence?: Evidence;
  readonly debriefTrigger?: DebriefTrigger;
}

/**
 * Read the fixed closing line the prompt asks for: the first non-empty line of the
 * participant's last message, exactly one of three phrases, punctuation and case forgiven. Anything
 * else is absence, never a guess. Exported for tests.
 */
export function declaredOutcomeFromClosingLine(
  message: string | undefined,
): ParticipantDeclaredOutcome | undefined {
  if (message === undefined) return undefined;
  const first = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) return undefined;
  const normalized = first.replace(/^[*_#>\s-]+|[*_.!\s]+$/g, "").toLowerCase();
  if (normalized === "reached the goal") return "reached";
  if (normalized === "did not reach the goal") return "not_reached";
  if (normalized === "blocked") return "blocked";
  return undefined;
}

/** The participant's own word for how it ended: a schema field first, then the closing line. */
export function declaredOutcomeOf(turn: CuaTurn): ParticipantDeclaredOutcome | undefined {
  return turn.outcome ?? declaredOutcomeFromClosingLine(turn.message);
}

/**
 * The participant reported a natural endpoint. "not_reached" is a participant who stopped without
 * finishing: gave_up, which tallies as abandoned. "blocked" keeps goal_satisfied here (the actor
 * did stop on purpose) and the route's credibility read turns it into a blocked participant, the
 * same path a narrated blocker takes.
 */
export function participantEnded(
  turn: CuaTurn,
  declaredOutcome: ParticipantDeclaredOutcome | undefined,
  redactNarration: (text: string) => string,
): Stop {
  const summary = turn.message?.trim();
  return {
    completionReason: declaredOutcome === "not_reached" ? "gave_up" : "goal_satisfied",
    reason: summary
      ? redactNarration(summary)
      : "model reported a natural endpoint with no further action",
  };
}

export const harnessAborted: Stop = {
  completionReason: "harness_error",
  reason: "run aborted by the harness",
  stopCause: "harness_aborted",
};

/**
 * The wall-clock deadline. A session that took at least one material (non-idle) action before the
 * cap reached its budget rather than stalling; a deadline hit with zero material actions is still
 * recorded as a failure (timed_out).
 */
export function timeLimit(session: LoopSession): Stop {
  const { timeoutMs } = session;
  const { materialActions, turns } = session.trace.counts;
  if (materialActions === 0) {
    return {
      completionReason: "timed_out",
      reason: `wall-clock deadline reached after ${timeoutMs}ms with no material progress`,
      stopCause: "time_limit",
    };
  }
  return {
    completionReason: "budget_reached",
    reason: session.actionHistory.interruptedActionOutcome
      ? `reached the ${timeoutMs}ms time budget with ${materialActions} material action attempt(s), ${turns} turn(s); the latest action outcome is uncertain`
      : `reached the ${timeoutMs}ms time budget after productive activity (${materialActions} material action(s), ${turns} turn(s))`,
    stopCause: "time_limit",
  };
}

/**
 * A harness spend cap interrupts the session regardless of prior activity. budget_reached maps to
 * incomplete; zero executed actions do not establish that the participant gave up. Cite the
 * running estimate, cap, and progress so the operator can inspect the interruption.
 */
export function spendLimit(session: LoopSession, estimate: number, maxUsd: number): Stop {
  const { materialActions, turns } = session.trace.counts;
  const booked = session.usage.reservedRequests;
  const spend =
    booked === 0
      ? `estimated spend $${estimate}`
      : `estimated spend $${estimate}, including the worst case of ${booked} lost request(s),`;
  return {
    completionReason: "budget_reached",
    reason:
      materialActions > 0
        ? `Stopped before the next model turn: ${spend} passed execution.caps.maxUsd=$${maxUsd} after productive activity (${materialActions} material action(s), ${turns} turn(s))`
        : `Stopped before the next model turn: ${spend} passed execution.caps.maxUsd=$${maxUsd} with no material progress`,
    stopCause: "spend_limit",
  };
}

// Fail closed on a non-finite estimate: NaN > maxUsd is always false, so a cap fed NaN would never
// trip.
export const nonFiniteEstimate: Stop = {
  completionReason: "harness_error",
  reason:
    "the injected estimateTurnCostUsd returned a non-finite estimate while execution.caps.maxUsd is set; the estimator receives one ActorTokenUsage object. Failing closed instead of running uncapped.",
};

/** A study-level stop is a recruiting decision hitting its limit, not this participant's runaway. */
export function runSpendLimit(reason: string): Stop {
  return { completionReason: "budget_reached", reason, stopCause: "study_spend_limit" };
}

// A host-authenticated provider may learn its account billing class during startup. Never price
// that account usage from an API model rate.
export const accountBilledCaps: Stop = {
  completionReason: "harness_error",
  reason:
    "API dollar caps and output-token limits cannot bound account-billed providers; use a finite timeout or an API-billed participant.",
};

const noticeEvidence = (status: string, title: string, text: string): Evidence => ({
  kind: "notice",
  body: () => notice(status, title, text),
});

const ADAPTER_LIMIT_REASON =
  "the adapter reported a local admission limit before provider dispatch; the participant did not report completion. No actions or closing request followed the refusal.";
export const adapterLimit: Stop = {
  completionReason: "budget_reached",
  reason: ADAPTER_LIMIT_REASON,
  stopCause: "adapter_limit",
  evidence: noticeEvidence("warn", "adapter admission limit reached", ADAPTER_LIMIT_REASON),
};

const USAGE_UNREPORTED_REASON =
  "provider usage is unavailable for a request, so the declared model-spend cap cannot be established; no further or closing request was dispatched";
export const usageUnreported: Stop = {
  completionReason: "harness_error",
  reason: USAGE_UNREPORTED_REASON,
  stopCause: "usage_unreported",
  evidence: noticeEvidence("error", "provider usage unavailable", USAGE_UNREPORTED_REASON),
};

/**
 * A capped session lost a request without a reply and cannot bound what it cost: no output-token
 * limit is set, so its worst case is the model's whole output allowance.
 */
export function lostRequestUnbounded(turnNumber: number, lost: LostRequest): Stop {
  const reason = `provider turn ${turnNumber} ${lost}; its usage is unknown and no maxOutputTokens bounds what it cost, so the declared model-spend cap cannot be established; no further or closing request was dispatched. Set actors[].maxOutputTokens so a capped session can book the worst case and retry.`;
  return {
    completionReason: "harness_error",
    reason,
    stopCause: "usage_unreported",
    evidence: noticeEvidence("error", "provider usage unavailable", reason),
  };
}

/** How a request was lost without a reply. */
export type LostRequest = "stalled" | "failed in transit";

export function providerStalledTwice(turnNumber: number, afterMs: number): Stop {
  const reason = `provider turn ${turnNumber} stalled twice (${afterMs}ms each); the model produced no turn and the participant was ended rather than left to run out its budget`;
  return {
    completionReason: "harness_error",
    reason,
    evidence: noticeEvidence("error", "provider turn stalled twice", reason),
  };
}

/**
 * A provider can exhaust its response budget before producing visible text, or midway through an
 * action. Never interpret either as participant completion or dispatch actions from an explicitly
 * incomplete response.
 */
export function providerInterrupted(interruption: NonNullable<CuaTurn["interruption"]>): Stop {
  const tokenLimit = interruption === "token_limit" || interruption === "output_limit";
  const unexpectedStatus = interruption === "unexpected_status";
  const reason = tokenLimit
    ? "the provider's output/context token limit interrupted this response; the participant did not report completion. No actions or closing request followed the incomplete response."
    : unexpectedStatus
      ? "the provider returned an unexpected noncompleted response status; the participant did not report completion. No actions or closing request followed this response."
      : "the provider returned an explicitly incomplete response; the participant did not report completion. No actions or closing request followed the incomplete response.";
  return {
    completionReason: tokenLimit ? "budget_reached" : "harness_error",
    reason,
    stopCause:
      interruption === "output_limit"
        ? "provider_output_limit"
        : tokenLimit
          ? "provider_token_limit"
          : unexpectedStatus
            ? "provider_status"
            : "provider_incomplete",
    evidence: noticeEvidence(
      tokenLimit ? "warn" : "error",
      tokenLimit
        ? "provider token limit reached"
        : unexpectedStatus
          ? "unexpected provider response status"
          : "provider response incomplete",
      reason,
    ),
  };
}

/**
 * Safety-check categories are provider-defined enums (e.g. "malicious_instructions"), not free
 * text; the evidence records them (redacted for defense-in-depth) so it shows why the run paused.
 */
export function blockedOnSafetyChecks(checks: string): Stop {
  return {
    completionReason: "blocked_approval",
    reason: `paused on model safety check(s): ${checks}; not acknowledged`,
    evidence: {
      kind: "approval",
      body: () => ({ lifecycle: "completed", status: "blocked", title: `safety check: ${checks}` }),
    },
  };
}

/**
 * A vision provider against a screenshot-less observation is a fail-closed harness error, not a
 * silent crash. The provider sets requiresFrame; a state-reasoning provider omits it.
 */
export function missingFrame(provider: CuaProvider, observation: CuaObservation): Stop | undefined {
  if (provider.requiresFrame !== true || observation.screenshot !== undefined) return undefined;
  return {
    completionReason: "harness_error",
    reason: `provider ${provider.id} requires a screenshot frame but the executor returned an observation with no screenshot (vision provider against a state-only executor)`,
  };
}

export function stopWhenMatched(
  match: StopConditionMatch,
  observation: CuaObservation,
  redactNarration: (text: string) => string,
): Stop {
  return {
    completionReason: "goal_satisfied",
    reason: `stopWhen matched ${match.id} (${match.kinds.join("+")})`,
    evidence: {
      kind: "notice",
      body: () =>
        notice(
          "matched",
          `stopWhen matched: ${match.id}`,
          redactNarration(
            `Harness stop condition matched rule ${match.id} using ${match.kinds.join(", ")}. Raw observed URL/text/appState were runtime-only and were not persisted; when a screenshot was available, the immediately preceding screenshot item is the visual evidence for the matched surface.`,
          ),
        ),
    },
    debriefTrigger: { kind: "stop_when", observation },
  };
}

export function dwellCompleted(heldMs: number, when: string, observation: CuaObservation): Stop {
  return {
    completionReason: "goal_satisfied",
    reason: `dwell window complete (${heldMs}ms held ${when})`,
    debriefTrigger: { kind: "dwell", observation },
  };
}

/** The friction backstop tripped: cite the reason, the last material action and recent actions. */
export function gaveUp(session: LoopSession, reason: string): Stop {
  const { lastMaterialActionTitle, recentActionTitles } = session.actionHistory;
  const screenshotRef = session.lastScreenshotRef;
  const details = (): string =>
    [
      `reason: ${reason}`,
      lastMaterialActionTitle === undefined
        ? "last material action: none"
        : `last material action: ${lastMaterialActionTitle}`,
      recentActionTitles.length === 0
        ? "recent actions: none"
        : `recent actions: ${recentActionTitles.join(" -> ")}`,
    ].join("; ");
  return {
    completionReason: "gave_up",
    reason,
    evidence: {
      kind: "notice",
      body: () => ({
        ...notice("blocked", "computer-use backstop gave up", session.redactNarration(details())),
        ...(screenshotRef === undefined ? {} : { screenshotRef }),
      }),
    },
  };
}

/**
 * Classify an error that ended the session, with the diagnostics a reader needs to place it.
 * A stop cause committed by an earlier stop that failed to record is kept.
 */
export function stopForError(session: LoopSession, error: unknown): Stop {
  if (error instanceof CuaDeadlineError) return timeLimit(session);
  if (error instanceof CuaAbortError) return harnessAborted;
  const redact = (text: string): string => session.redactNarration(text);
  const { lastActionTitle } = session.actionHistory;
  const lastAction = (): string | undefined =>
    lastActionTitle === undefined ? undefined : `last action: ${redact(lastActionTitle)}`;
  const screenshot =
    session.lastScreenshotRef === undefined ? {} : { screenshotRef: session.lastScreenshotRef };
  if (isCuaPromptRefusedError(error)) {
    // The provider's policy decision about the prompt, not a harness fault; never resent.
    const reason = `${error.message}; the prompt was not sent again`;
    return {
      completionReason: "actor_error",
      reason,
      stopCause: "provider_refused_prompt",
      evidence: noticeEvidence(
        "error",
        "provider refused the prompt",
        `phase: ${redact(session.phase)}; ${reason}`,
      ),
    };
  }
  if (isCuaProviderError(error)) {
    const reason = `participant provider error: ${error.code}${error.failurePhase ? ` during ${error.failurePhase}` : ""}; cleanup: ${error.receipt.cleanup}`;
    return {
      completionReason: "harness_error",
      reason,
      evidence: noticeEvidence("error", "participant provider error", reason),
    };
  }
  if (isCuaExecutorError(error)) {
    const detail = (): string =>
      [
        `phase: ${redact(session.phase)}`,
        `code: ${error.code}`,
        `disposition: ${error.disposition}`,
        lastAction(),
      ]
        .filter(Boolean)
        .join("; ");
    return {
      completionReason: "harness_error",
      reason: `desktop executor error: ${error.code}; disposition: ${error.disposition}`,
      evidence: {
        kind: "notice",
        body: () => ({ ...notice("error", "desktop executor error", detail()), ...screenshot }),
      },
    };
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redact(rawMessage);
  const reason = redact(`computer-use loop error: ${rawMessage}`);
  const detail = (): string =>
    [
      `phase: ${redact(session.phase)}`,
      error instanceof Error && error.name ? `error: ${redact(error.name)}` : undefined,
      `message: ${message}`,
      lastAction(),
    ]
      .filter(Boolean)
      .join("; ");
  return {
    completionReason: "actor_error",
    reason,
    evidence: {
      kind: "notice",
      body: () => ({ ...notice("error", "computer-use loop error", detail()), ...screenshot }),
    },
  };
}
