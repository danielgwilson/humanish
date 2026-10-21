import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { serveObserverProxy, type ObserverProxy } from "../../src/remote/observer-proxy.js";

let upstream: Server | undefined;
let proxy: ObserverProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  await new Promise((resolve) =>
    upstream === undefined ? resolve(undefined) : upstream.close(resolve),
  );
});

/** A stand-in for the provider's proxy: it answers only requests that carry the credential. */
async function provider(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  upstream = createServer((req, res) => {
    seen.push(req.headers);
    if (req.headers.authorization !== `Bearer ${"synthetic-token"}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end(`observer ${req.method} ${req.url}`);
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, seen };
}

function call(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the local proxy to a remote run's Observer", () => {
  it("adds the provider credential, which the browser never holds", async () => {
    const { url, seen } = await provider();
    proxy = await serveObserverProxy(
      { url, headers: { Authorization: `Bearer ${"synthetic-token"}` } },
      0,
    );
    const answer = await call(`${proxy.url}observer/index.html`);
    expect(answer).toEqual({ status: 200, body: "observer GET /observer/index.html" });
    expect(seen[0]?.host).toBe(new URL(url).host);
  });

  it("refuses a request addressed to another host name, as a rebound page sends", async () => {
    const { url, seen } = await provider();
    proxy = await serveObserverProxy({ url, headers: {} }, 0);
    const answer = await call(`${proxy.url}observer/index.html`, {
      headers: { host: "attacker.example" },
    });
    expect(answer.status).toBe(421);
    expect(seen).toEqual([]);
  });

  it("refuses a write from another origin", async () => {
    const { url, seen } = await provider();
    proxy = await serveObserverProxy({ url, headers: {} }, 0);
    const answer = await call(`${proxy.url}_humanish/notes`, {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });
    expect(answer.status).toBe(421);
    expect(seen).toEqual([]);
  });
});
