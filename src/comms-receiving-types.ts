/** Internal receiving-only contract. Provider identifiers and content are host/runtime-only. */
import type { CommsInlineImage } from "./comms-types.js";

export interface ReceivingContext { signal?: AbortSignal; timeoutMs?: number }
export interface ReceivingIdentity {
  provider: "agentmail";
  accountId: string;
  scopeType: "organization" | "pod" | "inbox";
  scopeId: string;
}
export interface ReceivingLease { resourceId: string; address: string; clientId: string }
export interface ReceivedEmail {
  channel: "email";
  providerMessageId: string;
  providerTimestamp?: string;
  from: string;
  subject?: string;
  text: string;
  html?: string;
  inlineImages: CommsInlineImage[];
  limitations: string[];
}
export interface ReceivingBatch {
  messages: ReceivedEmail[];
  complete: boolean;
  /** Stable safe codes only, never provider error bodies or identifiers. */
  limitations: string[];
}
export interface ReceivingAdapter {
  readonly provider: "agentmail";
  authenticate(context?: ReceivingContext): Promise<ReceivingIdentity>;
  acquire(clientId: string, context?: ReceivingContext): Promise<ReceivingLease>;
  read(lease: ReceivingLease, context?: ReceivingContext): Promise<ReceivingBatch>;
  release(lease: ReceivingLease, context?: ReceivingContext): Promise<{ status: "absent" | "deleting" }>;
}

/** Content provided to a single participant's desktop; no provider identifiers. */
export interface ParticipantEmail extends Omit<ReceivedEmail, "providerMessageId"> { id: string }
export interface ReceivingSurfaceFile { path: string; body: string; contentType: "text/html; charset=utf-8" | "application/json; charset=utf-8" }
export interface RenderedReceivingInbox {
  files: ReceivingSurfaceFile[];
  blockedAssetCount: number;
  blockedLinkCount: number;
  /** Register before publishing; never persist this array. */
  secrets: string[];
  linkCount: number;
  codeCount: number;
}
export interface ReceivingSurface {
  url: string;
  publish(files: ReceivingSurfaceFile[]): Promise<void>;
  stop(): Promise<void>;
}

export const COMMS_RECEIVING_SCHEMA = "humanish.comms-receiving.v2";
export interface ReceivingMessageEvidence {
  id: string;
  firstObservedAt: string;
  providerTimestamp?: string;
  publishedAt?: string;
}
export interface ReceivingParticipantEvidence {
  participantId: string;
  leaseId: string;
  acquisition: "pending" | "active" | "failed";
  cleanup: "pending" | "absent" | "deleting" | "unresolved";
  observed: number;
  published: number;
  linkCount: number;
  codeCount: number;
  blockedAssetCount: number;
  blockedLinkCount: number;
  messages: ReceivingMessageEvidence[];
  limitations: string[];
}
export interface CommsReceivingEvidence {
  schema: typeof COMMS_RECEIVING_SCHEMA;
  channel: "email";
  provider: "agentmail";
  publication: "restricted-real-communications";
  state: "acquiring" | "running" | "finished";
  participants: ReceivingParticipantEvidence[];
  limitations: string[];
  /** Inbox links are constrained; the rest of the browser is not network-confined. */
  browserConfinement: "mail-surface-only";
}
