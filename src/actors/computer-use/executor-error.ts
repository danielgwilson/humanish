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
  cancelled: "Desktop executor request was cancelled.",
});

export type CuaExecutorErrorCode = keyof typeof messages;
export type CuaExecutorDisposition = "not_dispatched" | "outcome_uncertain";

/**
 * Why an executor refused an action before dispatch, when the participant can act on it. Each is
 * a fixed word: `extra_tab` means the local browser types only while the study's tab is its only
 * tab, and another tab is open.
 */
export const CUA_REJECTION_REASONS = Object.freeze(["extra_tab"] as const);
export type CuaRejectionReason = (typeof CUA_REJECTION_REASONS)[number];

function isCuaRejectionReason(value: unknown): value is CuaRejectionReason {
  return (CUA_REJECTION_REASONS as readonly unknown[]).includes(value);
}

export function isCuaExecutorErrorCode(value: unknown): value is CuaExecutorErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

const executorErrors = new WeakSet<object>();

/**
 * An executor's bounded failure declaration. No backend message, cause, action payload or
 * transport details belong here. `not_dispatched` requires evidence that dispatch never
 * began; a lost acknowledgement or partial action is `outcome_uncertain`, never a retry.
 * `reason` is allowed only on an `action_rejected` / `not_dispatched` refusal.
 * Import from the same installation as the loop: names and lookalike objects do not qualify.
 */
export class ComputerUseExecutorError extends Error {
  readonly code: CuaExecutorErrorCode;
  readonly disposition: CuaExecutorDisposition;
  readonly reason?: CuaRejectionReason;

  constructor(
    code: CuaExecutorErrorCode,
    disposition: CuaExecutorDisposition,
    details: { reason?: CuaRejectionReason | undefined } = {},
  ) {
    const { reason } = details;
    if (
      !isCuaExecutorErrorCode(code) ||
      (disposition !== "not_dispatched" && disposition !== "outcome_uncertain") ||
      (reason !== undefined &&
        (!isCuaRejectionReason(reason) ||
          code !== "action_rejected" ||
          disposition !== "not_dispatched"))
    ) {
      throw new TypeError("Invalid desktop executor error declaration.");
    }
    super(messages[code]);
    this.name = "ComputerUseExecutorError";
    this.code = code;
    this.disposition = disposition;
    if (reason !== undefined) this.reason = reason;
    // Keep the values used in durable diagnostics finite even for JavaScript callers.
    Object.defineProperties(this, {
      code: { writable: false, configurable: false },
      disposition: { writable: false, configurable: false },
      reason: { writable: false, configurable: false },
    });
    executorErrors.add(this);
  }
}

/** A forged prototype is not an executor declaration. */
export function isComputerUseExecutorError(error: unknown): error is ComputerUseExecutorError {
  return typeof error === "object" && error !== null && executorErrors.has(error);
}
