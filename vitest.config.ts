import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Runs the suite in its own temp dir and fails it when a test leaves a humanish-* entry there.
    globalSetup: ["./tests/helpers/tmp-leak-guard.ts"],
    setupFiles: [
      "./tests/helpers/no-implicit-analysis-key.ts",
      "./tests/helpers/deprecation-guard.ts",
    ],
    // Key discovery reads machine state (gh auth token, ~/.e2b, ~/.config/humanish).
    // HUMANISH_STRICT_KEYS=1 turns it off for the suite, so a developer's or CI runner's
    // credentials never reach an assertion; discovery is tested against injected temp homes.
    // HUMANISH_TELEMETRY_DISABLED and DO_NOT_TRACK keep the suite out of the adoption dataset.
    // src/cli/telemetry.ts also skips a source checkout, but a test that builds its cwd in a temp
    // dir would pass that check. Blank HUMANISH_E2B_MAX_SANDBOX_MINUTES and
    // HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES keep the plans at the default E2B limits on a machine
    // whose shell raises them for an E2B Pro plan.
    env: {
      HUMANISH_STRICT_KEYS: "1",
      HUMANISH_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      HUMANISH_E2B_MAX_SANDBOX_MINUTES: "",
      HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES: "",
    },
    // A file named *.scratch.test.ts is a local experiment and never runs in the suite.
    exclude: ["**/node_modules/**", "**/*.scratch.test.ts"],
    restoreMocks: true,
    // Many tests spawn git, python3 or tsx, which can exceed vitest's 5 s default on a loaded
    // CI runner.
    testTimeout: 20_000,
  },
});
