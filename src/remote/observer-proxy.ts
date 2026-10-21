// The local end of watching a remote run: a server on 127.0.0.1 that forwards each request to the
// runner's Observer through the provider's proxy, adding the credential the provider requires. The
// credential stays in this process; the browser only ever talks to loopback.
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";

import type { SandboxPortAccess } from "../substrates/e2b/sdk.js";
import { listenOnLoopback } from "../observer/listen.js";

/** The hop-by-hop headers a proxy does not forward, and the ones this proxy sets itself. */
const DROPPED = new Set(["host", "connection", "keep-alive", "upgrade", "proxy-authorization"]);

export interface ObserverProxy {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Serve `access` on 127.0.0.1:`port` (0 picks a free port). A request whose Host is not this
 * loopback address is refused, so a page that rebinds a name to 127.0.0.1 cannot read the runner's
 * Observer through it; a write must also come from this origin.
 */
export async function serveObserverProxy(
  access: SandboxPortAccess,
  port: number,
): Promise<ObserverProxy> {
  const target = new URL(access.url);
  let origin = "";
  const server: Server = createServer((request, response) => {
    if (!sameOrigin(request, origin)) {
      response.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
      response.end("This address only serves 127.0.0.1.\n");
      return;
    }
    forward(request, response, target, access.headers);
  });
  const bound = await listenOnLoopback(server, port);
  origin = `127.0.0.1:${bound}`;
  return {
    url: `http://${origin}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function sameOrigin(request: IncomingMessage, host: string): boolean {
  const allowed = new Set([host, host.replace("127.0.0.1", "localhost")]);
  if (!allowed.has(request.headers.host ?? "")) return false;
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.origin;
  return origin !== undefined && [...allowed].some((name) => origin === `http://${name}`);
}

function forward(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  credentials: Readonly<Record<string, string>>,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers))
    if (value !== undefined && !DROPPED.has(name)) headers[name] = value;
  const secure = target.protocol === "https:";
  const upstream = (secure ? httpsRequest : httpRequest)(
    {
      host: target.hostname,
      port: target.port === "" ? (secure ? 443 : 80) : Number(target.port),
      path: `${target.pathname.replace(/\/$/, "")}${request.url ?? "/"}`,
      method: request.method,
      headers: { ...headers, ...credentials, host: target.host },
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent)
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(
      "The runner's Observer did not answer. The run may still be going; retry shortly.\n",
    );
  });
  request.pipe(upstream);
}
