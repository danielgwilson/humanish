// The keys and subject env a live plan's requirements list, and the live checks that read them.
// Each route lists the checks below (keysCheck, localAgentCheck, subjectEnvCheck,
// unpricedCapCheck) in its own order, with its own error codes. Doctor and the TUI ask
// requiredKeys and requiredSubjectEnv which names to report, and `run` asks keyNamesOf which
// key-source lines to print, so the planner alone decides what a run needs. The terminal runtime
// key (`key-one-of`) stays with buildRuntimeAuth at run time, which also picks its placement.
import { detectLocalAgents } from "../actors/local-agent/cli.js";
import { localAgentRefusal, type LocalAgentRefusal } from "../actors/local-agent/readiness.js";
import { describeMissingKeys } from "../keys/key-resolution.js";
import { MODEL_RATES, unpricedCapMessage } from "../run/pricing.js";
import type { Brain, StudyPlan, Requirement } from "./plan-types.js";

/** Provider keys in the order the routes name them in a refusal. */
const KEY_ORDER = ["OPENAI_API_KEY", "E2B_API_KEY"] as const;

const present = (env: Record<string, string | undefined>, name: string): boolean =>
  (env[name]?.trim() ?? "") !== "";

/** The `key` requirements whose value `env` lacks, OPENAI_API_KEY before E2B_API_KEY. */
function missingKeys(
  requirements: readonly Requirement[],
  env: Record<string, string | undefined>,
): string[] {
  const required = new Set(
    requirements.flatMap((requirement) => (requirement.kind === "key" ? [requirement.name] : [])),
  );
  return KEY_ORDER.filter((name) => required.has(name) && !present(env, name));
}

/** The subject env names the requirements list and `env` lacks, in declaration order. */
function missingSubjectEnv(
  requirements: readonly Requirement[],
  env: Record<string, string | undefined>,
): string[] {
  return requiredSubjectEnv(requirements).filter((name) => !present(env, name));
}

/**
 * The provider keys the requirements name, in plan order. A `key-one-of` names the first of its
 * keys that `isPresent` reports, else OPENAI_API_KEY.
 */
export function requiredKeys(
  requirements: readonly Requirement[],
  isPresent: (name: string) => boolean,
): string[] {
  return requirements.flatMap((requirement) => {
    if (requirement.kind === "key") return [requirement.name];
    if (requirement.kind === "key-one-of")
      return [requirement.names.find(isPresent) ?? requirement.names[1]];
    return [];
  });
}

/** The subject env names the requirements list, in declaration order. */
export function requiredSubjectEnv(requirements: readonly Requirement[]): string[] {
  return requirements.flatMap((requirement) =>
    requirement.kind === "subject-env" ? requirement.names : [],
  );
}

/**
 * The provider keys a live run of `plan` is known to read: its `key` and `key-one-of` names, its
 * subject env, the external catch's token variable, ANTHROPIC_API_KEY for a Claude Code
 * participant, and OPENAI_API_KEY when automatic analysis runs on OpenAI. `run` prints a
 * key-source line for these only. Discovery still fills every key it finds: other readers, such as
 * a declared scorer's host code, are not in the plan.
 */
export function keyNamesOf(plan: StudyPlan): ReadonlySet<string> {
  const names = new Set<string>();
  for (const requirement of plan.requirements) {
    if (requirement.kind === "key") names.add(requirement.name);
    if (requirement.kind === "key-one-of" || requirement.kind === "subject-env")
      for (const name of requirement.names) names.add(name);
    if (requirement.kind === "local-agent" && requirement.agent === "claude")
      names.add("ANTHROPIC_API_KEY");
  }
  const catchToken = plan.residual.comms?.email?.external?.authTokenEnv;
  if (catchToken !== undefined) names.add(catchToken);
  if (plan.analysis !== undefined && plan.analysis.config.provider !== "codex")
    names.add("OPENAI_API_KEY");
  return names;
}

/** A live check's refusal, in its route's error code. */
export interface LiveRefusal<C extends string> {
  readonly code: C;
  readonly message: string;
}

/** One live check: its refusal, or undefined when this machine passes it. */
export type LiveCheck<C extends string> = () =>
  | LiveRefusal<C>
  | undefined
  | Promise<LiveRefusal<C> | undefined>;

/**
 * The first refusal of `checks`, run one at a time in the order given. Which check comes first
 * decides which error a run with two problems reports, so each route keeps its own order.
 */
export async function firstLiveRefusal<C extends string>(
  checks: readonly LiveCheck<C>[],
): Promise<LiveRefusal<C> | undefined> {
  for (const check of checks) {
    const refusal = await check();
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * Refuses a run whose environment lacks a provider key the requirements list. `need` writes the
 * route's sentence for the missing names ("OPENAI_API_KEY and E2B_API_KEY"); the message goes on
 * to say where discovery looked and what fills each key. With `suggestLocalAgent`, a missing
 * OPENAI_API_KEY also names each coding agent signed in on this machine: someone new meets this
 * refusal first, and an agent they already use runs the participants without a key.
 */
export async function keysCheck<C extends string>(args: {
  readonly requirements: readonly Requirement[];
  readonly env: Record<string, string | undefined>;
  readonly code: C;
  readonly need: (names: string) => string;
  readonly suggestLocalAgent?: boolean;
}): Promise<LiveRefusal<C> | undefined> {
  const { env } = args;
  const missing = missingKeys(args.requirements, env);
  if (missing.length === 0) return undefined;
  const suggestion =
    args.suggestLocalAgent === true && missing.includes("OPENAI_API_KEY")
      ? await signedInAgentSuggestion(env)
      : "";
  return {
    code: args.code,
    message: `${args.need(missing.join(" and "))} ${describeMissingKeys(missing, env)}${suggestion}`,
  };
}

/** The sentence naming the coding agents signed in on this machine, or "" when none is. */
async function signedInAgentSuggestion(env: Record<string, string | undefined>): Promise<string> {
  const ready = (await detectLocalAgents({ env })).filter(
    (agent) => agent.authStatus === "authenticated",
  );
  if (ready.length === 0) return "";
  const labels = ready.map((agent) => agent.label).join(" and ");
  return ` ${labels} reports authenticated on this machine. Set actor.type: local-agent to use ${ready.length === 1 ? "it" : "one"} instead of a key.`;
}

/**
 * Refuses a local-agent brain whose CLI is missing, signed out, too old, or cannot honor the
 * caps, before any sandbox is paid for. `codes` names the route's code for each kind of refusal.
 */
export async function localAgentCheck<C extends string>(args: {
  readonly brain: Brain;
  readonly env: Record<string, string | undefined>;
  readonly caps: { readonly maxUsd?: number; readonly maxTotalUsd?: number };
  readonly codes: Readonly<Record<LocalAgentRefusal["kind"], C>>;
}): Promise<LiveRefusal<C> | undefined> {
  const { brain, env, caps } = args;
  if (brain.kind !== "local-agent") return undefined;
  const refusal = await localAgentRefusal({ agent: brain.agent, env, caps });
  return refusal === undefined
    ? undefined
    : { code: args.codes[refusal.kind], message: refusal.message };
}

/** Refuses a run whose environment lacks a subject env name the requirements list. */
export function subjectEnvCheck<C extends string>(args: {
  readonly requirements: readonly Requirement[];
  readonly env: Record<string, string | undefined>;
  readonly code: C;
}): LiveRefusal<C> | undefined {
  const unset = missingSubjectEnv(args.requirements, args.env);
  if (unset.length === 0) return undefined;
  return {
    code: args.code,
    message: `subject.env declares ${unset.join(", ")} but the environment does not provide ${unset.length === 1 ? "it" : "them"} (pass via --dotenv; values are never persisted).`,
  };
}

/**
 * Refuses a maxUsd or maxTotalUsd cap on a model with no rate in src/run/pricing.ts. The loop
 * could not measure spend against the cap, and running uncapped would drop the protection the
 * cap promised; the operator picks a priced model or removes the cap.
 */
export function unpricedCapCheck<C extends string>(args: {
  readonly caps: { readonly maxUsd?: number; readonly maxTotalUsd?: number };
  readonly model: string;
  readonly code: C;
}): LiveRefusal<C> | undefined {
  const { caps, model } = args;
  if (caps.maxUsd === undefined && caps.maxTotalUsd === undefined) return undefined;
  if (MODEL_RATES[model.trim().toLowerCase()]) return undefined;
  return { code: args.code, message: unpricedCapMessage(model) };
}
