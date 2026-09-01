import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Key discovery (#436) reads REAL machine state (gh auth token, ~/.e2b, ~/.config/humanish)
    // through the CLI seam; the suite runs with the documented strict flag so no developer's or
    // CI runner's credentials can leak into assertions. Discovery itself is unit-tested against
    // injected temp homes, and the CLI seam against an injected discovery fn.
    // The suite must never reach the adoption dataset. Before this, humanish's own CI and tests
    // were 82% of all telemetry events (4,042 of 4,932, 49 of 59 anonymous ids) in the two days
    // after telemetry shipped. Belt and braces with the source-checkout guard in src/telemetry.ts:
    // a test that constructs its own cwd in a temp dir would slip past that check alone.
    env: { HUMANISH_STRICT_KEYS: "1", HUMANISH_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
    // Never let a stray scratch file (a reviewer probe, a half-written experiment) red the gate.
    exclude: ["**/node_modules/**", "**/_throwaway*", "**/zz-*", "**/zzz-*", "**/*.scratch.test.ts"],
    restoreMocks: true
  }
});
