// Anonymous usage telemetry, on the convention Next.js and the Vercel CLI established: collected by
// default, disclosed the first time it happens, trivially switched off, and inspectable.
//
// WHY IT EXISTS: humanish shipped 61 releases without being able to answer "does anyone get to a
// working first run". The funnel was broken at the first live run for months and we learned it from
// an adoption post-mortem, not from data. A tool that cannot see its own activation is guessing.
//
// WHAT IT WILL NEVER SEND, and this is stricter than the convention because of what humanish is:
// no paths, no cwd, no repo names, no URLs, no lab titles or ids that are not our own starter labs,
// no persona or mission text, no run ids, no evidence, no key values, no key names. A study's
// subject is the adopter's product and often unannounced; leaking a lab id would leak a roadmap.
// The allowlist below is the whole vocabulary — anything not on it cannot be sent by construction.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Write-only PostHog project key. Public by design — it can ingest, and can read nothing. */
const INGEST_KEY = "phc_oeMeBqxDZhZ9tCHMSnuDFimLqHpU5Myc847WD33hAh4C";
const INGEST_HOST = "https://us.i.posthog.com";

/** The ONLY lab ids that may be named. Ours, shipped by `init`; everything else is "custom". */
const STARTER_LABS = new Set(["first-run", "try-live", "cua-browser", "lobby-trivia-3player", "oss"]);

/** The ONLY event names. */
export type TelemetryEvent =
  | "cli_command"
  | "project_initialized"
  | "study_finished";

export interface TelemetryProperties {
  command?: string;
  /** A starter lab id, or "custom" — never an adopter's own lab id. */
  lab?: string;
  mode?: "dry-run" | "live";
  outcome?: string;
  /** Bucketed, not exact: a duration is a fingerprint at full precision. */
  durationBucket?: string;
  /** Which brain ran it, as a route name — never a model id the adopter configured. */
  brain?: "provider-key" | "local-agent" | "none";
  ok?: boolean;
  exitCode?: number;
  /** One of humanish's OWN error codes (`HUMANISH_*`), never a message. Which failure ends a
   *  first run is the question the funnel exists to answer. */
  errorCode?: string;
}

export interface TelemetryState {
  enabled: boolean;
  /** Random, generated locally, tied to nothing. */
  anonymousId: string;
  /** Whether the first-run notice has been shown. */
  noticed: boolean;
}

export function telemetryStatePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const declared = env.XDG_CONFIG_HOME?.trim();
  // Same XDG rule the key store uses: a relative value MUST be ignored, or state becomes
  // cwd-relative and follows people between projects.
  const configHome = declared !== undefined && declared !== "" && path.isAbsolute(declared)
    ? declared
    : path.join(home, ".config");
  return path.join(configHome, "humanish", "telemetry.json");
}

/**
 * Off means off, from any of the three switches people already expect: the cross-tool
 * `DO_NOT_TRACK` standard, our own env var, and the persisted opt-out.
 */
export function disabledByEnvironment(env: NodeJS.ProcessEnv): boolean {
  const truthy = (value: string | undefined): boolean =>
    value !== undefined && value.trim() !== "" && value.trim() !== "0" && value.trim().toLowerCase() !== "false";
  return (
    truthy(env.DO_NOT_TRACK)
    || truthy(env.HUMANISH_TELEMETRY_DISABLED)
    // Our OWN development and test runs must never reach the adoption dataset. In the first two
    // days after telemetry shipped, 82% of events (4,042 of 4,932, from 49 of 59 anonymous ids)
    // came from humanish's own CI and suite: ~50 ids each running nearly every subcommand about
    // once, which is the shape of a test matrix and not of people. That made the one number whose
    // job is measuring adoption measure us instead.
    //
    // Deliberately NOT keyed on CI. An adopter running humanish in their pipeline is real usage
    // and stays countable; the `ci` property already separates it, which is what Next.js does.
    // This keys on being inside the humanish source tree, which only we ever are.
    || truthy(env.HUMANISH_DEV)
  );
}

/**
 * True when this process is running from a humanish SOURCE CHECKOUT rather than an install.
 *
 * Checked by walking up from cwd for a package.json whose name is `humanish` AND which carries
 * this repo's private marker. An adopter with a dependency named humanish in node_modules is not
 * matched: node_modules copies are skipped, and a consumer's own package.json has a different
 * name. Falls back to "not a checkout" on any read error, because the failure direction that
 * loses one event is better than the one that silently disables real telemetry.
 */
export function inHumanishCheckout(startDir: string, readFileSyncFn: (p: string) => string): boolean {
  let dir = path.resolve(startDir);
  // Any node_modules ANYWHERE in the path means this is an installed copy, not our checkout.
  // Checking only the basename missed `/app/node_modules/humanish`, which is the single most
  // likely real-world path to get wrong: it would silence a genuine adopter.
  if (dir.split(path.sep).includes("node_modules")) return false;
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSyncFn(path.join(dir, "package.json"))) as {
        name?: unknown;
        private?: unknown;
      };
      if (parsed.name === "humanish") return true;
    } catch {
      // No package.json here, or unreadable. Keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Is this command one of OUR runs, whichever directory it was started from? Two walks: from the
 * cwd (catches `pnpm humanish ...` inside the repo) and from the running CLI's own directory
 * (catches a test, TUI smoke or release-dogfood host that spawns dist/cli.js into a temp
 * directory with a constructed env). The second walk is the one the 0.63.0 fix lacked: one
 * development box put 1,251 events into the adopter metric between 2026-08-31 and 09-03 through
 * exactly those spawns. An installed copy lives under node_modules and is never matched, so an
 * adopter running from their own project still reports.
 */
export function isOwnCheckoutRun(
  cwd: string,
  cliDir: string,
  readFileSyncFn: (p: string) => string
): boolean {
  return inHumanishCheckout(cwd, readFileSyncFn) || inHumanishCheckout(cliDir, readFileSyncFn);
}

export async function readTelemetryState(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): Promise<TelemetryState> {
  try {
    const raw = await readFile(telemetryStatePath(env, home), "utf8");
    const parsed = JSON.parse(raw) as Partial<TelemetryState>;
    return {
      enabled: parsed.enabled !== false,
      anonymousId: typeof parsed.anonymousId === "string" ? parsed.anonymousId : randomUUID(),
      noticed: parsed.noticed === true
    };
  } catch {
    return { enabled: true, anonymousId: randomUUID(), noticed: false };
  }
}

export async function writeTelemetryState(
  state: TelemetryState,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): Promise<void> {
  const file = telemetryStatePath(env, home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Coarse enough that a duration cannot fingerprint a session. */
export function durationBucket(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  if (ms < 900_000) return "5-15m";
  return ">15m";
}

/** A lab id only if it is one of ours. An adopter's lab id can name an unannounced product. */
export function safeLabId(lab: string | undefined): string | undefined {
  if (lab === undefined) return undefined;
  return STARTER_LABS.has(lab) ? lab : "custom";
}

export interface TelemetryPayload {
  event: TelemetryEvent;
  distinct_id: string;
  properties: Record<string, string | number | boolean>;
}

/**
 * The exact document that would be sent. Built separately from sending so that
 * `HUMANISH_TELEMETRY_DEBUG=1` can show it and so tests can assert on it — "you can read exactly
 * what we collect" is the part of this convention that makes it honest rather than merely legal.
 */
export function buildPayload(args: {
  event: TelemetryEvent;
  anonymousId: string;
  version: string;
  properties?: TelemetryProperties;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  nodeVersion?: string;
}): TelemetryPayload {
  const env = args.env ?? process.env;
  const properties: Record<string, string | number | boolean> = {
    // Ask the receiver not to derive a location from the request. "Anonymous" and "tied to
    // nothing" are only true if the collector honours them too: PostHog enriches every event
    // with GeoIP city/coordinates from the source address unless told not to, and the project
    // is additionally set to discard the client IP at ingestion (`anonymize_ips`). Both, so that
    // neither a default nor a console setting decides what the doc promised.
    $geoip_disable: true,
    // No person profile. PostHog builds one per distinct_id by default and attaches $set /
    // $set_once properties to it (before 2026-09-01 those carried a city and coordinates). An
    // anonymous machine id has nothing to profile, and PostHog's own docs name this flag as the
    // way to say so.
    $process_person_profile: false,
    version: args.version,
    os: args.platform ?? process.platform,
    node: (args.nodeVersion ?? process.version).split(".")[0]!.replace("v", ""),
    ci: env.CI !== undefined && env.CI !== "" && env.CI !== "0",
    // A humanish study participant is a real cold install on a machine we do not own, so it emits
    // like any other new adopter and is indistinguishable from one. It is also the exact
    // population we are trying to count, so a busy self-study day reads as an adoption spike.
    // Stamped rather than suppressed, the same shape as `ci`: participant runs stay visible and
    // stay separable, and we keep a genuine measurement of what a cold install does (#546).
    studyParticipant: env.HUMANISH_STUDY_PARTICIPANT !== undefined
      && env.HUMANISH_STUDY_PARTICIPANT !== ""
      && env.HUMANISH_STUDY_PARTICIPANT !== "0"
  };
  const given = args.properties ?? {};
  if (given.command !== undefined) properties.command = given.command;
  if (given.lab !== undefined) properties.lab = given.lab;
  if (given.mode !== undefined) properties.mode = given.mode;
  if (given.outcome !== undefined) properties.outcome = given.outcome;
  if (given.durationBucket !== undefined) properties.duration = given.durationBucket;
  if (given.brain !== undefined) properties.brain = given.brain;
  if (given.ok !== undefined) properties.ok = given.ok;
  if (given.exitCode !== undefined) properties.exit_code = given.exitCode;
  if (given.errorCode !== undefined && OWN_ERROR_CODE.test(given.errorCode)) properties.error_code = given.errorCode;
  return { event: args.event, distinct_id: args.anonymousId, properties };
}

/** Our own codes only. A provider's or the OS's message is free text and never travels. */
const OWN_ERROR_CODE = /^HUMANISH_[A-Z0-9_]{1,80}$/;

/**
 * The closed vocabulary an outcome may take. Actor statuses (src/actor-contract.ts), the two
 * shared-world extras, a fan-out roll-up, and the two shapes a non-study command has. Anything
 * else — a provider's reason string, a scorer's verdict text — is dropped, never forwarded.
 */
const OUTCOMES = new Set([
  "passed", "abandoned", "incomplete", "blocked", "timed_out", "failed",
  "contract_proof_only",
  "all_passed", "some_passed", "none_passed",
  "ok", "error"
]);

const BRAINS_BY_ACTOR: Record<string, NonNullable<TelemetryProperties["brain"]>> = {
  "local-agent": "local-agent",
  "openai-computer-use": "provider-key",
  "codex-exec": "provider-key",
  "codex-tui": "provider-key",
  "codex-app-server": "provider-key",
  "scripted-browser": "none"
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Read the study facts off a command's result document: mode, outcome, starter lab, brain route,
 * and our own error code. Duck-typed over every result shape the CLI writes, because the point is
 * ONE derivation at the one seam every command already passes through (writeResult), so that a
 * backend added later cannot forget to report. Returns {} for results that carry no study.
 *
 * The first two days of 0.62.0 data had 1,359 `run`/`lab run` events and not one carried a mode
 * or an outcome — the vocabulary existed, nothing populated it — so the one question telemetry
 * was added to answer ("does anyone get to a working LIVE first run") had no answer in the data.
 */
export function deriveStudyFacts(result: unknown): TelemetryProperties {
  const r = asRecord(result);
  if (!r) return {};
  const facts: TelemetryProperties = {};

  if (r.dryRun === true) facts.mode = "dry-run";
  else if (r.dryRun === false) facts.mode = "live";
  else if (r.mode === "dry-run" || r.mode === "live") facts.mode = r.mode;

  const labRecord = asRecord(r.lab);
  const labId = typeof r.labId === "string" ? r.labId
    : typeof labRecord?.id === "string" ? labRecord.id
    : typeof r.lab === "string" ? r.lab
    : undefined;
  const lab = safeLabId(labId);
  if (lab !== undefined) facts.lab = lab;

  const error = asRecord(r.error);
  if (typeof error?.code === "string" && OWN_ERROR_CODE.test(error.code)) facts.errorCode = error.code;

  const session = asRecord(r.session);
  const laneSummary = asRecord(r.laneSummary);
  let outcome: string | undefined;
  if (laneSummary && typeof laneSummary.total === "number" && typeof laneSummary.passed === "number" && laneSummary.total > 1) {
    outcome = laneSummary.passed === laneSummary.total ? "all_passed"
      : laneSummary.passed === 0 ? "none_passed"
      : "some_passed";
  } else if (typeof session?.status === "string") {
    outcome = session.status;
  } else if (typeof r.status === "string") {
    outcome = r.status;
  } else if (r.error !== undefined && r.error !== null) {
    outcome = "error";
  } else if (r.ok === true && facts.mode !== undefined) {
    outcome = "ok";
  }
  if (outcome !== undefined && OUTCOMES.has(outcome)) facts.outcome = outcome;
  else if (outcome !== undefined && facts.errorCode !== undefined) facts.outcome = "error";

  if (typeof r.actor === "string") {
    const brain = facts.mode === "dry-run" ? "none" : BRAINS_BY_ACTOR[r.actor];
    if (brain !== undefined) facts.brain = brain;
  }
  return facts;
}

/** The notice, shown once, before anything is sent. */
export const TELEMETRY_NOTICE = [
  "humanish collects anonymous usage data (which command ran, whether it worked, how long it took).",
  "It never sends your labs, subjects, personas, paths, or evidence. Opt out any time:",
  "  humanish telemetry disable        (or set DO_NOT_TRACK=1)",
  "  humanish telemetry status         shows exactly what is collected"
].join("\n");

export interface SendDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * Fire and forget, bounded, and incapable of affecting the command that triggered it. A tool whose
 * telemetry can slow down or fail a run has made its users pay for its metrics.
 */
export async function sendTelemetry(payload: TelemetryPayload, deps: SendDeps = {}): Promise<void> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function" || INGEST_KEY.length === 0) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    await fetchFn(`${INGEST_HOST}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: INGEST_KEY,
        event: payload.event,
        distinct_id: payload.distinct_id,
        properties: payload.properties
      }),
      signal: controller.signal
    });
  } catch {
    // Never surfaces. Metrics are our problem, not the operator's.
  } finally {
    clearTimeout(timer);
  }
}
