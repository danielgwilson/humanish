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

/** The provider's closing request for a trigger: the closing report, or impressions only. */
type ClosingAsk = NonNullable<CuaProvider["debrief"]>;

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
        `participant ${trigger.kind === "participant_end" ? "impressions request" : "debrief"} ${status}`,
        session.redactNarration(detail),
      ),
    );
    return debrief;
  };
  const plan = planDebrief(session, trigger);
  const debrief =
    "skip" in plan
      ? record("skipped", plan.skip)
      : await debriefExchange(session, plan.ask, context, trigger, plan.boundMs, record);
  session.flush();
  return debrief;
}

/** Why the debrief is skipped, or the request and time bound its one request gets. */
type DebriefPlan =
  | { readonly skip: string }
  | { readonly ask: ClosingAsk; readonly boundMs: number };

function planDebrief(session: LoopSession, trigger: DebriefTrigger): DebriefPlan {
  const { provider, signal, usage } = session;
  const { maxUsd, overRunBudget, estimateTurnCostUsd } = session.settings;
  if (session.trace.counts.turns === 0)
    return { skip: "the study stopped before any participant turn" };
  const ask = trigger.kind === "participant_end" ? provider.requestImpressions : provider.debrief;
  if (ask === undefined)
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
  return { ask, boundMs };
}

async function debriefExchange(
  session: LoopSession,
  ask: ClosingAsk,
  context: DebriefContext,
  trigger: DebriefTrigger,
  boundMs: number,
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
      contextHint: trigger.kind === "participant_end" ? IMPRESSIONS_HINT : DEBRIEF_HINT,
    };
    const turn =
      provider.requestPolicy === "fail_closed"
        ? await singleDispatch(
            session,
            "debrief",
            (dispatchSignal) => ask.call(provider, request, dispatchSignal),
            boundMs,
          )
        : await raceSessionDeadline(ask.call(provider, request, scope.signal), boundMs, signal);
    return acceptDebriefTurn(session, turn, trigger, record);
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
        ? `${trigger.kind === "participant_end" ? "impressions request" : "closing report"} deadline reached`
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
  trigger: DebriefTrigger,
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
  if (trigger.kind === "participant_end") {
    const impressions = participantImpressionsSchema.safeParse(turn.impressions);
    if (!impressions.success) {
      return record(
        "failed",
        turn.interruption === "output_limit"
          ? "the reply was cut off by the output limit"
          : "the reply did not contain valid impressions",
        usageReported,
      );
    }
    session.impressions = recordImpressions(session, impressions.data);
    return record(
      "completed",
      "one read-only impressions request; no additional desktop actions; the participant's own ending is unchanged",
      usageReported,
    );
  }
  const closing = closingReportSchema.safeParse(turn.closingReport);
  if (!closing.success) {
    return record(
      "failed",
      "the closing response did not contain a valid structured participant report",
      usageReported,
    );
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
  const debrief = record(
    "completed",
    "one read-only report; no additional desktop actions; original stop and task outcomes preserved",
    usageReported,
  );
  return { ...debrief, report, messageId };
}
