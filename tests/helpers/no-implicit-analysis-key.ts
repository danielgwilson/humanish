import { afterEach, beforeEach, expect, vi } from "vitest";

// Deterministic producer tests may finish live-shaped recordings. The default
// post-run review must never inherit a developer's real provider key. Explicitly
// gated live suites retain their environment; wire tests inject their own keys.
beforeEach(() => {
  if (!expect.getState().testPath?.endsWith(".live.test.ts")) vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => { vi.unstubAllEnvs(); });
