import type { ActorPersonaRef } from "../../src/actors/contract.js";
import { DEVICE_PRESETS } from "../../src/lab/device-presets.js";
import type { ComputerUseParticipant } from "../../src/lab/plan-participants.js";
import type { DesktopParticipantRun } from "../../src/routes/computer-use/types.js";

/**
 * A synthetic participant run on the default desktop preset, for tests that drive a lane runner or
 * a bundle builder directly. Ids and paths default to a single participant.
 */
export function participantRun(fields: {
  id: string;
  index: number;
  persona: ActorPersonaRef;
  instructions: string;
  simId?: string;
  streamId?: string;
  screenshotDir?: string;
  traceArtifactPath?: string;
  limits?: ComputerUseParticipant["limits"];
  targetUrl?: string;
}): DesktopParticipantRun {
  const ordinal = String(fields.index + 1).padStart(3, "0");
  return {
    planned: {
      id: fields.id,
      index: fields.index,
      personaId: fields.persona.id,
      assignment: {},
      labels: {},
      device: {
        name: "desktop",
        preset: DEVICE_PRESETS.desktop,
        resolution: [DEVICE_PRESETS.desktop.width, DEVICE_PRESETS.desktop.height],
      },
      limits: fields.limits ?? {},
      ...(fields.targetUrl === undefined ? {} : { targetUrl: fields.targetUrl }),
    },
    simId: fields.simId ?? `sim-${ordinal}`,
    streamId: fields.streamId ?? `stream-${ordinal}`,
    persona: fields.persona,
    instructions: fields.instructions,
    screenshotDir: fields.screenshotDir ?? "",
    traceArtifactPath: fields.traceArtifactPath ?? "actor.json",
  };
}
