import { describe, expect, it } from "vitest";
import { STUDY_SCHEMA } from "../../src/study/types.js";
import { parseStudy } from "../../src/study/config.js";

const base = {
  schema: STUDY_SCHEMA,
  id: "mail-capture",
  route: "computer-use",
  mode: "live",
  subject: {
    source: "clone",
    repos: ["example-org/example-app"],
    serve: { install: "npm ci", start: "npm start", url: "http://127.0.0.1:3000/" },
  },
  actor: { type: "openai-computer-use", mission: "Create an account." },
  execution: { target: "e2b-desktop" },
};

describe("communication declarations fail explicitly", () => {
  it.each([
    { sms: {} },
    { sms: {}, email: { injectEnv: "MAIL_API_URL" } },
    { emali: { injectEnv: "MAIL_API_URL" } },
  ])("rejects unsupported channels instead of running without them: %j", (comms) => {
    const result = parseStudy({ ...base, comms });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Unknown study field in `comms`");
  });

  it("retains supported email capture and absence of communications", () => {
    expect(parseStudy(base).ok).toBe(true);
    expect(parseStudy({ ...base, comms: { email: { injectEnv: "MAIL_API_URL" } } }).ok).toBe(true);
  });

  it("rejects mixing real receiving and local capture", () => {
    const result = parseStudy({
      ...base,
      comms: { email: { connection: "agentmail", injectEnv: "MAIL_API_URL" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("cannot be mixed");
  });

  it.each([undefined, "MAIL_API_URL"])(
    "rejects shared-world SMTP even when HTTP is also declared (%s)",
    (injectEnv) => {
      const result = parseStudy({
        ...base,
        route: "shared-world",
        participants: [{ id: "host" }, { id: "guest" }],
        comms: {
          email: {
            ...(injectEnv ? { injectEnv } : {}),
            smtp: { hostEnv: "SMTP_HOST", portEnv: "SMTP_PORT" },
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.message).toContain(
          "SMTP capture is not supported yet for shared-world",
        );
    },
  );
});
