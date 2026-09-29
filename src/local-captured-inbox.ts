import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inboxRecipientScope } from "./comms-inbox.js";
import { externalInboxUrl, type ExternalCommsCatch } from "./comms-sandbox-catch.js";

/** Expose only this participant's existing catch pages through its local desktop. */
export async function startLocalCapturedInbox(
  external: ExternalCommsCatch,
  address: string,
): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const scope = inboxRecipientScope(address);
  const route = new RegExp(
    `^/(?:api/)?inbox/for/${scope}(?:/(?:comms-[0-9]+|latest)(?:/synth)?)?/?$`,
  );
  const upstream = new URL(externalInboxUrl(external));
  const base = upstream.pathname.replace(/\/inbox$/, "");
  const stop = new AbortController();
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (["/", "/inbox", "/api/inbox"].includes(url.pathname)) {
        response
          .writeHead(303, {
            location: `${url.pathname.startsWith("/api/") ? "/api" : ""}/inbox/for/${scope}`,
          })
          .end();
        return;
      }
      if (!route.test(url.pathname)) {
        response.writeHead(404).end();
        return;
      }
      const target = new URL(upstream);
      target.pathname = base + url.pathname;
      target.search = "";
      const result = await fetch(target, {
        redirect: "error",
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]),
      });
      response.statusCode = result.status;
      for (const header of [
        "content-type",
        "content-security-policy",
        "referrer-policy",
        "x-content-type-options",
      ]) {
        const value = result.headers.get(header);
        if (value !== null) response.setHeader(header, value);
      }
      response.setHeader("cache-control", "no-store");
      if (result.body)
        await pipeline(
          Readable.fromWeb(result.body as import("node:stream/web").ReadableStream),
          response,
        );
      else response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else
        response
          .writeHead(502)
          .end("The captured inbox is unavailable. Check the running mail catch.");
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Local inbox did not bind a port.");
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${bound.port}/inbox`,
    close: () =>
      (closing ??= (async () => {
        stop.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      })()),
  };
}
