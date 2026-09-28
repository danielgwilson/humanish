import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { inboxRecipientScope, recipientInboxUrl } from "../src/comms-inbox.js";
import { startLocalCapturedInbox } from "../src/local-captured-inbox.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("local captured inbox boundary", () => {
  it("serves only the assigned recipient and never forwards management credentials or browser cookies", async () => {
    const requests: Array<{ path: string; authorization?: string; cookie?: string }> = [];
    const upstream = await listen(createServer((request, response) => {
      requests.push({ path: request.url!, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}) });
      response.setHeader("content-security-policy", "script-src 'none'");
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end('<a href="http://localhost:3000/verify?token=synthetic">Verify</a>');
    }));
    const alpha = await startLocalCapturedInbox({ catchBaseUrl: upstream + "/catch", authToken: "synthetic-management-token" }, "alpha@example.test");
    const beta = await startLocalCapturedInbox({ catchBaseUrl: upstream + "/catch" }, "beta@example.test");
    cleanup.push(alpha.close, beta.close);
    for (const [inbox, address, other] of [[alpha, "alpha@example.test", "beta@example.test"], [beta, "beta@example.test", "alpha@example.test"]] as const) {
      const url = recipientInboxUrl(inbox.url, address);
      const result = await fetch(url + "/latest", { headers: { cookie: "operator=synthetic" } });
      expect(result.status).toBe(200);
      expect(result.headers.get("content-security-policy")).toBe("script-src 'none'");
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(await result.text()).toContain('href="http://localhost:3000/verify?token=synthetic"');
      expect((await fetch(recipientInboxUrl(inbox.url, other))).status).toBe(404);
      const base = new URL(inbox.url).origin;
      for (const route of ["/deliveries", "/health", "/inbox/for/unknown", "/inbox/for/" + inboxRecipientScope(address) + "/../../deliveries"]) {
        expect((await fetch(base + route)).status).toBe(404);
      }
      expect((await fetch(base + "/emails", { method: "POST", body: "mail" })).status).toBe(405);
      const root = await fetch(base, { redirect: "manual" });
      expect(root.status).toBe(303);
      expect(root.headers.get("location")).toBe(`/inbox/for/${inboxRecipientScope(address)}`);
      expect((await fetch(base + `/api/inbox/for/${inboxRecipientScope(address)}/comms-1`)).status).toBe(200);
    }
    expect(requests).toHaveLength(4);
    expect(requests.every(request => request.path.startsWith("/catch/") && !request.authorization && !request.cookie)).toBe(true);
  });

  it("refuses upstream redirects and closes the owned listener idempotently", async () => {
    const upstream = await listen(createServer((_request, response) => response.writeHead(302, { location: "http://127.0.0.1:1/private" }).end()));
    const inbox = await startLocalCapturedInbox({ catchBaseUrl: upstream }, "alpha@example.test");
    const url = recipientInboxUrl(inbox.url, "alpha@example.test");
    expect((await fetch(url)).status).toBe(502);
    await inbox.close(); await inbox.close();
    await expect(fetch(url)).rejects.toThrow();
  });
  it("aborts an upstream read when the participant inbox closes", async () => {
    let received!: () => void;
    const pending = new Promise<void>(resolve => { received = resolve; });
    const upstream = await listen(createServer(() => received()));
    const inbox = await startLocalCapturedInbox({ catchBaseUrl: upstream }, "alpha@example.test");
    cleanup.push(inbox.close);
    const reading = fetch(recipientInboxUrl(inbox.url, "alpha@example.test")).catch(() => undefined);
    await pending;
    await inbox.close();
    expect(await reading).toBeUndefined();
  });

});
