// Digest-only evidence for a captured comms thread. Proves "the verification mail arrived and
// the persona could act on it" without persisting raw PHI. Written as an adapter-artifact
// (humanish.comms-thread.v1), so it inherits the bundle's existence-verify + public-safety scan.
//
// Digest discipline (deliberate, see below): addresses + links are digested (high entropy → the digest
// is not reversible). The subject is digested too instead of stored as text, because redactText only scrubs
// secret-shaped tokens/paths, not free-form PII, so a subject like "results for <name>"
// would pass through verbatim; a sha256-16 keeps a PII subject non-reversible while still letting you
// correlate identical subjects. OTP codes are a count only, never digested: a sha256 of a 6-digit code
// has ~10^6 preimages and is trivially brute-forced back to the code, so a "code digest" would leak it.
// Net: no raw address/subject/link/OTP text ever lands in the artifact. Same caution as the lobby code.

import type { CommsMessage } from "./types.js";
import { digestText } from "../evidence/redaction.js";

const COMMS_THREAD_SCHEMA = "humanish.comms-thread.v1";

interface CommsThreadEntry {
  id: string;
  channel: CommsMessage["channel"];
  /** sha256-16 of the raw sender address. */
  fromDigest: string;
  /** sha256-16 of each recipient inbox address. */
  toDigests: string[];
  /** sha256-16 of the subject (non-reversible for a PII subject; correlates identical subjects). */
  subjectDigest?: string;
  /** sha256-16 of each actionable link (high-entropy → non-reversible). */
  linkDigests: string[];
  /** Count only: a short OTP's digest is reversible, so the code itself never lands here. */
  codeCount: number;
  sentAt: number;
  deliveredAt: number;
}

export interface CommsThreadArtifact {
  schema: typeof COMMS_THREAD_SCHEMA;
  channel: CommsMessage["channel"];
  count: number;
  thread: CommsThreadEntry[];
}

/** Project polled inbox messages into the digest-only thread artifact. Pure; the caller writes it into
 *  the run dir and registers it as an adapter-artifact. */
export function buildCommsThreadArtifact(messages: CommsMessage[]): CommsThreadArtifact {
  const channel: CommsMessage["channel"] = messages[0]?.channel ?? "email";
  const thread: CommsThreadEntry[] = messages.map((message) => ({
    id: message.id,
    channel: message.channel,
    fromDigest: digestText(message.from, 16),
    toDigests: message.to.map((address) => address.digest),
    ...(message.subject === undefined ? {} : { subjectDigest: digestText(message.subject, 16) }),
    linkDigests: message.links.map((link) => digestText(link, 16)),
    codeCount: message.codes.length,
    sentAt: message.sentAt,
    deliveredAt: message.deliveredAt,
  }));
  return { schema: COMMS_THREAD_SCHEMA, channel, count: thread.length, thread };
}
