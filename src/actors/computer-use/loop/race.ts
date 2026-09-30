// Deadline races for port calls. A promise cannot be force-cancelled, so these stop the loop
// waiting on it when the session clock, the call's own bound or the caller's abort signal wins.
// The underlying call may still settle later. Distinct error classes let the loop tell a deadline
// or abort apart from a real adapter failure.

export class CuaDeadlineError extends Error {}
export class CuaAbortError extends Error {}
/** A single call outlived its own bound while the session still had budget: a stall, not a deadline. */
export class CuaStallError extends Error {
  constructor(
    readonly what: string,
    readonly afterMs: number,
  ) {
    super(`${what} produced nothing within ${afterMs}ms`);
  }
}

export const neverAbort: AbortSignal = new AbortController().signal;

/**
 * raceSettle with a second, tighter clock: the call's own bound. When the tighter clock wins the
 * result is a CuaStallError (the caller decides whether to retry); when the session clock wins it
 * stays a CuaDeadlineError, so the existing budget_reached / timed_out reading is untouched.
 */
export async function raceBounded<T>(
  what: string,
  promise: Promise<T>,
  remainingMs: number,
  boundMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const cap = Math.min(remainingMs, boundMs);
  const boundWins = boundMs < remainingMs;
  try {
    return await raceSettle(promise, cap, signal);
  } catch (error) {
    if (error instanceof CuaDeadlineError && boundWins) throw new CuaStallError(what, cap);
    throw error;
  }
}

/**
 * Wait on a port promise, but stop waiting if the wall-clock budget runs out or the caller
 * aborts. An already-settled promise always wins, so a fast op is never spuriously failed.
 */
export function raceSettle<T>(
  promise: Promise<T>,
  remainingMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new CuaAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      apply();
    };
    const onAbort = (): void => finish(() => reject(new CuaAbortError()));
    const timer = setTimeout(
      () => finish(() => reject(new CuaDeadlineError())),
      Math.max(0, remainingMs),
    );
    if (typeof timer.unref === "function") timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
