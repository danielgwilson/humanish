import type { CuaExecutor } from "../../actors/computer-use/loop.js";
import type { LaneRunOutcome } from "./types.js";
import type { LabCommsEmail, LabCommsRecipient } from "../../lab/types.js";

/** A prepared desktop supplies only participant input/observation and its inbox location. */
export interface ReadyParticipantDesktop {
  executor: CuaExecutor;
  inbox?: { url: string; address?: string; receiving?: boolean };
}

/** Existing bundle fields. Provider-specific facts remain optional and must be measured. */
export type ParticipantDesktopEvidence = {
  /** The substrate confirmed the desktop was released (an E2B kill or a local VM shutdown). The lane
   *  outcome records it as `killed`. */
  released: boolean;
} & Pick<
  LaneRunOutcome,
  | "sandboxId"
  | "desktopDurationMs"
  | "desktopResources"
  | "streamUrlPresent"
  | "subjectCommit"
  | "desktopBrowser"
  | "desktopGeometry"
  | "stateStepRecords"
  | "phaseRecords"
  | "failureCode"
  | "commsArtifactPath"
  | "recording"
>;

/**
 * The desktop one participant runs on, owned from preparation through final evidence collection.
 * Call methods sequentially: prepare, openSession, then finalize in a finally block.
 * finalize must be idempotent, record unavailable evidence/cleanup as warnings, and not throw.
 * A constructor must not acquire resources. Participant/model behavior stays in the runner.
 *
 * The implementations (the hosted E2B desktop, the local VM, the in-process executor) live in
 * src/routes/computer-use/: each composes the provider primitives in src/substrates/ (the E2B
 * sandbox, local VMs, the Shell) with route concerns such as subject provisioning, comms and the
 * participant plan. src/substrates/ holds only the primitives.
 */
export interface ParticipantDesktop {
  prepare(): Promise<void>;
  openSession(): Promise<ReadyParticipantDesktop>;
  finalize(options: { failed: boolean }): Promise<void>;
  snapshot(): ParticipantDesktopEvidence;
}

/** The lane's addressed comms recipient, when one exists — the gate AND the address source for the
 *  inbox instruction (#351). A lane told to check an inbox it can never receive into would stall,
 *  so no addressed recipient means no instruction. */
export function inboxRecipientFor(
  commsEmail: LabCommsEmail,
  participantId: string,
): LabCommsRecipient | undefined {
  return (commsEmail.recipients ?? []).find(
    (recipient) => recipient.lane === participantId && recipient.address !== undefined,
  );
}

/** True when a lane has a declared comms recipient WITH an address, so the drain can actually match the
 *  mail the persona will be told to read. Gates the inbox instruction to lanes that can receive mail —
 *  a lane told to check an inbox it can never receive into would just stall. */
export function laneHasInboxRecipient(commsEmail: LabCommsEmail, participantId: string): boolean {
  return inboxRecipientFor(commsEmail, participantId) !== undefined;
}
