import { afterAll, afterEach } from "vitest";
import {
  deprecationGuardState,
  isHumanishDeprecation,
  resetDeprecationGuard,
} from "./deprecations.js";

// A humanish DeprecationWarning means first-party code used a surface that the next minor
// removes, so it fails the test that emitted it. A test that uses that surface on purpose allows
// the code with allowDeprecationsInThisTest (./deprecations.ts);
// allowed warnings are dropped so they do not clutter the suite's output. Every other warning
// reaches its listeners unchanged. Tests that spy on process.emitWarning wrap this filter, so
// they still see every call.
//
// A deprecation that warns once per process emits nothing after an allowed test triggers it, so
// a later test in the same file that uses the same surface emits nothing for this guard to catch.

// A worker runs several test files in one process and this file runs once per test file, so the
// filter always wraps the original function instead of the previous file's filter.
const ORIGINAL = Symbol.for("humanish.tests.originalEmitWarning");
type EmitWarning = (warning: string | Error, ...args: unknown[]) => void;
const holder = process as unknown as Record<symbol, EmitWarning | undefined>;
const original = (holder[ORIGINAL] ??= process.emitWarning.bind(process) as EmitWarning);

resetDeprecationGuard();

/** The type and code a warning was emitted with: `(warning, { type, code })` or `(warning, type, code)`. */
function typeAndCode(
  warning: string | Error,
  [typeOrOptions, code]: readonly unknown[],
): unknown[] {
  if (typeof typeOrOptions === "object" && typeOrOptions !== null) {
    const options = typeOrOptions as { type?: unknown; code?: unknown };
    return [options.type ?? (warning instanceof Error ? warning.name : undefined), options.code];
  }
  return [typeOrOptions ?? (warning instanceof Error ? warning.name : undefined), code];
}

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const [type, code] = typeAndCode(warning, args);
  if (!isHumanishDeprecation(type, code)) {
    original(warning, ...args);
    return;
  }
  const state = deprecationGuardState();
  if (state.test.has(code)) return;
  state.unexpected.push(`[${code}] ${typeof warning === "string" ? warning : warning.message}`);
}) as typeof process.emitWarning;

function failOnUnexpected(): void {
  const found = deprecationGuardState().unexpected.splice(0);
  if (found.length === 0) return;
  throw new Error(
    "A humanish DeprecationWarning fired without an allowance. Use the replacement it names, or, " +
      "when the test is about the deprecated surface, call allowDeprecationsInThisTest from " +
      `tests/helpers/deprecations.ts with the reason.\n${found.join("\n")}`,
  );
}

afterEach(() => {
  deprecationGuardState().test.clear();
  failOnUnexpected();
});

// A warning from an afterAll hook, or from a file whose tests all skipped, has no test to fail.
afterAll(failOnUnexpected);
