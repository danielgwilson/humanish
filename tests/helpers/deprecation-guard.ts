import { afterAll, afterEach } from "vitest";
import {
  deprecationGuardState,
  HUMANISH_DEPRECATION_CODES,
  resetDeprecationGuard,
} from "./deprecations.js";

// A humanish DeprecationWarning means first-party code used a surface that the next minor
// removes, so it fails the test that emitted it. A test that uses that surface on purpose allows
// the code with allowDeprecationsInThisTest (./deprecations.ts);
// allowed warnings are dropped so they do not clutter the suite's output. Every other warning
// reaches its listeners unchanged. Tests that spy on process.emitWarning wrap this filter, so
// they still see every call.
//
// Each deprecated export warns once per process, so after an allowed test triggers it, a later
// test in the same file that uses the same export emits nothing for this guard to catch.

const CODES: ReadonlySet<string> = new Set(HUMANISH_DEPRECATION_CODES);

// A worker runs several test files in one process and this file runs once per test file, so the
// filter always wraps the original function instead of the previous file's filter.
const ORIGINAL = Symbol.for("humanish.tests.originalEmitWarning");
type EmitWarning = (warning: string | Error, ...args: unknown[]) => void;
const holder = process as unknown as Record<symbol, EmitWarning | undefined>;
const original = (holder[ORIGINAL] ??= process.emitWarning.bind(process) as EmitWarning);

resetDeprecationGuard();

/** The code a warning was emitted with: `(warning, { code })` or `(warning, type, code)`. */
function warningCode([typeOrOptions, code]: readonly unknown[]): unknown {
  if (typeof typeOrOptions === "object" && typeOrOptions !== null)
    return (typeOrOptions as { code?: unknown }).code;
  return code;
}

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const code = warningCode(args);
  if (typeof code !== "string" || !CODES.has(code)) {
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
