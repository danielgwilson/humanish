// The addressed message bus for captured mail (#297): the email or SMS a persona receives off the
// app, as a testable surface. One port, addressed by lane, so the inbox surface and the evidence
// writer read messages without knowing how they were captured.
//
// PUBLIC-SAFETY: raw address values, message bodies, links, and codes are RUNTIME-ONLY. Only the
// address DIGEST (sha256-short, via redaction.digestText) is ever meant to reach a persisted bundle;
// a verification link / OTP has "no secret shape" (like the lobby code) → literal-scrub + digest.

export type CommsChannelKind = "email" | "sms";

/**
 * One participant's inbox identity. `value` is runtime-only; `digest` is the only form meant to
 * persist.
 */
export interface CommsAddress {
  channel: CommsChannelKind;
  /** Which participant owns this inbox. */
  participantId: string;
  /** Runtime-only raw address, e.g. user-07@example.test | +15550137. */
  value: string;
  /** sha256-short(value) — the only form persisted (redaction.digestText). */
  digest: string;
}

/** Runtime-only captured raster attachment. Bytes never enter digest-only evidence. */
export interface CommsInlineImage {
  contentId: string;
  contentType: string;
  base64: string;
}

/** A message that arrived to (or was sent from) an inbox. Body/links/codes are runtime-only. */
export interface CommsMessage {
  id: string;
  channel: CommsChannelKind;
  /** Raw sender — an app-under-test address, or another actor's address. Runtime-only. */
  from: string;
  /** Resolved recipient inboxes this message was delivered to. */
  to: CommsAddress[];
  subject?: string;
  /** Runtime-only for real; local-only for fake (never a share path without redaction — #108). */
  body: string;
  inlineImages?: CommsInlineImage[];
  /** Actionable links extracted from the body (magic-link / invite / reset). Runtime-only. */
  links: string[];
  /** OTP-shaped tokens extracted from the body. Runtime-only; literal-scrub targets. */
  codes: string[];
  sentAt: number;
  deliveredAt: number;
}

/** An actor sending OUT (a reply/compose); recipients are known CommsAddresses. */
export interface OutboundMessage {
  from: CommsAddress;
  to: CommsAddress[];
  subject?: string;
  body: string;
  inlineImages?: CommsInlineImage[];
}

/** A raw inbound from an INGRESS (the vendor-neutral email catch, an SMTP sink, …): recipients are
 *  raw address strings the bus resolves against its provisioned inboxes. */
export interface InboundRaw {
  from: string;
  to: string[];
  subject?: string;
  body: string;
  inlineImages?: CommsInlineImage[];
}

/**
 * The captured-mail port. Only the in-process FakeInbox implements it; real email goes through
 * ReceivingAdapter (receiving-types.ts). It is async so a network adapter could fit without
 * changing callers; the fake resolves immediately.
 */
export interface CommsChannel {
  readonly channel: CommsChannelKind;
  readonly kind: "fake" | "real";
  /** Mint an inbox for a participant (address generated). Idempotent per participant. */
  provision(participantId: string): Promise<CommsAddress>;
  /** Route a composed message from one actor to addressed inboxes. Returns the delivered record. */
  send(message: OutboundMessage): Promise<CommsMessage>;
  /** Route a raw ingress delivery (app-under-test → recipient strings). Returns the messages that
   *  matched a provisioned inbox (unmatched recipients are dropped — no inbox to deliver to). */
  deliverRaw(inbound: InboundRaw): Promise<CommsMessage[]>;
  /** New messages delivered to `address` since `since` (exclusive), oldest-first. Drives the surface. */
  poll(address: CommsAddress, since?: number): Promise<CommsMessage[]>;
  /** Release every provisioned inbox. */
  teardown(): Promise<void>;
}
