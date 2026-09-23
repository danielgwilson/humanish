import type { CuaExecutor } from './computer-use.js';
import type { LaneRunOutcome } from './cua-actor-lab.js';
import type { LabCommsEmail, LabCommsRecipient } from './lab-config.js';

/** A prepared desktop supplies only participant input/observation and its inbox location. */
export interface ReadyCuaDesktop {
  executor: CuaExecutor;
  inbox?: { url: string; address?: string; receiving?: boolean; };
}

/** Existing bundle fields. Provider-specific facts remain optional and must be measured. */
export type DesktopLaneEvidence = Pick<LaneRunOutcome,
  'sandboxId' | 'desktopDurationMs' | 'desktopResources' | 'killed' | 'streamUrlPresent' |
  'subjectCommit' | 'desktopBrowser' | 'desktopGeometry' | 'stateStepRecords' | 'phaseRecords' |
  'failureCode' | 'commsArtifactPath'>;

/** One lane owns its desktop through preparation failure and final evidence collection.
 * Call methods sequentially: prepare, openSession, then finalize in a finally block.
 * finalize must be idempotent, record unavailable evidence/cleanup as warnings, and not throw.
 * A constructor must not acquire resources. Participant/model behavior stays in the runner.
 */
export interface CuaDesktopLane {
  prepare(): Promise<void>;
  openSession(): Promise<ReadyCuaDesktop>;
  finalize(options: { failed: boolean; }): Promise<void>;
  snapshot(): DesktopLaneEvidence;
}

/** The lane's addressed comms recipient, when one exists — the gate AND the address source for the
 *  inbox instruction (#351). A lane told to check an inbox it can never receive into would stall,
 *  so no addressed recipient means no instruction. */
export function inboxRecipientFor(commsEmail: LabCommsEmail, laneId: string): LabCommsRecipient | undefined {
  return (commsEmail.recipients ?? []).find((recipient) => recipient.lane === laneId && recipient.address !== undefined);
}

/** True when a lane has a declared comms recipient WITH an address, so the drain can actually match the
 *  mail the persona will be told to read. Gates the inbox instruction to lanes that can receive mail —
 *  a lane told to check an inbox it can never receive into would just stall. */
export function laneHasInboxRecipient(commsEmail: LabCommsEmail, laneId: string): boolean {
  return inboxRecipientFor(commsEmail, laneId) !== undefined;
}
