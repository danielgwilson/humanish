import { describe, expect, it } from "vitest";

import { planTerminalStudy } from "../../../src/routes/terminal/plan.js";
import { sandboxCeiling } from "../../../src/substrates/e2b/lifetime.js";
import type { StudyConfig } from "../../../src/study/types.js";
import { terminalConfig } from "../../helpers/terminal-live-fake.js";

function modalConfig(execution: Partial<NonNullable<StudyConfig["execution"]>> = {}): StudyConfig {
  const config = terminalConfig({ caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } });
  config.execution = {
    ...config.execution,
    target: "modal-terminal",
    runtimeAuth: "openai-env",
    ...execution,
  };
  return config;
}

const plan = (config: StudyConfig) =>
  planTerminalStudy(config, { dryRun: false, sandboxCeiling: sandboxCeiling({}) });

describe("planning a terminal study on Modal", () => {
  it("runs on Modal and needs the Modal token pair in place of E2B_API_KEY", () => {
    const planned = plan(modalConfig());
    if (!planned.ok) throw new Error(planned.refusal.message);
    expect(planned.plan.sandboxProvider).toBe("modal");
    expect(planned.plan.requirements).toEqual([
      { kind: "key", name: "MODAL_TOKEN_ID" },
      { kind: "key", name: "MODAL_TOKEN_SECRET" },
      { kind: "key-one-of", names: ["CODEX_API_KEY", "OPENAI_API_KEY"] },
    ]);
  });

  it("refuses to keep the key outside the sandbox, which only an E2B egress rule can do", () => {
    for (const runtimeAuth of ["openai-egress", undefined] as const) {
      const config = modalConfig();
      if (runtimeAuth === undefined) delete config.execution!.runtimeAuth;
      else config.execution!.runtimeAuth = runtimeAuth;
      const refused = plan(config);
      if (refused.ok) throw new Error("expected a refusal");
      expect(refused.refusal.code).toBe("HUMANISH_TERMINAL_CREDENTIAL_DENIED");
    }
  });

  it("allows a sandbox up to Modal's 24 hours, past E2B's default hour", () => {
    // 6m of steps before the codex command and a 5m teardown buffer leave 1429m of 1440.
    const planWith = (maxMinutes: number) =>
      plan({ ...modalConfig(), caps: { maxUsd: 0, maxJobs: 0, maxMinutes } });
    expect(planWith(1429).ok).toBe(true);
    const refused = planWith(1430);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("HUMANISH_TERMINAL_CAPS_INVALID");
  });

  it("refuses an egress entry that is neither a domain nor a CIDR range", () => {
    expect(plan(modalConfig({ egressAllow: ["registry.npmjs.org", "10.0.0.0/8"] })).ok).toBe(true);
    const refused = plan(modalConfig({ egressAllow: ["203.0.113.7"] }));
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("HUMANISH_TERMINAL_SUBJECT_INVALID");
  });
});
