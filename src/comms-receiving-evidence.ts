import { z } from "zod";
import { COMMS_RECEIVING_SCHEMA, type CommsReceivingEvidence } from "./comms-receiving-types.js";

const localId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
const count = z.number().int().min(0).max(100_000);
const limitations = z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,100}$/)).max(128);
const time = z.string().datetime();
export const commsReceivingEvidenceSchema = z.object({
  schema: z.literal(COMMS_RECEIVING_SCHEMA), channel: z.literal("email"), provider: z.literal("agentmail"),
  publication: z.literal("restricted-real-communications"),
  state: z.enum(["acquiring", "running", "finished"]),
  browserConfinement: z.literal("mail-surface-only"),
  limitations,
  participants: z.array(z.object({
    participantId: localId, leaseId: localId,
    acquisition: z.enum(["pending", "active", "failed"]), cleanup: z.enum(["pending", "absent", "deleting", "unresolved"]),
    observed: count, published: count, linkCount: count, codeCount: count, blockedAssetCount: count, blockedLinkCount: count,
    messages: z.array(z.object({ id: localId, firstObservedAt: time, providerTimestamp: time.optional(), publishedAt: time.optional() }).strict()).max(1000),
    limitations
  }).strict()).max(128)
}).strict();

export function isCommsReceivingEvidence(value: unknown): value is CommsReceivingEvidence {
  return commsReceivingEvidenceSchema.safeParse(value).success;
}

/** Safe operational context for findings; no raw content or provider identity reaches this projection. */
export function receivingAnalysisContext(evidence: CommsReceivingEvidence, laneId: string | undefined): string {
  const participants = evidence.participants.filter(p => p.participantId === laneId);
  const selected = participants.length ? participants : evidence.participants;
  return [
    "Real email was supplied by the Humanish harness. Provider receipt, inbox publication and a participant reading/using the email are separate observations.",
    "A missing email does not establish that the target app failed to send. Blocked assets/links and publication or collection failures are harness limitations, not target defects.",
    ...selected.map(p => `Participant ${p.participantId}: acquired=${p.acquisition}; observed=${p.observed}; published=${p.published}; blocked assets=${p.blockedAssetCount}; blocked links=${p.blockedLinkCount}; cleanup=${p.cleanup}; limitations=${p.limitations.join(",") || "none recorded"}.`),
    `Collection limitations: ${evidence.limitations.join(",") || "none recorded"}. Mail-surface links are constrained; browser navigation beyond the inbox is not confined.`
  ].join("\n");
}
