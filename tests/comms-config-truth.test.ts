import { describe, expect, it } from "vitest";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";

const base = {
  schema: LAB_CONFIG_SCHEMA,
  id: "mail-capture",
  subject: {
    source: "clone",
    repos: ["example-org/example-app"],
    serve: { install: "npm ci", start: "npm start", url: "http://127.0.0.1:3000/" }
  },
  actors: [{ type: "openai-computer-use", mission: "Create an account." }],
  execution: { target: "e2b-desktop" },
  scenario: { mode: "live" }
};

describe("communication declarations fail explicitly", () => {
  it.each([
    { sms: {} },
    { sms: {}, email: { injectEnv: "MAIL_API_URL" } },
    { emali: { injectEnv: "MAIL_API_URL" } }
  ])("rejects unsupported channels instead of running without them: %j", comms => {
    const result = parseLabConfig({ ...base, comms });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Unsupported comms setting");
  });

  it("retains supported email capture and absence of communications", () => {
    expect(parseLabConfig(base).ok).toBe(true);
    expect(parseLabConfig({ ...base, comms: { email: { injectEnv: "MAIL_API_URL" } } }).ok).toBe(true);
  });

  it("does not mistake a saved connection for a supported email execution route", () => {
    const result = parseLabConfig({ ...base, comms: { email: { connection: "agentmail", injectEnv: "MAIL_API_URL" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("setup only");
  });

  it.each([undefined, "MAIL_API_URL"])("rejects shared-world SMTP even when HTTP is also declared (%s)", injectEnv => {
    const result = parseLabConfig({ ...base,
      subject: { ...base.subject, topology: "shared-world" },
      comms: { email: { ...(injectEnv ? { injectEnv } : {}), smtp: { hostEnv: "SMTP_HOST", portEnv: "SMTP_PORT" } } }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("SMTP capture is not yet wired for shared-world");
  });
});
