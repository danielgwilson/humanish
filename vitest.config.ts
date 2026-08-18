import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Key discovery (#436) reads REAL machine state (gh auth token, ~/.e2b, ~/.config/humanish)
    // through the CLI seam; the suite runs with the documented strict flag so no developer's or
    // CI runner's credentials can leak into assertions. Discovery itself is unit-tested against
    // injected temp homes, and the CLI seam against an injected discovery fn.
    env: { HUMANISH_STRICT_KEYS: "1" },
    // Never let a stray scratch file (a reviewer probe, a half-written experiment) red the gate.
    exclude: ["**/node_modules/**", "**/_throwaway*", "**/zz-*", "**/zzz-*", "**/*.scratch.test.ts"],
    restoreMocks: true
  }
});
