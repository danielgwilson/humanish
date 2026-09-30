// The in-process email/SMS bus (#297): a working, in-memory implementation of the CommsChannel
// port. Deterministic, offline and free: a message the app under test sends (through an ingress
// such as the email catch) is routed to the addressed inbox and read back through the same port.
// Nothing leaves the process. See types.ts for the port and its public-safety notes.

import { digestText } from "../evidence/redaction.js";
import { extractLinks, extractOtpCodes } from "./extract.js";
import type {
  CommsAddress,
  CommsChannel,
  CommsChannelKind,
  CommsMessage,
  CommsInlineImage,
  InboundRaw,
  OutboundMessage,
} from "./types.js";

function sanitizeLocalPart(laneId: string): string {
  return (
    laneId
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "actor"
  );
}

function smsAddressFor(laneId: string): string {
  const digits = digestText(laneId, 16)
    .replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10))
    .slice(0, 7);
  return `+1555${digits}`;
}

export interface FakeInboxOptions {
  /** "email" (default) or "sms" — the address shape + surface differ; machinery is identical. */
  channel?: CommsChannelKind;
  /** Email domain for minted addresses. Default example.test, an RFC 6761 reserved, unroutable
   *  test domain. */
  domain?: string;
  /** Injected clock (ms) for deterministic tests. Default Date.now. */
  now?: () => number;
}

/** The in-process fake adapter. Implements the same CommsChannel port a real provider adapter would. */
export class FakeInbox implements CommsChannel {
  readonly channel: CommsChannelKind;
  readonly kind = "fake" as const;
  private readonly domain: string;
  private readonly clock: () => number;
  private readonly byLane = new Map<string, CommsAddress>();
  private readonly byValue = new Map<string, CommsAddress>();
  private readonly queues = new Map<string, CommsMessage[]>();
  private counter = 0;

  constructor(options: FakeInboxOptions = {}) {
    this.channel = options.channel ?? "email";
    this.domain = options.domain ?? "example.test";
    this.clock = options.now ?? ((): number => Date.now());
  }

  async provision(laneId: string): Promise<CommsAddress> {
    const existing = this.byLane.get(laneId);
    if (existing) return existing;
    let value =
      this.channel === "sms"
        ? smsAddressFor(laneId)
        : `${sanitizeLocalPart(laneId)}@${this.domain}`;
    // Minted identities must stay distinct. Explicit duplicate addresses below
    // are the intentional shared-mailbox path.
    if (this.byValue.has(value.toLowerCase())) {
      if (this.channel === "sms")
        throw new Error("Generated inbox identity collision; declare distinct addresses");
      let attempt = 0;
      do {
        value = `${sanitizeLocalPart(laneId)}-${digestText(`${laneId}:${attempt++}`, 16)}@${this.domain}`;
      } while (this.byValue.has(value.toLowerCase()));
    }
    const address: CommsAddress = {
      channel: this.channel,
      laneId,
      value,
      digest: digestText(value, 16),
    };
    this.byLane.set(laneId, address);
    this.byValue.set(value.toLowerCase(), address);
    this.queues.set(value.toLowerCase(), []);
    return address;
  }

  /**
   * Provision an inbox for `laneId` at an EXPLICIT address (a lab-declared recipient), so the
   * app-under-test's send to that literal address resolves in `deliverRaw` (which drops recipients
   * with no provisioned inbox). Declaring the same address intentionally shares its inbox; if `laneId` already held
   * a different auto-generated address, the declared address supersedes it (the lab's declaration
   * wins). Idempotent: re-declaring the same address returns the existing inbox without clearing it.
   */
  async provisionAddress(laneId: string, value: string): Promise<CommsAddress> {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    const prior = this.byValue.get(key);
    if (prior) {
      this.byLane.set(laneId, prior);
      return prior;
    }
    const address: CommsAddress = {
      channel: this.channel,
      laneId,
      value: normalized,
      digest: digestText(normalized, 16),
    };
    this.byLane.set(laneId, address);
    this.byValue.set(key, address);
    this.queues.set(key, []);
    return address;
  }

  private route(
    from: string,
    to: CommsAddress[],
    subject: string | undefined,
    body: string,
    inlineImages?: CommsInlineImage[],
  ): CommsMessage {
    const at = this.clock();
    const message: CommsMessage = {
      id: `comms-${(this.counter += 1).toString().padStart(4, "0")}`,
      channel: this.channel,
      from,
      to,
      ...(subject === undefined ? {} : { subject }),
      body,
      ...(inlineImages?.length ? { inlineImages } : {}),
      links: extractLinks(body),
      codes: extractOtpCodes(body),
      sentAt: at,
      deliveredAt: at,
    };
    for (const addr of to) {
      const queue = this.queues.get(addr.value.toLowerCase());
      if (queue) queue.push(message);
    }
    return message;
  }

  async send(message: OutboundMessage): Promise<CommsMessage> {
    return this.route(
      message.from.value,
      message.to,
      message.subject,
      message.body,
      message.inlineImages,
    );
  }

  async deliverRaw(inbound: InboundRaw): Promise<CommsMessage[]> {
    const to = (inbound.to ?? [])
      .map((raw) => this.byValue.get(String(raw).trim().toLowerCase()))
      .filter((address): address is CommsAddress => address !== undefined);
    if (to.length === 0) return []; // no provisioned inbox matched → nothing to deliver to
    return [this.route(inbound.from, to, inbound.subject, inbound.body, inbound.inlineImages)];
  }

  async poll(address: CommsAddress, since = 0): Promise<CommsMessage[]> {
    const queue = this.queues.get(address.value.toLowerCase()) ?? [];
    return queue.filter((message) => message.deliveredAt > since);
  }

  async teardown(): Promise<void> {
    this.byLane.clear();
    this.byValue.clear();
    this.queues.clear();
    this.counter = 0;
  }

  /** Inspection helper (tests / a surface): every inbox currently provisioned. */
  addresses(): CommsAddress[] {
    return [...this.byLane.values()];
  }
}
