import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentMailReceiver } from "../src/comms-agentmail.js";
import { inspectCommsRecovery, recoverCommsReceiving, startCommsReceiving, type CommsReceivingRun, type StartCommsReceivingOptions } from "../src/comms-receiving.js";
import type { CommsReceivingEvidence, ReceivedEmail, ReceivingAdapter, ReceivingBatch, ReceivingIdentity, ReceivingLease, ReceivingSurface } from "../src/comms-receiving-types.js";

// This is a receiver-only orchestration fake, not an invented provider wire fixture.
function receiver() {
  const resources = new Map<string, ReceivingLease>();
  const batch = new Map<string, ReceivingBatch[]>();
  const identity: ReceivingIdentity = { provider: "agentmail", accountId: "synthetic-account", scopeType: "organization", scopeId: "synthetic-scope" };
  const authenticate = vi.fn(async () => identity);
  const acquire = vi.fn(async (clientId: string) => {
    let lease = resources.get(clientId);
    if (!lease) {
      const number = resources.size + 1;
      lease = { resourceId: `provider-resource-${number}`, address: `participant-${number}@example.test`, clientId };
      resources.set(clientId, lease);
    }
    return lease;
  });
  const read = vi.fn(async (lease: ReceivingLease): Promise<ReceivingBatch> => batch.get(lease.resourceId)?.shift() ?? { messages: [], complete: true, limitations: [] });
  const release = vi.fn(async (lease: ReceivingLease): Promise<{ status: "absent" | "deleting" }> => {
    if (resources.get(lease.clientId)?.resourceId !== lease.resourceId) throw new Error("borrowed-resource-canary");
    resources.delete(lease.clientId);
    return { status: "absent" };
  });
  const adapter: ReceivingAdapter = { provider: "agentmail", authenticate, acquire, read, release };
  return { adapter, identity, resources, batch, authenticate, acquire, read, release };
}
function email(id: string, body = "A synthetic message"): ReceivedEmail {
  return { channel: "email", providerMessageId: `private-${id}`, providerTimestamp: "2026-01-01T12:00:00Z", from: "sender@example.test",
    subject: `Private subject ${id}`, text: body, inlineImages: [], limitations: [] };
}
const complete = (messages: ReceivedEmail[]): ReceivingBatch => ({ messages, complete: true, limitations: [] });
const empty = (): ReceivingBatch => complete([]);
function surface(): ReceivingSurface & { publish: ReturnType<typeof vi.fn<ReceivingSurface["publish"]>>; stop: ReturnType<typeof vi.fn<ReceivingSurface["stop"]>> } {
  return { url: "http://127.0.0.1:8026/inbox", publish: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
}

describe("run-scoped real-email coordination", () => {
  let base: string;
  let cwd: string;
  let stateDir: string;
  let provider: ReturnType<typeof receiver>;
  let options: StartCommsReceivingOptions;
  let evidence: CommsReceivingEvidence[];
  let secrets: Set<string>;
  const runs: CommsReceivingRun[] = [];
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "humanish-receiving-"));
    cwd = path.join(base, "project");
    stateDir = path.join(base, "operator-state");
    await mkdir(cwd);
    provider = receiver();
    evidence = [];
    secrets = new Set();
    options = { cwd, stateDir, runId: "synthetic-study", connectionName: "mail", apiKeyEnv: "AGENTMAIL_API_KEY", adapter: provider.adapter,
      participants: ["participant-a", "participant-b"],
      writeEvidence: async value => { evidence.push(structuredClone(value)); },
      registerSecrets: values => { values.forEach(value => secrets.add(value)); },
      render: input => ({ files: [{ path: "inbox", body: JSON.stringify(input), contentType: "text/html; charset=utf-8" }],
        secrets: [input.address, ...input.messages.map(message => message.text)], blockedAssetCount: 0, blockedLinkCount: 0,
        linkCount: input.messages.length, codeCount: input.messages.length }) };
  });
  afterEach(async () => {
    for (const run of runs.splice(0)) await run.finish();
    vi.useRealTimers();
    await rm(base, { recursive: true, force: true });
  });
  async function start(overrides: Partial<StartCommsReceivingOptions> = {}): Promise<CommsReceivingRun> {
    const run = await startCommsReceiving({ ...options, ...overrides });
    runs.push(run);
    return run;
  }
  const recovery = () => ({ cwd, stateDir, runId: options.runId, connectionName: options.connectionName, apiKeyEnv: options.apiKeyEnv, adapter: provider.adapter });

  it("records intent before allocation, acquires all before return and only publishes each participant's projection", async () => {
    const original = provider.acquire.getMockImplementation()!;
    provider.acquire.mockImplementation(async clientId => {
      const name = (await readdir(stateDir)).find(value => value.endsWith(".json"))!;
      const journal = JSON.parse(await readFile(path.join(stateDir, name), "utf8"));
      expect(journal.leases.find((lease: { clientId: string }) => lease.clientId === clientId).state).toBe("intent");
      expect(evidence[0]).toMatchObject({ publication: "restricted-real-communications", state: "acquiring" });
      return original(clientId);
    });
    const run = await start();
    expect(provider.acquire).toHaveBeenCalledTimes(2);
    expect(run.address("participant-a")).not.toBe(run.address("participant-b"));
    expect(secrets.has(run.address("participant-a"))).toBe(true);
    const a = surface();
    const b = surface();
    provider.batch.set("provider-resource-1", [complete([email("a-one"), email("a-two"), email("a-one")]), complete([email("a-two"), email("a-one")])]);
    provider.batch.set("provider-resource-2", [complete([email("b-one", "participant-b-only-message")]), empty()]);
    await Promise.all([run.attach("participant-a", { surface: a, allowedOrigins: ["https://example.test"] }),
      run.attach("participant-b", { surface: b, allowedOrigins: ["https://example.test"] })]);
    expect(JSON.stringify(a.publish.mock.calls)).not.toContain("participant-b-only-message");
    expect(JSON.stringify(a.publish.mock.calls)).not.toContain("private-a-one");
    expect(run.snapshot().participants.map(item => [item.observed, item.published])).toEqual([[2, 2], [1, 1]]);
    const finished = await run.finish();
    expect(finished.participants.map(item => item.messages.map(message => message.id))).toEqual([["message-000001", "message-000002"], ["message-000001"]]);
    expect(finished.participants[0]?.linkCount).toBe(2); // snapshot counts, not additive polling counts
    expect(finished.participants.every(item => item.cleanup === "absent")).toBe(true);
    expect(provider.release).toHaveBeenCalledTimes(2);
    expect(a.stop).toHaveBeenCalledOnce();
    expect(b.stop).toHaveBeenCalledOnce();
    for (const privateValue of ["private-a-one", "Private subject", "provider-resource", "sender@example.test", "participant-1@example.test"]) {
      expect(JSON.stringify(evidence)).not.toContain(privateValue);
    }
    expect(finished.participants[0]?.messages[0]).toMatchObject({ providerTimestamp: "2026-01-01T12:00:00.000Z", publishedAt: expect.any(String), firstObservedAt: expect.any(String) });
    expect(await inspectCommsRecovery({ cwd, stateDir })).toMatchObject([{ status: "closed", unresolvedCount: 0, activeOwner: false }]);
  });

  it("retains observations through a failed publication even when the next provider read is empty", async () => {
    const run = await start({ participants: ["participant-a"] });
    const inbox = surface();
    const body = "synthetic-sensitive-message-449933";
    let writes = 0;
    inbox.publish.mockImplementation(async files => {
      writes += 1;
      if (files[0]!.body.includes(body)) expect(secrets.has(body)).toBe(true);
      if (writes === 2) throw new Error("arbitrary-renderer-secret-canary");
    });
    provider.batch.set("provider-resource-1", [complete([email("message", body)]), empty()]);
    await run.attach("participant-a", { surface: inbox, allowedOrigins: [] });
    expect(run.snapshot().participants[0]).toMatchObject({ observed: 1, published: 0, limitations: ["surface_publication_failed"] });
    const final = await run.finish();
    expect(final.participants[0]).toMatchObject({ observed: 1, published: 1, cleanup: "absent" });
    expect(inbox.publish).toHaveBeenCalledTimes(3); // empty, failed content, retried retained content
    expect(inbox.publish.mock.calls.at(-1)?.[0][0]?.body).toContain(body);
    expect(JSON.stringify(final)).not.toContain("arbitrary-renderer-secret-canary");
  });

  it("hydrates a previously observed message after a failed content/image retrieval without inventing another observation", async () => {
    const run = await start({ participants: ["participant-a"] });
    const inbox = surface();
    const partial = { ...email("retry", ""), limitations: ["agentmail_content_missing", "agentmail_attachment_unavailable"] };
    const image = { contentId: "logo", contentType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VwAAAABJRU5ErkJggg==" };
    const hydrated = { ...email("retry", "The complete synthetic message"), html: '<p>The complete synthetic message</p><img src="cid:logo">', inlineImages: [image] };
    provider.batch.set("provider-resource-1", [complete([partial]), complete([hydrated])]);
    await run.attach("participant-a", { surface: inbox, allowedOrigins: [] });
    const initial = run.snapshot().participants[0]!.messages[0]!;
    expect(inbox.publish.mock.calls.at(-1)?.[0][0]?.body).not.toContain(image.base64);
    const result = await run.finish();
    const participant = result.participants[0]!;
    expect(participant).toMatchObject({ observed: 1, published: 1, cleanup: "absent" });
    expect(participant.messages).toEqual([initial]);
    expect(participant.limitations).toEqual(expect.arrayContaining(["agentmail_content_missing", "agentmail_attachment_unavailable", "message_content_updated_after_publication"]));
    const publication = inbox.publish.mock.calls.at(-1)?.[0][0]?.body;
    expect(inbox.publish).toHaveBeenCalledTimes(3); // empty, partial content, enriched content
    expect(publication).toContain("The complete synthetic message");
    expect(publication).toContain(image.base64);
    expect(publication).toContain("message-000001");
    expect(JSON.stringify(result)).not.toContain(image.base64);
  });

  it("retains hydrated content when a later duplicate fetch is incomplete", async () => {
    const run = await start({ participants: ["participant-a"] });
    const inbox = surface();
    const full = { ...email("stable", "The retained complete message"), html: "<p>The retained complete message</p>" };
    const partial = { ...email("stable", ""), limitations: ["agentmail_content_missing"] };
    provider.batch.set("provider-resource-1", [complete([full]), complete([partial])]);
    await run.attach("participant-a", { surface: inbox, allowedOrigins: [] });
    const result = await run.finish();
    expect(inbox.publish.mock.calls.at(-1)?.[0][0]?.body).toContain("The retained complete message");
    expect(result.participants[0]).toMatchObject({ observed: 1, published: 1 });
    expect(result.participants[0]?.limitations).toContain("agentmail_content_missing");
    expect(result.participants[0]?.limitations).not.toContain("message_content_updated_after_publication");
    expect(inbox.publish).toHaveBeenCalledTimes(2); // later failed hydration did not degrade or rewrite content
  });

  it.each(["empty", "populated"])("does not rerender or upload unchanged %s mail on periodic/final reconciliation", async kind => {
    let periodicPersisted!: () => void;
    const periodicEvidence = new Promise<void>(resolve => { periodicPersisted = resolve; });
    const render = vi.fn(options.render);
    const run = await start({ participants: ["participant-a"], render, writeEvidence: async value => {
      evidence.push(structuredClone(value));
      if (provider.read.mock.calls.length >= 2) periodicPersisted();
    } });
    const inbox = surface();
    const messages = kind === "empty" ? [] : [email("one"), email("two")];
    provider.batch.set("provider-resource-1", [complete(messages), complete([...messages].reverse()), empty()]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await run.attach("participant-a", { surface: inbox, allowedOrigins: [] });
    const publications = kind === "empty" ? 1 : 2;
    expect(inbox.publish).toHaveBeenCalledTimes(publications);
    await vi.advanceTimersByTimeAsync(3_001);
    await periodicEvidence;
    const result = await run.finish();
    expect(provider.read).toHaveBeenCalledTimes(3); // first, scheduled, final: provider coverage still reconciles
    expect(inbox.publish).toHaveBeenCalledTimes(publications);
    expect(render).toHaveBeenCalledTimes(publications);
    expect(result.participants[0]).toMatchObject({ observed: messages.length, published: messages.length, cleanup: "absent" });
    expect(result.participants[0]?.limitations).not.toContain("surface_publication_failed");
  });

  it("keeps publishing within the renderer's message cap when later messages exceed retention", async () => {
    const render = options.render;
    const run = await start({ participants: ["participant-a"], render: input => {
      if (input.messages.length > 100) throw new Error("Renderer capacity exceeded");
      return render(input);
    } });
    const inbox = surface();
    provider.batch.set("provider-resource-1", [complete(Array.from({ length: 100 }, (_, index) => email(`bounded-${index}`))), complete([email("overflow")])]);
    await run.attach("participant-a", { surface: inbox, allowedOrigins: [] });
    const result = await run.finish();
    expect(result.participants[0]).toMatchObject({ observed: 100, published: 100 });
    expect(result.participants[0]?.limitations).toContain("observation_memory_limit");
    expect(result.participants[0]?.limitations).not.toContain("surface_publication_failed");
  });

  it("records final-only mail as observed but unpublished when no participant surface was attached", async () => {
    const run = await start({ participants: ["participant-a"] });
    provider.batch.set("provider-resource-1", [complete([email("late")])]);
    const result = await run.finish();
    expect(result.participants[0]).toMatchObject({ observed: 1, published: 0, cleanup: "absent", limitations: ["participant_surface_not_attached"] });
    expect(result.participants[0]?.messages[0]?.publishedAt).toBeUndefined();
  });

  it("preserves uncertainty after a lost create response; explicit recovery replays only that immutable intent", async () => {
    const original = provider.acquire.getMockImplementation()!;
    const clientIds: string[] = [];
    provider.acquire.mockImplementation(async clientId => {
      clientIds.push(clientId);
      const lease = await original(clientId);
      if (clientIds.length === 2) throw new Error("lost-create-response-canary");
      return lease;
    });
    await expect(start({ participants: ["participant-a", "participant-b", "participant-c"] })).rejects.toMatchObject({ code: "comms_acquisition_failed" });
    expect(provider.acquire).toHaveBeenCalledTimes(2);
    expect(provider.release).toHaveBeenCalledTimes(1);
    expect(provider.resources.size).toBe(1);
    const inspected = await inspectCommsRecovery({ cwd, stateDir });
    expect(inspected).toMatchObject([{ status: "unresolved", unresolvedCount: 1, activeOwner: false }]);
    expect(JSON.stringify(inspected)).not.toContain("provider-resource");
    expect(provider.acquire).toHaveBeenCalledTimes(2); // inspection is not a create retry
    const recovered = await recoverCommsReceiving(recovery());
    expect(recovered).toMatchObject({ ok: true, recovered: 1, unresolved: 0 });
    expect(clientIds).toEqual([clientIds[0], clientIds[1], clientIds[1]]);
    expect(provider.resources.size).toBe(0);
    expect(evidence.at(-1)?.participants[2]).toMatchObject({ acquisition: "failed", cleanup: "absent" });
  });

  it("does not delete observations whose final evidence cannot be persisted; recovery disposes retained ownership", async () => {
    let failure = false;
    const run = await start({ participants: ["participant-a"], writeEvidence: async value => {
      if (failure) throw new Error("private-filesystem-diagnostic");
      evidence.push(value);
    } });
    const inbox = surface();
    await run.attach("participant-a", { surface: inbox, allowedOrigins: [] });
    failure = true;
    const result = await run.finish();
    expect(result.participants[0]).toMatchObject({ cleanup: "unresolved", limitations: ["cleanup_retained_for_evidence"] });
    expect(result.limitations).toContain("evidence_write_failed");
    expect(inbox.stop).toHaveBeenCalledOnce();
    expect(provider.release).not.toHaveBeenCalled();
    expect(provider.resources.size).toBe(1);
    expect(await recoverCommsReceiving(recovery())).toMatchObject({ ok: true, recovered: 1 });
  });

  it("allocates nothing if the initial evidence restriction cannot be recorded", async () => {
    await expect(start({ writeEvidence: async () => { throw new Error("evidence unavailable"); } })).rejects.toMatchObject({ code: "evidence_write_failed" });
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.release).not.toHaveBeenCalled();
    expect(await inspectCommsRecovery({ cwd, stateDir })).toMatchObject([{ status: "closed", unresolvedCount: 0 }]);
  });

  it.each(["pod", "inbox"] as const)("rejects unsupported %s scope before recording intents or requesting inboxes", async scopeType => {
    provider.authenticate.mockResolvedValue({ ...provider.identity, scopeType });
    await expect(start()).rejects.toMatchObject({ code: "comms_scope_unsupported" });
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.release).not.toHaveBeenCalled();
    await expect(readdir(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancellation racing creation retains the original intent instead of inventing replacement ownership", async () => {
    const controller = new AbortController();
    const original = provider.acquire.getMockImplementation()!;
    let first = true;
    provider.acquire.mockImplementation(async clientId => {
      const lease = await original(clientId);
      if (first) { first = false; controller.abort(); }
      return lease;
    });
    await expect(start({ signal: controller.signal })).rejects.toMatchObject({ code: "comms_cancelled" });
    expect(provider.resources.size).toBe(1);
    expect(provider.release).not.toHaveBeenCalled();
    expect(await recoverCommsReceiving(recovery())).toMatchObject({ ok: true, recovered: 1 });
    expect(provider.acquire.mock.calls[1]?.[0]).toBe(provider.acquire.mock.calls[0]?.[0]);
  });

  it("cancels an in-flight poll, does final reconciliation, and finishes idempotently before release", async () => {
    const controller = new AbortController();
    const run = await start({ participants: ["participant-a"], signal: controller.signal });
    const inbox = surface();
    let reading!: () => void;
    const began = new Promise<void>(resolve => { reading = resolve; });
    let first = true;
    provider.adapter.read = async (_lease, context) => {
      if (!first) return complete([email("during-close")]);
      first = false;
      reading();
      return new Promise((_resolve, reject) => context?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    };
    const attach = run.attach("participant-a", { surface: inbox, allowedOrigins: [] });
    await began;
    controller.abort();
    await attach;
    const [a, b] = await Promise.all([run.finish(), run.finish()]);
    expect(a).toEqual(b);
    expect(a.participants[0]).toMatchObject({ observed: 1, published: 1, cleanup: "absent" });
    expect(provider.release).toHaveBeenCalledOnce();
    expect(inbox.stop.mock.invocationCallOrder[0]).toBeLessThan(provider.release.mock.invocationCallOrder[0]!);
  });

  it("never releases a borrowed resource or trusts provider identifiers in a copied bundle", async () => {
    provider.acquire.mockResolvedValue({ resourceId: "borrowed-provider-resource", address: "borrowed@example.test", clientId: "not-our-intent" });
    await expect(start()).rejects.toMatchObject({ code: "comms_ownership_mismatch" });
    expect(provider.release).not.toHaveBeenCalled();
    await mkdir(path.join(cwd, ".humanish/runs/forged"), { recursive: true });
    await writeFile(path.join(cwd, ".humanish/runs/forged/comms.json"), JSON.stringify({ owned: true, resourceId: "borrowed-provider-resource" }));
    expect(await recoverCommsReceiving({ ...recovery(), runId: "forged" })).toMatchObject({ ok: false });
    expect(provider.release).not.toHaveBeenCalled();
    expect(await recoverCommsReceiving(recovery())).toMatchObject({ ok: false, unresolved: 1 });
    expect(provider.release).not.toHaveBeenCalled();
  });

  it("keeps provider failures and coverage gaps safe, without mislabeling empty data as full coverage", async () => {
    const run = await start({ participants: ["participant-a"] });
    const inbox = surface();
    provider.batch.set("provider-resource-1", [{ messages: [email("first")], complete: false,
      limitations: ["agentmail_page_limit", "sensitive-provider-response-canary"] }, empty()]);
    await run.attach("participant-a", { surface: inbox, allowedOrigins: [] });
    const evidence = await run.finish();
    expect(evidence.participants[0]?.limitations).toEqual(["agentmail_page_limit", "provider_coverage_limited"]);
    expect(JSON.stringify(evidence)).not.toContain("sensitive-provider-response-canary");
  });

  it("bounds an uncooperative poll and still stops the surface and releases the owned resource", async () => {
    const run = await start({ participants: ["participant-a"] });
    const inbox = surface();
    let reading!: () => void;
    const began = new Promise<void>(resolve => { reading = resolve; });
    let calls = 0;
    provider.adapter.read = async () => {
      calls += 1;
      if (calls === 1) { reading(); return new Promise(() => undefined); }
      return empty();
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const attach = run.attach("participant-a", { surface: inbox, allowedOrigins: [] });
    await began;
    await vi.advanceTimersByTimeAsync(15_001);
    await attach;
    const result = await run.finish();
    expect(result.participants[0]?.limitations).toContain("comms_deadline_exceeded");
    expect(provider.release).toHaveBeenCalledOnce();
    expect(inbox.stop).toHaveBeenCalledOnce();
  });

  it("lets the real adapter return earlier messages when a later response body reaches its deadline", async () => {
    // Start with captured provider shapes and mutate only the adverse second-message response.
    const fixture = async (name: string): Promise<{ status: number; body: Record<string, unknown> | null }> =>
      JSON.parse(await readFile(new URL(`./fixtures/agentmail-receiving/${name}.json`, import.meta.url), "utf8"));
    const [auth, mailbox, listing, detail, noMessages, absent, deleted] = await Promise.all(
      ["auth", "inbox", "messages", "message", "empty", "absent", "delete-accepted"].map(fixture));
    detail!.body!.attachments = [];
    const first = (listing!.body!.messages as Array<Record<string, unknown>>)[0]!;
    listing!.body!.messages = [first, { ...first, message_id: "second-hanging-message" }];
    const respond = (wire: { status: number; body: unknown }): Response => new Response(wire.body === null ? null : JSON.stringify(wire.body), { status: wire.status });
    let reads = 0, removed = false;
    let hanging!: () => void;
    const began = new Promise<void>(resolve => { hanging = resolve; });
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/auth/me") return respond(auth!);
      if (init?.method === "POST") {
        mailbox!.body!.client_id = JSON.parse(String(init.body)).client_id;
        return respond(mailbox!);
      }
      if (init?.method === "DELETE") { removed = true; return respond(deleted!); }
      if (url.pathname.endsWith("/messages")) { reads += 1; return respond(reads === 1 ? listing! : noMessages!); }
      if (url.pathname.endsWith("/second-hanging-message")) {
        hanging();
        return new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => undefined); } }));
      }
      if (url.pathname.endsWith("/message-fixture-1")) return respond(detail!);
      return respond(removed ? absent! : mailbox!);
    }) as typeof fetch;
    const adapter = createAgentMailReceiver({ apiKey: "synthetic-management-key-canary", fetch: fetcher });
    const run = await start({ participants: ["participant-a"], adapter });
    const inbox = surface();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const attach = run.attach("participant-a", { surface: inbox, allowedOrigins: ["https://example.test"] });
    await began;
    await vi.advanceTimersByTimeAsync(15_001);
    await attach;
    const partial = run.snapshot().participants[0]!;
    expect(partial).toMatchObject({ observed: 1, published: 1 });
    expect(partial.limitations).toContain("agentmail_timeout");
    expect(partial.limitations).not.toContain("comms_deadline_exceeded");
    expect((await run.finish()).participants[0]?.cleanup).toBe("absent");
  });

  it("does not race a timed-out evidence callback with newer writes, and retains the mailbox", async () => {
    let hang = false;
    let writing!: () => void;
    const began = new Promise<void>(resolve => { writing = resolve; });
    const writer = vi.fn(async (value: CommsReceivingEvidence) => {
      if (hang) { writing(); await new Promise(() => undefined); }
      evidence.push(value);
    });
    const run = await start({ participants: ["participant-a"], writeEvidence: writer });
    const count = writer.mock.calls.length;
    hang = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const finish = run.finish();
    await began;
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await finish).participants[0]?.cleanup).toBe("unresolved");
    expect(writer).toHaveBeenCalledTimes(count + 1);
    expect(provider.release).not.toHaveBeenCalled();
  });

  it("distinguishes accepted asynchronous deletion from confirmed absence", async () => {
    const run = await start({ participants: ["participant-a"] });
    const original = provider.release.getMockImplementation()!;
    provider.release.mockImplementation(async () => ({ status: "deleting" }));
    const result = await run.finish();
    expect(result.participants[0]).toMatchObject({ cleanup: "deleting", limitations: expect.arrayContaining(["cleanup_absence_unconfirmed"]) });
    expect(provider.release).toHaveBeenCalledTimes(3);
    expect(await inspectCommsRecovery({ cwd, stateDir })).toMatchObject([{ status: "unresolved", unresolvedCount: 1 }]);
    provider.release.mockImplementation(original);
    expect(await recoverCommsReceiving(recovery())).toMatchObject({ ok: true, recovered: 1 });
  });
});
