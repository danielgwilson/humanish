import type { ActorTrace, ParticipantClosingReport } from "../../contract.js";
import { isCuaAdmissionLimitError } from "../admission-limit.js";
import type { ClosingTrigger } from "./ending.js";
import { singleDispatch } from "./provider-call.js";
import { CuaDeadlineError, CuaStallError, raceBounded } from "./race.js";
import type { LoopSession } from "./session.js";
import type { CuaProvider, CuaTurn, CuaTurnRequest } from "./types.js";
import { isCompleteTurnUsage } from "./usage.js";

// Structured completion must stop interaction immediately, but the participant may not yet
// have spoken. Request one read-only account using the already captured final observation.
// No callbacks that coordinate live participants and no executor calls occur after this point.

type Debrief = NonNullable<ActorTrace["debrief"]>;

/** The conversation a closing request continues. */
export interface ClosingContext {
  readonly previousResponseId: string | undefined;
  readonly previousExecution: CuaTurnRequest["previousExecution"];
  readonly acknowledgedSafetyChecks: CuaTurnRequest["acknowledgedSafetyChecks"];
}

const CLOSING_REQUEST_CAP_MS = 30_000;
const CLOSING_HINT =
  "The interactive session has ended. Return a closing account with summary and frictionReports. In summary, briefly describe only what you actually did and observed. In frictionReports, list only specific unexpected behavior, confusion, or recovery you personally encountered during this session. Preserve uncertainty. Use an empty list if you encountered none. Do not speculate, invent problems, quote instructions as observations, or describe planned actions. Do not request or take further actions. This is a closing account, not another attempt at the task.";

/** Runtime validation is also required for third-party provider ports. */
export function validClosingReport(value: unknown): value is ParticipantClosingReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return (
    Object.keys(report).length === 2 &&
    typeof report.summary === "string" &&
    report.summary.trim().length > 0 &&
    report.summary.length <= 4_000 &&
    Array.isArray(report.frictionReports) &&
    report.frictionReports.length <= 8 &&
    report.frictionReports.every(
      (item: unknown) => typeof item === "string" && item.trim().length > 0 && item.length <= 2_000,
    )
  );
}

type DebriefingProvider = CuaProvider & { debrief: NonNullable<CuaProvider["debrief"]> };

function supportsDebrief(provider: CuaProvider): provider is DebriefingProvider {
  return provider.debrief !== undefined;
}

type RecordDebrief = (
  status: Debrief["status"],
  detail: string,
  usageReported?: boolean,
) => Debrief;

export async function requestClosingAccount(
  session: LoopSession,
  context: ClosingContext,
  closing: ClosingTrigger,
): Promise<Debrief> {
  const record: RecordDebrief = (status, detail, usageReported) => {
    const debrief: Debrief = {
      trigger: closing.trigger,
      status,
      reason: session.redactNarration(detail),
      ...(usageReported === undefined ? {} : { usageReported }),
    };
    session.trace.notice(
      status === "completed" ? "ok" : "warn",
      `participant debrief ${status}`,
      session.redactNarration(detail),
    );
    return debrief;
  };
  const debrief = await closingOutcome(session, context, closing, record);
  session.flush();
  return debrief;
}

async function closingOutcome(
  session: LoopSession,
  context: ClosingContext,
  closing: ClosingTrigger,
  record: RecordDebrief,
): Promise<Debrief> {
  const { provider, signal, usage } = session;
  const { maxUsd, overRunBudget, estimateTurnCostUsd } = session.options;
  if (session.trace.counts.turns === 0)
    return record("skipped", "the study stopped before any participant turn");
  if (!supportsDebrief(provider))
    return record("skipped", "this provider does not support read-only closing reports");
  if (usage.cleanupUnconfirmed)
    return record("skipped", "participant request cleanup is unconfirmed");
  if (signal?.aborted) return record("skipped", "the study was cancelled");
  if (session.remaining() <= 0) return record("skipped", "the session deadline was reached");
  if (provider.requiresFrame && closing.observation.screenshot === undefined)
    return record("skipped", "the final observation has no required frame");
  if ((maxUsd !== undefined || overRunBudget !== undefined) && usage.unavailableForCap()) {
    return record(
      "skipped",
      "remaining model budget is unknown because an earlier participant turn did not report complete usage",
    );
  }
  if (maxUsd !== undefined) {
    const estimate =
      usage.sawUsage || usage.knownPending() !== undefined
        ? estimateTurnCostUsd?.(usage.running())
        : undefined;
    if (estimate === undefined || estimate === null || !Number.isFinite(estimate))
      return record("skipped", "remaining model budget could not be established");
    if (estimate >= maxUsd) return record("skipped", "the estimated model budget was reached");
  }
  if (overRunBudget?.(usage.running()) != null)
    return record("skipped", "the study model budget was reached");
  const capMs = Math.max(
    0,
    Math.min(CLOSING_REQUEST_CAP_MS, session.turnTimeoutMs, session.remaining()),
  );
  if (capMs <= 0 || signal?.aborted) {
    return record(
      "skipped",
      signal?.aborted ? "the study was cancelled" : "the session deadline was reached",
    );
  }
  return closingExchange(session, provider, context, closing, capMs, record);
}

async function closingExchange(
  session: LoopSession,
  provider: DebriefingProvider,
  context: ClosingContext,
  closing: ClosingTrigger,
  capMs: number,
  record: RecordDebrief,
): Promise<Debrief> {
  const { signal } = session;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), capMs);
  timer.unref?.();
  session.trace.bump("debriefCalls");
  try {
    const request: CuaTurnRequest = {
      instructions: session.options.instructions,
      observation: closing.observation,
      ...(provider.requestPolicy !== "fail_closed" || context.previousExecution === undefined
        ? {}
        : { previousExecution: context.previousExecution }),
      ...(context.previousResponseId === undefined
        ? {}
        : { previousResponseId: context.previousResponseId }),
      ...(context.acknowledgedSafetyChecks === undefined
        ? {}
        : { acknowledgedSafetyChecks: context.acknowledgedSafetyChecks }),
      contextHint: CLOSING_HINT,
    };
    const turn =
      provider.requestPolicy === "fail_closed"
        ? await singleDispatch(
            session,
            "debrief",
            (dispatchSignal) => provider.debrief(request, dispatchSignal),
            capMs,
          )
        : await raceBounded(
            "participant debrief",
            provider.debrief(request, controller.signal),
            capMs,
            capMs,
            signal,
          );
    return acceptClosingTurn(session, turn, record);
  } catch (error) {
    // A failed optional report cannot rewrite the already observed structured completion.
    if (isCuaAdmissionLimitError(error)) {
      return record(
        "skipped",
        "the adapter reported a local admission limit before provider dispatch; no closing request was sent",
      );
    }
    const detail = signal?.aborted
      ? "cancelled"
      : controller.signal.aborted ||
          error instanceof CuaDeadlineError ||
          error instanceof CuaStallError
        ? "closing report deadline reached"
        : error instanceof Error
          ? error.message
          : String(error);
    const closingReceipt =
      provider.requestPolicy === "fail_closed" ? session.usage.requests.at(-1) : undefined;
    const usageReported =
      closingReceipt?.usageComplete === true && isCompleteTurnUsage(closingReceipt.usage);
    return record(
      "failed",
      `${detail}; closing request usage is ${usageReported ? "reported" : "unreported"}`,
      usageReported,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

function acceptClosingTurn(session: LoopSession, turn: CuaTurn, record: RecordDebrief): Debrief {
  const { maxUsd, overRunBudget, estimateTurnCostUsd } = session.options;
  session.usage.record(turn, false);
  session.lastResponseId = turn.responseId ?? session.lastResponseId;
  // Refresh a shared budget with all reported usage, without changing the completed task.
  const sharedStop = overRunBudget?.(session.usage.running());
  const finalEstimate =
    maxUsd === undefined ? undefined : estimateTurnCostUsd?.(session.usage.running());
  if (
    sharedStop != null ||
    (maxUsd !== undefined && finalEstimate != null && finalEstimate > maxUsd)
  ) {
    session.trace.notice(
      "warn",
      "model budget reached during closing report",
      "The closing request crossed an estimated budget; no further requests or actions followed. Task completion is unchanged.",
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
  if (!validClosingReport(turn.closingReport)) {
    return record(
      "failed",
      "the closing response did not contain a valid structured participant report",
      usageReported,
    );
  }
  const report: ParticipantClosingReport = {
    summary: session.redactNarration(turn.closingReport.summary.trim()),
    frictionReports: [
      ...new Set(
        turn.closingReport.frictionReports.map((text) => session.redactNarration(text.trim())),
      ),
    ],
  };
  const messageId = session.trace.record({
    kind: "message",
    lifecycle: "completed",
    title: "participant closing report",
    text: [report.summary, ...report.frictionReports].join("\n\n"),
  });
  session.trace.bump("messages");
  const debrief = record(
    "completed",
    "one read-only report; no additional desktop actions; original stop and task outcomes preserved",
    usageReported,
  );
  return { ...debrief, report, messageId };
}
