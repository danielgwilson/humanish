import { runCuaActorSession } from "../../src/actors/computer-use/actor.js";
import type { ActorPersonaRef } from "../../src/actors/contract.js";
import { prepareSelectedOutputDirectory } from "../../src/run/contained-output.js";
import { parseStudy } from "../../src/study/config.js";
import { DEVICE_PRESETS } from "../../src/study/device-presets.js";
import type { ComputerUseParticipant } from "../../src/study/plan-participants.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { planComputerUseStudy } from "../../src/routes/computer-use/plan.js";
import { participantRunsAndPlan } from "../../src/routes/computer-use/participant-runs.js";
import type {
  CuaParticipantDeps,
  CuaParticipantPlan,
  DesktopParticipantRun,
} from "../../src/routes/computer-use/types.js";
import {
  concurrencyCap,
  concurrentSandboxes,
  sandboxCeiling,
} from "../../src/substrates/e2b/lifetime.js";

/**
 * The participant table a computer-use config plans to, the one the route prints before a run.
 * A live plan unless `dryRun` is set; `env` holds the operator's limits, as planStudy reads them.
 */
export function participantPlanOf(
  config: StudyConfig,
  opts: { countOverride?: number; env?: Record<string, string | undefined>; dryRun?: boolean } = {},
): CuaParticipantPlan {
  const planned = planComputerUseStudy(config, {
    dryRun: opts.dryRun === true,
    ...(opts.countOverride === undefined ? {} : { countOverride: opts.countOverride }),
    sandboxCeiling: sandboxCeiling(opts.env ?? {}),
    concurrentSandboxes: concurrentSandboxes(opts.env ?? {}),
    concurrencyCap: concurrencyCap(opts.env ?? {}),
  });
  if (!planned.ok) throw new Error(planned.refusal.message);
  return participantRunsAndPlan(planned.plan).participantPlan;
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
      schedule: {},
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

const APP_URL = "http://127.0.0.1:3000/";

/**
 * What runCuaParticipant takes beside a participantRun, for one participant of a live study of
 * the app at http://127.0.0.1:3000/ that writes under `cwd`. The model comes from the caller's
 * `createProvider`, the session is the real runCuaActorSession, and loading the E2B desktop module
 * throws. `fields` replaces any of these; a test that runs the participant also supplies
 * `createDesktop`.
 */
export async function participantRunDeps(
  cwd: string,
  fields: Partial<CuaParticipantDeps> = {},
): Promise<CuaParticipantDeps> {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "synthetic-participant",
    route: "computer-use",
    mode: "live",
    subject: { source: "app-url", appUrl: APP_URL },
    actor: { type: "openai-computer-use", persona: "first-time-visitor", mission: "Save a note." },
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return {
    residual: parsed.config,
    studyId: parsed.config.id,
    caps: {},
    brain: { kind: "caller" },
    appUrl: APP_URL,
    subject: { kind: "app-url", appUrl: APP_URL, publicTargets: false },
    env: {},
    participantApiKey: "",
    e2bApiKey: "",
    requestTimeoutMs: 60_000,
    sandboxMs: 60_000,
    timeoutMs: 60_000,
    participantCount: 1,
    artifactRoot: await prepareSelectedOutputDirectory(cwd, "artifacts"),
    studyCwd: cwd,
    redactScreenshots: false,
    scrubKnownValues: (value) => value,
    runSession: runCuaActorSession,
    now: Date.now,
    desktopModule: async () => {
      throw new Error("This participant must never load an E2B desktop");
    },
    onStream: async () => undefined,
    reportSubjectPhase: () => undefined,
    ...fields,
  };
}
