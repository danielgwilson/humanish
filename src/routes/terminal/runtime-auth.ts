import type { StudyRuntimeAuth } from "../../study/types.js";

/**
 * The runtime auth a study gets when it declares none. A shell agent can read its own command env,
 * so the raw key stays in the host-side E2B request unless a study declares openai-env.
 */
export const DEFAULT_RUNTIME_AUTH: StudyRuntimeAuth = "openai-egress";
