// `comms.email.smtp` config surface: the transport that lets humanish study the many self-hostable
// apps that send mail over SMTP rather than a provider's HTTP API.
import { describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";

function cloneLab(email: unknown) {
  return parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "smtp-lab",
    subject: {
      source: "clone",
      repos: ["example-org/example-app"],
      serve: { install: "npm ci", build: "npm run build", start: "npm start", url: "http://127.0.0.1:3000/" }
    },
    actors: [{ type: "openai-computer-use", mission: "sign up" }],
    execution: { target: "e2b-desktop" },
    scenario: { mode: "live" },
    comms: { email }
  });
}

describe("comms.email.smtp", () => {
  it("accepts an SMTP-only lab — no HTTP base URL needed for an app that speaks SMTP", () => {
    const parsed = cloneLab({ smtp: { hostEnv: "SMTP_HOST", portEnv: "SMTP_PORT" } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.comms?.email?.smtp).toMatchObject({
      hostEnv: "SMTP_HOST",
      portEnv: "SMTP_PORT",
      port: 2525 // a default, so the port is known before the sandbox is created
    });
    expect(parsed.config.comms?.email?.injectEnv).toBeUndefined();
  });

  it("carries optional credential env vars, because many apps refuse to boot without them set", () => {
    const parsed = cloneLab({
      smtp: {
        hostEnv: "SMTP_HOST",
        portEnv: "SMTP_PORT",
        userEnv: "SMTP_USER",
        passwordEnv: "SMTP_PASS",
        port: 2600
      }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.comms?.email?.smtp).toMatchObject({
      port: 2600,
      userEnv: "SMTP_USER",
      passwordEnv: "SMTP_PASS"
    });
  });

  it("lets a lab declare BOTH transports, for an app that could use either", () => {
    const parsed = cloneLab({ injectEnv: "RESEND_BASE_URL", smtp: { hostEnv: "SMTP_HOST", portEnv: "SMTP_PORT" } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.comms?.email?.injectEnv).toBe("RESEND_BASE_URL");
    expect(parsed.config.comms?.email?.smtp?.hostEnv).toBe("SMTP_HOST");
  });

  it("refuses a half-declared SMTP block rather than silently capturing nothing", () => {
    const missingPortEnv = cloneLab({ smtp: { hostEnv: "SMTP_HOST" } });
    expect(missingPortEnv.ok).toBe(false);
    if (!missingPortEnv.ok) expect(missingPortEnv.error.message).toContain("portEnv");

    const missingHostEnv = cloneLab({ smtp: { portEnv: "SMTP_PORT" } });
    expect(missingHostEnv.ok).toBe(false);
  });

  it("refuses env names that are not valid env var names", () => {
    const bad = cloneLab({ smtp: { hostEnv: "not a var", portEnv: "SMTP_PORT" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("env var name");
  });

  it("refuses an out-of-range port", () => {
    expect(cloneLab({ smtp: { hostEnv: "H", portEnv: "P", port: 70_000 } }).ok).toBe(false);
    expect(cloneLab({ smtp: { hostEnv: "H", portEnv: "P", port: 0 } }).ok).toBe(false);
  });
});
