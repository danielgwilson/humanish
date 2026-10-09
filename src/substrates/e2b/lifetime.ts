// How long an E2B sandbox may live, and the budgets the desktop routes add to a participant's own
// deadline when they set a sandbox's server-side timeout. A dead host process can never orphan a
// sandbox past that timeout, so every route derives it from these values.

import { readPositiveInt } from "../../study/parse/values.js";
import { DEFAULT_STATE_STEP_TIMEOUT_MS } from "../../subject/state.js";

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
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;

/** Room a provisioned subject adds to the sandbox deadline for clone, install, build, start and probe. */
const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;

/**
 * What a sandbox's server-side timeout adds to the session it hosts: the teardown buffer, and on a
 * sandbox that serves the subject, the provisioning budget and each seed step's budget. A planner
 * adds it to the session to get the deadline it checks against the ceiling, and the route adds it
 * to set the timeout it asks E2B for.
 */
export function sandboxHeadroomMs(servedSubject?: {
  readonly seed: readonly { readonly timeoutMs?: number | undefined }[];
}): number {
  if (servedSubject === undefined) return SANDBOX_TIMEOUT_BUFFER_MS;
  const seedMs = servedSubject.seed.reduce(
    (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS),
    0,
  );
  return SUBJECT_PROVISION_BUDGET_MS + seedMs + SANDBOX_TIMEOUT_BUFFER_MS;
}

/** A sandbox a plan will ask E2B for, as its deadline refusal describes it. */
export interface PlannedSandbox {
  /** How the refusal names the sandbox, as in "the subject sandbox". */
  readonly name: string;
  /** The session it hosts, and whether the study set it in execution.timeoutMs. */
  readonly sessionMs: number;
  readonly sessionDeclared: boolean;
  /** The subject it serves, whose provisioning and seed steps add to its deadline. */
  readonly servedSubject?:
    | { readonly seed: readonly { readonly timeoutMs?: number | undefined }[] }
    | undefined;
}

/**
 * Why the sandbox's deadline, its session plus sandboxHeadroomMs, passes the `ceilingMs` ceiling,
 * or undefined when it fits. The message shows the arithmetic, the longest execution.timeoutMs the
 * ceiling leaves, and the setting value that would admit the study.
 */
export function sandboxDeadlineRefusal(
  sandbox: PlannedSandbox,
  ceilingMs: number,
): string | undefined {
  const headroomMs = sandboxHeadroomMs(sandbox.servedSubject);
  const deadlineMs = sandbox.sessionMs + headroomMs;
  if (deadlineMs <= ceilingMs) return undefined;
  const inMinutes = (ms: number) => Math.round(ms / 60_000);
  const session = sandbox.sessionDeclared
    ? `execution.timeoutMs ${inMinutes(sandbox.sessionMs)}m`
    : `The default session budget of ${inMinutes(sandbox.sessionMs)}m`;
  const headroom =
    sandbox.servedSubject === undefined
      ? `${inMinutes(headroomMs)}m of teardown buffer`
      : `${inMinutes(headroomMs)}m to provision and seed the subject and tear it down`;
  const roomMinutes = Math.floor((ceilingMs - headroomMs) / 60_000);
  const lower =
    roomMinutes >= 1
      ? `Lower execution.timeoutMs to at most ${roomMinutes}m.`
      : "The provisioning and seed step budgets alone leave no session time under it, so shorten subject.state.seed[].timeoutMs.";
  return `${session} derives a ${inMinutes(deadlineMs)}m deadline for ${sandbox.name}, and a sandbox may not live longer than ${ceilingMs / 60_000}m. The deadline is the session budget plus ${headroom}. ${lower}${ceilingAdvice(deadlineMs)}`;
}

/** The timeout of one E2B API request: HUMANISH_E2B_REQUEST_TIMEOUT_MS when set, else 60 s. */
export function e2bRequestTimeoutMs(env: Record<string, string | undefined>): number {
  return readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
}
