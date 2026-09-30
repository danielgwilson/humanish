import type { ActorTokenUsage, ProviderRequestReceipt } from "../contract.js";

const CUA_PROVIDER_FAILURE_PHASES = [
  "startup",
  "initialize",
  "config/read",
  "account/read",
  "thread/start",
  "mcpServerStatus/list",
  "turn/start",
  "response",
  "cleanup",
] as const;
export type CuaProviderFailurePhase = (typeof CUA_PROVIDER_FAILURE_PHASES)[number];
export const isCuaProviderFailurePhase = (value: unknown): value is CuaProviderFailurePhase =>
  typeof value === "string" && (CUA_PROVIDER_FAILURE_PHASES as readonly string[]).includes(value);

const codes = Object.freeze([
  "request_rejected",
  "unavailable",
  "busy",
  "refused",
  "invalid_response",
  "protocol_error",
  "timeout",
  "cancelled",
  "process_failed",
  "cleanup_unconfirmed",
] as const);
export type CuaProviderErrorCode = (typeof codes)[number];
const errors = new WeakSet<object>();
/** Safe local classification. Never attach provider prose, stderr, paths or a raw cause. */
export class CuaProviderError extends Error {
  readonly code: CuaProviderErrorCode;
  readonly receipt: ProviderRequestReceipt;
  readonly usage?: ActorTokenUsage;
  readonly failurePhase?: CuaProviderFailurePhase;
  constructor(
    code: CuaProviderErrorCode,
    receipt: ProviderRequestReceipt,
    usage?: ActorTokenUsage,
    failurePhase?: CuaProviderFailurePhase,
  ) {
    if (
      typeof code !== "string" ||
      !codes.includes(code) ||
      !receipt ||
      typeof receipt !== "object" ||
      Object.keys(receipt).length !== 3 ||
      !(typeof receipt.dispatched === "boolean" || receipt.dispatched === "unknown") ||
      typeof receipt.usageComplete !== "boolean" ||
      (receipt.cleanup !== "confirmed" && receipt.cleanup !== "unconfirmed") ||
      (failurePhase !== undefined && !isCuaProviderFailurePhase(failurePhase)) ||
      (usage !== undefined &&
        (!usage ||
          typeof usage !== "object" ||
          Array.isArray(usage) ||
          Object.entries(usage).some(
            ([key, count]) =>
              !["input", "output", "cachedInput", "cacheWriteInput", "total"].includes(key) ||
              typeof count !== "number" ||
              !Number.isSafeInteger(count) ||
              count < 0,
          )))
    ) {
      throw new TypeError("Invalid participant provider error declaration.");
    }
    super(`Participant provider: ${code}`);
    this.name = "CuaProviderError";
    this.code = code;
    this.receipt = Object.freeze({
      dispatched: receipt.dispatched,
      usageComplete: receipt.usageComplete,
      cleanup: receipt.cleanup,
    });
    if (usage !== undefined) this.usage = Object.freeze({ ...usage });
    if (failurePhase !== undefined) this.failurePhase = failurePhase;
    for (const key of ["code", "receipt", "usage", "failurePhase"])
      Object.defineProperty(this, key, { writable: false, configurable: false });
    errors.add(this);
  }
}
export const isCuaProviderError = (value: unknown): value is CuaProviderError =>
  typeof value === "object" && value !== null && errors.has(value);

const refusals = new WeakSet<object>();
/**
 * The model provider refused the request under its usage policy (OpenAI `invalid_prompt`). A
 * refusal is the provider's decision about this prompt, so it is not a harness fault, and sending
 * the same prompt again is not a recovery path. `providerCode` is the provider's identifier only;
 * the provider's message can echo the prompt and is never attached.
 */
export class CuaPromptRefusedError extends Error {
  readonly providerCode: string;
  constructor(provider: string, providerCode: string) {
    super(`${provider} refused the prompt under its usage policy (${providerCode})`);
    this.name = "CuaPromptRefusedError";
    this.providerCode = providerCode;
    refusals.add(this);
  }
}
export const isCuaPromptRefusedError = (value: unknown): value is CuaPromptRefusedError =>
  typeof value === "object" && value !== null && refusals.has(value);
