import { expect, it } from "vitest";
import { allowDeprecationsInThisTest, deprecationGuardState } from "./deprecations.js";

// tests/helpers/deprecation-guard.ts filters process.emitWarning for the whole suite. It holds back
// the humanish deprecation codes to fail the test, and passes every other warning through.

async function warningsSeen(emit: () => void): Promise<unknown[]> {
  const listeners = process.listeners("warning");
  const seen: unknown[] = [];
  process.removeAllListeners("warning");
  process.on("warning", (warning: Error & { code?: unknown }) => seen.push(warning.code));
  try {
    emit();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.removeAllListeners("warning");
    for (const listener of listeners) process.on("warning", listener);
  }
  return seen;
}

it("passes other warnings through", async () => {
  const seen = await warningsSeen(() => {
    process.emitWarning("synthetic", { type: "SyntheticWarning", code: "HUMANISH_SYNTHETIC" });
    process.emitWarning("synthetic", "SyntheticWarning", "HUMANISH_SYNTHETIC_POSITIONAL");
  });
  expect(seen).toEqual(["HUMANISH_SYNTHETIC", "HUMANISH_SYNTHETIC_POSITIONAL"]);
  expect(deprecationGuardState().unexpected).toEqual([]);
});

it("holds back a humanish deprecation without an allowance, to fail the test", async () => {
  const seen = await warningsSeen(() => {
    process.emitWarning("option form", {
      type: "DeprecationWarning",
      code: "HUMANISH_DEPRECATED_EXPORT",
    });
    process.emitWarning("positional form", "DeprecationWarning", "HUMANISH_DEPRECATED_EXPORT");
  });
  expect(seen).toEqual([]);
  // The guard's afterEach throws on these; take them so this test can pass.
  expect(deprecationGuardState().unexpected.splice(0)).toEqual([
    "[HUMANISH_DEPRECATED_EXPORT] option form",
    "[HUMANISH_DEPRECATED_EXPORT] positional form",
  ]);
});

it("drops an allowed humanish deprecation", async () => {
  allowDeprecationsInThisTest("HUMANISH_DEPRECATED_EXPORT", "the guard's own test");
  const seen = await warningsSeen(() =>
    process.emitWarning("allowed", "DeprecationWarning", "HUMANISH_DEPRECATED_EXPORT"),
  );
  expect(seen).toEqual([]);
  expect(deprecationGuardState().unexpected).toEqual([]);
});

it("ends a test's allowance with the test", () => {
  expect(deprecationGuardState().test.size).toBe(0);
});
