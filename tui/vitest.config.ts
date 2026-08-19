import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.tsx", "tests/**/*.test.ts"],
    // Ink renders through timers and a reconciler; one fork keeps frame ordering deterministic
    // instead of interleaving several terminals in one process.
    pool: "forks",
    maxForks: 1,
    minForks: 1
  }
});
