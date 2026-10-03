import { expect, it } from "vitest";
import {
  ComputerUseProviderError,
  isComputerUseProviderError,
  type CuaProviderErrorCode,
} from "../../../src/actors/computer-use/provider-error.js";
import type { ProviderRequestReceipt } from "../../../src/actors/contract.js";
import { validActorProviderRequests } from "../../../src/actors/contract.js";

it("keeps nominal errors and immutable safe diagnostics even for JavaScript callers", () => {
  const receipt: ProviderRequestReceipt = {
    dispatched: true,
    usageComplete: false,
    cleanup: "confirmed",
  };
  const usage = { input: 7 };
  const error = new ComputerUseProviderError("cancelled", receipt, usage);
  receipt.cleanup = "unconfirmed";
  usage.input = 9;
  expect(error.receipt.cleanup).toBe("confirmed");
  expect(error.usage?.input).toBe(7);
  expect(() => Object.assign(error, { code: "raw-private-message" })).toThrow();
  expect(() => Object.assign(error.receipt, { cleanup: "raw" })).toThrow();
  expect(isComputerUseProviderError(error)).toBe(true);
  expect(isComputerUseProviderError(Object.create(ComputerUseProviderError.prototype))).toBe(false);
  for (const create of [
    () => new ComputerUseProviderError("raw-private-message" as CuaProviderErrorCode, receipt),
    () =>
      new ComputerUseProviderError("busy", {
        ...receipt,
        cleanup: ["confirmed"],
      } as unknown as ProviderRequestReceipt),
    () => new ComputerUseProviderError("busy", receipt, { input: 0.5 }),
    () => new ComputerUseProviderError("busy", receipt, { costUsd: 0 }),
  ])
    expect(create).toThrow("Invalid participant provider error declaration.");
});

it("admits only a finite failure phase and reads older receipts without it", () => {
  const receipt: ProviderRequestReceipt = {
    dispatched: false,
    usageComplete: false,
    cleanup: "confirmed",
  };
  const error = new ComputerUseProviderError("timeout", receipt, undefined, "thread/start");
  expect(error.failurePhase).toBe("thread/start");
  expect(() => Object.assign(error, { failurePhase: "response" })).toThrow();
  expect(
    () => new ComputerUseProviderError("timeout", receipt, undefined, "private/raw/path" as never),
  ).toThrow();
  const recorded = {
    ...receipt,
    ordinal: 1,
    kind: "interaction",
    profileVerified: false,
    errorCode: "timeout",
  };
  expect(validActorProviderRequests([recorded])).toBe(true);
  expect(validActorProviderRequests([{ ...recorded, failurePhase: "thread/start" }])).toBe(true);
  expect(validActorProviderRequests([{ ...recorded, failurePhase: "private/raw/path" }])).toBe(
    false,
  );
  expect(
    validActorProviderRequests([{ ...recorded, errorCode: undefined, failurePhase: "response" }]),
  ).toBe(false);
});
