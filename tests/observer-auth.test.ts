import { describe, expect, it } from "vitest";

import {
  SERVE_COOKIE_NAME,
  buildSessionCookie,
  createServeSessionStore,
  mintServeToken,
  parseCookies,
  sha256Digest,
  verifyTokenDigest
} from "../src/observer-auth.js";

function cookieHeaderFor(cookieValue: string): string {
  return `${SERVE_COOKIE_NAME}=${cookieValue}`;
}

describe("mintServeToken", () => {
  it("returns 43 chars of base64url encoding exactly 32 random bytes", () => {
    const token = mintServeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("returns a different token on every call", () => {
    expect(mintServeToken()).not.toBe(mintServeToken());
  });
});

describe("verifyTokenDigest", () => {
  it("accepts the token whose digest it was given", () => {
    const token = mintServeToken();
    expect(verifyTokenDigest(token, sha256Digest(token))).toBe(true);
  });

  it("rejects a wrong token of equal length", () => {
    const token = mintServeToken();
    const impostor = mintServeToken();
    expect(impostor).toHaveLength(token.length);
    expect(verifyTokenDigest(impostor, sha256Digest(token))).toBe(false);
  });

  it("rejects a different-length candidate without throwing (hash-first)", () => {
    const digest = sha256Digest(mintServeToken());
    // Raw timingSafeEqual throws on length mismatch; hashing the candidate
    // first must turn every candidate into a fixed-length comparison instead.
    for (const candidate of ["", "short", mintServeToken() + "-longer"]) {
      expect(() => verifyTokenDigest(candidate, digest)).not.toThrow();
      expect(verifyTokenDigest(candidate, digest)).toBe(false);
    }
  });
});

describe("createServeSessionStore", () => {
  const TTL_MS = 10 * 60 * 1000;

  function storeWithClock(startAt = 1_000_000) {
    let currentTime = startAt;
    const store = createServeSessionStore({ ttlMs: TTL_MS, now: () => currentTime });
    return {
      store,
      advance(byMs: number): void {
        currentTime += byMs;
      }
    };
  }

  it("validates a freshly minted session from a Cookie header", () => {
    const { store } = storeWithClock();
    const { cookieValue } = store.mint();
    expect(store.validate(cookieHeaderFor(cookieValue))).toBe(true);
  });

  it("rejects a missing or foreign cookie header", () => {
    const { store } = storeWithClock();
    store.mint();
    expect(store.validate(undefined)).toBe(false);
    expect(store.validate("")).toBe(false);
    expect(store.validate("other_cookie=hello")).toBe(false);
  });

  it("rejects a tampered cookie value even while the real session is live", () => {
    const { store } = storeWithClock();
    const { cookieValue } = store.mint();
    const tampered = cookieValue.slice(0, -1) + (cookieValue.endsWith("A") ? "B" : "A");
    expect(store.validate(cookieHeaderFor(tampered))).toBe(false);
    expect(store.validate(cookieHeaderFor(cookieValue))).toBe(true);
  });

  it("expires sessions once the injected clock passes the TTL", () => {
    const { store, advance } = storeWithClock();
    const { cookieValue } = store.mint();

    advance(TTL_MS - 1);
    expect(store.validate(cookieHeaderFor(cookieValue))).toBe(true);

    advance(1);
    expect(store.validate(cookieHeaderFor(cookieValue))).toBe(false);
    // The expired record is pruned, not just hidden.
    expect(store.sessionCount()).toBe(0);
  });

  it("revokeAll invalidates every live session", () => {
    const { store } = storeWithClock();
    const first = store.mint();
    const second = store.mint();

    store.revokeAll();

    expect(store.validate(cookieHeaderFor(first.cookieValue))).toBe(false);
    expect(store.validate(cookieHeaderFor(second.cookieValue))).toBe(false);
    expect(store.sessionCount()).toBe(0);
  });

  it("sessionCount tracks mints and revocation", () => {
    const { store } = storeWithClock();
    expect(store.sessionCount()).toBe(0);
    store.mint();
    store.mint();
    expect(store.sessionCount()).toBe(2);
    store.revokeAll();
    expect(store.sessionCount()).toBe(0);
  });

  it("exposes no surface that returns raw cookie values", () => {
    const { store } = storeWithClock();
    const { cookieValue } = store.mint();

    // mint() is the only way a raw value ever leaves the store; the public
    // surface is exactly these four methods, none of which lists sessions.
    expect(Object.keys(store).sort()).toEqual(["mint", "revokeAll", "sessionCount", "validate"]);

    // Behavioral digest check: a near-miss value never validates, and the raw
    // value is only ever accepted via the digest lookup path.
    expect(store.validate(cookieHeaderFor(cookieValue.toUpperCase()))).toBe(cookieValue === cookieValue.toUpperCase());
    expect(store.validate(cookieHeaderFor(sha256Digest(cookieValue).toString("hex")))).toBe(false);
  });
});

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    expect(parseCookies("a=b")).toEqual({ a: "b" });
  });

  it("parses multiple cookies separated by semicolons", () => {
    expect(parseCookies("a=b; c=d;e=f")).toEqual({ a: "b", c: "d", e: "f" });
  });

  it("trims whitespace around names and values", () => {
    expect(parseCookies("  a = b ;  c =d ")).toEqual({ a: "b", c: "d" });
  });

  it("keeps everything after the first equals sign as the value", () => {
    expect(parseCookies("a=b=c")).toEqual({ a: "b=c" });
  });

  it("returns an empty map for malformed or absent headers", () => {
    expect(parseCookies("a")).toEqual({});
    expect(parseCookies("=x")).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies(undefined)).toEqual({});
  });

  it("skips malformed segments without dropping well-formed neighbors", () => {
    expect(parseCookies("a; =x; c=d")).toEqual({ c: "d" });
  });

  it("round-trips the leading name=value pair of buildSessionCookie", () => {
    const cookieValue = mintServeToken();
    const setCookie = buildSessionCookie(cookieValue, { ttlSeconds: 600, secure: true });
    expect(parseCookies(setCookie)[SERVE_COOKIE_NAME]).toBe(cookieValue);
  });
});

describe("buildSessionCookie", () => {
  const cookieValue = "token-value";

  it("emits the expected attributes for a secure cookie", () => {
    const cookie = buildSessionCookie(cookieValue, { ttlSeconds: 600, secure: true });
    expect(cookie.startsWith("humanish_serve=token-value")).toBe(true);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("Secure");
  });

  it("honors the ttlSeconds option in Max-Age", () => {
    const cookie = buildSessionCookie(cookieValue, { ttlSeconds: 86_400, secure: false });
    expect(cookie).toContain("Max-Age=86400");
  });

  it("omits Secure when secure is false", () => {
    const cookie = buildSessionCookie(cookieValue, { ttlSeconds: 600, secure: false });
    expect(cookie).not.toContain("Secure");
  });

  it("never sets a Domain attribute, keeping the cookie host-only", () => {
    for (const secure of [true, false]) {
      expect(buildSessionCookie(cookieValue, { ttlSeconds: 600, secure })).not.toContain("Domain");
    }
  });
});
