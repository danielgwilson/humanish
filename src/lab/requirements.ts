// The keys and subject env a live plan's requirements list. Each route's preflight asks
// missingKeys and missingSubjectEnv which names to refuse on, and doctor and the TUI ask
// requiredKeys and requiredSubjectEnv which names to report, so the planner alone decides what a
// run needs. A route keeps its own error codes, messages and check order. The terminal runtime key
// (`key-one-of`) stays with buildRuntimeAuth at run time, which also picks its placement.
import type { Requirement } from "./plan-types.js";

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
