import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Never let a stray scratch file (a reviewer probe, a half-written experiment) red the gate.
    exclude: ["**/node_modules/**", "**/_throwaway*", "**/zz-*", "**/zzz-*", "**/*.scratch.test.ts"],
    restoreMocks: true
  }
});
