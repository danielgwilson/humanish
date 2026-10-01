// The keys and subject env a live plan's requirements list, checked against an environment. Each
// route's preflight asks these which names to refuse on, so the planner alone decides what a route
// needs; the route keeps its own error codes, messages and check order. The terminal runtime key
// (`key-one-of`) stays with buildRuntimeAuth, which also picks its placement.
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
  return requirements
    .flatMap((requirement) => (requirement.kind === "subject-env" ? requirement.names : []))
    .filter((name) => !present(env, name));
}
