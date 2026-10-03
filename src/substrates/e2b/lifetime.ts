// How long an E2B sandbox may live, and the budgets the desktop routes add to a participant's own
// deadline when they set a sandbox's server-side timeout. A dead host process can never orphan a
// sandbox past that timeout, so every route derives it from these values.

import { readPositiveInt } from "../../study/parse/values.js";

/**
 * E2B refuses a sandbox lifetime over one hour ("400: Timeout cannot be greater than 1 hours").
 * A derived deadline has to stay under it, and saying so at plan time beats discovering it from a
 * raw provider 400 after a plan has already printed.
 */
export const MAX_SANDBOX_MS = 60 * 60_000;

/** Server-side reclamation buffer past a participant's own wall-clock stop. */
export const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;

/** Room a provisioned subject adds to the sandbox deadline for clone, install, build, start and probe. */
export const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;

/** The timeout of one E2B API request: HUMANISH_E2B_REQUEST_TIMEOUT_MS when set, else 60 s. */
export function e2bRequestTimeoutMs(env: Record<string, string | undefined>): number {
  return readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
}
