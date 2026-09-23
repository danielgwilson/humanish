import { expect, it } from "vitest";
import { CuaProviderError, isCuaProviderError, type CuaProviderErrorCode } from "../src/cua-provider-error.js";
import type { ProviderRequestReceipt } from "../src/actor-contract.js";

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
