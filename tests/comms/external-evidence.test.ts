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

// The warning shows its escapes decoded, so pattern redaction reads a key percent-encoded in it.
it("scrubs a known value from a warning and redacts a key that percent-encoding hid", async () => {
  const key = "sk-" + "syntheticvalue1234567890abcdef";
  vi.stubGlobal("fetch", async () => {
    throw new Error(`catch refused 7%343921 for sk%2D${key.slice(3)} at /inbox%2Fa`);
  });
  const result = await collectExternalCommsEvidence({
    external: { catchBaseUrl: "https://catch.example.test", authTokenEnv: "CATCH_TOKEN" },
    email: { kind: "fake" },
    env: { CATCH_TOKEN: "catch-token-value" },
    runPaths: {} as PreparedRunArtifactPaths,
    knownSecretValues: ["743921"],
  });
  const warning = result.warnings.join("\n");
  expect(warning).toContain("catch refused [REDACTED_SECRET] for [REDACTED_SECRET] at /inbox/a");
  expect(warning).not.toContain("743921");
  expect(warning).not.toContain(key.slice(3));
});
