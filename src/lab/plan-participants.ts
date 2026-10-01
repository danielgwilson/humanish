// Who takes part in a lab: one record per participant, built from the declared roster or a count.
// Computer-use lanes and shared-world seats share the desktop fields; each kind adds its own.

import type { DwellWindow, StopWhen } from "../actors/stop-conditions.js";
import type { ReasoningEffort } from "../actors/reasoning-effort.js";
import { resolveParticipantDevice, type DevicePreset } from "./device-presets.js";
import { isSharedWorldComposition, participantIdAt } from "./routing.js";
import type { LabTask } from "./tasks.js";
import type { LabActorLane, LabConfig } from "./types.js";

/** Who one participant is. Every route with participants carries this record. */
export interface Participant {
  /** Declared roster id, else `lane-NN` (independent lanes) or `role-NN` (shared-world seats). */
  readonly id: string;
  /** 0-based position in the roster. Bundle `sim-NNN` and `stream-NNN` ids derive from it. */
  readonly index: number;
  /** `lanes[i].persona ?? actors[0].persona`. The route compiles the committed persona file. */
  readonly personaId: string | undefined;
  /** The declared mission and per-participant focus. An absent mission takes the route's default. */
  readonly assignment: { readonly mission?: string; readonly focus?: string };
  /** Taxonomy labels copied to the bundle and the plan table; they change no behavior. */
  readonly labels: {
    readonly actorType?: string;
    readonly surface?: string;
    readonly caseGroup?: string;
  };
}

/** A participant at a desktop: computer use and shared world. */
interface DesktopParticipant extends Participant {
  readonly device: {
    readonly name: string;
    readonly preset: DevicePreset;
    readonly resolution: [number, number];
  };
  /** Lane value, else actor value, else absent (the provider default is recorded in the trace). */
  readonly limits: {
    readonly stopWhen?: StopWhen;
    readonly dwell?: DwellWindow;
    readonly reasoningEffort?: ReasoningEffort;
    readonly maxOutputTokens?: number;
  };
}

/** Only independent computer-use lanes consume a task protocol and a per-lane target. */
export interface ComputerUseParticipant extends DesktopParticipant {
  readonly tasks?: readonly LabTask[];
  /** app-url fan-out only: this lane's own entry URL; absent means the subject URL. */
  readonly targetUrl?: string;
}

/** A seat on a provisioned plane: an optional same-origin path under `serve.url`. */
export interface ProvisionedParticipant extends DesktopParticipant {
  readonly entry?: string;
  // Fields of other participant kinds. `never` keeps them out even through a variable, where
  // TypeScript's excess-property check does not apply.
  readonly host?: never;
  readonly tasks?: never;
  readonly targetUrl?: never;
}

/** A seat on an external public plane: exactly one seat hosts the shared session. */
export interface ExternalPublicParticipant extends DesktopParticipant {
  readonly host: boolean;
  readonly entry?: never;
  readonly tasks?: never;
  readonly targetUrl?: never;
}

export type SharedWorldRoster =
  | { readonly plane: "provisioned"; readonly participants: readonly ProvisionedParticipant[] }
  | {
      readonly plane: "external-public";
      readonly participants: readonly ExternalPublicParticipant[];
    };

/** One shared-world participant on either plane. */
export type SharedWorldParticipant = ProvisionedParticipant | ExternalPublicParticipant;

function desktopParticipant(
  config: LabConfig,
  lane: LabActorLane | undefined,
  index: number,
  kind: "lane" | "seat",
  focus: string | undefined,
): DesktopParticipant {
  const actor = config.actors[0];
  const device = resolveParticipantDevice(config, lane?.device);
  const personaId = lane?.persona ?? actor?.persona;
  const mission = actor?.mission;
  const stopWhen = lane?.stopWhen ?? actor?.stopWhen;
  const dwell = lane?.dwell ?? actor?.dwell;
  const reasoningEffort = lane?.reasoningEffort ?? actor?.reasoningEffort;
  const maxOutputTokens = actor?.maxOutputTokens;
  return {
    id: participantIdAt(index, lane?.id, kind),
    index,
    personaId,
    assignment: {
      ...(mission === undefined ? {} : { mission }),
      ...(focus === undefined ? {} : { focus }),
    },
    labels: {
      ...(lane?.actorType === undefined ? {} : { actorType: lane.actorType }),
      ...(lane?.surface === undefined ? {} : { surface: lane.surface }),
      ...(lane?.caseGroup === undefined ? {} : { caseGroup: lane.caseGroup }),
    },
    device: { name: device.name, preset: device.preset, resolution: device.resolution },
    limits: {
      ...(stopWhen === undefined ? {} : { stopWhen }),
      ...(dwell === undefined ? {} : { dwell }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    },
  };
}

/**
 * The lanes of a computer-use lab: the declared roster, else `count` identical lanes. A count
 * override (`--count`) applies only when no roster is declared.
 */
export function computerUseParticipants(
  config: LabConfig,
  countOverride?: number,
): ComputerUseParticipant[] {
  const actor = config.actors[0];
  const roster = actor?.lanes;
  const count = roster ? roster.length : Math.max(1, countOverride ?? actor?.count ?? 1);
  return Array.from({ length: count }, (_, index) => {
    const lane = roster?.[index];
    const focus = roster ? lane?.instruction : actor?.laneFocus?.instruction;
    return {
      ...desktopParticipant(config, lane, index, "lane", focus),
      ...(actor?.tasks === undefined ? {} : { tasks: actor.tasks }),
      ...(lane?.target === undefined ? {} : { targetUrl: lane.target }),
    };
  });
}

/** The participants of a shared-world lab, one per roster entry, typed by the plane they share. */
export function sharedWorldParticipants(config: LabConfig): SharedWorldRoster {
  const roster = config.actors[0]?.lanes ?? [];
  const participantAt = (lane: LabActorLane, index: number): DesktopParticipant =>
    desktopParticipant(config, lane, index, "seat", lane.instruction);
  if (config.subject.source === "app-url") {
    return {
      plane: "external-public",
      participants: roster.map((lane, index) => ({
        ...participantAt(lane, index),
        host: lane.host === true,
      })),
    };
  }
  return {
    plane: "provisioned",
    participants: roster.map((lane, index) => ({
      ...participantAt(lane, index),
      ...(lane.entry === undefined ? {} : { entry: lane.entry }),
    })),
  };
}

/** The ids of the participants a computer-use or shared-world lab runs, in roster order. */
export function declaredParticipantIds(config: LabConfig): string[] {
  const actor = config.actors[0];
  const roster = actor?.lanes;
  const kind = isSharedWorldComposition(config) ? "seat" : "lane";
  if (roster && roster.length > 0) {
    return roster.map((lane, index) => participantIdAt(index, lane.id, kind));
  }
  const count = Math.max(1, actor?.count ?? 1);
  return Array.from({ length: count }, (_, index) => participantIdAt(index, undefined, kind));
}

/** The entry URLs roster entries declare in place of the subject URL (computer use, app-url). */
export function declaredTargets(config: LabConfig): string[] {
  return (config.actors[0]?.lanes ?? [])
    .map((lane) => lane.target)
    .filter((target): target is string => target !== undefined);
}
