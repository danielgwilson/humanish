import { isCuaAdmissionLimitError } from "../admission-limit.js";
import { CuaProviderError, isCuaProviderError } from "../provider-error.js";
import { adapterLimit, providerStalledTwice, usageUnreported, type Stop } from "./ending.js";
import { CuaAbortError, CuaDeadlineError, CuaStallError, raceBounded } from "./race.js";
import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";
import type { CuaTurn, CuaTurnRequest } from "./types.js";
import { reportedCounts, settledReceipt } from "./usage.js";

// Asking the provider for a turn. A provider with requestPolicy "fail_closed" owns one attempt
// through settlement and reports a receipt; any other provider is raced against the turn bound
// and retried once when it stalls.

const CUA_PROVIDER_CLEANUP_GRACE_MS = 5000;

export type TurnReply = { readonly turn: CuaTurn } | { readonly stop: Stop };

// Stops decided here are concluded before the `finally` releases the request signal, so their
// notices are recorded before any abort listener runs.

/**
 * Bounded per call (#469): one hung request used to be indistinguishable from thinking and cost
 * the lane its whole remaining budget. One retry with a notice; then the lane ends as
 * harness_error, named, instead of thirty silent minutes.
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
      turn: await raceBounded(
        `provider turn ${turnNumber}`,
        provider.nextTurn(request, first.signal),
        session.remaining(),
        session.turnTimeoutMs,
        signal,
      ),
    };
  } catch (error) {
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

/**
 * One provider request's signal. It follows the session signal and ends when the loop stops
 * waiting on the request, because a timeout race alone does not cancel the losing promise.
 */
interface RequestScope {
  readonly signal: AbortSignal;
  /** Abort the request and stop following the session signal. Safe to call twice. */
  end(): void;
}

function requestScope(signal: AbortSignal | undefined): RequestScope {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    end: () => {
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
    },
  };
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
      turn: await raceBounded(
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
 * interaction may yield actions before it settles; that turn is returned unbooked.
 */
export async function singleDispatch(
  session: LoopSession,
  kind: "interaction" | "debrief",
  dispatch: (signal: AbortSignal) => Promise<CuaTurn>,
  capMs: number,
): Promise<CuaTurn> {
  const { signal } = session;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const settled: { current?: Settlement } = {};
  const pending = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted)
        throw new CuaProviderError("cancelled", {
          dispatched: false,
          usageComplete: false,
          cleanup: "confirmed",
        });
      return dispatch(controller.signal);
    })
    .then(
      (turn) => {
        settled.current = { turn };
        return turn;
      },
      (error: unknown) => {
        settled.current = { error };
        throw error;
      },
    );
  void pending.catch(() => undefined);
  let outcome: { turn: CuaTurn; yielded: boolean } | { error: unknown };
  try {
    const turn = await raceBounded(
      `participant ${kind}`,
      pending,
      session.remaining(),
      capMs,
      signal,
    );
    outcome = { turn, yielded: acceptedYield(kind, turn) };
  } catch (error) {
    outcome = { error };
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", onAbort);
    if (settled.current === undefined) await cleanupGrace(pending);
  }
  if ("turn" in outcome && outcome.yielded) {
    session.usage.requestPending = true;
    return outcome.turn;
  }
  const failure = "error" in outcome ? outcome.error : undefined;
  const final = settled.current;
  const typed = isCuaProviderError(failure)
    ? failure
    : final && "error" in final && isCuaProviderError(final.error)
      ? final.error
      : undefined;
  const turn = final && "turn" in final ? final.turn : undefined;
  const receipt = settledReceipt(typed?.receipt ?? turn?.providerRequest);
  const rawUsage =
    typed?.usage ?? (turn?.providerRequestPending === true ? undefined : turn?.usage);
  const usage = rawUsage === undefined ? undefined : reportedCounts(rawUsage);
  const settledKind = session.usage.settle(kind, receipt, usage, typed);
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
      settledKind === "interaction",
    );
  if (failure instanceof CuaAbortError || failure instanceof CuaDeadlineError) throw failure;
  if (failure instanceof CuaStallError)
    throw new CuaProviderError("timeout", receipt, usage, typed?.failurePhase);
  throw typed ?? new CuaProviderError("process_failed", receipt, usage);
}

/**
 * Whether a single-dispatch turn is a valid yield from a still-active interaction. A yield
 * carries actions only; a settled turn must carry a dispatched, cleaned-up receipt.
 */
function acceptedYield(kind: "interaction" | "debrief", turn: CuaTurn): boolean {
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
