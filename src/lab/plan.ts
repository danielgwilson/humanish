// The route decision. A lab's route follows from its composition (subject.source,
// execution.target, the first actor's registered lane, subject.topology), never from a declared
// kind. This is the only function that decides it; selectLabBackend maps its answer to the older
// backend names.

import type { DwellWindow, StopWhen } from "../actors/stop-conditions.js";
import type { ReasoningEffort } from "../actors/reasoning-effort.js";
import { resolveLaneDevice } from "../routes/computer-use/lane-plan.js";
import type { DevicePreset } from "./device-presets.js";
import type { LabBackend } from "./engine.js";
import {
  participantIdAt,
  routesToComputerUse,
  routesToScriptedBrowser,
  routesToSharedWorld,
  routesToTerminalProduct,
} from "./routing.js";
import type { LabTask } from "./tasks.js";
import type { LabActorLane, LabConfig } from "./types.js";

/** The five execution paths a lab can take. */
export type LabRoute = "preview" | "computer-use" | "shared-world" | "terminal" | "scripted";

const BACKENDS: Record<LabRoute, LabBackend> = {
  preview: "synthetic",
  "computer-use": "cua",
  "shared-world": "concurrent-shared-world",
  terminal: "terminal",
  scripted: "scripted",
};

/** The backend name older callers and wire fields use for a route. */
export function backendOf(route: LabRoute): LabBackend {
  return BACKENDS[route];
}

/**
 * The route a config takes. It never refuses: a config no route can run still gets the route
 * whose own checks refuse it with the most precise reason.
 */
export function routeOf(config: LabConfig): LabRoute {
  const source = config.subject.source;
  // A scripted-browser actor on a loopback app or a provisioned clone replays committed steps.
  if (routesToScriptedBrowser(config)) return "scripted";
  // A terminal-product subject goes to the terminal route even with an unregistered actor, so that
  // route refuses the actor instead of another route running something else.
  if (routesToTerminalProduct(config) || source === "terminal-product") return "terminal";
  // Checked before computer use: the same composition without the topology declaration runs as
  // independent lanes.
  if (routesToSharedWorld(config)) return "shared-world";
  // A CLI studied at a desktop is a computer-use study whose subject is a terminal window.
  if (source === "desktop-cli") return "computer-use";
  // Every other app-url, clone, local-app or local-tree config goes to computer use, including
  // ones with an unknown actor: that route refuses the actor, where the preview route would run
  // no participant at all.
  if (
    routesToComputerUse(config) ||
    source === "app-url" ||
    source === "clone" ||
    source === "local-app" ||
    source === "local-tree"
  )
    return "computer-use";
  // this-repo runs the synthetic preview.
  return "preview";
}

/** Who one participant is. Every route with participants carries this record. */
interface Participant {
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
    readonly resolution: readonly [number, number];
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
interface ProvisionedSeat extends DesktopParticipant {
  readonly entry?: string;
}

/** A seat on an external public plane: exactly one seat hosts the shared session. */
interface ExternalPublicSeat extends DesktopParticipant {
  readonly host: boolean;
}

export type SharedWorldSeats =
  | { readonly plane: "provisioned"; readonly seats: readonly ProvisionedSeat[] }
  | { readonly plane: "external-public"; readonly seats: readonly ExternalPublicSeat[] };

function desktopParticipant(
  config: LabConfig,
  lane: LabActorLane | undefined,
  index: number,
  kind: "lane" | "seat",
  focus: string | undefined,
): DesktopParticipant {
  const actor = config.actors[0];
  const device = resolveLaneDevice(config, lane);
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

/** The seats of a shared-world lab, one per roster entry, typed by the plane they share. */
export function sharedWorldSeats(config: LabConfig): SharedWorldSeats {
  const roster = config.actors[0]?.lanes ?? [];
  const seat = (lane: LabActorLane, index: number): DesktopParticipant =>
    desktopParticipant(config, lane, index, "seat", lane.instruction);
  if (config.subject.source === "app-url") {
    return {
      plane: "external-public",
      seats: roster.map((lane, index) => ({ ...seat(lane, index), host: lane.host === true })),
    };
  }
  return {
    plane: "provisioned",
    seats: roster.map((lane, index) => ({
      ...seat(lane, index),
      ...(lane.entry === undefined ? {} : { entry: lane.entry }),
    })),
  };
}
