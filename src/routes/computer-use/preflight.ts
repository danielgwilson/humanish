import type { Brain, ComputerUsePlan } from "../../lab/plan-types.js";
import { pricedModel } from "../../lab/plan-base.js";
import { missingKeys, missingSubjectEnv } from "../../lab/requirements.js";
import type { LabCommsExternal } from "../../lab/types.js";
import { detectLocalAgents } from "../../actors/local-agent/cli.js";
import { localAgentRefusal, type LocalAgentRefusal } from "../../actors/local-agent/readiness.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import { catchTokenOf, catchTokenRefusal } from "../../comms/external-evidence.js";
import { externalCatchHealthy } from "../../comms/sandbox-catch.js";
import { MODEL_RATES } from "../../run/pricing.js";
import type { CuaActorLabErrorCode } from "./types.js";

/** The computer-use code for each local-agent refusal; shared-world keeps the same kinds. */
const LOCAL_AGENT_REFUSAL_CODES = {
  "agent-missing": "HUMANISH_CUA_LAB_AGENT_MISSING",
  "signin-required": "HUMANISH_CUA_LAB_AGENT_SIGNIN_REQUIRED",
  unsupported: "HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED",
  "unpriced-cap": "HUMANISH_CUA_LAB_UNPRICED_CAP",
} as const satisfies Record<LocalAgentRefusal["kind"], CuaActorLabErrorCode>;

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
  externalCommsConfig: LabCommsExternal | undefined;
}): Promise<{ code: CuaActorLabErrorCode; message: string } | undefined> {
  const { caps, brain, env, requirements, externalCommsConfig } = args;
  // The plan lists OPENAI_API_KEY only for an openai brain (a signed-in local agent or the
  // caller's provider needs none) and E2B_API_KEY only when this run creates hosted desktops.
  const localAgent = brain.kind === "local-agent" ? brain.agent : undefined;
  const missing = missingKeys(requirements, env);
  if (missing.length > 0) {
    // The moment someone new actually hits the wall. If a signed-in coding agent is sitting
    // right there, say so HERE rather than making them go and find an API key — that detour is
    // where most people trying humanish stop.
    const suggestion = missing.includes("OPENAI_API_KEY")
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
      message: `Live computer-use labs need ${missing.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missing, env)}${suggestion}`,
    };
  }
  // A caller's createProvider makes the brain `caller`, so only the lab's own local agent is checked.
  if (localAgent) {
    // Refuse HERE, before a sandbox exists. "codex is not installed" discovered after the
    // machine is paid for is the same information delivered at the worst possible moment.
    const refusal = await localAgentRefusal({ agent: localAgent, env, caps });
    if (refusal) return { code: LOCAL_AGENT_REFUSAL_CODES[refusal.kind], message: refusal.message };
  }
  const unsetSubjectEnv = missingSubjectEnv(requirements, env);
  if (unsetSubjectEnv.length > 0) {
    return {
      code: "HUMANISH_CUA_LAB_SUBJECT_ENV_MISSING",
      message: `subject.env declares ${unsetSubjectEnv.join(", ")} but the environment does not provide ${unsetSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
    };
  }
  // FAIL-CLOSED CAP TENSION (discipline #3): a maxUsd cap needs a MEASURABLE per-turn estimate.
  // If the operator set execution.caps.maxUsd but src/run/pricing.ts has no rate for the resolved
  // model, the loop could not enforce the cap — and silently running uncapped would break the
  // runaway-retry protection. Refuse at PREFLIGHT (before any sandbox/spend) rather than run
  // uncapped: an unenforceable cap is more dangerous than none. The operator adds a rate to
  // src/run/pricing.ts (the honest place) or removes the cap.
  if (caps.maxUsd !== undefined || caps.maxTotalUsd !== undefined) {
    const model = pricedModel(brain);
    const capModelId = model.trim().toLowerCase();
    if (!MODEL_RATES[capModelId]) {
      return {
        code: "HUMANISH_CUA_LAB_UNPRICED_CAP",
        message: `execution.caps declares a spend cap (maxUsd/maxTotalUsd) but src/run/pricing.ts has no rate for model "${model}"; add a rate or remove the cap — an unenforceable cap is refused rather than run uncapped.`,
      };
    }
  }
  // Adopter-hosted comms catch (#380): fail closed BEFORE any sandbox is created — a comms lab
  // whose catch is unreachable collects nothing while every lane still spends. The probe asserts
  // OUR service marker in /health, so an adopter's proxy answering 200 for everything cannot
  // pass for a catch.
  const tokenRefusal =
    externalCommsConfig === undefined
      ? undefined
      : catchTokenRefusal(catchTokenOf(externalCommsConfig, env));
  if (tokenRefusal !== undefined)
    return { code: "HUMANISH_CUA_LAB_COMMS_TOKEN_INVALID", message: tokenRefusal };
  if (externalCommsConfig && !(await externalCatchHealthy(externalCommsConfig))) {
    return {
      code: "HUMANISH_CUA_LAB_COMMS_CATCH_UNREACHABLE",
      message:
        "The external comms catch or inbox is unreachable or incompatible (GET /health must identify humanish-comms-catch and advertise recipient-inbox-v1). Update humanish on the catch host and restart it with `humanish comms catch` on that host, or drop comms.email to run without the inbox funnel.",
    };
  }
  return undefined;
}
