import type { Brain, ComputerUsePlan } from "../../study/plan-types.js";
import { pricedModel } from "../../study/plan-base.js";
import {
  firstLiveRefusal,
  keysCheck,
  localAgentCheck,
  subjectEnvCheck,
  unpricedCapCheck,
  type LiveRefusal,
} from "../../study/requirements.js";
import type { StudyCommsExternal } from "../../study/types.js";
import type { LocalAgentRefusal } from "../../actors/local-agent/readiness.js";
import { catchTokenOf, catchTokenRefusal } from "../../comms/external-evidence.js";
import { externalCatchHealthy } from "../../comms/sandbox-catch.js";
import type { CuaActorStudyErrorCode } from "./types.js";

/** The computer-use code for each local-agent refusal; shared-world keeps the same kinds. */
const LOCAL_AGENT_REFUSAL_CODES = {
  "agent-missing": "HUMANISH_COMPUTER_USE_AGENT_MISSING",
  "signin-required": "HUMANISH_COMPUTER_USE_AGENT_SIGNIN_REQUIRED",
  unsupported: "HUMANISH_COMPUTER_USE_ACTOR_UNSUPPORTED",
  "unpriced-cap": "HUMANISH_COMPUTER_USE_UNPRICED_CAP",
} as const satisfies Record<LocalAgentRefusal["kind"], CuaActorStudyErrorCode>;

/**
 * The first reason a live computer-use run cannot start on this machine: missing keys, a missing
 * or signed-out local agent, missing subject env, a spend cap with no price, or an unreachable
 * external comms catch. Checked before any sandbox exists, because each one found later has
 * already paid for a desktop.
 */
export async function liveCuaRejection(args: {
  caps: ComputerUsePlan["caps"];
  /** The plan's brain: whether a local agent drives the participant, and the model a cap prices. */
  brain: Brain;
  env: Record<string, string | undefined>;
  /** The plan's requirements: which keys and subject env names this run needs. */
  requirements: ComputerUsePlan["requirements"];
  externalCommsConfig: StudyCommsExternal | undefined;
}): Promise<{ code: CuaActorStudyErrorCode; message: string } | undefined> {
  const { caps, brain, env, requirements, externalCommsConfig } = args;
  return firstLiveRefusal<CuaActorStudyErrorCode>([
    // The plan lists OPENAI_API_KEY only for an openai brain (a signed-in local agent or the
    // caller's provider needs none) and E2B_API_KEY only when this run creates hosted desktops.
    () =>
      keysCheck({
        requirements,
        env,
        code: "HUMANISH_COMPUTER_USE_KEYS_MISSING",
        need: (names) =>
          `Live computer-use studies need ${names} in the environment (values are never persisted).`,
        suggestLocalAgent: true,
      }),
    // A caller's createProvider makes the brain `caller`, so only the study's own local agent is
    // checked.
    () => localAgentCheck({ brain, env, caps, codes: LOCAL_AGENT_REFUSAL_CODES }),
    () => subjectEnvCheck({ requirements, env, code: "HUMANISH_COMPUTER_USE_SUBJECT_ENV_MISSING" }),
    () =>
      unpricedCapCheck({
        caps,
        model: pricedModel(brain),
        code: "HUMANISH_COMPUTER_USE_UNPRICED_CAP",
      }),
    () => externalCatchCheck(externalCommsConfig, env),
  ]);
}

/**
 * Adopter-hosted comms catch: refused before any sandbox is created, because a comms study whose
 * catch is unreachable collects nothing while every participant still spends. The probe asserts
 * humanish's own service marker in /health, so an adopter's proxy answering 200 for everything
 * cannot pass for a catch.
 */
async function externalCatchCheck(
  externalCommsConfig: StudyCommsExternal | undefined,
  env: Record<string, string | undefined>,
): Promise<LiveRefusal<CuaActorStudyErrorCode> | undefined> {
  if (externalCommsConfig === undefined) return undefined;
  const tokenRefusal = catchTokenRefusal(catchTokenOf(externalCommsConfig, env));
  if (tokenRefusal !== undefined)
    return { code: "HUMANISH_COMPUTER_USE_COMMS_TOKEN_INVALID", message: tokenRefusal };
  if (!(await externalCatchHealthy(externalCommsConfig))) {
    return {
      code: "HUMANISH_COMPUTER_USE_COMMS_CATCH_UNREACHABLE",
      message:
        "The external comms catch or inbox is unreachable or incompatible (GET /health must identify humanish-comms-catch and advertise recipient-inbox-v1). Update humanish on the catch host and restart it with `humanish comms catch` on that host, or drop comms.email to run without the inbox funnel.",
    };
  }
  return undefined;
}
