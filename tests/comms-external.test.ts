import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #328 functional half: comms on a plane humanish does NOT provision. The adopter runs the catch;
// humanish points the persona at it, drains it over HTTP, and writes the same digest-only evidence.
//
// These tests run the REAL python catch script as a subprocess — the same bytes deployed in-sandbox
// — so the HTTP contract (POST capture, GET /deliveries, the token guard, /health's service marker)
// is proven against the actual implementation rather than a stub of it.
import { SANDBOX_CATCH_SCRIPT, collectExternalCommsThread, drainExternalCommsCatch, externalCatchHealthy, externalInboxUrl } from "../src/comms-sandbox-catch.js";
import { FakeInbox } from "../src/comms-fake-inbox.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";

const TOKEN = "test-token-not-a-secret";
let dir: string;
let child: ChildProcess | undefined;
let port: number;
let baseUrl: string;

async function waitForCatch(url: string, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await externalCatchHealthy({ catchBaseUrl: url }, { timeoutMs: 1000 })) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "humanish-external-catch-"));
  const scriptPath = path.join(dir, "catch.py");
  const deliveries = path.join(dir, "deliveries.ndjson");
  const surface = path.join(dir, "surface");
  await mkdir(surface, { recursive: true });
  await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");
  port = 18000 + Math.floor(Math.random() * 2000);
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn("python3", [scriptPath, String(port), deliveries, surface, "0", TOKEN], { stdio: "ignore" });
  const ready = await waitForCatch(baseUrl);
  if (!ready) throw new Error("catch did not become healthy");
}, 30_000);

afterAll(async () => {
  child?.kill();
  await rm(dir, { recursive: true, force: true });
});

describe("adopter-hosted comms ingress (#328)", () => {
  it("health asserts OUR service marker, so a bare 200 from someone else's server is not a catch", async () => {
    expect(await externalCatchHealthy({ catchBaseUrl: baseUrl })).toBe(true);
    // A server that answers 200 with something else must NOT pass — an adopter proxy or captive
    // portal would otherwise let a comms lab run and collect nothing.
    expect(await externalCatchHealthy({ catchBaseUrl: "https://example.test" }, { timeoutMs: 1500 })).toBe(false);
  });

  it("captures a send over HTTP and drains it back, with the token guard enforced", async () => {
    const posted = await fetch(`${baseUrl}/emails`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "no-reply@example.test",
        to: ["user@example.test"],
        subject: "Confirm your email",
        html: '<p>Verify</p><a href="https://app.example.test/verify?token=abc123">Verify</a>'
      })
    });
    expect(posted.ok).toBe(true);

    // Without the token the drain read is refused — the capture body carries a verification link.
    await expect(drainExternalCommsCatch({ catchBaseUrl: baseUrl })).rejects.toThrow(/401/);

    const drained = await drainExternalCommsCatch({ catchBaseUrl: baseUrl, authToken: TOKEN });
    expect(drained.sends).toHaveLength(1);
    expect(drained.sends[0]?.path).toBe("/emails");
    expect(drained.cursor).toBe(1);
  });

  it("collects the SAME digest-only evidence artifact the provisioned route produces", async () => {
    const channel = new FakeInbox();
    const inbox = await channel.provisionAddress("signup-01", "user@example.test");
    const collected = await collectExternalCommsThread({
      external: { catchBaseUrl: baseUrl, authToken: TOKEN },
      channel,
      inboxes: [inbox]
    });
    expect(collected.captured).toBeGreaterThanOrEqual(1);
    expect(collected.matched).toBeGreaterThanOrEqual(1);
    expect(collected.artifact).toBeDefined();
    // Digest-only: no raw address, subject, or link may appear anywhere in the artifact.
    const serialized = JSON.stringify(collected.artifact);
    expect(serialized).not.toContain("user@example.test");
    expect(serialized).not.toContain("Confirm your email");
    expect(serialized).not.toContain("abc123");
  });

  it("derives the persona inbox URL, defaulting to the catch host when no separate inbox is declared", () => {
    expect(externalInboxUrl({ catchBaseUrl: "https://catch.example.test" })).toBe("https://catch.example.test/inbox");
    expect(externalInboxUrl({ catchBaseUrl: "https://catch.example.test/" })).toBe("https://catch.example.test/inbox");
    expect(externalInboxUrl({ catchBaseUrl: "https://catch.example.test", inboxBaseUrl: "https://mail.example.test" })).toBe("https://mail.example.test/inbox");
  });
});

describe("comms.email.external config (#328)", () => {
  const appUrlLab = (comms: Record<string, unknown>) => ({
    schema: LAB_CONFIG_SCHEMA,
    id: "external-comms",
    subject: { source: "app-url", appUrl: "https://app.example.test/" },
    actors: [{ type: "openai-computer-use", count: 1, mission: "Sign up." }],
    execution: { target: "e2b-desktop" },
    policies: { allowPublicTargets: true },
    scenario: { mode: "live" },
    comms
  });

  it("makes comms LIVE on an app-url subject instead of warning it inert", () => {
    const result = parseLabConfig(appUrlLab({ email: { external: { catchBaseUrl: "https://catch.example.test" } } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The previously-inert warning must be gone: this is the whole point of the feature.
    expect(result.warnings.join("\n")).not.toContain("comms.email (the in-sandbox email/SMS catch");
    expect(result.config.comms?.email?.external?.catchBaseUrl).toBe("https://catch.example.test");
    // Recipients still auto-fill per lane, so the persona is told an address without extra config.
    expect(result.config.comms?.email?.recipients).toEqual([{ lane: "lane-01", address: "lane-01@example.test" }]);
  });

  it("drops the injectEnv requirement for an external catch (there is no subject env to inject)", () => {
    const withoutInject = parseLabConfig(appUrlLab({ email: { external: { catchBaseUrl: "https://catch.example.test" } } }));
    expect(withoutInject.ok).toBe(true);
    // ...but still refuses when NOTHING declares where mail should go, and the message names every
    // transport that would satisfy it rather than only the HTTP one.
    const neither = parseLabConfig(appUrlLab({ email: {} }));
    expect(neither.ok).toBe(false);
    if (!neither.ok) {
      expect(neither.error.message).toContain("injectEnv");
      expect(neither.error.message).toContain("smtp");
      expect(neither.error.message).toContain("external");
    }
  });

  it("rejects a non-absolute URL and a malformed token env NAME", () => {
    const badUrl = parseLabConfig(appUrlLab({ email: { external: { catchBaseUrl: "/relative" } } }));
    expect(badUrl.ok).toBe(false);
    const badEnv = parseLabConfig(appUrlLab({ email: { external: { catchBaseUrl: "https://c.example.test", authTokenEnv: "not a var" } } }));
    expect(badEnv.ok).toBe(false);
    if (!badEnv.ok) expect(badEnv.error.message).toContain("authTokenEnv");
  });

  it("warns when an external catch is declared on a route where humanish hosts its own", () => {
    const provisioned = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "conflict",
      subject: { source: "clone", repos: ["e/a"], serve: { start: "npm start", url: "http://127.0.0.1:3000/" } },
      actors: [{ type: "openai-computer-use", count: 1, mission: "Sign up." }],
      execution: { target: "e2b-desktop" },
      scenario: { mode: "live" },
      comms: { email: { injectEnv: "RESEND_API_URL", external: { catchBaseUrl: "https://catch.example.test" } } }
    });
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;
    // Two catches would exist and the app would point at humanish's, so the declared one would
    // silently collect nothing — say so rather than letting it look wired.
    expect(provisioned.warnings.join("\n")).toContain("comms.email.external");
  });
});
