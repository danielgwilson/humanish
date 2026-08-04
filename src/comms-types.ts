// The addressed message bus (#297) — the seam that makes "off-app" comms (email/SMS the persona
// actually lives in) a first-class, persona-driven testable surface. A single port, addressed by
// actor; fake (in-process) and real (provider-backed) adapters implement it identically, so the
// persona surface + evidence writer consume it without knowing which is behind it.
//
// PUBLIC-SAFETY: raw address values, message bodies, links, and codes are RUNTIME-ONLY. Only the
// address DIGEST (sha256-short, via redaction.digestText) is ever meant to reach a persisted bundle;
// a verification link / OTP has "no secret shape" (like the lobby code) → literal-scrub + digest.

export type CommsChannelKind = "email" | "sms";

/** One actor's inbox identity. `value` is runtime-only; `digest` is the only form meant to persist. */
export interface CommsAddress {
  channel: CommsChannelKind;
  /** Which lane owns this inbox. */
  actorId: string;
  /** Runtime-only raw address, e.g. patient-07@example.test | +15550137. */
  value: string;
  /** sha256-short(value) — the only form persisted (redaction.digestText). */
  digest: string;
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
}

/** A raw inbound from an INGRESS (the vendor-neutral email catch, an SMTP sink, …): recipients are
 *  raw address strings the bus resolves against its provisioned inboxes. */
export interface InboundRaw {
  from: string;
  to: string[];
  subject?: string;
  body: string;
}

/**
 * The port. Fake (in-process) + real-email + real-sms adapters implement it identically. Async so a
 * real (network) adapter fits without changing callers; the fake adapter just resolves immediately.
 */
export interface CommsChannel {
  readonly channel: CommsChannelKind;
  readonly kind: "fake" | "real";
  /** Mint/allocate an inbox for an actor (address auto-generated). Idempotent per actor. */
  provision(actorId: string): Promise<CommsAddress>;
  /** Route a composed message from one actor to addressed inboxes. Returns the delivered record. */
  send(message: OutboundMessage): Promise<CommsMessage>;
  /** Route a raw ingress delivery (app-under-test → recipient strings). Returns the messages that
   *  matched a provisioned inbox (unmatched recipients are dropped — no inbox to deliver to). */
  deliverRaw(inbound: InboundRaw): Promise<CommsMessage[]>;
  /** New messages delivered to `address` since `since` (exclusive), oldest-first. Drives the surface. */
  poll(address: CommsAddress, since?: number): Promise<CommsMessage[]>;
  /** Release inboxes BY id (mirror the by-id sandbox teardown rail). */
  teardown(): Promise<void>;
}
