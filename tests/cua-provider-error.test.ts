import { expect, it } from "vitest";
import { CuaProviderError, isCuaProviderError, type CuaProviderErrorCode } from "../src/cua-provider-error.js";
import type { ProviderRequestReceipt } from "../src/actor-contract.js";
import { validActorProviderRequests } from "../src/actor-contract.js";

it("keeps nominal errors and immutable safe diagnostics even for JavaScript callers", () => {
  const receipt: ProviderRequestReceipt = { dispatched: true, usageComplete: false, cleanup: "confirmed" };
  const usage = { input: 7 };
  const error = new CuaProviderError("cancelled", receipt, usage);
  receipt.cleanup = "unconfirmed"; usage.input = 9;
  expect(error.receipt.cleanup).toBe("confirmed"); expect(error.usage?.input).toBe(7);
  expect(() => Object.assign(error, { code: "raw-private-message" })).toThrow();
  expect(() => Object.assign(error.receipt, { cleanup: "raw" })).toThrow();
  expect(isCuaProviderError(error)).toBe(true);
  expect(isCuaProviderError(Object.create(CuaProviderError.prototype))).toBe(false);
  for (const create of [() => new CuaProviderError("raw-private-message" as CuaProviderErrorCode, receipt),
    () => new CuaProviderError("busy", { ...receipt, cleanup: ["confirmed"] } as unknown as ProviderRequestReceipt),
    () => new CuaProviderError("busy", receipt, { input: 0.5 }),
    () => new CuaProviderError("busy", receipt, { costUsd: 0 })]) expect(create).toThrow("Invalid participant provider error declaration.");
});

it("admits only a finite failure phase and reads older receipts without it", () => {
  const receipt: ProviderRequestReceipt = { dispatched: false, usageComplete: false, cleanup: "confirmed" };
  const error = new CuaProviderError("timeout", receipt, undefined, "thread/start");
  expect(error.failurePhase).toBe("thread/start");
  expect(() => Object.assign(error, { failurePhase: "response" })).toThrow();
  expect(() => new CuaProviderError("timeout", receipt, undefined, "private/raw/path" as never)).toThrow();
  const recorded = { ...receipt, ordinal: 1, kind: "interaction", profileVerified: false, errorCode: "timeout" };
  expect(validActorProviderRequests([recorded])).toBe(true);
  expect(validActorProviderRequests([{ ...recorded, failurePhase: "thread/start" }])).toBe(true);
  expect(validActorProviderRequests([{ ...recorded, failurePhase: "private/raw/path" }])).toBe(false);
  expect(validActorProviderRequests([{ ...recorded, errorCode: undefined, failurePhase: "response" }])).toBe(false);
});
