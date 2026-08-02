// Shared HTTP hardening primitives for the serve surfaces. Extracted here so BOTH the live
// Observer server (src/observer.ts, exposed mode) and the run-library server
// (src/observer-serve.ts) can enforce the identical Host allowlist + security-header posture
// without a module cycle. This file imports nothing from the serve modules.

// The exposure mode a serve/watch surface is running in.
// - "loopback": no exposure declared; bound to 127.0.0.1 for local viewing only.
// - "exposed": reachable through an authenticated edge (ngrok --oauth or an operator --public-url);
//   serves every run unless --safe narrows it.
// - "share-safe-open": reachable openly (no edge auth) but admits only share_ready runs (--safe).
export type ServeMode = "loopback" | "exposed" | "share-safe-open";

export function buildServeSecurityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow"
  };
}

export function hostAllowed(hostHeader: string | undefined, allowlist: ReadonlySet<string>): boolean {
  return typeof hostHeader === "string" && allowlist.has(hostHeader.trim().toLowerCase());
}

export function parsePublicOrigin(value: string): { origin: string; host: string; scheme: "http" | "https" } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash || !parsed.host) {
    return null;
  }
  return {
    origin: parsed.origin,
    host: parsed.host.toLowerCase(),
    scheme: parsed.protocol === "https:" ? "https" : "http"
  };
}
