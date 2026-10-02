import { afterEach, expect, it, vi } from "vitest";
import { collectExternalCommsEvidence } from "../../src/comms/external-evidence.js";
import type { PreparedRunArtifactPaths } from "../../src/run/paths.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// A library caller can hand the drain a token the CLI and routes would refuse. The drain still
// promises a warning, never a rejection.
it("returns a warning, not a rejection, for a catch token that is not well-formed", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("synthetic catch outage");
  });
  const result = await collectExternalCommsEvidence({
    external: { catchBaseUrl: "https://catch.example.test", authTokenEnv: "CATCH_TOKEN" },
    email: { kind: "fake" },
    env: { CATCH_TOKEN: "x".repeat(16) + "\uD800" },
    // The failed drain never writes a file.
    runPaths: {} as PreparedRunArtifactPaths,
    knownSecretValues: [],
  });
  expect(result.path).toBeUndefined();
  expect(result.warnings.join("\n")).toContain("Comms evidence collection failed");
});
