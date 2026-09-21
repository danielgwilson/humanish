/** Run-scoped real-email receiving. Resource authority and message content stay on the host. */
import {
  CommsAuthorityError, CommsLeaseStore, inspectCommsLeaseStore, sameReceivingIdentity, validReceivingIdentity,
  validReceivingLease, type CommsLeaseRecord, type CommsRecoveryEntry
} from "./comms-lease-store.js";
import {
  COMMS_RECEIVING_SCHEMA, type CommsReceivingEvidence, type ParticipantEmail, type ReceivedEmail,
  type ReceivingAdapter, type ReceivingContext, type ReceivingLease, type ReceivingParticipantEvidence,
  type ReceivingSurface, type RenderedReceivingInbox
} from "./comms-receiving-types.js";
import { capturedInlineImages } from "./comms-images.js";

export type { CommsRecoveryEntry } from "./comms-lease-store.js";
const POLL_MS = 3_000;
const REQUEST_MS = 15_000;
const SURFACE_MS = 8_000;
const EVIDENCE_MS = 5_000;
// Match the participant renderer's bounded snapshot. Crossing its cap must not poison all later publications.
const MAX_MESSAGES = 100;
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const SAFE_PROVIDER_CODES = new Set([
  "agentmail_auth_rejected", "agentmail_rate_limited", "agentmail_unavailable", "agentmail_timeout", "agentmail_cancelled",
  "agentmail_invalid_response", "agentmail_ownership_mismatch", "agentmail_not_found", "agentmail_resource_deleting",
  "agentmail_download_blocked", "agentmail_size_limit", "agentmail_invalid_input", "agentmail_request_limit",
  "agentmail_content_truncated", "agentmail_content_missing", "agentmail_timestamp_missing", "agentmail_attachment_limit",
  "agentmail_attachment_unsupported", "agentmail_attachment_unavailable", "agentmail_message_unavailable",
  "agentmail_pagination_stalled", "agentmail_page_limit"
]);

export class CommsReceivingError extends Error {
  constructor(readonly code: string) {
    super("Real email receiving could not complete. Inspect communications coverage and private cleanup status.");
    this.name = "CommsReceivingError";
  }
}
function errorCode(error: unknown, fallback: string): string {
  if (error instanceof CommsReceivingError) return error.code;
  if (error instanceof CommsAuthorityError) return "comms_authority_unavailable";
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && SAFE_PROVIDER_CODES.has(code) ? code : fallback;
}
function addCode(codes: string[], code: string): void { if (!codes.includes(code) && codes.length < 64) codes.push(code); }
function providerCodes(codes: string[], values: string[]): void {
  for (const value of values) addCode(codes, SAFE_PROVIDER_CODES.has(value) ? value : "provider_coverage_limited");
}
function now(): string { return new Date().toISOString(); }
function providerTime(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function contentBytes(message: Pick<ParticipantEmail, "from" | "text" | "html" | "subject" | "inlineImages">): number {
  return Buffer.byteLength(message.from) + Buffer.byteLength(message.text) + Buffer.byteLength(message.html ?? "")
    + Buffer.byteLength(message.subject ?? "") + message.inlineImages.reduce((sum, image) => sum + Buffer.byteLength(JSON.stringify(image)), 0);
}
/** Provider IDs deduplicate observations, not successful hydration. A later fetch may restore missing content. */
function reconcileMessage(previous: ParticipantEmail, next: ParticipantEmail): ParticipantEmail {
  const prefer = (oldValue: string | undefined, newValue: string | undefined): string | undefined => {
    if (!newValue) return oldValue;
    // Received mail is immutable: a retry may fill/truncate a representation, not revise its meaning.
    return !oldValue || newValue.length > oldValue.length ? newValue : oldValue;
  };
  const images = new Map(previous.inlineImages.map(image => [image.contentId, image]));
  for (const image of next.inlineImages) if (!images.has(image.contentId)) images.set(image.contentId, image);
  const html = prefer(previous.html, next.html);
  const subject = previous.subject || next.subject;
  const timestamp = previous.providerTimestamp ?? next.providerTimestamp;
  return { channel: "email", id: previous.id, from: previous.from || next.from,
    text: prefer(previous.text, next.text) ?? "", ...(html === undefined ? {} : { html }),
    ...(subject === undefined ? {} : { subject }), ...(timestamp === undefined ? {} : { providerTimestamp: timestamp }),
    inlineImages: capturedInlineImages([...images.values()]), limitations: next.limitations };
}
function visibleContent(message: ParticipantEmail): string {
  return JSON.stringify([message.from, message.subject, message.text, message.html, message.inlineImages]);
}
/** Deadlines bound even a broken injected dependency; cancellation reaches cooperative I/O. */
function bounded<T>(operation: (context: ReceivingContext) => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve(value as T);
    };
    const abort = (): void => { controller.abort(); finish(new CommsReceivingError("comms_cancelled")); };
    const timer = setTimeout(() => { controller.abort(); finish(new CommsReceivingError("comms_deadline_exceeded")); }, timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    // Give cooperative dependencies time to return retained partial results before our hard
    // cancellation. Equal timers make the earlier host timer discard the adapter's partial batch.
    const cooperativeTimeout = Math.max(1, timeoutMs - Math.min(500, Math.floor(timeoutMs / 10)));
    Promise.resolve().then(() => operation({ signal: controller.signal, timeoutMs: cooperativeTimeout })).then(value => finish(undefined, value), error => finish(error));
  });
}

type RenderInput = { address: string; messages: ParticipantEmail[]; allowedOrigins: string[]; originMap?: Array<[string, string]> };
export interface StartCommsReceivingOptions {
  cwd: string;
  runId: string;
  connectionName: string;
  apiKeyEnv: string;
  adapter: ReceivingAdapter;
  participants: string[];
  writeEvidence: (evidence: CommsReceivingEvidence) => Promise<void>;
  registerSecrets: (secrets: string[]) => void;
  render: (input: RenderInput) => RenderedReceivingInbox;
  signal?: AbortSignal;
  stateDir?: string;
}
export interface CommsReceivingRun {
  address(participantId: string): string;
  attach(participantId: string, options: { surface: ReceivingSurface; allowedOrigins: string[]; originMap?: Array<[string, string]> }): Promise<void>;
  finishParticipant(participantId: string): Promise<void>;
  finish(): Promise<CommsReceivingEvidence>;
  snapshot(): CommsReceivingEvidence;
}
type Participant = {
  record: CommsLeaseRecord;
  evidence: ReceivingParticipantEvidence;
  messages: Map<string, ParticipantEmail>;
  contentBytes: number;
  lease?: ReceivingLease;
  surface?: ReceivingSurface;
  allowedOrigins: string[];
  originMap?: Array<[string, string]>;
  timer?: ReturnType<typeof setTimeout>;
  task?: Promise<void>;
  readAbort?: AbortController;
  pendingPublication?: Promise<void>;
  finishing?: Promise<void>;
  finished: boolean;
};

class ReceivingRun implements CommsReceivingRun {
  private readonly participants = new Map<string, Participant>();
  private readonly evidence: CommsReceivingEvidence;
  private evidenceQueue: Promise<unknown> = Promise.resolve();
  private pendingEvidence?: Promise<void>;
  private finishPromise?: Promise<CommsReceivingEvidence>;
  private readonly onAbort = (): void => { void this.finish().catch(() => undefined); };
  constructor(private readonly options: StartCommsReceivingOptions, private readonly store: CommsLeaseStore) {
    this.evidence = { schema: COMMS_RECEIVING_SCHEMA, channel: "email", provider: "agentmail", publication: "restricted-real-communications",
      state: "acquiring", browserConfinement: "mail-surface-only", participants: [],
      limitations: ["delivery_after_observation_end_unknown", "participant_read_not_inferred_from_publication"] };
    for (const record of store.snapshot().leases) {
      const evidence: ReceivingParticipantEvidence = { participantId: record.participantId, leaseId: record.leaseId,
        acquisition: "pending", cleanup: "pending", observed: 0, published: 0, linkCount: 0, codeCount: 0,
        blockedAssetCount: 0, blockedLinkCount: 0, messages: [], limitations: [] };
      this.evidence.participants.push(evidence);
      this.participants.set(record.participantId, { record, evidence, messages: new Map(), contentBytes: 0, allowedOrigins: [], finished: false });
    }
  }
  snapshot(): CommsReceivingEvidence { return structuredClone(this.evidence); }
  private participant(id: string): Participant {
    const participant = this.participants.get(id);
    if (!participant) throw new CommsReceivingError("comms_participant_unknown");
    return participant;
  }
  private async persist(): Promise<boolean> {
    const operation = this.evidenceQueue.then(async () => {
      // A timed-out callback may still complete. Never let a later write race its older snapshot.
      if (this.pendingEvidence) return false;
      try {
        const pending = Promise.resolve().then(() => this.options.writeEvidence(this.snapshot()));
        this.pendingEvidence = pending;
        void pending.then(() => { if (this.pendingEvidence === pending) delete this.pendingEvidence; },
          () => { if (this.pendingEvidence === pending) delete this.pendingEvidence; });
        await bounded(() => pending, EVIDENCE_MS);
        return true;
      } catch { addCode(this.evidence.limitations, "evidence_write_failed"); return false; }
    });
    this.evidenceQueue = operation.catch(() => undefined);
    return operation;
  }
  async acquire(): Promise<void> {
    try {
      // Establish the publication restriction before any provider resource or participant content.
      if (!await this.persist()) throw new CommsReceivingError("evidence_write_failed");
      for (const participant of this.participants.values()) {
        if (this.options.signal?.aborted) throw new CommsReceivingError("comms_cancelled");
        await this.store.setState(participant.record.participantId, "intent");
        participant.record.state = "intent";
        const lease = await bounded(context => this.options.adapter.acquire(participant.record.clientId, context), REQUEST_MS, this.options.signal);
        if (!validReceivingLease(lease, participant.record.clientId)) throw new CommsReceivingError("comms_ownership_mismatch");
        // Never release an unexpected duplicate under a second client's authority.
        if ([...this.participants.values()].some(other => other !== participant && other.lease?.resourceId === lease.resourceId)) {
          throw new CommsReceivingError("comms_ownership_mismatch");
        }
        participant.lease = structuredClone(lease);
        await this.store.bind(participant.record.participantId, lease);
        participant.record.state = "active";
        this.options.registerSecrets([lease.address]);
        if ([...this.participants.values()].some(other => other !== participant && other.lease?.address.toLowerCase() === lease.address.toLowerCase())) {
          throw new CommsReceivingError("comms_duplicate_address");
        }
        participant.evidence.acquisition = "active";
        if (!await this.persist()) throw new CommsReceivingError("evidence_write_failed");
      }
      if (this.options.signal?.aborted) throw new CommsReceivingError("comms_cancelled");
      this.evidence.state = "running";
      if (!await this.persist()) throw new CommsReceivingError("evidence_write_failed");
      this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
    } catch (error) {
      const code = errorCode(error, "comms_acquisition_failed");
      addCode(this.evidence.limitations, code);
      for (const participant of this.participants.values()) {
        if (participant.evidence.acquisition === "pending") {
          participant.evidence.acquisition = "failed";
          addCode(participant.evidence.limitations, code);
        }
      }
      await this.finish();
      throw new CommsReceivingError(code);
    }
  }
  address(participantId: string): string {
    const participant = this.participant(participantId);
    if (this.evidence.state !== "running" || !participant.lease || participant.finished || participant.finishing) {
      throw new CommsReceivingError("comms_participant_inactive");
    }
    return participant.lease.address;
  }
  private remember(participant: Participant, message: ReceivedEmail): void {
    if (!message.providerMessageId) return;
    const previous = participant.messages.get(message.providerMessageId);
    providerCodes(participant.evidence.limitations, message.limitations);
    const timestamp = providerTime(message.providerTimestamp);
    if (message.providerTimestamp && !timestamp) addCode(participant.evidence.limitations, "provider_timestamp_invalid");
    const id = previous?.id ?? `message-${String(participant.messages.size + 1).padStart(6, "0")}`;
    const { providerMessageId: _privateId, ...content } = message;
    const current = previous ? reconcileMessage(previous, { ...content, id }) : { ...content, id };
    const size = contentBytes(current);
    const previousSize = previous ? contentBytes(previous) : 0;
    if ((!previous && participant.messages.size >= MAX_MESSAGES) || participant.contentBytes - previousSize + size > MAX_CONTENT_BYTES) {
      addCode(participant.evidence.limitations, "observation_memory_limit");
      return;
    }
    participant.messages.set(message.providerMessageId, structuredClone(current));
    participant.contentBytes += size - previousSize;
    if (previous) {
      const observation = participant.evidence.messages.find(item => item.id === id)!;
      if (timestamp && observation.providerTimestamp === undefined) observation.providerTimestamp = timestamp;
      if (observation.publishedAt && visibleContent(previous) !== visibleContent(current)) {
        // publishedAt is the first publication, not a claim that a subsequently enriched version was seen.
        addCode(participant.evidence.limitations, "message_content_updated_after_publication");
      }
    } else participant.evidence.messages.push({ id, firstObservedAt: now(), ...(timestamp ? { providerTimestamp: timestamp } : {}) });
    participant.evidence.observed = participant.messages.size;
  }
  private async publish(participant: Participant): Promise<boolean> {
    if (!participant.surface || !participant.lease) return false;
    if (participant.pendingPublication) { addCode(participant.evidence.limitations, "surface_publication_pending"); return false; }
    try {
      const rendered = this.options.render({ address: participant.lease.address, messages: [...participant.messages.values()],
        allowedOrigins: participant.allowedOrigins, ...(participant.originMap ? { originMap: participant.originMap } : {}) });
      this.options.registerSecrets(rendered.secrets);
      participant.evidence.linkCount = rendered.linkCount;
      participant.evidence.codeCount = rendered.codeCount;
      participant.evidence.blockedAssetCount = rendered.blockedAssetCount;
      participant.evidence.blockedLinkCount = rendered.blockedLinkCount;
      if (rendered.blockedAssetCount > 0) addCode(participant.evidence.limitations, "remote_or_unsafe_assets_blocked");
      if (rendered.blockedLinkCount > 0) addCode(participant.evidence.limitations, "out_of_scope_links_blocked");
      const pending = Promise.resolve().then(() => participant.surface!.publish(rendered.files));
      participant.pendingPublication = pending;
      void pending.then(() => { if (participant.pendingPublication === pending) delete participant.pendingPublication; },
        () => { if (participant.pendingPublication === pending) delete participant.pendingPublication; });
      await bounded(() => pending, SURFACE_MS);
      const publishedAt = now();
      for (const message of participant.evidence.messages) message.publishedAt ??= publishedAt;
      participant.evidence.published = participant.evidence.messages.filter(message => message.publishedAt !== undefined).length;
      return true;
    } catch { addCode(participant.evidence.limitations, "surface_publication_failed"); return false; }
  }
  private async poll(participant: Participant, final = false): Promise<void> {
    if (!participant.lease || (!final && (participant.finishing || participant.finished))) return;
    const controller = new AbortController();
    participant.readAbort = controller;
    try {
      await this.store.assertOwnership();
      const batch = await bounded(context => this.options.adapter.read(structuredClone(participant.lease!), context), REQUEST_MS, controller.signal);
      for (const message of batch.messages) this.remember(participant, message);
      providerCodes(participant.evidence.limitations, batch.limitations);
      if (!batch.complete) addCode(participant.evidence.limitations, "provider_coverage_limited");
    } catch (error) {
      // A final bounded reconciliation follows an intentional in-flight cancellation.
      if (!(participant.finishing && !final && controller.signal.aborted)) addCode(participant.evidence.limitations, errorCode(error, "mail_poll_failed"));
    } finally { delete participant.readAbort; }
    // Retained messages are retried even if this provider read failed or no longer lists them.
    await this.persist();
    if (participant.surface) await this.publish(participant);
    await this.persist();
  }
  private schedule(participant: Participant): void {
    if (participant.finished || participant.finishing || this.finishPromise) return;
    participant.timer = setTimeout(() => {
      participant.task = this.poll(participant).finally(() => { delete participant.task; this.schedule(participant); });
    }, POLL_MS);
    participant.timer.unref();
  }
  async attach(participantId: string, options: { surface: ReceivingSurface; allowedOrigins: string[]; originMap?: Array<[string, string]> }): Promise<void> {
    const participant = this.participant(participantId);
    if (this.evidence.state !== "running" || participant.surface || participant.finishing || participant.finished) {
      try { await bounded(() => options.surface.stop(), SURFACE_MS); } catch { /* The caller still owns the desktop. */ }
      throw new CommsReceivingError("comms_participant_inactive");
    }
    participant.surface = options.surface;
    participant.allowedOrigins = [...options.allowedOrigins];
    if (options.originMap) participant.originMap = structuredClone(options.originMap);
    participant.task = (async () => {
      if (!await this.publish(participant)) throw new CommsReceivingError("surface_publication_failed");
      await this.persist();
      await this.poll(participant);
    })();
    try { await participant.task; }
    finally { delete participant.task; this.schedule(participant); }
  }
  private async release(participant: Participant): Promise<void> {
    if (!participant.lease) {
      if (participant.record.state === "planned") {
        await this.store.setState(participant.record.participantId, "not-created");
        participant.evidence.cleanup = "absent";
      } else {
        await this.store.setState(participant.record.participantId, "unresolved");
        participant.evidence.cleanup = "unresolved";
        addCode(participant.evidence.limitations, "acquisition_outcome_unknown");
      }
      return;
    }
    await this.store.assertOwnership();
    if (!this.store.snapshot().leases.find(item => item.participantId === participant.record.participantId)?.lease) {
      await this.store.bind(participant.record.participantId, participant.lease);
    }
    await this.store.setState(participant.record.participantId, "closing");
    const status = await releaseOwned(this.options.adapter, participant.lease, this.store);
    participant.evidence.cleanup = status;
    await this.store.setState(participant.record.participantId, status);
    if (status === "deleting") addCode(participant.evidence.limitations, "cleanup_absence_unconfirmed");
  }
  finishParticipant(participantId: string): Promise<void> {
    const participant = this.participant(participantId);
    if (participant.finishing) return participant.finishing;
    participant.finishing = Promise.resolve().then(async () => {
      if (participant.timer) clearTimeout(participant.timer);
      participant.readAbort?.abort();
      try { await participant.task; } catch { /* Final reconciliation retries publication. */ }
      try { await this.store.setState(participantId, participant.lease ? "closing" : participant.record.state); }
      catch { addCode(participant.evidence.limitations, "comms_authority_unavailable"); }
      if (participant.lease && this.evidence.state === "running") await this.poll(participant, true);
      if (!participant.surface && participant.lease) addCode(participant.evidence.limitations, "participant_surface_not_attached");
      const evidenceSaved = await this.persist();
      if (participant.surface) {
        try { await bounded(() => participant.surface!.stop(), SURFACE_MS); }
        catch { addCode(participant.evidence.limitations, "surface_stop_unconfirmed"); }
      }
      try {
        if (!evidenceSaved && participant.lease) {
          // Preserve the only retrievable copy when observation evidence could not be committed.
          participant.evidence.cleanup = "unresolved";
          addCode(participant.evidence.limitations, "cleanup_retained_for_evidence");
          await this.store.setState(participantId, "unresolved");
        } else await this.release(participant);
      } catch (error) {
        participant.evidence.cleanup = "unresolved";
        addCode(participant.evidence.limitations, errorCode(error, "cleanup_failed"));
        try { await this.store.setState(participantId, "unresolved"); } catch { addCode(participant.evidence.limitations, "comms_authority_unavailable"); }
      }
      participant.finished = true;
      participant.messages.clear();
      await this.persist();
    });
    return participant.finishing;
  }
  finish(): Promise<CommsReceivingEvidence> {
    this.finishPromise ??= (async () => {
      this.options.signal?.removeEventListener("abort", this.onAbort);
      await Promise.all([...this.participants.keys()].map(id => this.finishParticipant(id)));
      this.evidence.state = "finished";
      await this.persist();
      try { await this.store.close(); }
      catch { addCode(this.evidence.limitations, "comms_authority_unavailable"); await this.persist(); }
      return this.snapshot();
    })();
    return this.finishPromise;
  }
}

async function releaseOwned(adapter: ReceivingAdapter, lease: ReceivingLease, store: CommsLeaseStore): Promise<"absent" | "deleting"> {
  // Each call has an operation deadline; the small retry count bounds asynchronous deletion.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await store.assertOwnership();
    const authority = store.snapshot().leases.find(item => item.clientId === lease.clientId);
    if (!authority || authority.ownership !== "fresh" || authority.lease?.resourceId !== lease.resourceId || authority.lease.address !== lease.address) {
      throw new CommsReceivingError("comms_ownership_mismatch");
    }
    const result = await bounded(context => adapter.release(structuredClone(lease), context), REQUEST_MS);
    if (result.status === "absent") return "absent";
    if (result.status !== "deleting") throw new CommsReceivingError("cleanup_invalid_result");
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return "deleting";
}

export async function startCommsReceiving(options: StartCommsReceivingOptions): Promise<CommsReceivingRun> {
  try {
    if (options.adapter.provider !== "agentmail") throw new CommsReceivingError("comms_provider_unsupported");
    const identity = await bounded(context => options.adapter.authenticate(context), REQUEST_MS, options.signal);
    if (!validReceivingIdentity(identity)) throw new CommsReceivingError("comms_identity_invalid");
    // Fresh-inbox creation is supported only for the organization-scoped route advertised by setup.
    if (identity.scopeType !== "organization") throw new CommsReceivingError("comms_scope_unsupported");
    const store = await CommsLeaseStore.create({ cwd: options.cwd, runId: options.runId, connectionName: options.connectionName,
      apiKeyEnv: options.apiKeyEnv, identity, participants: options.participants, ...(options.stateDir ? { stateDir: options.stateDir } : {}) });
    const run = new ReceivingRun(options, store);
    await run.acquire();
    return run;
  } catch (error) { throw new CommsReceivingError(errorCode(error, "comms_start_failed")); }
}

/** Side-effect-free local inspection: does not authenticate, enumerate provider resources or replay creation. */
export async function inspectCommsRecovery(options: { cwd: string; stateDir?: string }): Promise<CommsRecoveryEntry[]> {
  return inspectCommsLeaseStore(options);
}

/** Explicit mutation: may replay an uncertain original create, then immediately dispose that exact resource. */
export async function recoverCommsReceiving(options: { cwd: string; runId: string; connectionName: string; apiKeyEnv: string; adapter: ReceivingAdapter; stateDir?: string }): Promise<{ ok: boolean; recovered: number; unresolved: number; message: string }> {
  let store: CommsLeaseStore | undefined;
  let recovered = 0;
  let unresolved = 0;
  let result: { ok: boolean; recovered: number; unresolved: number; message: string };
  try {
    store = await CommsLeaseStore.recover(options);
    const identity = await bounded(context => options.adapter.authenticate(context), REQUEST_MS);
    if (!validReceivingIdentity(identity) || !sameReceivingIdentity(store.snapshot().identity, identity)) throw new CommsAuthorityError("binding_mismatch");
    for (const record of store.snapshot().leases) {
      if (record.state === "absent" || record.state === "not-created") continue;
      try {
        if (record.state === "planned") { await store.setState(record.participantId, "not-created"); continue; }
        await store.assertOwnership();
        // Use the recorded client ID even if no resource ID was received before the interruption.
        const lease = record.lease ?? await bounded(context => options.adapter.acquire(record.clientId, context), REQUEST_MS);
        if (!validReceivingLease(lease, record.clientId)) throw new CommsAuthorityError("binding_mismatch");
        if (!record.lease) await store.bind(record.participantId, lease);
        await store.setState(record.participantId, "closing");
        const status = await releaseOwned(options.adapter, lease, store);
        await store.setState(record.participantId, status);
        if (status === "absent") recovered += 1; else unresolved += 1;
      } catch {
        unresolved += 1;
        try { await store.setState(record.participantId, "unresolved"); } catch { /* Original durable intent remains. */ }
      }
    }
    result = { ok: unresolved === 0, recovered, unresolved, message: unresolved === 0
      ? "Owned inbox cleanup is confirmed absent. This does not establish permanent provider data erasure."
      : "Some owned inbox cleanup is unresolved. Retry explicit recovery with the same connection; no replacement identities were requested." };
  } catch (error) {
    unresolved = store?.snapshot().leases.filter(item => item.state !== "absent" && item.state !== "not-created").length ?? 0;
    result = { ok: false, recovered, unresolved, message: error instanceof CommsAuthorityError ? error.message
      : "Communications recovery could not establish provider access. No unverified resource was deleted." };
  }
  if (store) {
    try { await store.close(); }
    catch { result = { ...result, ok: false, message: "Communications authority could not be finalized. Inspect local recovery status before retrying." }; }
  }
  return result;
}
