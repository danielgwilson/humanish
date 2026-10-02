// Shared state for tests/helpers/deprecation-guard.ts, the setup file that fails a test when a
// humanish DeprecationWarning fires in it. A test that uses a deprecated option or export on
// purpose says so with allowDeprecationsInThisTest below.
//
// The state lives on globalThis, so a test file that imports this module sees the same state as
// the setup file even if the two imports evaluate it separately.

/** The deprecation codes humanish emits: src/deprecated.ts and src/lab/adapter-extension.ts. */
export const HUMANISH_DEPRECATION_CODES = [
  "HUMANISH_DEPRECATED_EXPORT",
  "HUMANISH_SCORING_CONTEXT_FIELD_DEPRECATED",
] as const;
export type HumanishDeprecationCode = (typeof HUMANISH_DEPRECATION_CODES)[number];

interface DeprecationGuardState {
  /** Codes the running test allows. Cleared after each test. */
  readonly test: Set<string>;
  /** Warnings no allowance covered, waiting for the next check. */
  readonly unexpected: string[];
}

const KEY = Symbol.for("humanish.tests.deprecationGuard");
const holder = globalThis as unknown as Record<symbol, DeprecationGuardState | undefined>;

export function deprecationGuardState(): DeprecationGuardState {
  return (holder[KEY] ??= { test: new Set(), unexpected: [] });
}

/** Starts a test file with no allowances. The setup file calls this once per test file. */
export function resetDeprecationGuard(): void {
  holder[KEY] = { test: new Set(), unexpected: [] };
}

/** Lets the running test emit `code`. Call it inside the test. `reason` is for the reader. */
export function allowDeprecationsInThisTest(code: HumanishDeprecationCode, reason: string): void {
  void reason;
  deprecationGuardState().test.add(code);
}
