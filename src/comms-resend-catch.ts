// A LOOPBACK catch server that speaks the Resend `POST /emails` wire shape, so an app hardwired to
// Resend is redirected into the faux bus with ONE env var and no code change: point the app at this
// server via `RESEND_BASE_URL=<url>` (the official `resend` Node SDK reads that env var / a `baseUrl`
// option). The app's real verification email POSTs here instead of api.resend.com; we route it into
// the CommsChannel and the persona reads it. Nothing is delivered onward. (#297 — the API-first
// analog of pointing SMTP at a local catcher, since Resend is HTTPS-first and its own SMTP delivers
// for real.) 127.0.0.1 only; bodies are never logged.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { CommsChannel, InboundRaw } from "./comms-types.js";

/** A Resend send payload we accepted, normalized (runtime-only; for inspection/tests). */
export interface ResendEmailPayload {
  from: string;
  to: string[];
  subject?: string;
  html?: string;
  text?: string;
}

export interface ResendCatchServer {
  /** Point the app here: `RESEND_BASE_URL=<url>` (loopback only). */
  readonly url: string;
  readonly port: number;
  /** Every payload accepted this run (runtime-only). */
  readonly received: ResendEmailPayload[];
  close(): Promise<void>;
}

export interface ResendCatchOptions {
  /** Bind host. Default 127.0.0.1 (loopback ONLY — never bind a public interface). */
  host?: string;
  /** Port. Default 0 (ephemeral — read the chosen port off the returned server). */
  port?: number;
  /** Deterministic id for the Resend-shaped response (tests). Default a zero-padded counter. */
  idFor?: (n: number) => string;
}

/** "Name <email@host>" → "email@host"; a bare address passes through. */
function bareEmail(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  return (angle ? angle[1] ?? value : value).trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string") return [value];
  return [];
}

function normalizeResendPayload(payload: Record<string, unknown>): ResendEmailPayload {
  return {
    from: typeof payload.from === "string" ? payload.from : "",
    to: asStringArray(payload.to).map(bareEmail),
    ...(typeof payload.subject === "string" ? { subject: payload.subject } : {}),
    ...(typeof payload.html === "string" ? { html: payload.html } : {}),
    ...(typeof payload.text === "string" ? { text: payload.text } : {})
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("request body too large"));
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
 * Start the Resend-shaped catch server, routing accepted sends into `channel`. Returns the loopback
 * URL to hand the app as `RESEND_BASE_URL`. `close()` in a finally (mirror by-id teardown).
 */
export async function startResendCatchServer(
  channel: CommsChannel,
  options: ResendCatchOptions = {}
): Promise<ResendCatchServer> {
  const host = options.host ?? "127.0.0.1";
  const received: ResendEmailPayload[] = [];
  let idCounter = 0;
  const idFor = options.idFor ?? ((n: number): string => `humanish-catch-${n.toString().padStart(6, "0")}`);

  const respondJson = (res: ServerResponse, status: number, value: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (path === "/" || path === "/health")) {
      respondJson(res, 200, { ok: true, service: "humanish-resend-catch", channel: channel.channel });
      return;
    }
    // Resend's send endpoints: POST /emails (single) and /emails/batch. Batch is an array of sends.
    if (req.method === "POST" && (path === "/emails" || path === "/emails/batch")) {
      const raw = await readBody(req, MAX_BODY_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.length > 0 ? raw : "{}");
      } catch {
        respondJson(res, 422, { error: "invalid JSON body" });
        return;
      }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const ids: string[] = [];
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const payload = normalizeResendPayload(item as Record<string, unknown>);
        received.push(payload);
        const inbound: InboundRaw = {
          from: payload.from,
          to: payload.to,
          ...(payload.subject === undefined ? {} : { subject: payload.subject }),
          body: payload.html ?? payload.text ?? ""
        };
        await channel.deliverRaw(inbound);
        idCounter += 1;
        ids.push(idFor(idCounter));
      }
      // Resend-shaped response: a single send returns { id }; a batch returns { data: [{ id }, …] }.
      if (path === "/emails/batch") respondJson(res, 200, { data: ids.map((id) => ({ id })) });
      else respondJson(res, 200, { id: ids[0] ?? idFor(idCounter) });
      return;
    }
    respondJson(res, 404, { error: "not found" });
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
