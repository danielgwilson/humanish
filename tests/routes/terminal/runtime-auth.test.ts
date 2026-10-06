import type { Sandbox } from "@e2b/desktop";
import { describe, expect, it } from "vitest";
import { buildRuntimeAuth } from "../../../src/routes/terminal/credentials.js";
import {
  buildOpenAiEgressNetwork,
  OPENAI_EGRESS_PLACEHOLDER,
} from "../../../src/routes/terminal/runtime-auth.js";
import type { StudyRuntimeAuth } from "../../../src/study/types.js";

// The network request contract is checked against the installed Desktop SDK's real create
// overload, not a hand-authored provider response fixture. No sandbox or provider call occurs.
type InstalledSdkNetwork = NonNullable<
  NonNullable<Parameters<typeof Sandbox.create>[1]>["network"]
>;

describe("OpenAI egress runtime auth request", () => {
  it("is assignable to the installed SDK and adds an exact-host transform without routing restrictions", () => {
    const network: InstalledSdkNetwork = buildOpenAiEgressNetwork("synthetic-test-value");
    expect(network).toEqual({
      rules: {
        "api.openai.com": [
          { transform: { headers: { Authorization: "Bearer synthetic-test-value" } } },
        ],
      },
    });
    expect(OPENAI_EGRESS_PLACEHOLDER).toBe("humanish-egress-auth-placeholder");
  });

  it("preserves an adopter's routing and unrelated host rules without mutating them", () => {
    const existing = {
      allowOut: ["example.com"],
      denyOut: ["0.0.0.0/0"],
      rules: { "example.com": [{ transform: { headers: { "X-Study": "yes" } } }] },
    };
    const before = JSON.stringify(existing);
    const network = buildOpenAiEgressNetwork("synthetic-test-value", existing);
    expect(network.allowOut).toEqual(existing.allowOut);
    expect(network.denyOut).toEqual(existing.denyOut);
    expect(network.rules?.["example.com"]).toEqual(existing.rules["example.com"]);
    expect(JSON.stringify(existing)).toBe(before);
  });

  it.each(["api.openai.com", "API.OPENAI.COM", "api.openai.com."])(
    "refuses an existing %s rule without exposing values",
    (host) => {
      expect(() =>
        buildOpenAiEgressNetwork("synthetic-new-value", {
          rules: {
            [host]: [{ transform: { headers: { Authorization: "synthetic-existing-value" } } }],
          },
        }),
      ).toThrow(
        "openai-egress conflicts with an existing api.openai.com network rule; refusing to overwrite it.",
      );
    },
  );
});

describe("runtime auth mode", () => {
  const env = { OPENAI_API_KEY: "synthetic-runtime-value" };

  it("uses openai-egress when the study declares none", () => {
    const resolved = buildRuntimeAuth({ runtimeAuth: undefined, env });
    expect(resolved.ok && resolved.mode).toBe("openai-egress");
    expect(resolved.ok && resolved.envs.CODEX_API_KEY).toBe(OPENAI_EGRESS_PLACEHOLDER);
    expect(JSON.stringify(resolved.ok && resolved.envs)).not.toContain("synthetic-runtime-value");
  });

  it("refuses a mode it does not know instead of placing the key", () => {
    const resolved = buildRuntimeAuth({
      runtimeAuth: "openai-egres" as unknown as StudyRuntimeAuth,
      env,
    });
    expect(resolved).toMatchObject({ ok: false, code: "HUMANISH_TERMINAL_CREDENTIAL_DENIED" });
    expect(JSON.stringify(resolved)).not.toContain("synthetic-runtime-value");
  });

  it.each([
    [undefined, "`execution.runtimeAuth` is unset, so the default openai-egress keeps the key"],
    ["openai-egress", "`execution.runtimeAuth: openai-egress` keeps the key"],
    ["openai-env", "`execution.runtimeAuth: openai-env` passes the key"],
  ] as const)(
    "names the missing keys and where runtimeAuth %s puts one",
    (runtimeAuth, placement) => {
      const resolved = buildRuntimeAuth({ runtimeAuth, env: {} });
      expect(resolved).toMatchObject({ ok: false, code: "HUMANISH_TERMINAL_RUNTIME_AUTH_MISSING" });
      const message = resolved.ok ? "" : resolved.message;
      expect(message).toContain(
        "need CODEX_API_KEY or OPENAI_API_KEY in the environment, and neither is set.",
      );
      expect(message).toContain(placement);
      expect(message).not.toContain("undefined");
    },
  );
});
