const admissionLimits = new WeakSet<object>();

/**
 * A caller's adapter refused this request BEFORE provider dispatch because a configured
 * local control limit was reached. This is an adapter declaration, not a provider response
 * or independent transport/billing attestation. Never use it for a dispatched request whose
 * outcome or usage is unknown. Import this class from the same Humanish installation as the
 * loop/provider; names, message text and lookalike objects are not the contract.
 */
export class CuaAdmissionLimitError extends Error {
  constructor() {
    super("The adapter refused the request before provider dispatch because a local admission limit was reached.");
    this.name = "CuaAdmissionLimitError";
    admissionLimits.add(this);
  }
}

/** Internal nominal check: neither a matching payload nor a forged prototype is a declaration. */
export function isCuaAdmissionLimitError(error: unknown): error is CuaAdmissionLimitError {
  return typeof error === "object" && error !== null && admissionLimits.has(error);
}
