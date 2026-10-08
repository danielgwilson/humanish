import type { ActorPersonaRef } from "../../src/actors/contract.js";
import { DEVICE_PRESETS } from "../../src/study/device-presets.js";
import type { ComputerUseParticipant } from "../../src/study/plan-participants.js";
import type { StudyConfig } from "../../src/study/types.js";
import { planComputerUseStudy } from "../../src/routes/computer-use/plan.js";
import { participantRunsAndPlan } from "../../src/routes/computer-use/participant-runs.js";
import type {
  CuaParticipantPlan,
  DesktopParticipantRun,
} from "../../src/routes/computer-use/types.js";
import { sandboxCeiling } from "../../src/substrates/e2b/lifetime.js";

/**
 * The participant table a computer-use config plans to, the one the route prints before a run.
 * A live plan unless `dryRun` is set; `env` may lower the planned concurrency.
 */
export function participantPlanOf(
  config: StudyConfig,
  opts: { countOverride?: number; env?: Record<string, string | undefined>; dryRun?: boolean } = {},
): CuaParticipantPlan {
  const planned = planComputerUseStudy(config, {
    dryRun: opts.dryRun === true,
    ...(opts.countOverride === undefined ? {} : { countOverride: opts.countOverride }),
    sandboxCeiling: sandboxCeiling(opts.env ?? {}),
  });
  if (!planned.ok) throw new Error(planned.refusal.message);
  return participantRunsAndPlan(planned.plan, opts.env === undefined ? {} : { env: opts.env })
    .participantPlan;
}

/**
 * A synthetic participant run on the default desktop preset, for tests that drive a participant
 * runner or a bundle builder directly. Ids and paths default to a single participant.
 */
export function participantRun(fields: {
  id: string;
  index: number;
  persona: ActorPersonaRef;
  instructions: string;
  recordId?: string;
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
    recordId: fields.recordId ?? `sim-${ordinal}`,
    streamId: fields.streamId ?? `stream-${ordinal}`,
    persona: fields.persona,
    instructions: fields.instructions,
    screenshotDir: fields.screenshotDir ?? "",
    traceArtifactPath: fields.traceArtifactPath ?? "actor.json",
  };
}
