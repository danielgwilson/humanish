import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  buildHistoryIndex,
  matchRunRoute,
  pinDirectChildDirectory,
  pinDirectory,
  serveRunPath
} from "./observer.js";
import type { PinnedDirectory } from "./observer.js";
import {
  buildSessionCookie,
  createServeSessionStore,
  mintServeToken,
  sha256Digest,
  verifyTokenDigest
} from "./observer-auth.js";
import type { ServeSessionStore } from "./observer-auth.js";
import { renderLibraryHtml } from "./observer-library.js";
import type { LibraryHistory } from "./observer-library.js";
import { listRuns, verifyRun } from "./run.js";

export const SERVE_SCHEMA = "humanish.serve-result.v1";

export type ServeMode = "loopback" | "capability-link" | "share-safe-open";

export type ServeErrorCode =
  | "HUMANISH_INVALID_PORT"
  | "HUMANISH_SERVE_INVALID_TTL"
  | "HUMANISH_SERVE_OPTION_CONFLICT"
  | "HUMANISH_SERVE_TUNNEL_REQUIRES_EXPOSE"
  | "HUMANISH_SERVE_EXPOSE_REQUIRES_ORIGIN"
  | "HUMANISH_SERVE_OPEN_REQUIRES_SAFE"
  | "HUMANISH_SERVE_TUNNEL_NOT_FOUND"
  | "HUMANISH_SERVE_TUNNEL_START_FAILED"
  | "HUMANISH_RUN_NOT_FOUND"
  | "HUMANISH_SERVE_RUN_NOT_SHAREABLE";

export interface ServeResult {
  schema: typeof SERVE_SCHEMA;
  ok: boolean;
  cwd: string;
  mode: ServeMode;
  safe: boolean;
  host: "127.0.0.1";
  port?: number;
  url?: string;
  capabilityUrl?: string;
  publicUrl?: string;
  publicCapabilityUrl?: string;
  tunnel?: { provider: "ngrok"; url: string };
  ttlMinutes?: number;
  runsListed: number;
  shareReadyCount?: number;
  entryRunId?: string;
  opened?: boolean;
  openCommand?: string;
  warnings: string[];
  error?: { code: ServeErrorCode; message: string };
}

// v2 seam: declared, never implemented in v1. When provided, the reserved
// /_humanish/api/* namespace would dispatch into it; v1 always passes undefined
// and the namespace answers 501.
export interface ServeControlPlane {
  startRun?(request: { labId: string; dryRun: boolean }): Promise<{ accepted: boolean; runId?: string }>;
}

export interface ShareSafetyAdmission {
  admit(runId: string): Promise<boolean>;
}

export function createShareSafetyAdmission(
  cwd: string,
  options: { verifyImpl?: typeof verifyRun } = {}
): ShareSafetyAdmission {
  const verifyImpl = options.verifyImpl ?? verifyRun;
  const cache = new Map<string, { identity: string; admitted: Promise<boolean> }>();

  const bundleIdentity = async (runId: string): Promise<string | null> => {
    try {
      const stats = await lstat(path.join(cwd, ".humanish", "runs", runId, "run.json"), { bigint: true });
      if (!stats.isFile()) {
        return null;
      }
      return `${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.size}`;
    } catch {
      return null;
    }
  };

  return {
    async admit(runId: string): Promise<boolean> {
      const identity = await bundleIdentity(runId);
      if (!identity) {
        cache.delete(runId);
        return false;
      }

      const cached = cache.get(runId);
      if (cached && cached.identity === identity) {
        return cached.admitted;
      }

      const admitted = verifyImpl(cwd, runId)
        .then((verified) => verified.ok === true && verified.shareSafety.status === "share_ready")
        .catch(() => false);
      cache.set(runId, { identity, admitted });
      return admitted;
    }
  };
}

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

export function parsePublicOrigin(value: string): { origin: string; host: string } | null {
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
  return { origin: parsed.origin, host: parsed.host.toLowerCase() };
}

export interface ServeAuthContext {
  tokenDigest: Buffer;
  sessions: ServeSessionStore;
  ttlSeconds: number;
}

export interface ServeRequestHandlerOptions {
  proofRoot: PinnedDirectory;
  safe: boolean;
  admit?: (runId: string) => Promise<boolean>;
  auth?: ServeAuthContext | null;
  hostAllowlist: ReadonlySet<string>;
  entryRunId?: string;
  renderLibrary: (history: LibraryHistory) => string;
  controlPlane?: ServeControlPlane;
}

const UNAUTHORIZED_BODY = "humanish serve: capability link required";

export function createServeRequestHandler(
  options: ServeRequestHandlerOptions
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      for (const [name, value] of Object.entries(buildServeSecurityHeaders())) {
        response.setHeader(name, value);
      }

      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        writeText(response, 405, "Method Not Allowed");
        return;
      }

      if (!hostAllowed(request.headers.host, options.hostAllowlist)) {
        writeText(response, 421, "Misdirected Request");
        return;
      }

      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

      if (options.auth) {
        const mintMatch = url.pathname.match(/^\/_humanish\/auth\/([^/]+)$/);
        if (mintMatch) {
          let candidate = "";
          try {
            candidate = decodeURIComponent(mintMatch[1] ?? "");
          } catch {
            candidate = "";
          }
          if (candidate && verifyTokenDigest(candidate, options.auth.tokenDigest)) {
            const { cookieValue } = options.auth.sessions.mint();
            const forwardedProto = request.headers["x-forwarded-proto"];
            const secure = typeof forwardedProto === "string"
              && forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
            response.setHeader(
              "set-cookie",
              buildSessionCookie(cookieValue, { ttlSeconds: options.auth.ttlSeconds, secure })
            );
            response.writeHead(302, { location: "/" });
            response.end();
            return;
          }
          writeText(response, 401, UNAUTHORIZED_BODY);
          return;
        }

        // Every route below requires a valid session, regardless of source
        // address: the tunnel agent connects from 127.0.0.1, so a loopback-peer
        // trust shortcut would disable auth in exactly the deployment it protects.
        if (!options.auth.sessions.validate(request.headers.cookie)) {
          writeText(response, 401, UNAUTHORIZED_BODY);
          return;
        }
      } else if (url.pathname.startsWith("/_humanish/auth/")) {
        writeText(response, 404, "Not found");
        return;
      }

      if (url.pathname === "/_humanish/api" || url.pathname.startsWith("/_humanish/api/")) {
        writeText(
          response,
          501,
          `${JSON.stringify({
            error: {
              code: "HUMANISH_SERVE_CONTROL_PLANE_DISABLED",
              message: "control plane not enabled in this version"
            }
          }, null, 2)}\n`,
          "application/json; charset=utf-8"
        );
        return;
      }

      if (url.pathname === "/") {
        if (options.entryRunId) {
          response.writeHead(302, {
            location: `/_humanish/runs/${encodeURIComponent(options.entryRunId)}/observer/index.html`
          });
          response.end();
          return;
        }
        const history = await loadFilteredHistory(options);
        writeText(response, 200, options.renderLibrary(history), "text/html; charset=utf-8");
        return;
      }

      if (url.pathname === "/_humanish/history.json") {
        const history = await loadFilteredHistory(options);
        writeText(response, 200, JSON.stringify(history, null, 2), "application/json; charset=utf-8");
        return;
      }

      if (url.pathname.startsWith("/_humanish/runs/")) {
        const runRoute = matchRunRoute(url.pathname);
        if (!runRoute) {
          writeText(response, 404, "Run not found");
          return;
        }
        if (options.safe && options.admit && !(await options.admit(runRoute.runId))) {
          // Byte-identical to the nonexistent-run 404: no existence oracle.
          writeText(response, 404, "Run not found");
          return;
        }
        const targetRoot = await pinDirectChildDirectory(options.proofRoot, runRoute.runId);
        if (!targetRoot) {
          writeText(response, 404, "Run not found");
          return;
        }
        // The explicit empty runtimeStreamUrls keeps a future refactor from
        // reintroducing auth-keyed stream injection on the serve surface.
        await serveRunPath(targetRoot, runRoute.relativePath || "observer/index.html", response, []);
        return;
      }

      writeText(response, 404, "Not found");
    } catch {
      writeText(response, 500, "Observer request failed");
    }
  };
}

async function loadFilteredHistory(options: ServeRequestHandlerOptions): Promise<LibraryHistory> {
  const history = await buildHistoryIndex(options.proofRoot);
  if (!options.safe || !options.admit) {
    return history;
  }

  const admissions = await Promise.all(
    history.runs.map(async (run) => ((await options.admit?.(run.runId)) === true ? run : null))
  );
  const runs = admissions.filter((run): run is LibraryHistory["runs"][number] => run !== null);
  const latestRunId = runs.some((run) => run.runId === history.latestRunId)
    ? history.latestRunId
    : runs[0]?.runId ?? null;
  return { latestRunId, runs };
}

export interface ServeLibraryOptions {
  port: number;
  safe: boolean;
  expose: boolean;
  authMode: "link" | "none";
  ttlMinutes: number;
  publicOrigin?: string;
  entryRunId?: string;
  controlPlane?: ServeControlPlane;
  verifyImpl?: typeof verifyRun;
  now?: () => number;
}

export interface ServeLibraryServer {
  url: string;
  port: number;
  mode: ServeMode;
  capabilityToken?: string;
  runsListed: number;
  shareReadyCount?: number;
  entryRunId?: string;
  addPublicHost(host: string): void;
  close(): Promise<void>;
}

export type ServeLibraryStart =
  | { ok: true; server: ServeLibraryServer }
  | { ok: false; error: { code: ServeErrorCode; message: string } };

export async function serveObserverLibrary(
  cwdInput: string,
  options: ServeLibraryOptions
): Promise<ServeLibraryStart> {
  const cwd = path.resolve(cwdInput);
  const verifyImpl = options.verifyImpl ?? verifyRun;

  let proofRoot: PinnedDirectory;
  try {
    proofRoot = await pinDirectory(path.join(cwd, ".humanish", "runs"));
  } catch {
    return {
      ok: false,
      error: {
        code: "HUMANISH_RUN_NOT_FOUND",
        message: "No run library found under .humanish/runs. Run `humanish watch` to create the first run."
      }
    };
  }

  const admission = createShareSafetyAdmission(cwd, { verifyImpl });
  const mode: ServeMode = options.expose
    ? options.authMode === "link" ? "capability-link" : "share-safe-open"
    : "loopback";

  let entryRunId: string | undefined;
  if (options.entryRunId) {
    const resolved = options.entryRunId === "latest"
      ? (await listRuns(cwd)).latest ?? null
      : options.entryRunId;
    const pinned = resolved ? await pinDirectChildDirectory(proofRoot, resolved) : null;
    if (!resolved || !pinned) {
      return {
        ok: false,
        error: { code: "HUMANISH_RUN_NOT_FOUND", message: `Run not found: ${options.entryRunId}` }
      };
    }
    if (options.safe && !(await admission.admit(resolved))) {
      const verified = await verifyImpl(cwd, resolved).catch(() => null);
      const status = verified?.shareSafety.status ?? "unverifiable";
      const reasons = verified?.shareSafety.reasons.map((reason) => reason.code).join(", ") || "VERIFY_FAILED";
      return {
        ok: false,
        error: {
          code: "HUMANISH_SERVE_RUN_NOT_SHAREABLE",
          message: `Run ${resolved} is not share_ready (shareSafety: ${status}; reasons: ${reasons}); --safe refuses to serve it.`
        }
      };
    }
    entryRunId = resolved;
  }

  const startupHistory = await loadFilteredHistory({
    proofRoot,
    safe: options.safe,
    admit: (runId) => admission.admit(runId),
    hostAllowlist: new Set(),
    renderLibrary: () => ""
  });
  const runsListed = startupHistory.runs.length;

  let auth: ServeAuthContext | null = null;
  let capabilityToken: string | undefined;
  if (options.expose && options.authMode === "link") {
    capabilityToken = mintServeToken();
    auth = {
      tokenDigest: sha256Digest(capabilityToken),
      sessions: createServeSessionStore({
        ttlMs: options.ttlMinutes * 60_000,
        ...(options.now ? { now: options.now } : {})
      }),
      ttlSeconds: options.ttlMinutes * 60
    };
  }

  const hostAllowlist = new Set<string>();
  const handler = createServeRequestHandler({
    proofRoot,
    safe: options.safe,
    admit: (runId) => admission.admit(runId),
    auth,
    hostAllowlist,
    ...(entryRunId ? { entryRunId } : {}),
    renderLibrary: (history) => renderLibraryHtml(history, {
      mode,
      safe: options.safe,
      capabilities: { actions: false }
    }),
    ...(options.controlPlane ? { controlPlane: options.controlPlane } : {})
  });

  const server = createServer((request, response) => {
    void handler(request, response);
  });
  const port = await listen(server, options.port);
  hostAllowlist.add(`127.0.0.1:${port}`);
  hostAllowlist.add(`localhost:${port}`);
  hostAllowlist.add(`[::1]:${port}`);
  if (options.publicOrigin) {
    const parsed = parsePublicOrigin(options.publicOrigin);
    if (parsed) {
      hostAllowlist.add(parsed.host);
    }
  }

  return {
    ok: true,
    server: {
      url: `http://127.0.0.1:${port}/`,
      port,
      mode,
      ...(capabilityToken ? { capabilityToken } : {}),
      runsListed,
      ...(options.safe ? { shareReadyCount: runsListed } : {}),
      ...(entryRunId ? { entryRunId } : {}),
      addPublicHost(host: string): void {
        hostAllowlist.add(host.trim().toLowerCase());
      },
      close: async () => {
        auth?.sessions.revokeAll();
        await closeServer(server);
      }
    }
  };
}

function writeText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8"
): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // The serve surface never binds beyond loopback; exposure only ever happens
    // through a tunnel or proxy forwarding to this port.
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Serve library server did not bind to a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
