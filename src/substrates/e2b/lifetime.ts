// How long an E2B sandbox may live, and the budgets the desktop routes add to a participant's own
// deadline when they set a sandbox's server-side timeout. A dead host process can never orphan a
// sandbox past that timeout, so every route derives it from these values.

import { readPositiveInt } from "../../study/parse/values.js";

/** The setting that tells humanish how long the operator's E2B plan lets a sandbox live. */
const SANDBOX_CEILING_SETTING = "HUMANISH_E2B_MAX_SANDBOX_MINUTES";

/** E2B's Hobby plan ends a sandbox after 1 hour, so a key on any plan can use this ceiling. */
const DEFAULT_CEILING_MINUTES = 60;

/** E2B's Pro plan allows 24 hours, the longest lifetime E2B documents. */
const LARGEST_CEILING_MINUTES = 24 * 60;

/**
 * The longest lifetime humanish asks E2B for, in milliseconds, and whether it is the default or
 * the setting; or why the setting cannot be read.
 */
export type SandboxCeiling =
  | { readonly ok: true; readonly ms: number; readonly source: "default" | "setting" }
  | { readonly ok: false; readonly message: string };

/**
 * The sandbox ceiling: HUMANISH_E2B_MAX_SANDBOX_MINUTES when set, else 60 minutes. E2B refuses a
 * longer sandbox with a 400 ("Timeout cannot be greater than 1 hours" on Hobby), and neither its
 * API nor its SDK says which plan a key is on, so the operator states it. A derived deadline has
 * to stay under the ceiling, and saying so at plan time beats a provider 400 after the plan printed.
 */
export function sandboxCeiling(env: Readonly<Record<string, string | undefined>>): SandboxCeiling {
  const declared = env[SANDBOX_CEILING_SETTING]?.trim() ?? "";
  if (declared === "") return { ok: true, ms: DEFAULT_CEILING_MINUTES * 60_000, source: "default" };
  const minutes = /^\d+$/.test(declared) ? Number.parseInt(declared, 10) : Number.NaN;
  if (!(minutes >= 1 && minutes <= LARGEST_CEILING_MINUTES))
    return {
      ok: false,
      message: `${SANDBOX_CEILING_SETTING} must be a whole number of minutes from 1 to ${LARGEST_CEILING_MINUTES} (got "${declared.slice(0, 40)}"). Set it to the sandbox lifetime your E2B plan allows: ${DEFAULT_CEILING_MINUTES} on Hobby, ${LARGEST_CEILING_MINUTES} on Pro. Unset, it is ${DEFAULT_CEILING_MINUTES}.`,
    };
  return { ok: true, ms: minutes * 60_000, source: "setting" };
}

/** The ceiling in use and where it came from, or why the setting cannot be read (doctor's row). */
export function describeSandboxCeiling(ceiling: SandboxCeiling): string {
  if (!ceiling.ok) return ceiling.message;
  const minutes = ceiling.ms / 60_000;
  return ceiling.source === "setting"
    ? `${minutes} minutes, from ${SANDBOX_CEILING_SETTING}. A study whose sandbox deadline is longer is refused before any sandbox is created, and E2B refuses a lifetime past the plan's own limit.`
    : `${minutes} minutes, E2B's Hobby limit. On a plan with longer sandboxes (Pro allows ${LARGEST_CEILING_MINUTES} minutes), set ${SANDBOX_CEILING_SETTING} to that plan's limit.`;
}

/**
 * The sentence a plan refusal adds when a `deadlineMs` sandbox deadline passes the ceiling: the
 * setting value that would admit it, when an E2B plan allows that long.
 */
export function ceilingAdvice(deadlineMs: number): string {
  const needed = Math.ceil(deadlineMs / 60_000);
  return needed <= LARGEST_CEILING_MINUTES
    ? ` If your E2B plan allows longer sandboxes (Pro allows ${LARGEST_CEILING_MINUTES} minutes), set ${SANDBOX_CEILING_SETTING} to ${needed} or more.`
    : ` No E2B plan humanish knows allows a sandbox past ${LARGEST_CEILING_MINUTES} minutes.`;
}

/** Server-side reclamation buffer past a participant's own wall-clock stop. */
export const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;

/** Room a provisioned subject adds to the sandbox deadline for clone, install, build, start and probe. */
export const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;

/** The timeout of one E2B API request: HUMANISH_E2B_REQUEST_TIMEOUT_MS when set, else 60 s. */
export function e2bRequestTimeoutMs(env: Record<string, string | undefined>): number {
  return readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
}
