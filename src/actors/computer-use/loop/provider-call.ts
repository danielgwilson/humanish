import { isCuaAdmissionLimitError } from "../admission-limit.js";
import { CuaProviderError, isCuaProviderError } from "../provider-error.js";
import { adapterLimit, providerStalledTwice, usageUnreported, type Stop } from "./ending.js";
import {
  CuaAbortError,
  CuaDeadlineError,
  CuaStallError,
  raceCallBound,
  requestScope,
  type RequestScope,
} from "./race.js";
import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";
import type { CuaTurn, CuaTurnRequest } from "./types.js";
import { reportedCounts, settledReceipt } from "./usage.js";

// Asking the provider for a turn. A provider with requestPolicy "fail_closed" owns one attempt
// through settlement and reports a receipt; any other provider is raced against the turn bound
// and retried once when it stalls.

const CUA_PROVIDER_CLEANUP_GRACE_MS = 5000;

export type TurnReply = { readonly turn: CuaTurn } | { readonly stop: Stop };

/**
 * Ask the provider for one turn. A fail_closed provider gets one single dispatch; any other is
 * raced against turnTimeoutMs (#469) and retried once when it stalls.
 */
export async function requestTurn(
  session: LoopSession,
  request: CuaTurnRequest,
  turnNumber: number,
): Promise<TurnReply> {
  const { provider } = session;
  // A single-dispatch provider owns its one attempt through settlement.
  if (provider.requestPolicy === "fail_closed") {
    return {
      turn: await singleDispatch(
        session,
        "interaction",
        (signal) => provider.nextTurn(request, signal),
        session.turnTimeoutMs,
      ),
    };
  }
  const { signal } = session;
  const first = requestScope(signal);
  try {
    return {
      turn: await raceCallBound(
        `provider turn ${turnNumber}`,
        provider.nextTurn(request, first.signal),
        session.remaining(),
        session.turnTimeoutMs,
        signal,
      ),
    };
  } catch (error) {
    // Stops are concluded here, before `finally` ends the request scope, so their notices are
    // recorded before any abort listener runs.
    if (isCuaAdmissionLimitError(error)) return { stop: session.conclude(adapterLimit) };
    // A thrown request may have been billed without returning usage. Admission refusal is
    // the explicit no-dispatch exception above; strict capped routes cannot safely retry.
    if (session.requiresUsage) {
      session.usage.markUnreported();
      return { stop: session.conclude(usageUnreported) };
    }
    if (!(error instanceof CuaStallError)) throw error;
    return await retryStalledTurn(session, request, turnNumber, error, first);
  } finally {
    first.end();
  }
}

async function retryStalledTurn(
  session: LoopSession,
  request: CuaTurnRequest,
  turnNumber: number,
  stall: CuaStallError,
  stalled: RequestScope,
): Promise<TurnReply> {
  session.usage.markUnreported();
  session.trace.record("notice", () =>
    notice(
      "warn",
      "provider turn stalled; retrying once",
      `${stall.what} produced nothing within ${stall.afterMs}ms; sending the same observation again`,
    ),
  );
  // Two copies of a paid request must not run at once: cancel the stalled one before the retry.
  stalled.end();
  const retry = requestScope(session.signal);
  try {
    return {
      turn: await raceCallBound(
        `provider turn ${turnNumber} (retry)`,
        session.provider.nextTurn(request, retry.signal),
        session.remaining(),
        session.turnTimeoutMs,
        session.signal,
      ),
    };
  } catch (retryError) {
    if (isCuaAdmissionLimitError(retryError)) return { stop: session.conclude(adapterLimit) };
    if (!(retryError instanceof CuaStallError)) throw retryError;
    session.usage.markUnreported();
    return { stop: session.conclude(providerStalledTwice(turnNumber, retryError.afterMs)) };
  } finally {
    retry.end();
  }
}

type Settlement = { turn: CuaTurn } | { error: unknown };

/**
 * One provider request that the provider owns through settlement: an outer race never retries
 * it, and the loop waits a bounded grace for cleanup before booking the receipt. A continuing
 * request may return actions before it settles; that turn is returned unbooked.
 */
export async function singleDispatch(
  session: LoopSession,
  kind: "interaction" | "debrief",
  dispatch: (signal: AbortSignal) => Promise<CuaTurn>,
  boundMs: number,
): Promise<CuaTurn> {
  const { signal } = session;
  const scope = requestScope(signal);
  const settlementRef: { current?: Settlement } = {};
  const pending = Promise.resolve()
    .then(() => {
      if (scope.signal.aborted)
        throw new CuaProviderError("cancelled", {
          dispatched: false,
          usageComplete: false,
          cleanup: "confirmed",
        });
      return dispatch(scope.signal);
    })
    .then(
      (turn) => {
        settlementRef.current = { turn };
        return turn;
      },
      (error: unknown) => {
        settlementRef.current = { error };
        throw error;
      },
    );
  void pending.catch(() => undefined);
  let outcome: { turn: CuaTurn; continuing: boolean } | { error: unknown };
  try {
    const turn = await raceCallBound(
      `participant ${kind}`,
      pending,
      session.remaining(),
      boundMs,
      signal,
    );
    outcome = { turn, continuing: isContinuingTurn(kind, turn) };
  } catch (error) {
    outcome = { error };
  } finally {
    scope.end();
    if (settlementRef.current === undefined) await cleanupGrace(pending);
  }
  if ("turn" in outcome && outcome.continuing) {
    session.usage.markPending();
    return outcome.turn;
  }
  const failure = "error" in outcome ? outcome.error : undefined;
  const requestSettlement = settlementRef.current;
  const providerError = isCuaProviderError(failure)
    ? failure
    : requestSettlement &&
        "error" in requestSettlement &&
        isCuaProviderError(requestSettlement.error)
      ? requestSettlement.error
      : undefined;
  const turn =
    requestSettlement && "turn" in requestSettlement ? requestSettlement.turn : undefined;
  const receipt = settledReceipt(providerError?.receipt ?? turn?.providerRequest);
  const rawUsage =
    providerError?.usage ?? (turn?.providerRequestPending === true ? undefined : turn?.usage);
  const usage = rawUsage === undefined ? undefined : reportedCounts(rawUsage);
  const settledKind = session.usage.settle(kind, receipt, usage, providerError);
  if (receipt.cleanup !== "confirmed") {
    session.trace.record("notice", () =>
      notice(
        "error",
        "participant request cleanup unconfirmed",
        "The request did not confirm cleanup within the settlement boundary. No further participant request or action is admitted.",
      ),
    );
  }
  if (!("error" in outcome)) return outcome.turn;
  if (usage)
    session.usage.record(
      { actions: [], pendingSafetyChecks: [], done: false, usage, providerRequest: receipt },
      settledKind,
    );
  if (failure instanceof CuaAbortError || failure instanceof CuaDeadlineError) throw failure;
  if (failure instanceof CuaStallError)
    throw new CuaProviderError("timeout", receipt, usage, providerError?.failurePhase);
  throw providerError ?? new CuaProviderError("process_failed", receipt, usage);
}

/**
 * Whether a single-dispatch turn is a valid turn from a continuing request (see
 * CuaTurn.providerRequestPending), which carries actions only. A settled turn must carry a
 * dispatched, cleaned-up receipt.
 */
function isContinuingTurn(kind: "interaction" | "debrief", turn: CuaTurn): boolean {
  if (turn.providerRequestPending === true) {
    if (
      kind !== "interaction" ||
      turn.done ||
      turn.actions.length === 0 ||
      turn.pendingSafetyChecks.length > 0 ||
      turn.providerRequest !== undefined ||
      turn.usage !== undefined ||
      turn.interruption !== undefined ||
      turn.closingReport !== undefined
    ) {
      throw new CuaProviderError("invalid_response", {
        dispatched: "unknown",
        usageComplete: false,
        cleanup: "unconfirmed",
      });
    }
    return true;
  }
  const r = turn.providerRequest;
  if (
    !r ||
    r.dispatched !== true ||
    typeof r.usageComplete !== "boolean" ||
    r.cleanup !== "confirmed"
  ) {
    throw new CuaProviderError(
      "invalid_response",
      { dispatched: "unknown", usageComplete: false, cleanup: "unconfirmed" },
      turn.usage,
    );
  }
  return false;
}

async function cleanupGrace(pending: Promise<CuaTurn>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CUA_PROVIDER_CLEANUP_GRACE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
