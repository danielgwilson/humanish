// A VENDOR-NEUTRAL loopback catch server for email-send APIs (#297). An app hardwired to a hosted
// email provider is redirected into the fake bus with ONE env var and no code change: point the app's
// API base URL at this server. The catch does not depend on, or name itself after, any one vendor —
// it normalizes each provider's distinct wire shape (Resend's flat body, SendGrid's nested
// personalizations, Postmark's TitleCase, a custom app's own JSON) to one shape via pluggable
// PROFILES, and routes the result into a CommsChannel. Resend-compatible and SendGrid-compatible out
// of the box; extend with a custom profile for anything else. (There is no standardized email-send
// request shape across vendors, so normalization is by design, not a shortcut.)
//
// 127.0.0.1 only; request bodies are never logged; request size is capped.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { CommsChannel, InboundRaw } from "./comms-types.js";

/** One send, normalized across providers. `body` is html-preferred, else text. */
export interface NormalizedSend {
  from: string;
  to: string[];
  subject?: string;
  body: string;
}

/**
 * A provider wire-shape adapter. Vendor-neutral seam: the server owns the HTTP + routing + bus
 * delivery; a profile only knows how ONE provider (or a custom app) shapes its send request.
 */
export interface EmailSendProfile {
  /** Descriptive name (e.g. "generic", "sendgrid"). Not a dependency — just a label. */
  name: string;
  /** Request paths (method POST) this profile accepts a send on. */
  sendPaths: string[];
  /** Parse a POST body (already JSON-parsed) into zero+ normalized sends (a batch yields many). */
  parse(path: string, body: unknown): NormalizedSend[];
  /** Optional provider-faithful success response. Default: 200 `{ id }` (single) / `{ data:[{id}] }`. */
  respond?: (res: ServerResponse, ids: string[], batch: boolean) => void;
}

export interface EmailCatchServer {
  /** Point the app's email-API base URL here (loopback only). */
  readonly url: string;
  readonly port: number;
  /** Every normalized send accepted this run (runtime-only; for inspection/tests). */
  readonly received: NormalizedSend[];
  close(): Promise<void>;
}

export interface EmailCatchOptions {
  /** Bind host. Default 127.0.0.1 (loopback ONLY). */
  host?: string;
  /** Port. Default 0 (ephemeral). */
  port?: number;
  /** Wire-shape profiles, tried in order by path. Default [genericEmailProfile, sendgridEmailProfile]. */
  profiles?: EmailSendProfile[];
  /** Deterministic id for responses (tests). Default a zero-padded counter. */
  idFor?: (n: number) => string;
}

// ---------------------------------------------------------------- shared parse helpers
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
/** "Name <email@host>" → "email@host"; a bare address passes through. */
function bareEmail(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  return (angle ? angle[1] ?? value : value).trim();
}
/** A recipient field → address strings: an array, a single, or a comma-separated string (Postmark). */
function toAddresses(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => bareEmail(String(entry)));
  if (typeof value === "string") return value.split(",").map((part) => bareEmail(part)).filter((part) => part.length > 0);
  return [];
}

// ---------------------------------------------------------------- built-in profiles

/** The flat-JSON shape: `{ from, to, subject, html, text }`. Matches Resend (POST /emails) AND a
 *  custom app that sends the common shape AND Postmark's TitleCase keys (From/To/HtmlBody/…). */
export const genericEmailProfile: EmailSendProfile = {
  name: "generic",
  sendPaths: ["/emails", "/emails/batch", "/email", "/email/batch", "/send"],
  parse(_path, body) {
    const items = Array.isArray(body) ? body : [body];
    const out: NormalizedSend[] = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const from = str(rec.from ?? rec.From);
      const to = toAddresses(rec.to ?? rec.To);
      const subject = optStr(rec.subject ?? rec.Subject);
      const bodyValue = str(rec.html ?? rec.HtmlBody ?? rec.text ?? rec.TextBody);
      if (to.length === 0 && from === "" && bodyValue === "") continue;
      out.push({ from, to, ...(subject === undefined ? {} : { subject }), body: bodyValue });
    }
    return out;
  }
};

/** SendGrid's nested shape: `from.email`, `personalizations[].to[].email`, `content[].value`. Proves
 *  the seam handles a structurally different vendor, not just a field-name rename. */
export const sendgridEmailProfile: EmailSendProfile = {
  name: "sendgrid",
  sendPaths: ["/v3/mail/send"],
  parse(_path, body) {
    if (typeof body !== "object" || body === null) return [];
    const rec = body as Record<string, unknown>;
    const fromObj = rec.from;
    const from = typeof fromObj === "object" && fromObj !== null ? str((fromObj as Record<string, unknown>).email) : str(fromObj);
    const subject = optStr(rec.subject);
    const content = Array.isArray(rec.content) ? (rec.content as unknown[]) : [];
    const isPart = (part: unknown): part is Record<string, unknown> => typeof part === "object" && part !== null;
    const chosen =
      content.find((part) => isPart(part) && part.type === "text/html") ??
      content.find((part) => isPart(part) && part.type === "text/plain");
    const bodyValue = isPart(chosen) ? str(chosen.value) : "";
    const personalizations = Array.isArray(rec.personalizations) ? (rec.personalizations as unknown[]) : [];
    const to: string[] = [];
    for (const personalization of personalizations) {
      if (!isPart(personalization)) continue;
      const recipients = Array.isArray(personalization.to) ? (personalization.to as unknown[]) : [];
      for (const recipient of recipients) {
        if (!isPart(recipient)) continue;
        const email = str(recipient.email);
        if (email.length > 0) to.push(email);
      }
    }
    if (to.length === 0) return [];
    return [{ from, to, ...(subject === undefined ? {} : { subject }), body: bodyValue }];
  },
  respond(res, ids, _batch) {
    // SendGrid answers 202 with the id in a header and an empty body.
    res.statusCode = 202;
    if (ids[0] !== undefined) res.setHeader("x-message-id", ids[0]);
    res.end();
  }
};

export const DEFAULT_EMAIL_PROFILES: EmailSendProfile[] = [genericEmailProfile, sendgridEmailProfile];

// ---------------------------------------------------------------- server

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Reject WITHOUT destroying the socket here: the handler responds 413 cleanly first (a
        // write-after-destroy would otherwise reset the connection), then tears the request down.
        reject(new BodyTooLargeError("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Start the vendor-neutral email catch, routing accepted sends into `channel`. Returns the loopback
 * URL to hand the app as its email-API base URL. `close()` in a finally (mirror by-id teardown).
 */
export async function startEmailCatchServer(
  channel: CommsChannel,
  options: EmailCatchOptions = {}
): Promise<EmailCatchServer> {
  const host = options.host ?? "127.0.0.1";
  const profiles = options.profiles ?? DEFAULT_EMAIL_PROFILES;
  const received: NormalizedSend[] = [];
  let idCounter = 0;
  const idFor = options.idFor ?? ((n: number): string => `humanish-catch-${n.toString().padStart(6, "0")}`);

  const respondJson = (res: ServerResponse, status: number, value: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && (path === "/" || path === "/health")) {
      respondJson(res, 200, { ok: true, service: "humanish-email-catch", channel: channel.channel, profiles: profiles.map((p) => p.name) });
      return;
    }
    const profile = req.method === "POST" ? profiles.find((candidate) => candidate.sendPaths.includes(path)) : undefined;
    if (profile === undefined) {
      respondJson(res, 404, { error: "not found" });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (!res.headersSent) respondJson(res, error instanceof BodyTooLargeError ? 413 : 400, { error: "request body could not be read" });
      req.destroy();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.length > 0 ? raw : "{}");
    } catch {
      respondJson(res, 422, { error: "invalid JSON body" });
      return;
    }
    const sends = profile.parse(path, parsed);
    if (sends.length === 0) {
      // A well-formed request that names no deliverable recipient (empty body, or a shape the profile
      // could not resolve to a send) — return a bad-request rather than a fabricated success id.
      respondJson(res, 422, { error: "no deliverable message in request" });
      return;
    }
    const ids: string[] = [];
    for (const send of sends) {
      received.push(send);
      const inbound: InboundRaw = {
        from: send.from,
        to: send.to,
        ...(send.subject === undefined ? {} : { subject: send.subject }),
        body: send.body
      };
      await channel.deliverRaw(inbound);
      idCounter += 1;
      ids.push(idFor(idCounter));
    }
    const batch = Array.isArray(parsed) || path.endsWith("/batch");
    if (profile.respond) profile.respond(res, ids, batch);
    else if (batch) respondJson(res, 200, { data: ids.map((id) => ({ id })) });
    else respondJson(res, 200, { id: ids[0] ?? idFor(idCounter) });
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) respondJson(res, 500, { error: "catch server error" });
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
