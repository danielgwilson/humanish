import { describe, expect, it } from "vitest";

import {
  startExposedObserver,
  validateExposure,
  type ExposableServer,
  type ExposureRequest
} from "../src/serve-exposure.js";
import type { ServeTunnel, StartNgrokTunnelOptions } from "../src/serve-tunnel.js";

function request(overrides: Partial<ExposureRequest> = {}): ExposureRequest {
  return {
    expose: false,
    allowEmails: [],
    allowDomains: [],
    safe: false,
    ...overrides
  };
}

describe("validateExposure: serve surface (edge auth OR --safe)", () => {
  it("no exposure flags → loopback plan", () => {
    const result = validateExposure("serve", request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ exposed: false, edgeAuthed: false, mode: "loopback" });
  });

  it("--expose --tunnel ngrok --oauth google → exposed, edge-authed, warns about no allow rule", () => {
    const result = validateExposure("serve", request({ expose: true, tunnel: "ngrok", oauth: "google" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe("exposed");
    expect(result.plan.edgeAuthed).toBe(true);
    expect(result.plan.oauth).toEqual({ provider: "google", allowEmails: [], allowDomains: [] });
    expect(result.plan.warnings.join(" ")).toContain("ANY Google account");
  });

  it("--expose --tunnel ngrok --oauth google --allow-email → no allow-rule warning", () => {
    const result = validateExposure("serve", request({
      expose: true, tunnel: "ngrok", oauth: "google", allowEmails: ["you@example.com"]
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.oauth?.allowEmails).toEqual(["you@example.com"]);
    expect(result.plan.warnings.join(" ")).not.toContain("ANY Google account");
  });

  it("--expose --tunnel ngrok --safe (no oauth) → share-safe-open", () => {
    const result = validateExposure("serve", request({ expose: true, tunnel: "ngrok", safe: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe("share-safe-open");
    expect(result.plan.edgeAuthed).toBe(false);
  });

  it("--expose --tunnel ngrok (no oauth, no safe) → EXPOSE_REQUIRES_EDGE_AUTH_OR_SAFE", () => {
    const result = validateExposure("serve", request({ expose: true, tunnel: "ngrok" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_SERVE_EXPOSE_REQUIRES_EDGE_AUTH_OR_SAFE");
  });

  it("--safe --expose with no origin → EXPOSE_REQUIRES_ORIGIN (an origin-less exposed server is an unreachable no-op)", () => {
    const result = validateExposure("serve", request({ expose: true, safe: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_SERVE_EXPOSE_REQUIRES_ORIGIN");
  });

  it("--expose with no origin and no safe → EXPOSE_REQUIRES_ORIGIN (origin is required before the edge-auth/safe gate)", () => {
    const result = validateExposure("serve", request({ expose: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_SERVE_EXPOSE_REQUIRES_ORIGIN");
  });

  it("--expose --public-url → exposed (operator-secured edge)", () => {
    const result = validateExposure("serve", request({ expose: true, publicUrl: "https://observer.example.com" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe("exposed");
    expect(result.plan.edgeAuthed).toBe(true);
    expect(result.plan.publicOrigin?.host).toBe("observer.example.com");
  });

  it("--oauth google (no tunnel) → OAUTH_REQUIRES_TUNNEL", () => {
    const result = validateExposure("serve", request({ expose: true, oauth: "google" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_SERVE_OAUTH_REQUIRES_TUNNEL");
  });

  it("--allow-email (no oauth) → ALLOW_REQUIRES_OAUTH", () => {
    const result = validateExposure("serve", request({ expose: true, safe: true, allowEmails: ["a@example.com"] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_SERVE_ALLOW_REQUIRES_OAUTH");
  });

  it("--tunnel + --public-url → OPTION_CONFLICT", () => {
    const result = validateExposure("serve", request({
      expose: true, tunnel: "ngrok", oauth: "google", publicUrl: "https://observer.example.com"
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_SERVE_OPTION_CONFLICT");
  });

  it("--tunnel without --expose → TUNNEL_REQUIRES_EXPOSE", () => {
    const result = validateExposure("serve", request({ tunnel: "ngrok" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_SERVE_TUNNEL_REQUIRES_EXPOSE");
  });

  it("--safe alone (no --expose) stays a valid loopback filter", () => {
    const result = validateExposure("serve", request({ safe: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ exposed: false, mode: "loopback", safe: true });
  });
});

describe("validateExposure: watch surface (edge auth REQUIRED)", () => {
  const live = { dryRun: false, detach: false, json: false };

  it("--expose --tunnel ngrok --oauth google --allow-email → ok, exposed", () => {
    const result = validateExposure("watch", request({
      expose: true, tunnel: "ngrok", oauth: "google", allowEmails: ["you@example.com"]
    }), live);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe("exposed");
    expect(result.plan.tunnel).toBe("ngrok");
    expect(result.plan.oauth?.allowEmails).toEqual(["you@example.com"]);
  });

  it("--expose --tunnel ngrok (no oauth, no safe) → EXPOSE_REQUIRES_EDGE_AUTH", () => {
    const result = validateExposure("watch", request({ expose: true, tunnel: "ngrok" }), live);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_WATCH_EXPOSE_REQUIRES_EDGE_AUTH");
  });

  it("--expose --safe → SAFE_NOT_APPLICABLE (--safe is a `serve` library filter; a live run is never share_ready)", () => {
    const result = validateExposure("watch", request({ expose: true, safe: true }), live);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_WATCH_SAFE_NOT_APPLICABLE");
  });

  it("--expose --safe --tunnel ngrok --oauth google → SAFE_NOT_APPLICABLE (rejected even with edge auth present)", () => {
    const result = validateExposure("watch", request({
      expose: true, safe: true, tunnel: "ngrok", oauth: "google", allowEmails: ["you@example.com"]
    }), live);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_WATCH_SAFE_NOT_APPLICABLE");
  });

  it("--expose --public-url → ok (operator-secured edge)", () => {
    const result = validateExposure("watch", request({ expose: true, publicUrl: "https://observer.example.com" }), live);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe("exposed");
    expect(result.plan.tunnel).toBeUndefined();
  });

  it.each([
    ["dry-run", { dryRun: true, detach: false, json: false }],
    ["detach", { dryRun: false, detach: true, json: false }],
    ["json", { dryRun: false, detach: false, json: true }]
  ])("--expose with %s → EXPOSE_REQUIRES_LIVE_FOLLOW (checked before edge auth)", (_label, ctx) => {
    const result = validateExposure("watch", request({ expose: true, tunnel: "ngrok" }), ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HUMANISH_WATCH_EXPOSE_REQUIRES_LIVE_FOLLOW");
  });

  it("no exposure flags → loopback (a plain live watch is unaffected)", () => {
    const result = validateExposure("watch", request(), live);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe("loopback");
  });
});

describe("startExposedObserver", () => {
  function fakeServer(): ExposableServer & { added: string[] } {
    const added: string[] = [];
    return {
      port: 4321,
      url: "http://127.0.0.1:4321/observer/index.html",
      added,
      addPublicOrigin(origin: string) {
        added.push(origin);
      }
    };
  }

  it("spawns the tunnel with mapped oauth args and extends the Host allowlist", async () => {
    const calls: StartNgrokTunnelOptions[] = [];
    const server = fakeServer();
    const validated = validateExposure("watch", request({
      expose: true, tunnel: "ngrok", oauth: "google", allowEmails: ["you@example.com"], allowDomains: ["example.com"]
    }), { dryRun: false, detach: false, json: false });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const result = await startExposedObserver(server, validated.plan, {
      startTunnel: async (options): Promise<ServeTunnel> => {
        calls.push(options);
        return { url: "https://observer.example.com/", close: async () => {} };
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.port).toBe(4321);
    expect(calls[0]?.oauthProvider).toBe("google");
    expect(calls[0]?.oauthAllowEmails).toEqual(["you@example.com"]);
    expect(calls[0]?.oauthAllowDomains).toEqual(["example.com"]);
    expect(result.publicUrl).toBe("https://observer.example.com");
    expect(server.added).toEqual(["https://observer.example.com/"]);
  });

  it("declares an operator --public-url without spawning a tunnel", async () => {
    const server = fakeServer();
    const validated = validateExposure("watch", request({ expose: true, publicUrl: "https://observer.example.com" }), {
      dryRun: false, detach: false, json: false
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    let spawned = false;
    const result = await startExposedObserver(server, validated.plan, {
      startTunnel: async () => {
        spawned = true;
        return { url: "unused", close: async () => {} };
      }
    });

    expect(spawned).toBe(false);
    expect(result.tunnel).toBeUndefined();
    expect(result.publicUrl).toBe("https://observer.example.com");
    expect(server.added).toEqual(["https://observer.example.com"]);
  });
});
