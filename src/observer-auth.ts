import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SERVE_COOKIE_NAME = "humanish_serve";

export interface ServeSessionStore {
  mint(): { cookieValue: string };
  validate(cookieHeader: string | undefined): boolean;
  revokeAll(): void;
  sessionCount(): number;
}

export function mintServeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// Hash-first comparison: both sides become fixed-length digests before
// timingSafeEqual, so an attacker-controlled candidate can neither throw on
// length mismatch nor learn the token length.
export function verifyTokenDigest(candidate: string, digest: Buffer): boolean {
  return timingSafeEqual(sha256Digest(candidate), digest);
}

interface ServeSessionRecord {
  readonly expiresAt: number;
  readonly scope: "viewer";
}

export function createServeSessionStore(options: {
  ttlMs: number;
  now?: () => number;
}): ServeSessionStore {
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, ServeSessionRecord>();

  return {
    mint(): { cookieValue: string } {
      const cookieValue = randomBytes(32).toString("base64url");
      sessions.set(sha256Digest(cookieValue).toString("hex"), {
        expiresAt: now() + options.ttlMs,
        scope: "viewer"
      });
      return { cookieValue };
    },
    validate(cookieHeader: string | undefined): boolean {
      const cookieValue = parseCookies(cookieHeader)[SERVE_COOKIE_NAME];
      if (!cookieValue) {
        return false;
      }
      const record = sessions.get(sha256Digest(cookieValue).toString("hex"));
      if (!record || record.scope !== "viewer") {
        return false;
      }
      if (record.expiresAt <= now()) {
        sessions.delete(sha256Digest(cookieValue).toString("hex"));
        return false;
      }
      return true;
    },
    revokeAll(): void {
      sessions.clear();
    },
    sessionCount(): number {
      return sessions.size;
    }
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function buildSessionCookie(
  cookieValue: string,
  options: { ttlSeconds: number; secure: boolean }
): string {
  const attributes = [
    `${SERVE_COOKIE_NAME}=${cookieValue}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.ttlSeconds}`
  ];
  if (options.secure) {
    attributes.push("Secure");
  }
  // Deliberately no Domain attribute: a host-only cookie on the public origin
  // can never leak to sibling subdomains of a shared tunnel domain.
  return attributes.join("; ");
}
