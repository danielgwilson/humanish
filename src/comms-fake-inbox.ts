// The FAKE in-process email/SMS bus (#297 Stage 2). "Fake" in the precise test-double sense (Fowler):
// a working, in-memory implementation of the CommsChannel port that takes a production shortcut — the
// same slot as Kubernetes' `fake` clientset, distinct from a mock/stub. Deterministic, $0, offline,
// public-safe: a
// message an app-under-test "sends" (via an ingress like the vendor-neutral email catch) is routed to the
// addressed actor inbox and read back through the same CommsChannel port a real provider adapter
// would implement. Nothing leaves the process. See comms-types.ts for the port + public-safety notes.

import { digestText } from "./redaction.js";
import type {
  CommsAddress,
  CommsChannel,
  CommsChannelKind,
  CommsMessage,
  InboundRaw,
  OutboundMessage
} from "./comms-types.js";

/** Extract actionable http(s) links from a message body (href="…" and bare URLs), de-duped, in order.
 *  The verification magic-link the persona would tap. Pure; body is runtime-only. */
export function extractLinks(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const url = raw.trim().replace(/[).,;'"]+$/, "");
    if (/^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };
  let m: RegExpExecArray | null;
  const href = /href\s*=\s*["']([^"']+)["']/gi;
  while ((m = href.exec(body)) !== null) push(m[1] ?? "");
  const bare = /https?:\/\/[^\s"'<>)\]]+/gi;
  while ((m = bare.exec(body)) !== null) push(m[0]);
  return out.slice(0, 50);
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract OTP-shaped tokens from a message body. Labeled codes ("your code is 481920",
 *  "verification code 8A3F2K") are high-precision and preferred; if none are labeled, fall back to an
 *  isolated 4–8 digit run (a bare OTP). Pure; tokens are runtime-only literal-scrub targets. */
export function extractOtpCodes(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const text = stripTags(body);
  const labeled: string[] = [];
  const seen = new Set<string>();
  const push = (list: string[], code: string): void => {
    const c = code.toUpperCase();
    if (c && !seen.has(c)) {
      seen.add(c);
      list.push(c);
    }
  };
  // The alphanumeric alternative requires at least one DIGIT (lookahead) so a labeled prose word like
  // "your code is INVALID" isn't captured as a code; pure-digit codes (4–8) match directly.
  const labeledRe = /(?:one[-\s]?time\s+(?:pass)?code|verification\s+code|security\s+code|access\s+code|login\s+code|confirmation\s+code|passcode|\bOTP\b|\bPIN\b|\bcode\b)\D{0,15}\b([0-9]{4,8}|(?=[A-Za-z0-9]*[0-9])[A-Z0-9]{6,8})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = labeledRe.exec(text)) !== null) push(labeled, m[1] ?? "");
  if (labeled.length > 0) return labeled.slice(0, 10);
  // Fallback: an isolated 4–8 digit run (a bare, unlabeled OTP), not embedded in a longer token.
  const bare: string[] = [];
  const bareRe = /(?<![0-9A-Za-z])([0-9]{4,8})(?![0-9A-Za-z])/g;
  while ((m = bareRe.exec(text)) !== null) push(bare, m[1] ?? "");
  return bare.slice(0, 10);
}

function sanitizeLocalPart(actorId: string): string {
  return actorId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "actor";
}

function smsAddressFor(actorId: string): string {
  const digits = digestText(actorId, 16).replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10)).slice(0, 7);
  return `+1555${digits}`;
}

export interface FakeInboxOptions {
  /** "email" (default) or "sms" — the address shape + surface differ; machinery is identical. */
  channel?: CommsChannelKind;
  /** Email domain for minted addresses. Default example.test (an RFC 6761 reserved, unroutable test
   *  domain — public-safe; override to a branded reserved domain once it's added to the email allowlist). */
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
  private readonly byActor = new Map<string, CommsAddress>();
  private readonly byValue = new Map<string, CommsAddress>();
  private readonly queues = new Map<string, CommsMessage[]>();
  private counter = 0;

  constructor(options: FakeInboxOptions = {}) {
    this.channel = options.channel ?? "email";
    this.domain = options.domain ?? "example.test";
    this.clock = options.now ?? ((): number => Date.now());
  }

  async provision(actorId: string): Promise<CommsAddress> {
    const existing = this.byActor.get(actorId);
    if (existing) return existing;
    const value = this.channel === "sms" ? smsAddressFor(actorId) : `${sanitizeLocalPart(actorId)}@${this.domain}`;
    // Address collision guard: two distinct actor ids can sanitize to the same local part. Reuse the
    // existing inbox rather than resetting its queue (which would drop already-delivered mail). Both
    // actors then share it — a fake-world edge; declare distinct addresses to avoid it.
    const prior = this.byValue.get(value.toLowerCase());
    if (prior) {
      this.byActor.set(actorId, prior);
      return prior;
    }
    const address: CommsAddress = { channel: this.channel, actorId, value, digest: digestText(value, 16) };
    this.byActor.set(actorId, address);
    this.byValue.set(value.toLowerCase(), address);
    this.queues.set(value.toLowerCase(), []);
    return address;
  }

  private route(from: string, to: CommsAddress[], subject: string | undefined, body: string): CommsMessage {
    const at = this.clock();
    const message: CommsMessage = {
      id: `comms-${(this.counter += 1).toString().padStart(4, "0")}`,
      channel: this.channel,
      from,
      to,
      ...(subject === undefined ? {} : { subject }),
      body,
      links: extractLinks(body),
      codes: extractOtpCodes(body),
      sentAt: at,
      deliveredAt: at
    };
    for (const addr of to) {
      const queue = this.queues.get(addr.value.toLowerCase());
      if (queue) queue.push(message);
    }
    return message;
  }

  async send(message: OutboundMessage): Promise<CommsMessage> {
    return this.route(message.from.value, message.to, message.subject, message.body);
  }

  async deliverRaw(inbound: InboundRaw): Promise<CommsMessage[]> {
    const to = (inbound.to ?? [])
      .map((raw) => this.byValue.get(String(raw).trim().toLowerCase()))
      .filter((address): address is CommsAddress => address !== undefined);
    if (to.length === 0) return []; // no provisioned inbox matched → nothing to deliver to
    return [this.route(inbound.from, to, inbound.subject, inbound.body)];
  }

  async poll(address: CommsAddress, since = 0): Promise<CommsMessage[]> {
    const queue = this.queues.get(address.value.toLowerCase()) ?? [];
    return queue.filter((message) => message.deliveredAt > since);
  }

  async teardown(): Promise<void> {
    this.byActor.clear();
    this.byValue.clear();
    this.queues.clear();
    this.counter = 0;
  }

  /** Inspection helper (tests / a surface): every inbox currently provisioned. */
  addresses(): CommsAddress[] {
    return [...this.byActor.values()];
  }
}
