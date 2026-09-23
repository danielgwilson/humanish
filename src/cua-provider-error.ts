import type { ActorTokenUsage, ProviderRequestReceipt } from "./actor-contract.js";

const codes = Object.freeze(["request_rejected", "unavailable", "busy", "refused", "invalid_response",
  "protocol_error", "timeout", "cancelled", "process_failed", "cleanup_unconfirmed"] as const);
export type CuaProviderErrorCode = typeof codes[number];
const errors = new WeakSet<object>();
/** Safe local classification. Never attach provider prose, stderr, paths or a raw cause. */
export class CuaProviderError extends Error {
  readonly code: CuaProviderErrorCode;
  readonly receipt: ProviderRequestReceipt;
  readonly usage?: ActorTokenUsage;
  constructor(code: CuaProviderErrorCode, receipt: ProviderRequestReceipt, usage?: ActorTokenUsage) {
    if (typeof code !== "string" || !codes.includes(code) || !receipt || typeof receipt !== "object" ||
      Object.keys(receipt).length !== 3 || !(typeof receipt.dispatched === "boolean" || receipt.dispatched === "unknown") ||
      typeof receipt.usageComplete !== "boolean" || (receipt.cleanup !== "confirmed" && receipt.cleanup !== "unconfirmed") ||
      (usage !== undefined && (!usage || typeof usage !== "object" || Array.isArray(usage) || Object.entries(usage).some(([key, count]) =>
        !["input", "output", "cachedInput", "cacheWriteInput", "total"].includes(key) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)))) {
      throw new TypeError("Invalid participant provider error declaration.");
    }
    super(`Participant provider: ${code}`);
    this.name = "CuaProviderError";
    this.code = code;
    this.receipt = Object.freeze({ dispatched: receipt.dispatched, usageComplete: receipt.usageComplete, cleanup: receipt.cleanup });
    if (usage !== undefined) this.usage = Object.freeze({ ...usage });
    for (const key of ["code", "receipt", "usage"]) Object.defineProperty(this, key, { writable: false, configurable: false });
    errors.add(this);
  }
}
export const isCuaProviderError = (value: unknown): value is CuaProviderError =>
  typeof value === "object" && value !== null && errors.has(value);
