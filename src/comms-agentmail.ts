import { inlineImageData, MAX_INLINE_IMAGE_BYTES, MAX_INLINE_IMAGES_BYTES, MAX_INLINE_IMAGES } from "./comms-images.js";
import type { ReceivingAdapter, ReceivingBatch, ReceivingContext, ReceivingIdentity, ReceivingLease, ReceivedEmail } from "./comms-receiving-types.js";

const API_ORIGIN = "https://api.agentmail.to";
const DOWNLOAD_ORIGIN = "https://cdn.agentmail.to";
/** Bounds apply to a whole operation, including every page, message and download. */
export const AGENTMAIL_RECEIVING_LIMITS = Object.freeze({
  timeoutMs: 30_000, maxTimeoutMs: 60_000, pages: 4, pageSize: 25, messages: 100,
  requests: 160, operationBytes: 12 * 1024 * 1024, responseBytes: 2 * 1024 * 1024,
  textBytes: 256 * 1024, downloadRedirects: 2,
});
export type AgentMailReceivingErrorCode =
  | "agentmail_auth_rejected" | "agentmail_rate_limited" | "agentmail_unavailable"
  | "agentmail_timeout" | "agentmail_cancelled" | "agentmail_invalid_response"
  | "agentmail_ownership_mismatch" | "agentmail_not_found" | "agentmail_resource_deleting"
  | "agentmail_download_blocked" | "agentmail_size_limit" | "agentmail_invalid_input"
  | "agentmail_request_limit";

/** Safe for callers to report. Never retains the response body, URL, key or caught cause. */
export class AgentMailReceivingError extends Error {
  constructor(readonly code: AgentMailReceivingErrorCode) {
    super(code);
    this.name = "AgentMailReceivingError";
  }
}
function fail(code: AgentMailReceivingErrorCode): never { throw new AgentMailReceivingError(code); }
function safeCode(error: unknown): AgentMailReceivingErrorCode {
  return error instanceof AgentMailReceivingError ? error.code : "agentmail_unavailable";
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("agentmail_invalid_response");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1024 || /[\u0000-\u0020\u007f]/.test(value)) fail("agentmail_invalid_response");
  return value;
}
function inputId(value: unknown): string {
  try { return identifier(value); } catch { return fail("agentmail_invalid_input"); }
}
function checkLease(lease: ReceivingLease): void {
  inputId(lease.resourceId); inputId(lease.address); inputId(lease.clientId);
}
const inboxPath = (lease: ReceivingLease) => `/v0/inboxes/${encodeURIComponent(lease.resourceId)}`;
const messagePath = (lease: ReceivingLease, id: string) => `${inboxPath(lease)}/messages/${encodeURIComponent(id)}`;

interface Budget { signal: AbortSignal; bytes: number; requests: number; cancelled: () => boolean }
function abortCode(budget: Budget): AgentMailReceivingErrorCode { return budget.cancelled() ? "agentmail_cancelled" : "agentmail_timeout"; }
function checkAbort(budget: Budget): void { if (budget.signal.aborted) fail(abortCode(budget)); }
function bounded<T>(promise: Promise<T>, budget: Budget): Promise<T> {
  if (budget.signal.aborted) return Promise.reject(new AgentMailReceivingError(abortCode(budget)));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AgentMailReceivingError(abortCode(budget)));
    budget.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => budget.signal.removeEventListener("abort", onAbort)).catch(() => {});
  });
}
async function operation<T>(context: ReceivingContext | undefined, action: (budget: Budget) => Promise<T>): Promise<T> {
  const timeout = context?.timeoutMs ?? AGENTMAIL_RECEIVING_LIMITS.timeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0) fail("agentmail_invalid_input");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(onAbort, Math.min(timeout, AGENTMAIL_RECEIVING_LIMITS.maxTimeoutMs));
  const budget: Budget = { signal: controller.signal, bytes: 0, requests: 0, cancelled: () => context?.signal?.aborted === true };
  context?.signal?.addEventListener("abort", onAbort, { once: true });
  if (context?.signal?.aborted) controller.abort();
  try { checkAbort(budget); return await action(budget); }
  catch (error) { throw new AgentMailReceivingError(safeCode(error)); }
  finally { clearTimeout(timer); context?.signal?.removeEventListener("abort", onAbort); controller.abort(); }
}
async function bodyBytes(response: Response, budget: Budget, maximum: number): Promise<Buffer> {
  checkAbort(budget);
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    void response.body?.cancel().catch(() => {}); fail("agentmail_size_limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await bounded(reader.read(), budget);
      if (result.done) break;
      size += result.value.byteLength; budget.bytes += result.value.byteLength;
      if (size > maximum || budget.bytes > AGENTMAIL_RECEIVING_LIMITS.operationBytes) fail("agentmail_size_limit");
      chunks.push(result.value);
    }
    return Buffer.concat(chunks, size);
  } finally { void reader.cancel().catch(() => {}); }
}
interface ApiReply { status: number; body: unknown }
function statusError(reply: ApiReply): never {
  if ([401, 403].includes(reply.status)) fail("agentmail_auth_rejected");
  if (reply.status === 429) fail("agentmail_rate_limited");
  if (reply.status === 404 && object(reply.body).code === "not_found") fail("agentmail_not_found");
  if (reply.status === 409 && object(reply.body).code === "resource_deleting") fail("agentmail_resource_deleting");
  if (reply.status >= 500 || reply.status === 408) fail("agentmail_unavailable");
  fail("agentmail_invalid_response");
}
function success(reply: ApiReply): Record<string, unknown> {
  if (reply.status < 200 || reply.status >= 300) statusError(reply);
  return object(reply.body);
}
function absentOrDeleting(reply: ApiReply): "absent" | "deleting" | undefined {
  if (reply.status === 404 && object(reply.body).code === "not_found") return "absent";
  if (reply.status === 409 && object(reply.body).code === "resource_deleting") return "deleting";
  return undefined;
}
function assertOwnership(raw: Record<string, unknown>, lease: ReceivingLease): void {
  if (raw.inbox_id !== lease.resourceId || raw.client_id !== lease.clientId || raw.email !== lease.address) fail("agentmail_ownership_mismatch");
}
function limitedText(value: unknown, limitations: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail("agentmail_invalid_response");
  if (Buffer.byteLength(value) <= AGENTMAIL_RECEIVING_LIMITS.textBytes) return value;
  limitations.push("agentmail_content_truncated");
  // Leave no partial UTF-8 sequence at the boundary.
  return Buffer.from(value).subarray(0, AGENTMAIL_RECEIVING_LIMITS.textBytes).toString("utf8").replace(/\ufffd$/, "");
}
const transient = (code: AgentMailReceivingErrorCode) => code === "agentmail_unavailable" || code === "agentmail_timeout";

/** Host-only transport; the management credential is never sent to a desktop or download host. */
export function createAgentMailReceiver(options: { apiKey: string; fetch?: typeof globalThis.fetch }): ReceivingAdapter {
  if (!options.apiKey || options.apiKey.length > 4096 || /[\u0000-\u0020\u007f]/.test(options.apiKey)) fail("agentmail_invalid_input");
  const fetcher = options.fetch ?? globalThis.fetch;
  const key = options.apiKey;
  async function request(url: string, init: RequestInit, budget: Budget): Promise<Response> {
    checkAbort(budget);
    if (++budget.requests > AGENTMAIL_RECEIVING_LIMITS.requests) fail("agentmail_request_limit");
    try {
      return await bounded(fetcher(url, { ...init, signal: budget.signal, credentials: "omit" }).then((response) => {
        if (budget.signal.aborted) { void response.body?.cancel().catch(() => {}); fail(abortCode(budget)); }
        return response;
      }), budget);
    } catch (error) { if (budget.signal.aborted) fail(abortCode(budget)); throw new AgentMailReceivingError(safeCode(error)); }
  }
  async function api(path: string, method: "GET" | "POST" | "DELETE", budget: Budget, payload?: unknown): Promise<ApiReply> {
    const response = await request(`${API_ORIGIN}${path}`, {
      method, redirect: "error", headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }, budget);
    const bytes = await bodyBytes(response, budget, AGENTMAIL_RECEIVING_LIMITS.responseBytes);
    let body: unknown = null;
    if (bytes.length) {
      try { body = JSON.parse(bytes.toString("utf8")); }
      catch { if (response.ok) fail("agentmail_invalid_response"); }
    }
    return { status: response.status, body };
  }
  async function download(rawUrl: unknown, budget: Budget): Promise<Buffer> {
    if (typeof rawUrl !== "string" || rawUrl.length > 16_384) fail("agentmail_download_blocked");
    let url: URL;
    try { url = new URL(rawUrl); } catch { return fail("agentmail_download_blocked"); }
    for (let redirect = 0; redirect <= AGENTMAIL_RECEIVING_LIMITS.downloadRedirects; redirect++) {
      // Exact origin established by live capture. No inferred S3 wildcard and no email-body fetches.
      if (url.origin !== DOWNLOAD_ORIGIN || url.username || url.password || url.hash) fail("agentmail_download_blocked");
      const response = await request(url.href, { method: "GET", redirect: "manual" }, budget);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const next = response.headers.get("location");
        if (!next || redirect === AGENTMAIL_RECEIVING_LIMITS.downloadRedirects) fail("agentmail_download_blocked");
        try { url = new URL(next, url); } catch { return fail("agentmail_download_blocked"); }
        continue;
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); fail("agentmail_unavailable"); }
      return bodyBytes(response, budget, MAX_INLINE_IMAGE_BYTES);
    }
    return fail("agentmail_download_blocked");
  }
  async function getMessage(lease: ReceivingLease, id: string, budget: Budget): Promise<ReceivedEmail> {
    const raw = success(await api(messagePath(lease, id), "GET", budget));
    if (raw.inbox_id !== lease.resourceId || raw.message_id !== id || !Array.isArray(raw.labels) || !raw.labels.includes("received")) fail("agentmail_ownership_mismatch");
    const limitations: string[] = [];
    const from = limitedText(raw.from, limitations);
    if (!from) fail("agentmail_invalid_response");
    const text = limitedText(raw.text, limitations) ?? "";
    const html = limitedText(raw.html, limitations);
    const subject = limitedText(raw.subject, limitations);
    const message: ReceivedEmail = { channel: "email", providerMessageId: id, from, text, ...(html === undefined ? {} : { html }), ...(subject === undefined ? {} : { subject }), inlineImages: [], limitations };
    if (!text && !html) limitations.push("agentmail_content_missing");
    if (typeof raw.timestamp === "string" && raw.timestamp.length <= 64 && Number.isFinite(Date.parse(raw.timestamp))) message.providerTimestamp = new Date(raw.timestamp).toISOString();
    else limitations.push("agentmail_timestamp_missing");
    if (raw.attachments !== undefined && !Array.isArray(raw.attachments)) fail("agentmail_invalid_response");
    const attachments = (raw.attachments ?? []) as unknown[];
    if (attachments.length > MAX_INLINE_IMAGES) limitations.push("agentmail_attachment_limit");
    let imageBytes = 0;
    for (const item of attachments.slice(0, MAX_INLINE_IMAGES)) {
      try {
        const attachment = object(item);
        if (attachment.content_disposition !== "inline" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(attachment.content_type))) { limitations.push("agentmail_attachment_unsupported"); continue; }
        const attachmentId = identifier(attachment.attachment_id);
        const cid = identifier(attachment.content_id).replace(/^<|>$/g, "");
        if (cid.length > 256) fail("agentmail_invalid_response");
        if (typeof attachment.size !== "number" || !Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > MAX_INLINE_IMAGE_BYTES || imageBytes + attachment.size > MAX_INLINE_IMAGES_BYTES) fail("agentmail_size_limit");
        const descriptor = success(await api(`${messagePath(lease, id)}/attachments/${encodeURIComponent(attachmentId)}`, "GET", budget));
        if (descriptor.attachment_id !== attachmentId || descriptor.content_type !== attachment.content_type || descriptor.content_id !== attachment.content_id || descriptor.size !== attachment.size) fail("agentmail_invalid_response");
        const bytes = await download(descriptor.download_url, budget);
        if (bytes.length !== attachment.size || imageBytes + bytes.length > MAX_INLINE_IMAGES_BYTES) fail("agentmail_size_limit");
        const image = { contentId: cid, contentType: String(attachment.content_type), base64: bytes.toString("base64") };
        if (!inlineImageData(image)) fail("agentmail_invalid_response");
        imageBytes += bytes.length; message.inlineImages.push(image);
      } catch (error) {
        const code = safeCode(error);
        if (code === "agentmail_cancelled") throw error;
        limitations.push(code, "agentmail_attachment_unavailable");
        if (budget.signal.aborted || budget.bytes >= AGENTMAIL_RECEIVING_LIMITS.operationBytes || budget.requests >= AGENTMAIL_RECEIVING_LIMITS.requests) break;
      }
    }
    message.limitations = [...new Set(limitations)];
    return message;
  }
  return {
    provider: "agentmail",
    authenticate: (context) => operation(context, async (budget): Promise<ReceivingIdentity> => {
      const raw = success(await api("/v0/auth/me", "GET", budget));
      if (raw.scope_type !== "organization" && raw.scope_type !== "pod" && raw.scope_type !== "inbox") fail("agentmail_invalid_response");
      return { provider: "agentmail", accountId: identifier(raw.organization_id), scopeType: raw.scope_type, scopeId: identifier(raw.scope_id) };
    }),
    acquire: (clientId, context) => operation(context, async (budget): Promise<ReceivingLease> => {
      inputId(clientId);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = success(await api("/v0/inboxes", "POST", budget, { client_id: clientId }));
          const lease = { resourceId: identifier(raw.inbox_id), address: identifier(raw.email), clientId };
          if (raw.client_id !== clientId) fail("agentmail_ownership_mismatch");
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lease.address)) fail("agentmail_invalid_response");
          return lease;
        } catch (error) { if (attempt || !transient(safeCode(error)) || budget.signal.aborted) throw error; }
      }
      return fail("agentmail_unavailable");
    }),
    read: (lease, context) => operation(context, async (budget): Promise<ReceivingBatch> => {
      checkLease(lease);
      const batch: ReceivingBatch = { messages: [], complete: true, limitations: [] };
      const ids = new Set<string>(); const tokens = new Set<string>();
      let token: string | undefined;
      for (let page = 0; page < AGENTMAIL_RECEIVING_LIMITS.pages; page++) {
        try {
          const query = new URLSearchParams({ limit: String(AGENTMAIL_RECEIVING_LIMITS.pageSize), labels: "received", ...(token === undefined ? {} : { page_token: token }) });
          const raw = success(await api(`${inboxPath(lease)}/messages?${query}`, "GET", budget));
          if (!Array.isArray(raw.messages) || raw.messages.length > AGENTMAIL_RECEIVING_LIMITS.pageSize) fail("agentmail_invalid_response");
          for (const item of raw.messages) {
            const entry = object(item);
            if (entry.inbox_id !== lease.resourceId) fail("agentmail_ownership_mismatch");
            if (!Array.isArray(entry.labels)) fail("agentmail_invalid_response");
            if (!entry.labels.includes("received")) continue;
            const id = identifier(entry.message_id);
            if (ids.has(id)) continue;
            if (ids.size >= AGENTMAIL_RECEIVING_LIMITS.messages) fail("agentmail_size_limit");
            ids.add(id);
            try {
              const message = await getMessage(lease, id, budget);
              batch.messages.push(message);
              if (message.limitations.length) { batch.complete = false; batch.limitations.push(...message.limitations); }
            } catch (error) {
              if (safeCode(error) === "agentmail_cancelled") throw error;
              batch.complete = false; batch.limitations.push(safeCode(error), "agentmail_message_unavailable");
              if (budget.signal.aborted || budget.bytes >= AGENTMAIL_RECEIVING_LIMITS.operationBytes || budget.requests >= AGENTMAIL_RECEIVING_LIMITS.requests) throw error;
            }
          }
          if (raw.next_page_token === undefined || raw.next_page_token === null || raw.next_page_token === "") break;
          token = identifier(raw.next_page_token);
          if (tokens.has(token)) { batch.complete = false; batch.limitations.push("agentmail_pagination_stalled"); break; }
          tokens.add(token);
          if (page + 1 === AGENTMAIL_RECEIVING_LIMITS.pages) { batch.complete = false; batch.limitations.push("agentmail_page_limit"); }
        } catch (error) {
          if (safeCode(error) === "agentmail_cancelled") throw error;
          batch.complete = false; batch.limitations.push(safeCode(error)); break;
        }
      }
      batch.limitations = [...new Set(batch.limitations)];
      return batch;
    }),
    release: (lease, context) => operation(context, async (budget) => {
      checkLease(lease);
      const before = await api(inboxPath(lease), "GET", budget);
      const existing = absentOrDeleting(before);
      if (existing) return { status: existing };
      assertOwnership(success(before), lease);
      const deleted = await api(inboxPath(lease), "DELETE", budget);
      const state = absentOrDeleting(deleted);
      if (state) return { status: state };
      if (![200, 202, 204].includes(deleted.status)) statusError(deleted);
      try {
        const after = await api(inboxPath(lease), "GET", budget);
        const result = absentOrDeleting(after);
        if (result) return { status: result };
        assertOwnership(success(after), lease);
        return { status: "deleting" };
      } catch (error) {
        if (transient(safeCode(error))) return { status: "deleting" };
        throw error;
      }
    }),
  };
}
