const messages = Object.freeze({
  executor_closed: "Desktop session is closed.",
  executor_not_ready: "Desktop executor is not ready.",
  executor_busy: "Desktop executor is handling another request.",
  invalid_request: "Desktop executor rejected an invalid request.",
  invalid_response: "Desktop executor returned an invalid response.",
  protocol_mismatch: "Desktop executor protocol does not match.",
  session_revoked: "Desktop executor session was revoked.",
  transport_failed: "Desktop executor transport failed.",
  deadline_exceeded: "Desktop executor request exceeded its deadline.",
  action_rejected: "Desktop executor rejected the action.",
  execution_failed: "Desktop executor could not complete the request.",
  cancelled: "Desktop executor request was cancelled."
});

export type CuaExecutorErrorCode = keyof typeof messages;
export type CuaExecutorDisposition = "not_dispatched" | "outcome_uncertain";

export function isCuaExecutorErrorCode(value: unknown): value is CuaExecutorErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

const executorErrors = new WeakSet<object>();

/**
 * An executor's bounded failure declaration. No backend message, cause, action payload or
 * transport details belong here. `not_dispatched` requires evidence that dispatch never
 * began; a lost acknowledgement or partial action is `outcome_uncertain`, never a retry.
 * Import from the same installation as the loop: names and lookalike objects do not qualify.
 */
export class CuaExecutorError extends Error {
  readonly code: CuaExecutorErrorCode;
  readonly disposition: CuaExecutorDisposition;

  constructor(code: CuaExecutorErrorCode, disposition: CuaExecutorDisposition) {
    if (!isCuaExecutorErrorCode(code) || (disposition !== "not_dispatched" && disposition !== "outcome_uncertain")) {
      throw new TypeError("Invalid desktop executor error declaration.");
    }
    super(messages[code]);
    this.name = "CuaExecutorError";
    this.code = code;
    this.disposition = disposition;
    // Keep the values used in durable diagnostics finite even for JavaScript callers.
    Object.defineProperties(this, {
      code: { writable: false, configurable: false },
      disposition: { writable: false, configurable: false }
    });
    executorErrors.add(this);
  }
}

/** A forged prototype is not an executor declaration. */
export function isCuaExecutorError(error: unknown): error is CuaExecutorError {
  return typeof error === "object" && error !== null && executorErrors.has(error);
}
