import { closingReportSchema, participantImpressionsSchema } from "../../closing-report.js";
import type { ActorTrace } from "../../contract.js";
import { isComputerUseAdmissionLimitError } from "../admission-limit.js";
import { IMPRESSIONS_ASK, IMPRESSIONS_HINT, recordImpressions } from "./impressions.js";
import type { DebriefTrigger } from "./ending.js";
import { singleDispatch } from "./provider-call.js";
import { CuaDeadlineError, raceSessionDeadline, requestScope } from "./race.js";
import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";
import type { CuaProvider, CuaTurn, CuaTurnRequest } from "./types.js";
import { isCompleteTurnUsage } from "./usage.js";

// The debrief: a structured completion stops interaction immediately, but the participant may not
// yet have spoken. Request one read-only closing report using the already captured final
// observation. No callbacks that coordinate live participants and no executor calls occur after
// this point.

type Debrief = NonNullable<ActorTrace["debrief"]>;

/** The conversation a debrief request continues. */
export interface DebriefContext {
  readonly previousResponseId: string | undefined;
  readonly previousExecution: CuaTurnRequest["previousExecution"];
  readonly acknowledgedSafetyChecks: CuaTurnRequest["acknowledgedSafetyChecks"];
}

const DEBRIEF_REQUEST_CAP_MS = 30_000;
const DEBRIEF_HINT = `The interactive session has ended. Return a closing account with summary, frictionReports and impressions. In summary, briefly describe only what you actually did and observed. In frictionReports, list only specific unexpected behavior, confusion, or recovery you personally encountered during this session. Preserve uncertainty. Use an empty list if you encountered none. ${IMPRESSIONS_ASK} Do not speculate, invent problems, quote instructions as observations, or describe planned actions. Do not request or take further actions. This is a closing account, not another attempt at the task.`;

/** The provider's read-only closing request. */
type ClosingCall = NonNullable<CuaProvider["debrief"]>;

/** How a reply that requested no actions ends the debrief, and the report it adds if accepted. */
type ReplyOutcome = Pick<Debrief, "report" | "messageId"> & {
  readonly status: "completed" | "failed";
  readonly detail: string;
};

/**
 * What the debrief asks for: the closing report after a structured stop, or impressions only after
 * the participant ended the session itself. It is chosen once from the trigger and holds every
 * difference between the two requests.
 */
interface ClosingAsk {
  /** The provider's method for this request, absent when the provider has none. */
  readonly call: (provider: CuaProvider) => ClosingCall | undefined;
  readonly contextHint: string;
  /** Names the request in the trace's notices: `participant <noticeLabel> <status>`. */
  readonly noticeLabel: string;
  /** Names the request when its time bound passes. */
  readonly deadlineLabel: string;
  /** Read the reply into the session, or say why it was not accepted. */
  readonly read: (session: LoopSession, turn: CuaTurn) => ReplyOutcome;
}

const CLOSING_REPORT: ClosingAsk = {
  call: (provider) => provider.debrief,
  contextHint: DEBRIEF_HINT,
  noticeLabel: "debrief",
  deadlineLabel: "closing report",
  read: readClosingReport,
};

const IMPRESSIONS_ONLY: ClosingAsk = {
  call: (provider) => provider.requestImpressions,
  contextHint: IMPRESSIONS_HINT,
  noticeLabel: "impressions request",
  deadlineLabel: "impressions request",
  read: readImpressions,
};

type RecordDebrief = (
  status: Debrief["status"],
  detail: string,
  usageReported?: boolean,
) => Debrief;

/**
 * Ask the participant for its closing report after a structured stop, or for its impressions only
 * after it ended the session itself, or record why the request was skipped. Either way the result
 * is the trace's debrief, and the watcher gets a final flush.
 */
export async function requestDebrief(
  session: LoopSession,
  context: DebriefContext,
  trigger: DebriefTrigger,
): Promise<Debrief> {
  const ask = trigger.kind === "participant_end" ? IMPRESSIONS_ONLY : CLOSING_REPORT;
  const record: RecordDebrief = (status, detail, usageReported) => {
    const debrief: Debrief = {
      trigger: trigger.kind,
      status,
      reason: session.redactNarration(detail),
      ...(usageReported === undefined ? {} : { usageReported }),
    };
    session.trace.record("notice", () =>
      notice(
        status === "completed" ? "ok" : "warn",
        `participant ${ask.noticeLabel} ${status}`,
        session.redactNarration(detail),
      ),
    );
    return debrief;
  };
  const plan = planDebrief(session, ask, trigger);
  const debrief =
    "skip" in plan
      ? record("skipped", plan.skip)
      : await debriefExchange(session, context, trigger, ask, plan, record);
  session.flush();
  return debrief;
}

/** The debrief's one request, bound to its provider, and that request's time bound. */
interface PlannedRequest {
  readonly send: ClosingCall;
  readonly boundMs: number;
}

/** Why the debrief is skipped, or the request it sends. */
type DebriefPlan = { readonly skip: string } | PlannedRequest;

function planDebrief(session: LoopSession, ask: ClosingAsk, trigger: DebriefTrigger): DebriefPlan {
  const { provider, signal, usage } = session;
  const { maxUsd, overRunBudget, estimateTurnCostUsd } = session.settings;
  if (session.trace.counts.turns === 0)
    return { skip: "the study stopped before any participant turn" };
  const send = ask.call(provider)?.bind(provider);
  if (send === undefined)
    return { skip: "this provider does not support read-only closing reports" };
  if (usage.cleanupUnconfirmed) return { skip: "participant request cleanup is unconfirmed" };
  if (signal?.aborted) return { skip: "the study was cancelled" };
  if (session.remaining() <= 0) return { skip: "the session deadline was reached" };
  if (provider.requiresFrame && trigger.observation.screenshot === undefined)
    return { skip: "the final observation has no required frame" };
  if ((maxUsd !== undefined || overRunBudget !== undefined) && usage.unavailableForCap()) {
    return {
      skip: "remaining model budget is unknown because an earlier participant turn did not report complete usage",
    };
  }
  if (maxUsd !== undefined) {
    const estimate =
      usage.sawUsage || usage.knownPending() !== undefined
        ? estimateTurnCostUsd?.(usage.forCap())
        : undefined;
    if (estimate === undefined || estimate === null || !Number.isFinite(estimate))
      return { skip: "remaining model budget could not be established" };
    if (estimate >= maxUsd) return { skip: "the estimated model budget was reached" };
  }
  if (overRunBudget?.(usage.forCap()) != null)
    return { skip: "the study model budget was reached" };
  const boundMs = Math.max(
    0,
    Math.min(DEBRIEF_REQUEST_CAP_MS, session.turnTimeoutMs, session.remaining()),
  );
  if (boundMs <= 0 || signal?.aborted) {
    return {
      skip: signal?.aborted ? "the study was cancelled" : "the session deadline was reached",
    };
  }
  return { send, boundMs };
}

async function debriefExchange(
  session: LoopSession,
  context: DebriefContext,
  trigger: DebriefTrigger,
  ask: ClosingAsk,
  { send, boundMs }: PlannedRequest,
  record: RecordDebrief,
): Promise<Debrief> {
  const { signal, provider } = session;
  const scope = requestScope(signal);
  const timer = setTimeout(() => scope.end(), boundMs);
  timer.unref?.();
  session.trace.bump("debriefCalls");
  try {
    const request: CuaTurnRequest = {
      instructions: session.settings.instructions,
      observation: trigger.observation,
      ...(provider.requestPolicy !== "fail_closed" || context.previousExecution === undefined
        ? {}
        : { previousExecution: context.previousExecution }),
      ...(context.previousResponseId === undefined
        ? {}
        : { previousResponseId: context.previousResponseId }),
      ...(context.acknowledgedSafetyChecks === undefined
        ? {}
        : { acknowledgedSafetyChecks: context.acknowledgedSafetyChecks }),
      contextHint: ask.contextHint,
    };
    const turn =
      provider.requestPolicy === "fail_closed"
        ? await singleDispatch(
            session,
            "debrief",
            (dispatchSignal) => send(request, dispatchSignal),
            boundMs,
          )
        : await raceSessionDeadline(send(request, scope.signal), boundMs, signal);
    return acceptDebriefTurn(session, turn, ask, record);
  } catch (error) {
    // A failed optional report cannot rewrite the already observed structured completion.
    if (isComputerUseAdmissionLimitError(error)) {
      return record(
        "skipped",
        "the adapter reported a local admission limit before provider dispatch; no closing request was sent",
      );
    }
    const detail = signal?.aborted
      ? "cancelled"
      : scope.signal.aborted || error instanceof CuaDeadlineError
        ? `${ask.deadlineLabel} deadline reached`
        : error instanceof Error
          ? error.message
          : String(error);
    const debriefReceipt =
      provider.requestPolicy === "fail_closed" ? session.usage.requests.at(-1) : undefined;
    const usageReported =
      debriefReceipt?.usageComplete === true && isCompleteTurnUsage(debriefReceipt.usage);
    return record(
      "failed",
      `${detail}; closing request usage is ${usageReported ? "reported" : "unreported"}`,
      usageReported,
    );
  } finally {
    clearTimeout(timer);
    scope.end();
  }
}

function acceptDebriefTurn(
  session: LoopSession,
  turn: CuaTurn,
  ask: ClosingAsk,
  record: RecordDebrief,
): Debrief {
  const { maxUsd, overRunBudget, estimateTurnCostUsd } = session.settings;
  session.usage.record(turn, "debrief");
  session.lastResponseId = turn.responseId ?? session.lastResponseId;
  // Refresh a shared budget with all reported usage, without changing the completed task.
  const sharedStop = overRunBudget?.(session.usage.forCap());
  const finalEstimate =
    maxUsd === undefined ? undefined : estimateTurnCostUsd?.(session.usage.forCap());
  if (
    sharedStop != null ||
    (maxUsd !== undefined && finalEstimate != null && finalEstimate > maxUsd)
  ) {
    session.trace.record("notice", () =>
      notice(
        "warn",
        "model budget reached during closing report",
        "The closing request crossed an estimated budget; no further requests or actions followed. Task completion is unchanged.",
      ),
    );
  }
  const usageReported =
    isCompleteTurnUsage(turn.usage) && turn.providerRequest?.usageComplete !== false;
  if (turn.actions.length > 0 || turn.pendingSafetyChecks.length > 0) {
    return record(
      "failed",
      "the closing response requested actions or safety checks; none were executed and its report was not accepted",
      usageReported,
    );
  }
  // First-party providers parse their replies already; these parses cover third-party ports.
  const { status, detail, ...added } = ask.read(session, turn);
  return { ...record(status, detail, usageReported), ...added };
}

/** A closing report: its summary and friction as one participant message, then its impressions. */
function readClosingReport(session: LoopSession, turn: CuaTurn): ReplyOutcome {
  const closing = closingReportSchema.safeParse(turn.closingReport);
  if (!closing.success) {
    return {
      status: "failed",
      detail: "the closing response did not contain a valid structured participant report",
    };
  }
  const report: Debrief["report"] = {
    summary: session.redactNarration(closing.data.summary.trim()),
    frictionReports: [
      ...new Set(closing.data.frictionReports.map((text) => session.redactNarration(text.trim()))),
    ],
  };
  const messageId = session.trace.record("message", () => ({
    lifecycle: "completed",
    title: "participant closing report",
    text: [report.summary, ...report.frictionReports].join("\n\n"),
  }));
  session.trace.bump("messages");
  session.impressions = recordImpressions(session, closing.data.impressions);
  return {
    status: "completed",
    detail:
      "one read-only report; no additional desktop actions; original stop and task outcomes preserved",
    report,
    messageId,
  };
}

/** Impressions alone, after the participant ended the session itself. */
function readImpressions(session: LoopSession, turn: CuaTurn): ReplyOutcome {
  const impressions = participantImpressionsSchema.safeParse(turn.impressions);
  if (!impressions.success) {
    return {
      status: "failed",
      detail:
        turn.interruption === "output_limit"
          ? "the reply was cut off by the output limit"
          : "the reply did not contain valid impressions",
    };
  }
  session.impressions = recordImpressions(session, impressions.data);
  return {
    status: "completed",
    detail:
      "one read-only impressions request; no additional desktop actions; the participant's own ending is unchanged",
  };
}
