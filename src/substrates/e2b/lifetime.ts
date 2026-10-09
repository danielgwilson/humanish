// The operator's E2B plan limits humanish plans against: how long a sandbox may live and how many
// run at once. Also the budgets the desktop routes add to a participant's own deadline when they set
// a sandbox's server-side timeout. A dead host process can never orphan a sandbox past that
// timeout, so every route derives it from these values.

import { plural } from "../../run/text.js";
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
  const minutes = planSetting(env, SANDBOX_CEILING_SETTING, LARGEST_CEILING_MINUTES);
  if (minutes === undefined)
    return { ok: true, ms: DEFAULT_CEILING_MINUTES * 60_000, source: "default" };
  if (typeof minutes === "string")
    return {
      ok: false,
      message: `${SANDBOX_CEILING_SETTING} must be a whole number of minutes from 1 to ${LARGEST_CEILING_MINUTES} (got "${minutes}"). Set it to the sandbox lifetime your E2B plan allows: ${DEFAULT_CEILING_MINUTES} on Hobby, ${LARGEST_CEILING_MINUTES} on Pro. Unset, it is ${DEFAULT_CEILING_MINUTES}.`,
    };
  return { ok: true, ms: minutes * 60_000, source: "setting" };
}

/**
 * A plan setting's whole number from 1 to `largest`: undefined when unset or blank, else the
 * number, else the value as given (cut to 40 characters) for the refusal to quote.
 */
function planSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  largest: number,
): number | string | undefined {
  const declared = env[name]?.trim() ?? "";
  if (declared === "") return undefined;
  const value = /^\d+$/.test(declared) ? Number.parseInt(declared, 10) : Number.NaN;
  return value >= 1 && value <= largest ? value : declared.slice(0, 40);
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

/** The setting that tells humanish how many sandboxes the operator's E2B plan runs at once. */
const CONCURRENCY_SETTING = "HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES";

/** E2B's Hobby plan runs 20 sandboxes at once, so a key on any plan can use this limit. */
const DEFAULT_CONCURRENT_SANDBOXES = 20;

/** E2B's Pro plan runs 100 at once, and add-ons raise it to 1,100. */
const PRO_CONCURRENT_SANDBOXES = 100;

/** Enterprise plans run tens of thousands; the setting refuses only a value no plan could mean. */
const LARGEST_CONCURRENT_SANDBOXES = 1_000_000;

/**
 * How many sandboxes humanish runs at once, and whether it is the default or the setting; or why
 * the setting cannot be read.
 */
export type ConcurrentSandboxes =
  | { readonly ok: true; readonly count: number; readonly source: "default" | "setting" }
  | { readonly ok: false; readonly message: string };

/**
 * The concurrent sandbox limit: HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES when set, else 20. E2B
 * refuses a create past the plan's limit, and neither its API nor its SDK says which plan a key is
 * on, so the operator states it, as for the sandbox ceiling. A study that would run more desktops
 * at once is refused or run in waves at plan time, before a create fails mid-run.
 */
export function concurrentSandboxes(
  env: Readonly<Record<string, string | undefined>>,
): ConcurrentSandboxes {
  const count = planSetting(env, CONCURRENCY_SETTING, LARGEST_CONCURRENT_SANDBOXES);
  if (count === undefined)
    return { ok: true, count: DEFAULT_CONCURRENT_SANDBOXES, source: "default" };
  if (typeof count === "string")
    return {
      ok: false,
      message: `${CONCURRENCY_SETTING} must be a whole number of 1 or more (got "${count}"). Set it to how many sandboxes your E2B plan runs at once: ${DEFAULT_CONCURRENT_SANDBOXES} on Hobby, ${PRO_CONCURRENT_SANDBOXES} on Pro. Unset, it is ${DEFAULT_CONCURRENT_SANDBOXES}.`,
    };
  return { ok: true, count, source: "setting" };
}

/** The limit in use and where it came from, or why the setting cannot be read (doctor's row). */
export function describeConcurrentSandboxes(limit: ConcurrentSandboxes): string {
  if (!limit.ok) return limit.message;
  return limit.source === "setting"
    ? `${limit.count} at once, from ${CONCURRENCY_SETTING}. A study that runs more desktops at once runs them in waves, and an execution.concurrency above it is refused before any sandbox is created.`
    : `${limit.count} at once, E2B's Hobby limit. On a plan that runs more (Pro runs ${PRO_CONCURRENT_SANDBOXES}), set ${CONCURRENCY_SETTING} to that plan's limit.`;
}

/**
 * How many participants a hosted study runs at once: its `concurrency` (the declared
 * execution.concurrency clamped to the roster, else every participant), lowered to what the plan
 * runs. `declared` says whether the study set it. `alongside` counts the sandboxes the study keeps
 * for the whole run besides its participants' desktops, such as a shared world's app, and
 * `minimum` is the fewest at once the route can run. A declared value that does not fit is a
 * refusal naming the setting value that admits it. `lowered` is the warning a plan records when
 * the limit holds an undeclared default to waves.
 */
export function participantsAtOnce(
  study: {
    readonly concurrency: number;
    readonly declared: boolean;
    readonly participants: number;
    readonly alongside?: number;
    readonly minimum?: number;
  },
  limit: ConcurrentSandboxes,
):
  | { readonly ok: true; readonly count: number; readonly lowered?: string }
  | { readonly ok: false; readonly message: string } {
  if (!limit.ok) return limit;
  const alongside = study.alongside ?? 0;
  const minimum = study.minimum ?? 1;
  const room = limit.count - alongside;
  const needed = Math.max(study.concurrency, minimum) + alongside;
  const raise = ` If your E2B plan runs more (Pro runs ${PRO_CONCURRENT_SANDBOXES}), set ${CONCURRENCY_SETTING} to ${needed} or more.`;
  const app =
    alongside === 0
      ? ""
      : ` beside the ${plural(alongside, "sandbox", "sandboxes")} the study keeps for its app`;
  if (room < minimum)
    return {
      ok: false,
      message: `This study runs at least ${minimum} participants at once${app}, and ${limitText(limit)}.${raise}`,
    };
  if (study.concurrency <= room) return { ok: true, count: study.concurrency };
  if (study.declared)
    return {
      ok: false,
      message: `execution.concurrency runs ${study.concurrency} participants at once${app}, and ${limitText(limit)}. Lower execution.concurrency to ${room} or less, or remove it to run ${room} at a time.${raise}`,
    };
  return {
    ok: true,
    count: room,
    lowered: `This study's ${study.participants} participants run ${room} at a time${app}, because ${limitText(limit)}.${raise}`,
  };
}

function limitText(limit: Extract<ConcurrentSandboxes, { ok: true }>): string {
  return limit.source === "setting"
    ? `${CONCURRENCY_SETTING} allows ${limit.count} sandboxes at once`
    : `humanish runs at most ${limit.count} sandboxes at once, E2B Hobby's limit, when ${CONCURRENCY_SETTING} is unset`;
}

/** Server-side reclamation buffer past a participant's own wall-clock stop. */
export const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;

/** Room a provisioned subject adds to the sandbox deadline for clone, install, build, start and probe. */
export const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;

/** The timeout of one E2B API request: HUMANISH_E2B_REQUEST_TIMEOUT_MS when set, else 60 s. */
export function e2bRequestTimeoutMs(env: Record<string, string | undefined>): number {
  return readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
}
