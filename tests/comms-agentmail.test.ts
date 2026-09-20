import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AGENTMAIL_RECEIVING_LIMITS, AgentMailReceivingError, createAgentMailReceiver } from "../src/comms-agentmail.js";
import type { ReceivingLease } from "../src/comms-receiving-types.js";

// Live-derived fixtures; mutations below are explicit adverse cases, not invented API contracts.
type WireFixture = { status: number; body: Record<string, any> | null };
function fixture(name: string): WireFixture { return JSON.parse(readFileSync(new URL(`./fixtures/agentmail-receiving/${name}.json`, import.meta.url), "utf8")) as WireFixture; }
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const KEY = "synthetic-management-key-canary";
const LEASE: ReceivingLease = { resourceId: "recipient@example.test", address: "recipient@example.test", clientId: "client-fixture-1" };
const INBOX_PATH = "/v0/inboxes/recipient%40example.test";
function response(wire: WireFixture): Response { return new Response(wire.body === null ? null : JSON.stringify(wire.body), { status: wire.status, headers: { "Content-Type": "application/json" } }); }
function queue(...items: Array<WireFixture | Response | Error>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init: init ?? {} });
    const next = items.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fixture request");
    return next instanceof Response ? next : response(next);
  }) as typeof fetch;
  return { adapter: createAgentMailReceiver({ apiKey: KEY, fetch: fetcher }), calls, fetcher };
}
function raster(): Response { return new Response(Buffer.from(PNG, "base64"), { headers: { "Content-Type": "image/png" } }); }
function messageWithoutAttachment(id = "message-fixture-1"): WireFixture {
  const value = fixture("message"); value.body!.attachments = []; value.body!.message_id = id; return value;
}
function page(ids: string[], next?: string): WireFixture {
  const value = fixture("messages");
  value.body!.messages = ids.map((id) => ({ ...value.body!.messages[0], message_id: id }));
  if (next !== undefined) value.body!.next_page_token = next;
  return value;
}

describe("AgentMail receiving transport", () => {
  it("authenticates the captured additive wire shape without exposing management metadata", async () => {
    const { adapter, calls } = queue(fixture("auth"));
    expect(await adapter.authenticate()).toEqual({ provider: "agentmail", accountId: "organization-fixture-1", scopeType: "organization", scopeId: "organization-fixture-1" });
    expect(calls[0]?.url.href).toBe("https://api.agentmail.to/v0/auth/me");
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", headers: { Authorization: `Bearer ${KEY}` } });
  });
  it("reports captured 403 as rejected authentication or scope, never an asserted invalid key", async () => {
    const { adapter } = queue(fixture("auth-rejected"));
    await expect(adapter.authenticate()).rejects.toMatchObject({ code: "agentmail_auth_rejected", message: "agentmail_auth_rejected" });
  });
  it.each([401, 429, 500, 408])("classifies HTTP %i without echoing the response or key", async (status) => {
    const { adapter } = queue({ status, body: { message: KEY, private: "private-provider-canary" } });
    try { await adapter.authenticate(); expect.fail("expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(AgentMailReceivingError);
      expect(String(error)).not.toContain(KEY); expect(JSON.stringify(error)).not.toContain("private-provider-canary");
      expect((error as AgentMailReceivingError).code).toBe(status === 401 ? "agentmail_auth_rejected" : status === 429 ? "agentmail_rate_limited" : "agentmail_unavailable");
    }
  });
  it("does not retain raw fetch errors or malformed successful auth bodies", async () => {
    const transport = queue(new Error(`url-with-secret:${KEY}`));
    await expect(transport.adapter.authenticate()).rejects.toMatchObject({ message: "agentmail_unavailable" });
    const invalid = queue({ status: 200, body: { scope_type: "unexpected", message: KEY } });
    await expect(invalid.adapter.authenticate()).rejects.toMatchObject({ code: "agentmail_invalid_response" });
  });
  it("creates a fresh inbox with the exact idempotency intent and uses the separate email field", async () => {
    const wire = fixture("inbox"); wire.body!.inbox_id = "opaque-inbox-id";
    const { adapter, calls } = queue(wire);
    expect(await adapter.acquire(LEASE.clientId)).toEqual({ ...LEASE, resourceId: "opaque-inbox-id" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/v0/inboxes");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ client_id: LEASE.clientId });
  });
  it("replays the SAME create intent once when the first response is lost", async () => {
    const { adapter, calls } = queue(new Error("lost create response"), fixture("inbox"));
    expect(await adapter.acquire(LEASE.clientId)).toEqual(LEASE);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.body).toBe(calls[1]?.init.body);
  });
  it("does not retry rejection or accept a different creation owner", async () => {
    const denied = queue(fixture("auth-rejected"));
    await expect(denied.adapter.acquire(LEASE.clientId)).rejects.toMatchObject({ code: "agentmail_auth_rejected" });
    expect(denied.calls).toHaveLength(1);
    const wrong = fixture("inbox"); wrong.body!.client_id = "another-owner";
    const mismatch = queue(wrong);
    await expect(mismatch.adapter.acquire(LEASE.clientId)).rejects.toMatchObject({ code: "agentmail_ownership_mismatch" });
    expect(mismatch.calls).toHaveLength(1);
  });
  it("reads only scoped received messages, preserves HTML and downloads captured raster bytes without API auth", async () => {
    const { adapter, calls } = queue(fixture("messages"), fixture("message"), fixture("attachment"), raster());
    const batch = await adapter.read(LEASE);
    expect(batch.complete).toBe(true); expect(batch.limitations).toEqual([]);
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0]).toMatchObject({ providerMessageId: "message-fixture-1", text: "Synthetic verification code 123456.", inlineImages: [{ contentId: "fixture-pixel", contentType: "image/png", base64: PNG }] });
    expect(batch.messages[0]?.html).toContain("cid:fixture-pixel");
    expect(calls[0]?.url.pathname).toBe(`${INBOX_PATH}/messages`);
    expect(calls[0]?.url.searchParams.get("labels")).toBe("received");
    expect(calls[3]?.url.origin).toBe("https://cdn.agentmail.to");
    expect(calls[3]?.init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(calls[3]?.init.headers).toBeUndefined();
    expect(JSON.stringify(batch)).not.toContain(KEY);
  });
  it("recognizes a captured empty fresh inbox", async () => {
    const { adapter } = queue(fixture("empty"));
    expect(await adapter.read(LEASE)).toEqual({ messages: [], complete: true, limitations: [] });
  });
  it("paginates the captured token field, filters sent entries and deduplicates overlap", async () => {
    const first = fixture("page-one");
    const second = fixture("page-two");
    expect(first.body!.messages[0].labels).toEqual(["sent"]);
    const id = second.body!.messages[0].message_id;
    second.body!.messages.push(second.body!.messages[0]);
    const { adapter, calls } = queue(first, second, messageWithoutAttachment(id));
    const batch = await adapter.read(LEASE);
    expect(batch.messages).toHaveLength(1); expect(batch.complete).toBe(true);
    expect(calls[1]?.url.searchParams.get("page_token")).toBe(first.body!.next_page_token);
  });
  it("never reads another inbox or accepts a mismatched get-message response", async () => {
    const listing = page(["one"]); listing.body!.messages[0].inbox_id = "unowned@example.test";
    const other = queue(listing);
    expect(await other.adapter.read(LEASE)).toMatchObject({ complete: false, messages: [], limitations: ["agentmail_ownership_mismatch"] });
    expect(other.calls).toHaveLength(1);
    const message = messageWithoutAttachment(); message.body!.inbox_id = "unowned@example.test";
    const mismatch = queue(page(["message-fixture-1"]), message);
    expect(await mismatch.adapter.read(LEASE)).toMatchObject({ complete: false, messages: [], limitations: expect.arrayContaining(["agentmail_ownership_mismatch"]) });
  });
  it("retains earlier messages and reports a later provider failure truthfully", async () => {
    const { adapter } = queue(page(["one", "two"]), messageWithoutAttachment("one"), fixture("auth-rejected"));
    const batch = await adapter.read(LEASE);
    expect(batch.messages.map((message) => message.providerMessageId)).toEqual(["one"]);
    expect(batch.complete).toBe(false); expect(batch.limitations).toContain("agentmail_auth_rejected");
  });
  it("stops repeated page tokens and bounds total pages", async () => {
    const same = queue(page([], "repeat"), page([], "repeat"));
    expect(await same.adapter.read(LEASE)).toMatchObject({ complete: false, limitations: ["agentmail_pagination_stalled"] });
    expect(same.calls).toHaveLength(2);
    const capped = queue(...Array.from({ length: AGENTMAIL_RECEIVING_LIMITS.pages }, (_, index) => page([], `page-${index}`)));
    expect(await capped.adapter.read(LEASE)).toMatchObject({ complete: false, limitations: ["agentmail_page_limit"] });
    expect(capped.calls).toHaveLength(AGENTMAIL_RECEIVING_LIMITS.pages);
  });
  it("reports bounded truncation and missing provider content without replacing it with a summary", async () => {
    const long = messageWithoutAttachment(); long.body!.text = "x".repeat(AGENTMAIL_RECEIVING_LIMITS.textBytes + 1);
    delete long.body!.timestamp;
    const { adapter } = queue(fixture("messages"), long);
    const batch = await adapter.read(LEASE);
    expect(batch.messages[0]?.text.length).toBe(AGENTMAIL_RECEIVING_LIMITS.textBytes);
    expect(batch.limitations).toEqual(expect.arrayContaining(["agentmail_content_truncated", "agentmail_timestamp_missing"]));
    expect(batch.complete).toBe(false);
    const missing = messageWithoutAttachment(); delete missing.body!.text; delete missing.body!.html;
    const empty = queue(fixture("messages"), missing);
    expect((await empty.adapter.read(LEASE)).limitations).toContain("agentmail_content_missing");
  });
  it.each(["https://evil.example.test/pixel", "http://cdn.agentmail.to/pixel", "https://cdn.agentmail.to.evil.example.test/pixel", "https://user:secret@cdn.agentmail.to/pixel", "https://cdn.agentmail.to:444/pixel", "https://cdn.agentmail.to/pixel#fragment", "https://example.s3.amazonaws.com/pixel"])("blocks unestablished download origin %s before fetching", async (url) => {
    const descriptor = fixture("attachment"); descriptor.body!.download_url = url;
    const { adapter, calls } = queue(fixture("messages"), fixture("message"), descriptor);
    const batch = await adapter.read(LEASE);
    expect(batch.messages).toHaveLength(1); expect(batch.messages[0]?.inlineImages).toEqual([]);
    expect(batch.limitations).toContain("agentmail_download_blocked"); expect(batch.complete).toBe(false);
    expect(calls).toHaveLength(3);
  });
  it("validates every redirect and allows a bounded same-origin download without auth", async () => {
    const safe = queue(fixture("messages"), fixture("message"), fixture("attachment"), new Response(null, { status: 302, headers: { location: "/fixture/next.png" } }), raster());
    expect((await safe.adapter.read(LEASE)).messages[0]?.inlineImages).toHaveLength(1);
    expect(safe.calls[4]?.init.headers).toBeUndefined();
    const bad = queue(fixture("messages"), fixture("message"), fixture("attachment"), new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    expect((await bad.adapter.read(LEASE)).limitations).toContain("agentmail_download_blocked");
    expect(bad.calls).toHaveLength(4);
    const loop = queue(fixture("messages"), fixture("message"), fixture("attachment"), ...Array.from({ length: 3 }, () => new Response(null, { status: 302, headers: { location: "/loop" } })));
    expect((await loop.adapter.read(LEASE)).limitations).toContain("agentmail_download_blocked");
    expect(loop.calls).toHaveLength(6);
  });
  it("refuses corrupt raster bytes and unsupported attachment formats while preserving message text", async () => {
    const bad = queue(fixture("messages"), fixture("message"), fixture("attachment"), new Response(Buffer.alloc(68)));
    const batch = await bad.adapter.read(LEASE);
    expect(batch.messages[0]?.text).toBeTruthy(); expect(batch.messages[0]?.inlineImages).toEqual([]);
    expect(batch.limitations).toContain("agentmail_invalid_response");
    const svg = fixture("message"); svg.body!.attachments[0].content_type = "image/svg+xml";
    const unsupported = queue(fixture("messages"), svg);
    expect((await unsupported.adapter.read(LEASE)).limitations).toContain("agentmail_attachment_unsupported");
    expect(unsupported.calls).toHaveLength(2);
  });
  it("checks descriptor identity and declared size before download", async () => {
    const wrong = fixture("attachment"); wrong.body!.attachment_id = "other-attachment";
    const mismatch = queue(fixture("messages"), fixture("message"), wrong);
    expect((await mismatch.adapter.read(LEASE)).limitations).toContain("agentmail_invalid_response");
    expect(mismatch.calls).toHaveLength(3);
    const oversized = fixture("message"); oversized.body!.attachments[0].size = 2 * 1024 * 1024;
    const huge = queue(fixture("messages"), oversized);
    expect((await huge.adapter.read(LEASE)).limitations).toContain("agentmail_size_limit");
    expect(huge.calls).toHaveLength(2);
  });
  it("limits streaming responses even without Content-Length and cancels excess bytes", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel: cancelled });
    const { adapter } = queue(new Response(stream));
    await expect(adapter.authenticate()).rejects.toMatchObject({ code: "agentmail_size_limit" });
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("bounds whole-operation bytes across individually valid message responses", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `message-${index}`);
    const messages = ids.map((id) => {
      const value = messageWithoutAttachment(id);
      value.body!.ignored_additive_field = "x".repeat(1900 * 1024);
      return value;
    });
    const { adapter, calls } = queue(page(ids), ...messages);
    const batch = await adapter.read(LEASE);
    expect(batch.complete).toBe(false);
    expect(batch.limitations).toContain("agentmail_size_limit");
    expect(batch.messages.length).toBeGreaterThan(0);
    expect(batch.messages.length).toBeLessThan(10);
    expect(calls.length).toBeLessThan(11);
  });
  it("caps total requests even with many valid inline attachments", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `message-${index}`);
    const replies: Array<WireFixture | Response> = [page(ids)];
    for (const id of ids) {
      const message = fixture("message"); message.body!.message_id = id;
      message.body!.attachments = Array.from({ length: 12 }, () => ({ ...message.body!.attachments[0] }));
      replies.push(message);
      for (let image = 0; image < 12; image++) replies.push(fixture("attachment"), raster());
    }
    const { adapter, calls } = queue(...replies);
    const batch = await adapter.read(LEASE);
    expect(batch.complete).toBe(false);
    expect(batch.limitations).toContain("agentmail_request_limit");
    expect(calls).toHaveLength(AGENTMAIL_RECEIVING_LIMITS.requests);
    expect(batch.messages.length).toBeGreaterThan(0);
  });
  it("does not trust an oversized page or a mismatched received label", async () => {
    const oversized = queue(page(Array.from({ length: 26 }, (_, index) => `id-${index}`)));
    expect(await oversized.adapter.read(LEASE)).toMatchObject({ complete: false, limitations: ["agentmail_invalid_response"] });
    expect(oversized.calls).toHaveLength(1);
    const sent = messageWithoutAttachment(); sent.body!.labels = ["sent"];
    const wrongLabel = queue(fixture("messages"), sent);
    expect((await wrongLabel.adapter.read(LEASE)).limitations).toContain("agentmail_ownership_mismatch");
  });
  it("honors cancellation and deadlines even if fetch ignores its AbortSignal", async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
    const adapter = createAgentMailReceiver({ apiKey: KEY, fetch: fetcher });
    await expect(adapter.authenticate({ timeoutMs: 10 })).rejects.toMatchObject({ code: "agentmail_timeout" });
    const controller = new AbortController();
    const reading = adapter.read(LEASE, { signal: controller.signal }); controller.abort();
    await expect(reading).rejects.toMatchObject({ code: "agentmail_cancelled" });
    const already = new AbortController(); already.abort();
    const before = vi.mocked(fetcher).mock.calls.length;
    await expect(adapter.acquire(LEASE.clientId, { signal: already.signal })).rejects.toMatchObject({ code: "agentmail_cancelled" });
    expect(vi.mocked(fetcher).mock.calls).toHaveLength(before);
  });
  it("bounds a stalled response body and retains preceding messages after a read deadline", async () => {
    const hang = () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } }));
    const auth = queue(hang());
    await expect(auth.adapter.authenticate({ timeoutMs: 10 })).rejects.toMatchObject({ code: "agentmail_timeout" });
    const reading = queue(page(["one", "two"]), messageWithoutAttachment("one"), hang());
    const batch = await reading.adapter.read(LEASE, { timeoutMs: 20 });
    expect(batch.messages).toHaveLength(1); expect(batch.complete).toBe(false);
    expect(batch.limitations).toContain("agentmail_timeout");
  });
  it("checks ownership before DELETE and distinguishes accepted deletion from confirmed absence", async () => {
    const deleting = queue(fixture("inbox"), fixture("delete-accepted"), fixture("deleting"));
    expect(await deleting.adapter.release(LEASE)).toEqual({ status: "deleting" });
    expect(deleting.calls.map((call) => call.init.method)).toEqual(["GET", "DELETE", "GET"]);
    const absent = queue(fixture("inbox"), fixture("delete-accepted"), fixture("absent"));
    expect(await absent.adapter.release(LEASE)).toEqual({ status: "absent" });
    const pending = queue(fixture("deleting"));
    expect(await pending.adapter.release(LEASE)).toEqual({ status: "deleting" });
    expect(pending.calls).toHaveLength(1);
    const gone = queue(fixture("absent"));
    expect(await gone.adapter.release(LEASE)).toEqual({ status: "absent" });
    expect(gone.calls).toHaveLength(1);
  });
  it.each(["client_id", "inbox_id", "email"])("never deletes when %s ownership differs", async (field) => {
    const wrong = fixture("inbox"); wrong.body![field] = "unowned@example.test";
    const { adapter, calls } = queue(wrong);
    await expect(adapter.release(LEASE)).rejects.toMatchObject({ code: "agentmail_ownership_mismatch" });
    expect(calls).toHaveLength(1); expect(calls[0]?.init.method).toBe("GET");
  });
  it("does not mistake arbitrary 404/409 or post-delete failure for proof of absence", async () => {
    const bad404 = queue(new Response("private proxy failure", { status: 404 }));
    await expect(bad404.adapter.release(LEASE)).rejects.toMatchObject({ code: "agentmail_invalid_response" });
    const bad409 = queue({ status: 409, body: { code: "unrelated-conflict" } });
    await expect(bad409.adapter.release(LEASE)).rejects.toMatchObject({ code: "agentmail_invalid_response" });
    const lostReadback = queue(fixture("inbox"), fixture("delete-accepted"), new Error("transport failure"));
    expect(await lostReadback.adapter.release(LEASE)).toEqual({ status: "deleting" });
  });
  it("rejects unsafe local inputs without making requests or exposing them", async () => {
    expect(() => createAgentMailReceiver({ apiKey: `${KEY}\n` })).toThrow("agentmail_invalid_input");
    const { adapter, calls } = queue();
    await expect(adapter.acquire("bad\nclient")).rejects.toMatchObject({ code: "agentmail_invalid_input" });
    await expect(adapter.authenticate({ timeoutMs: Infinity })).rejects.toMatchObject({ code: "agentmail_invalid_input" });
    expect(calls).toHaveLength(0);
  });
});
