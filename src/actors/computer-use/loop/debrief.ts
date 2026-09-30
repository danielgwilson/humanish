import type { ActorTrace, ParticipantClosingReport } from "../../contract.js";
import { isCuaAdmissionLimitError } from "../admission-limit.js";
import type { DebriefTrigger } from "./ending.js";
import { singleDispatch } from "./provider-call.js";
import { CuaDeadlineError, CuaStallError, raceCallBound } from "./race.js";
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
const DEBRIEF_HINT =
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

/**
 * Ask the participant for its closing report after a structured stop, or record why the request
 * was skipped. Either way the result is the trace's debrief, and the watcher gets a final flush.
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
        `participant debrief ${status}`,
        session.redactNarration(detail),
      ),
    );
    return debrief;
  };
  const plan = planDebrief(session, trigger);
  const debrief =
    "skip" in plan
      ? record("skipped", plan.skip)
      : await debriefExchange(session, plan.provider, context, trigger, plan.boundMs, record);
  session.flush();
  return debrief;
}

/** Why the debrief is skipped, or the provider and time bound its one request gets. */
type DebriefPlan =
  | { readonly skip: string }
  | { readonly provider: DebriefingProvider; readonly boundMs: number };

function planDebrief(session: LoopSession, trigger: DebriefTrigger): DebriefPlan {
  const { provider, signal, usage } = session;
  const { maxUsd, overRunBudget, estimateTurnCostUsd } = session.settings;
  if (session.trace.counts.turns === 0)
    return { skip: "the study stopped before any participant turn" };
  if (!supportsDebrief(provider))
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
        ? estimateTurnCostUsd?.(usage.running())
        : undefined;
    if (estimate === undefined || estimate === null || !Number.isFinite(estimate))
      return { skip: "remaining model budget could not be established" };
    if (estimate >= maxUsd) return { skip: "the estimated model budget was reached" };
  }
  if (overRunBudget?.(usage.running()) != null)
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
  return { provider, boundMs };
}

async function debriefExchange(
  session: LoopSession,
  provider: DebriefingProvider,
  context: DebriefContext,
  trigger: DebriefTrigger,
  boundMs: number,
  record: RecordDebrief,
): Promise<Debrief> {
  const { signal } = session;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), boundMs);
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
      contextHint: DEBRIEF_HINT,
    };
    const turn =
      provider.requestPolicy === "fail_closed"
        ? await singleDispatch(
            session,
            "debrief",
            (dispatchSignal) => provider.debrief(request, dispatchSignal),
            boundMs,
          )
        : await raceCallBound(
            "participant debrief",
            provider.debrief(request, controller.signal),
            boundMs,
            boundMs,
            signal,
          );
    return acceptDebriefTurn(session, turn, record);
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
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

function acceptDebriefTurn(session: LoopSession, turn: CuaTurn, record: RecordDebrief): Debrief {
  const { maxUsd, overRunBudget, estimateTurnCostUsd } = session.settings;
  session.usage.record(turn, "debrief");
  session.lastResponseId = turn.responseId ?? session.lastResponseId;
  // Refresh a shared budget with all reported usage, without changing the completed task.
  const sharedStop = overRunBudget?.(session.usage.running());
  const finalEstimate =
    maxUsd === undefined ? undefined : estimateTurnCostUsd?.(session.usage.running());
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
  const messageId = session.trace.record("message", () => ({
    lifecycle: "completed",
    title: "participant closing report",
    text: [report.summary, ...report.frictionReports].join("\n\n"),
  }));
  session.trace.bump("messages");
  const debrief = record(
    "completed",
    "one read-only report; no additional desktop actions; original stop and task outcomes preserved",
    usageReported,
  );
  return { ...debrief, report, messageId };
}
