import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

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
  const root = path.resolve(options.root);
  const indexRelative = options.indexPath ?? "index.html";

  try {
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

    const target = path.resolve(root, relative);
    if (!isPathInside(root, target)) {
      writeText(response, 403, "Forbidden");
      return;
    }

    let info;
    try {
      info = await stat(target);
    } catch {
      writeText(response, 404, "Not Found");
      return;
    }

    let filePath = target;
    if (info.isDirectory()) {
      filePath = path.resolve(target, indexRelative);
      if (!isPathInside(root, filePath)) {
        writeText(response, 403, "Forbidden");
        return;
      }
    }

    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch {
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
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    writeText(response, 500, error instanceof Error ? error.message : String(error));
  }
}

export function createObserverStaticHandler(
  options: ObserverStaticHandlerOptions
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void respondToObserverStaticRequest(options, request, response);
  };
}

export async function serveObserverStatic(options: ObserverStaticServeOptions): Promise<ObserverStaticServer> {
  const entryPath = options.entryPath?.replace(/^\/+/, "") ?? "";
  const handler = createObserverStaticHandler({
    root: options.root,
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(entryPath ? { redirectRootTo: entryPath } : {})
  });
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
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
