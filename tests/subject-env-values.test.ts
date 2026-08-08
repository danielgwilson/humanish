// `subject.envValues`: literal, non-secret subject configuration committed with the lab.
//
// Every real app needs configuration before it will boot — a public base URL, a transport selector,
// a feature flag. None of it is secret. Before this, the only channel was `subject.env`, whose
// values come from the caller's environment, so reproducing a public study meant carrying a private
// env file full of non-secrets. That is the opposite of a reproducible lab.
//
// The tradeoff is that these values ARE recorded in evidence, so the parser refuses anything
// secret-shaped rather than letting it be committed to a public repo.
import { describe, expect, it } from "vitest";

import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";

function cloneLab(subjectExtra: Record<string, unknown>) {
  return parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "env-values-lab",
    subject: {
      source: "clone",
      repos: ["example-org/example-app"],
      serve: { install: "npm ci", build: "npm run build", start: "npm start", url: "http://127.0.0.1:3000/" },
      ...subjectExtra
    },
    actors: [{ type: "openai-computer-use", mission: "sign up" }],
    execution: { target: "e2b-desktop" },
    scenario: { mode: "live" }
  });
}

describe("subject.envValues", () => {
  it("carries the non-secret configuration an app needs to boot", () => {
    const parsed = cloneLab({
      envValues: {
        NEXT_PUBLIC_WEBAPP_URL: "http://localhost:3000",
        NEXT_PRIVATE_SMTP_TRANSPORT: "smtp-auth",
        NEXT_PUBLIC_UPLOAD_TRANSPORT: "database"
      }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.subject.envValues).toEqual({
      NEXT_PUBLIC_WEBAPP_URL: "http://localhost:3000",
      NEXT_PRIVATE_SMTP_TRANSPORT: "smtp-auth",
      NEXT_PUBLIC_UPLOAD_TRANSPORT: "database"
    });
  });

  it("accepts numbers and booleans, because YAML config is full of both", () => {
    const parsed = cloneLab({ envValues: { PORT: 3000, DANGEROUS_BYPASS_RATE_LIMITS: true } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Coerced to strings, because that is what an environment actually holds.
    expect(parsed.config.subject.envValues).toEqual({ PORT: "3000", DANGEROUS_BYPASS_RATE_LIMITS: "true" });
  });

  it("coexists with subject.env — names for secrets, values for configuration", () => {
    const parsed = cloneLab({
      env: ["NEXT_PRIVATE_DATABASE_URL"],
      envValues: { NEXT_PUBLIC_WEBAPP_URL: "http://localhost:3000" }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.subject.env).toEqual(["NEXT_PRIVATE_DATABASE_URL"]);
    expect(parsed.config.subject.envValues?.NEXT_PUBLIC_WEBAPP_URL).toBe("http://localhost:3000");
  });

  it("REFUSES a secret-shaped value rather than committing it to a public repo", () => {
    // The whole point of the guard: these values are committed and persisted, unlike subject.env.
    // Assembled at runtime so the pattern never exists as a literal in this repo — the same
    // public-surface scanner that guards the repo would (correctly) reject the file otherwise.
    const secretShaped = ["sk", "live", "51H8xQ2eZvKYlo2C0abcdefghijklmnop"].join("_");
    const parsed = cloneLab({ envValues: { STRIPE_KEY: secretShaped } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("subject.env");
    expect(parsed.error.message.toLowerCase()).toContain("secret");
  });

  it("refuses keys that are not env var names", () => {
    const parsed = cloneLab({ envValues: { "not a var": "x" } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("env var NAMES");
  });

  it("refuses a non-scalar value rather than silently stringifying an object", () => {
    const parsed = cloneLab({ envValues: { CONFIG: { nested: true } } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("string, number, or boolean");
  });
});
