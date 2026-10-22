import { describe, expect, it } from "vitest";
import { buildRuntimeAuth } from "../../../src/routes/terminal/credentials.js";
import { EGRESS_PLACEHOLDER } from "../../../src/substrates/e2b/egress-keys.js";
import type { StudyRuntimeAuth } from "../../../src/study/types.js";

describe("runtime auth mode", () => {
  const env = { OPENAI_API_KEY: "synthetic-runtime-value" };

  it("uses openai-egress when the study declares none", () => {
    const resolved = buildRuntimeAuth({ runtimeAuth: undefined, env });
    expect(resolved.ok && resolved.mode).toBe("openai-egress");
    expect(resolved.ok && resolved.envs.CODEX_API_KEY).toBe(EGRESS_PLACEHOLDER);
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
