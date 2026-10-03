import type { Brain, ComputerUsePlan } from "../../study/plan-types.js";
import { pricedModel } from "../../study/plan-base.js";
import { missingKeys, missingSubjectEnv } from "../../study/requirements.js";
import type { StudyCommsExternal } from "../../study/types.js";
import { detectLocalAgents } from "../../actors/local-agent/cli.js";
import { localAgentRefusal, type LocalAgentRefusal } from "../../actors/local-agent/readiness.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import { catchTokenOf, catchTokenRefusal } from "../../comms/external-evidence.js";
import { externalCatchHealthy } from "../../comms/sandbox-catch.js";
import { MODEL_RATES, unpricedCapMessage } from "../../run/pricing.js";
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
  // The plan lists OPENAI_API_KEY only for an openai brain (a signed-in local agent or the
  // caller's provider needs none) and E2B_API_KEY only when this run creates hosted desktops.
  const localAgent = brain.kind === "local-agent" ? brain.agent : undefined;
  const missing = missingKeys(requirements, env);
  if (missing.length > 0) {
    // The moment someone new actually hits the wall. If a signed-in coding agent is sitting
    // right there, say so here rather than making them go and find an API key; that detour is
    // where most people trying humanish stop.
    const suggestion = missing.includes("OPENAI_API_KEY")
      ? await (async () => {
          const ready = (await detectLocalAgents({ env })).filter(
            (agent) => agent.authStatus === "authenticated",
          );
          return ready.length === 0
            ? ""
            : ` ${ready.map((agent) => agent.label).join(" and ")} reports authenticated on this machine` +
                `. Set actors[0].type: local-agent to use ${ready.length === 1 ? "it" : "one"} instead of a key.`;
        })()
      : "";
    return {
      code: "HUMANISH_COMPUTER_USE_KEYS_MISSING",
      message: `Live computer-use labs need ${missing.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missing, env)}${suggestion}`,
    };
  }
  // A caller's createProvider makes the brain `caller`, so only the lab's own local agent is checked.
  if (localAgent) {
    // Refuse here, before a sandbox exists. "codex is not installed" discovered after the
    // machine is paid for is the same information delivered at the worst possible moment.
    const refusal = await localAgentRefusal({ agent: localAgent, env, caps });
    if (refusal) return { code: LOCAL_AGENT_REFUSAL_CODES[refusal.kind], message: refusal.message };
  }
  const unsetSubjectEnv = missingSubjectEnv(requirements, env);
  if (unsetSubjectEnv.length > 0) {
    return {
      code: "HUMANISH_COMPUTER_USE_SUBJECT_ENV_MISSING",
      message: `subject.env declares ${unsetSubjectEnv.join(", ")} but the environment does not provide ${unsetSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
    };
  }
  // Fail-closed cap: a maxUsd cap needs a measurable per-turn estimate.
  // If the operator set execution.caps.maxUsd but src/run/pricing.ts has no rate for the resolved
  // model, the loop could not enforce the cap, and silently running uncapped would break the
  // runaway-retry protection. Refuse at preflight (before any sandbox/spend) rather than run
  // uncapped: an unenforceable cap is more dangerous than none. The operator picks a priced model
  // or removes the cap; a source checkout can also add a rate to src/run/pricing.ts.
  if (caps.maxUsd !== undefined || caps.maxTotalUsd !== undefined) {
    const model = pricedModel(brain);
    const capModelId = model.trim().toLowerCase();
    if (!MODEL_RATES[capModelId]) {
      return {
        code: "HUMANISH_COMPUTER_USE_UNPRICED_CAP",
        message: unpricedCapMessage(model),
      };
    }
  }
  // Adopter-hosted comms catch: fail closed before any sandbox is created, because a comms lab
  // whose catch is unreachable collects nothing while every participant still spends. The probe asserts
  // humanish's own service marker in /health, so an adopter's proxy answering 200 for everything cannot
  // pass for a catch.
  const tokenRefusal =
    externalCommsConfig === undefined
      ? undefined
      : catchTokenRefusal(catchTokenOf(externalCommsConfig, env));
  if (tokenRefusal !== undefined)
    return { code: "HUMANISH_COMPUTER_USE_COMMS_TOKEN_INVALID", message: tokenRefusal };
  if (externalCommsConfig && !(await externalCatchHealthy(externalCommsConfig))) {
    return {
      code: "HUMANISH_COMPUTER_USE_COMMS_CATCH_UNREACHABLE",
      message:
        "The external comms catch or inbox is unreachable or incompatible (GET /health must identify humanish-comms-catch and advertise recipient-inbox-v1). Update humanish on the catch host and restart it with `humanish comms catch` on that host, or drop comms.email to run without the inbox funnel.",
    };
  }
  return undefined;
}
