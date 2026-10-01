import { expect, it } from "vitest";

// tests/helpers/quiet-deprecations.ts filters process.emitWarning for the whole suite. It must drop
// only the humanish deprecation codes; every other warning still reaches the listeners.
it("drops only the humanish deprecation codes", async () => {
  const listeners = process.listeners("warning");
  const seen: unknown[] = [];
  process.removeAllListeners("warning");
  process.on("warning", (warning: Error & { code?: unknown }) => seen.push(warning.code));
  try {
    for (const code of ["HUMANISH_RUN_LAB_OPTION_DEPRECATED", "HUMANISH_DEPRECATED_EXPORT"]) {
      process.emitWarning("synthetic", { type: "DeprecationWarning", code });
      process.emitWarning("synthetic", "DeprecationWarning", code);
    }
    process.emitWarning("synthetic", { type: "SyntheticWarning", code: "HUMANISH_SYNTHETIC" });
    process.emitWarning("synthetic", "SyntheticWarning", "HUMANISH_SYNTHETIC_POSITIONAL");
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.removeAllListeners("warning");
    for (const listener of listeners) process.on("warning", listener);
  }
  expect(seen).toEqual(["HUMANISH_SYNTHETIC", "HUMANISH_SYNTHETIC_POSITIONAL"]);
});
