import { expect } from "vitest";

// Tests that exercise a deprecated option or export make it warn once per process. Those warnings
// are expected there and only add noise to the suite's output, so this drops each humanish
// deprecation code everywhere except the file that tests it. Those files spy on
// process.emitWarning, which wraps this filter, so they see every call either way.
const QUIET_CODES = new Map([
  // Older RunLabOptions fields (src/lab/run-lab-options.ts).
  ["HUMANISH_RUN_LAB_OPTION_DEPRECATED", "tests/lab/run-lab-deprecation.test.ts"],
  // Deprecated package exports (src/deprecated.ts).
  ["HUMANISH_DEPRECATED_EXPORT", "tests/deprecated.test.ts"],
]);

// A worker runs several test files in one process and this file runs once per test file, so the
// filter always wraps the original function instead of the previous file's filter.
const ORIGINAL = Symbol.for("humanish.tests.originalEmitWarning");
type EmitWarning = (warning: string | Error, ...args: unknown[]) => void;
const holder = process as unknown as Record<symbol, EmitWarning | undefined>;
const original = (holder[ORIGINAL] ??= process.emitWarning.bind(process) as EmitWarning);

/** The code a warning was emitted with: `(warning, { code })` or `(warning, type, code)`. */
function warningCode([typeOrOptions, code]: readonly unknown[]): unknown {
  if (typeof typeOrOptions === "object" && typeOrOptions !== null)
    return (typeOrOptions as { code?: unknown }).code;
  return code;
}

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const code = warningCode(args);
  const testedIn = typeof code === "string" ? QUIET_CODES.get(code) : undefined;
  if (testedIn !== undefined && !(expect.getState().testPath ?? "").endsWith(testedIn)) return;
  original(warning, ...args);
}) as typeof process.emitWarning;
