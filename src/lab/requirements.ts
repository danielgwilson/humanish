// The keys and subject env a live plan's requirements list. Each route's preflight asks
// missingKeys and missingSubjectEnv which names to refuse on, doctor and the TUI ask requiredKeys
// and requiredSubjectEnv which names to report, and `lab run` asks keyNamesOf which names to look
// up, so the planner alone decides what a run needs. A route keeps its own error codes, messages
// and check order. The terminal runtime key (`key-one-of`) stays with buildRuntimeAuth at run
// time, which also picks its placement.
import type { LabPlan, Requirement } from "./plan-types.js";

/** Provider keys in the order the routes name them in a refusal. */
const KEY_ORDER = ["OPENAI_API_KEY", "E2B_API_KEY"] as const;

const present = (env: Record<string, string | undefined>, name: string): boolean =>
  (env[name]?.trim() ?? "") !== "";

/** The `key` requirements whose value `env` lacks, OPENAI_API_KEY before E2B_API_KEY. */
export function missingKeys(
  requirements: readonly Requirement[],
  env: Record<string, string | undefined>,
): string[] {
  const required = new Set(
    requirements.flatMap((requirement) => (requirement.kind === "key" ? [requirement.name] : [])),
  );
  return KEY_ORDER.filter((name) => required.has(name) && !present(env, name));
}

/** The subject env names the requirements list and `env` lacks, in declaration order. */
export function missingSubjectEnv(
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
 * participant, and OPENAI_API_KEY when automatic analysis runs on OpenAI. `lab run` prints a
 * key-source line for these only. Discovery still fills every key it finds: other readers, such as
 * a declared scorer's host code, are not in the plan.
 */
export function keyNamesOf(plan: LabPlan): ReadonlySet<string> {
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
