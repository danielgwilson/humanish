import type { ComputerUsePlan } from "../../lab/plan-types.js";
import type { LabCommsExternal } from "../../lab/types.js";
import { DEFAULT_OPENAI_CU_MODEL } from "../../actors/computer-use/openai-provider.js";
import { detectLocalAgents, type LocalAgentId } from "../../actors/local-agent/cli.js";
import { localAgentRefusal } from "../../actors/local-agent/readiness.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import { externalCatchHealthy } from "../../comms/sandbox-catch.js";
import { MODEL_RATES } from "../../run/pricing.js";
import type { CuaActorLabErrorCode, CuaActorLabHooks } from "./types.js";
import { participantDesktopOf } from "./participant-desktop.js";

/**
 * The first reason a live computer-use run cannot start on this machine: missing keys, a missing
 * or signed-out local agent, missing subject env, a spend cap with no price, or an unreachable
 * external comms catch. Checked before any sandbox exists, because each one found later has
 * already paid for a desktop.
 */
export async function liveCuaRejection(args: {
  caps: ComputerUsePlan["caps"];
  /** The declared participant model; a spend cap needs its price. */
  model: string | undefined;
  hooks: CuaActorLabHooks;
  env: Record<string, string | undefined>;
  openaiApiKey: string;
  e2bApiKey: string;
  localAgentRoute: boolean;
  preferredLocalAgent: LocalAgentId;
  subjectEnvNames: string[];
  externalCommsConfig: LabCommsExternal | undefined;
}): Promise<{ code: CuaActorLabErrorCode; message: string } | undefined> {
  const {
    caps,
    model,
    hooks,
    env,
    openaiApiKey,
    e2bApiKey,
    localAgentRoute,
    preferredLocalAgent,
    subjectEnvNames,
    externalCommsConfig,
  } = args;
  const missingKeys = [
    ...(openaiApiKey || localAgentRoute || hooks.buildProvider ? [] : ["OPENAI_API_KEY"]),
    ...(e2bApiKey || participantDesktopOf(hooks) !== undefined ? [] : ["E2B_API_KEY"]),
  ];
  if (missingKeys.length > 0) {
    // The moment someone new actually hits the wall. If a signed-in coding agent is sitting
    // right there, say so HERE rather than making them go and find an API key — that detour is
    // where most people trying humanish stop.
    const suggestion = missingKeys.includes("OPENAI_API_KEY")
      ? await (async () => {
          const ready = (await detectLocalAgents({ env })).filter(
            (agent) => agent.authStatus === "authenticated",
          );
          return ready.length === 0
            ? ""
            : ` ${ready.map((agent) => agent.label).join(" and ")} reports authenticated on this machine` +
                ` — set actors[0].type: local-agent to use ${ready.length === 1 ? "it" : "one"} instead of a key.`;
        })()
      : "";
    return {
      code: "HUMANISH_CUA_LAB_KEYS_MISSING",
      message: `Live computer-use labs need ${missingKeys.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missingKeys, env)}${suggestion}`,
    };
  }
  if (localAgentRoute && !hooks.buildProvider) {
    // Refuse HERE, before a sandbox exists. "codex is not installed" discovered after the
    // machine is paid for is the same information delivered at the worst possible moment.
    const refusal = await localAgentRefusal({ agent: preferredLocalAgent, env, caps });
    if (refusal)
      return {
        code:
          refusal.kind === "signin-required"
            ? "HUMANISH_CUA_LAB_AGENT_SIGNIN_REQUIRED"
            : refusal.kind === "unsupported"
              ? "HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED"
              : "HUMANISH_CUA_LAB_UNPRICED_CAP",
        message: refusal.message,
      };
  }
  const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
  if (missingSubjectEnv.length > 0) {
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_ENV_MISSING",
      message: `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
    };
  }
  // FAIL-CLOSED CAP TENSION (discipline #3): a maxUsd cap needs a MEASURABLE per-turn estimate.
  // If the operator set execution.caps.maxUsd but src/run/pricing.ts has no rate for the resolved
  // model, the loop could not enforce the cap — and silently running uncapped would break the
  // runaway-retry protection. Refuse at PREFLIGHT (before any sandbox/spend) rather than run
  // uncapped: an unenforceable cap is more dangerous than none. The operator adds a rate to
  // src/run/pricing.ts (the honest place) or removes the cap.
  if (caps.maxUsd !== undefined || caps.maxTotalUsd !== undefined) {
    const capModelId = (model ?? DEFAULT_OPENAI_CU_MODEL).trim().toLowerCase();
    if (!MODEL_RATES[capModelId]) {
      return {
        code: "HUMANISH_CUA_LAB_UNPRICED_CAP",
        message: `execution.caps declares a spend cap (maxUsd/maxTotalUsd) but src/run/pricing.ts has no rate for model "${model ?? DEFAULT_OPENAI_CU_MODEL}"; add a rate or remove the cap — an unenforceable cap is refused rather than run uncapped.`,
      };
    }
  }
  // Adopter-hosted comms catch (#380): fail closed BEFORE any sandbox is created — a comms lab
  // whose catch is unreachable collects nothing while every lane still spends. The probe asserts
  // OUR service marker in /health, so an adopter's proxy answering 200 for everything cannot
  // pass for a catch.
  if (externalCommsConfig && !(await externalCatchHealthy(externalCommsConfig))) {
    return {
      code: "HUMANISH_CUA_LAB_COMMS_CATCH_UNREACHABLE",
      message:
        "The external comms catch or inbox is unreachable or incompatible (GET /health must identify humanish-comms-catch and advertise recipient-inbox-v1). Update humanish on the catch host and restart it with `humanish comms catch` on that host, or drop comms.email to run without the inbox funnel.",
    };
  }
  return undefined;
}
