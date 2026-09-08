import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { buildServeSecurityHeaders } from "./serve-http.js";

// Loopback-only host for the Observer static server. We never bind 0.0.0.0:
// the Observer surfaces local run evidence and must stay reachable only from
// the machine that owns the run bundle.
export const OBSERVER_STATIC_HOST = "127.0.0.1";

// Minimal extension -> content-type map. Kept dependency-free (no `mime`
// package) because the Observer ships a small, known set of asset kinds.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

export interface ObserverStaticHandlerOptions {
  /** Directory served as the loopback root. Requests can never escape it. */
  root: string;
  /** File served for directory requests. Defaults to `index.html`. */
  indexPath?: string;
  /**
   * When set, an exact `/` request returns a 302 to `/<redirectRootTo>` instead
   * of serving a file. Used to land visitors on `observer/index.html` so the
   * Observer's relative artifact links (`../run.json`, ...) resolve.
   */
  redirectRootTo?: string;
}

export interface ObserverStaticServeOptions extends ObserverStaticHandlerOptions {
  /** TCP port to bind on 127.0.0.1. Defaults to an ephemeral port (0). */
  port?: number;
  /**
   * Relative entry page (e.g. `observer/index.html`). Drives the returned
   * `url` and the `/` -> entry redirect so callers open the page directly.
   */
  entryPath?: string;
}

export interface ObserverStaticServer {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

interface PinnedStaticRoot {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly physicalPath: string;
}

interface PinnedStaticFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export function observerStaticContentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve, guard, and serve a single static request from `root`. Never throws:
 * any unexpected failure is reported as a 500 so the connection always closes.
 * Exported directly so the security guards can be unit-tested without binding a
 * socket.
 */
export async function respondToObserverStaticRequest(
  options: ObserverStaticHandlerOptions,
  request: Pick<IncomingMessage, "method" | "url">,
  response: ServerResponse
): Promise<void> {
  applySecurityHeaders(response);
  try {
    const root = await pinStaticRoot(options.root);
    await respondToPinnedObserverStaticRequest(root, options, request, response);
  } catch {
    if (response.headersSent) {
      response.end();
      return;
    }
    writeText(response, 500, "Observer request failed");
  }
}

async function respondToPinnedObserverStaticRequest(
  root: PinnedStaticRoot,
  options: ObserverStaticHandlerOptions,
  request: Pick<IncomingMessage, "method" | "url">,
  response: ServerResponse
): Promise<void> {
  applySecurityHeaders(response);
  const indexRelative = options.indexPath ?? "index.html";

  try {
    await assertPinnedStaticRoot(root);
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      writeText(response, 405, "Method Not Allowed");
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", `http://${OBSERVER_STATIC_HOST}`).pathname;
    } catch {
      writeText(response, 400, "Bad Request");
      return;
    }

    if (pathname === "/" && options.redirectRootTo) {
      const location = `/${options.redirectRootTo.replace(/^\/+/, "")}`;
      response.writeHead(302, {
        location,
        "cache-control": "no-store",
        "content-length": "0"
      });
      response.end();
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      writeText(response, 400, "Bad Request");
      return;
    }

    // Reject embedded NUL bytes outright rather than letting them reach the fs.
    if (decoded.includes("\0")) {
      writeText(response, 400, "Bad Request");
      return;
    }

    let relative = decoded.replace(/^\/+/, "");
    if (relative === "" || relative.endsWith("/")) {
      relative = `${relative}${indexRelative}`;
    }

    const target = path.resolve(root.physicalPath, relative);
    if (!isPathInside(root.physicalPath, target)) {
      writeText(response, 403, "Forbidden");
      return;
    }

    let info;
    try {
      info = await lstat(target);
    } catch {
      writeText(response, 404, "Not Found");
      return;
    }
    if (info.isSymbolicLink()) {
      writeText(response, 403, "Forbidden");
      return;
    }

    let filePath = target;
    if (info.isDirectory()) {
      filePath = path.resolve(target, indexRelative);
      if (!isPathInside(root.physicalPath, filePath)) {
        writeText(response, 403, "Forbidden");
        return;
      }
    }

    const rawBody = await readContainedRegularFile(root, filePath);
    const body = rawBody ? recordedObserverStaticBody(filePath, rawBody) : null;
    if (!body) {
      writeText(response, 404, "Not Found");
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": observerStaticContentType(filePath),
      "content-length": String(body.byteLength)
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    response.end(body);
  } catch {
    if (response.headersSent) {
      response.end();
      return;
    }
    writeText(response, 500, "Observer request failed");
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(buildServeSecurityHeaders())) response.setHeader(name, value);
}

/** Static serving is recorded evidence. Neither JSON files nor inline HTML snapshots
 * can carry a live process observation or grant provider-origin access. */
function recordedObserverStaticBody(filePath: string, body: Buffer): Buffer {
  const strip = (text: string): string | null => {
    try {
      const data: unknown = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)
        || (data as Record<string, unknown>).schema !== "humanish.observer-data.v1") return null;
      const projection = data as Record<string, unknown>;
      delete projection.runtime;
      if (Array.isArray(projection.streams)) {
        for (const stream of projection.streams) {
          if (!stream || typeof stream !== "object" || Array.isArray(stream)) continue;
          const embed: unknown = (stream as Record<string, unknown>).embed;
          if (embed && typeof embed === "object" && !Array.isArray(embed)) delete (embed as Record<string, unknown>).runtimeDesktop;
        }
      }
      return JSON.stringify(projection).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
    } catch { return null; }
  };
  if (path.basename(filePath) === "observer-data.json") {
    const stripped = strip(body.toString("utf8"));
    return stripped === null ? body : Buffer.from(stripped);
  }
  if (/\.html?$/i.test(filePath)) {
    const html = body.toString("utf8");
    // Identify Observer JSON by its schema, not an attribute spelling: HTML permits
    // encoded ids and '>' inside quoted attributes. Other scripts remain byte-identical.
    const sanitized = html.replace(/(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script\s*>)/gi,
      (match, start: string, json: string, end: string) => {
        const stripped = strip(json);
        return stripped === null ? match : `${start}${stripped}${end}`;
      });
    return sanitized === html ? body : Buffer.from(sanitized);
  }
  return body;
}

async function readContainedRegularFile(root: PinnedStaticRoot, filePathInput: string): Promise<Buffer | null> {
  const filePath = path.resolve(filePathInput);
  if (!isPathInside(root.physicalPath, filePath)) return null;
  try {
    await assertPinnedStaticRoot(root);
    const expectedStats = await inspectContainedStaticFile(root, filePath);
    if (!expectedStats) {
      return null;
    }

    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const openedStats = await handle.stat({ bigint: true });
      if (
        !openedStats.isFile()
        || openedStats.nlink !== 1n
        || openedStats.dev !== expectedStats.dev
        || openedStats.ino !== expectedStats.ino
      ) {
        return null;
      }
      const recheckedStats = await inspectContainedStaticFile(root, filePath);
      if (
        !recheckedStats
        || recheckedStats.dev !== expectedStats.dev
        || recheckedStats.ino !== expectedStats.ino
      ) {
        return null;
      }
      await assertPinnedStaticRoot(root);
      const body = await handle.readFile();
      await assertPinnedStaticRoot(root);
      return body;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function createObserverStaticHandler(
  options: ObserverStaticHandlerOptions
): (request: IncomingMessage, response: ServerResponse) => void {
  let rootPromise: Promise<PinnedStaticRoot> | undefined;
  return (request, response) => {
    applySecurityHeaders(response);
    rootPromise ??= pinStaticRoot(options.root);
    void rootPromise
      .then((root) => respondToPinnedObserverStaticRequest(root, options, request, response))
      .catch(() => {
        if (response.headersSent) {
          response.end();
          return;
        }
        writeText(response, 500, "Observer request failed");
      });
  };
}

export async function serveObserverStatic(options: ObserverStaticServeOptions): Promise<ObserverStaticServer> {
  const entryPath = options.entryPath?.replace(/^\/+/, "") ?? "";
  const handlerOptions = {
    root: options.root,
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(entryPath ? { redirectRootTo: entryPath } : {})
  };
  const root = await pinStaticRoot(options.root);
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void respondToPinnedObserverStaticRequest(root, handlerOptions, request, response);
  };
  const server = createServer(handler);
  const port = await listen(server, options.port ?? 0);
  return {
    url: `http://${OBSERVER_STATIC_HOST}:${port}/${entryPath}`,
    port,
    host: OBSERVER_STATIC_HOST,
    close: () => closeServer(server)
  };
}

function writeText(response: ServerResponse, status: number, message: string): void {
  const body = `${message}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body))
  });
  response.end(body);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function inspectContainedStaticFile(
  root: PinnedStaticRoot,
  filePath: string
): Promise<PinnedStaticFileIdentity | null> {
  const relative = path.relative(root.physicalPath, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  let current = root.physicalPath;
  let fileIdentity: PinnedStaticFileIdentity | null = null;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await lstat(current, { bigint: true });
    if (stats.isSymbolicLink()) return null;
    if (index < segments.length - 1) {
      if (!stats.isDirectory()) return null;
    } else {
      if (!stats.isFile() || stats.nlink !== 1n) return null;
      fileIdentity = { dev: stats.dev, ino: stats.ino };
    }
  }

  if (await realpath(filePath) !== filePath) return null;
  return fileIdentity;
}

async function pinStaticRoot(rootInput: string): Promise<PinnedStaticRoot> {
  const physicalPath = await realpath(path.resolve(rootInput));
  const stats = await lstat(physicalPath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Observer static roots must be physical directories.");
  }
  return Object.freeze({ birthtimeNs: stats.birthtimeNs, dev: stats.dev, ino: stats.ino, physicalPath });
}

async function assertPinnedStaticRoot(root: PinnedStaticRoot): Promise<void> {
  const stats = await lstat(root.physicalPath, { bigint: true });
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.birthtimeNs !== root.birthtimeNs
    || stats.dev !== root.dev
    || stats.ino !== root.ino
    || await realpath(root.physicalPath) !== root.physicalPath
  ) {
    throw new Error("Observer static root identity changed.");
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, OBSERVER_STATIC_HOST, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Observer static server did not bind to a TCP port."));
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
