// mimetic.lab.v2 — a lab is a COMPOSITION over code primitives, not a hardcoded kind.
//
// HONEST SCOPE (read before trusting field names): the engine routes by
// subject.source × execution.target (disambiguated by the actor lane where both axes
// collide) and consumes a deliberately small set of fields:
//   subject.source/repos/appUrl/serve/env/clone.{depth,fanout,keep}, actors[0].count,
//   execution.target + execution.desktop.codexAppServer, scenario.mode,
//   policies.redactRepos, defaults.open.
// On the computer-use routes (app-url, and clone × e2b-desktop with a computer-use actor),
// `actors[0].type` IS load-bearing: it must resolve to a registered computer-use actor, and
// that descriptor runs the session. Those routes also consume actors[0].{mission,persona,
// laneFocus.instruction,model}, execution.timeoutMs, execution.desktop.{resolution,
// sandboxTimeoutMs}, and (clone) subject.{serve,env,clone.depth}. On the other routes those
// fields remain FORWARD-DECLARED and NOT yet consumed — parseLabConfig emits a warning
// listing any such field that is set, so `lab inspect` shows the truth.
//
// There is deliberately NO v1 compatibility: v1 had zero real users. Breaking schema changes
// bump the version honestly.

import { actorRegistry } from "./actor-registry.js";
import { DEVICE_PRESET_NAMES, isDevicePresetName } from "./device-presets.js";

export const LAB_CONFIG_SCHEMA = "mimetic.lab.v2";

// Must start alphanumeric so an id never collides with the path-vs-id resolver heuristic
// (a leading "." or "/" is read as a file path; a leading "-" collides with CLI flags).
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Where the run acts: the host repo, a fresh clone, or a running app a browser actor drives. */
export type LabSubjectSource = "this-repo" | "clone" | "app-url";

export interface LabSubjectClone {
  /** git clone depth; 1 (shallow) by default. Consumed on the computer-use clone route. */
  depth?: number;
  /** how many independent clone lanes to fan out (one sandbox/desktop each). */
  fanout?: number;
  /** keep the disposable clone for debugging instead of discarding. */
  keep?: boolean;
}

/** How a cloned subject is installed/built/started inside the sandbox (computer-use route). */
export interface LabSubjectServe {
  /** Optional bounded install step (e.g. "pnpm install --frozen-lockfile"). */
  install?: string;
  /** Optional bounded build step. */
  build?: string;
  /** Required long-lived start command — launched detached; the sandbox lifecycle owns it. */
  start: string;
  /** Loopback entry URL: the readiness-probe target and the URL the actor drives. The lab
   *  serves the clone INSIDE the sandbox, so this is always loopback (not subject to
   *  allowPublicTargets — that governs app-url subjects, i.e. external deployments). */
  url: string;
  /** Budget for the served app to answer the readiness probe. Default 180000. */
  readyTimeoutMs?: number;
  /** Override the install-step timeout (default 600000). Monorepos can exceed it. */
  installTimeoutMs?: number;
  /** Override the build-step timeout (default 600000). Large builds can exceed it. */
  buildTimeoutMs?: number;
}

export interface LabSubject {
  source: LabSubjectSource;
  /** `clone`: one or more owner/repo slugs (public or authorized-private). */
  repos?: string[];
  clone?: LabSubjectClone;
  /**
   * `app-url`: a loopback http(s) URL the computer-use actor drives (127.0.0.1/localhost
   * only — driving arbitrary public sites is not allowed). The URL must be reachable from
   * INSIDE the desktop sandbox; library callers provision it via the prepareDesktop hook.
   * For a config-only path use `clone` + `serve` — the lab serves the app itself.
   */
  appUrl?: string;
  /** `clone` (computer-use route): how the cloned app is served in-sandbox. */
  serve?: LabSubjectServe;
  /**
   * Env var NAMES the subject app needs, provisioned into the sandbox from the caller's
   * environment (--env-file). Names are recorded in evidence; values never are. Consumed
   * on the computer-use clone route.
   */
  env?: string[];
}

export interface LabActorLaneFocus {
  id?: string;
  label?: string;
  /** Per-lane steer appended to the actor's mission. Consumed on the app-url route. */
  instruction?: string;
}

export interface LabActor {
  /**
   * The actor label. On app-url subjects this is a REAL dispatch key: it must resolve to a
   * registered computer-use actor (e.g. openai-computer-use) and that descriptor runs the
   * session. On other routes it remains a free-form label (built-ins use descriptive labels
   * like synthetic-persona, mimetic-setup, codex-app-server).
   */
  type: string;
  /** Lane count. Consumed for the synthetic backend (actors[0].count → simCount); must be 1 on app-url. */
  count?: number;
  /** Persona id/label threaded into the actor prompt. Consumed on the app-url route. */
  persona?: string;
  /** Consumed on the app-url route (laneFocus.instruction appended to the mission). */
  laneFocus?: LabActorLaneFocus;
  /** Free-form mission threaded into the actor prompt. Consumed on the app-url route. */
  mission?: string;
  /** Provider model override. Consumed on the app-url route. */
  model?: string;
}

export type LabExecutionTarget = "local" | "e2b-desktop";

export interface LabExecutionDesktop {
  /**
   * Named device preset (mobile / small-mobile / narrow-mobile / tablet / desktop / wide) the
   * run renders at. Consumed on the computer-use route; default `desktop` (1440x950). On that
   * route only width/height physically render (the X screen is sized to the preset, so
   * width-based responsive CSS fires) — touch/DPR/UA are sim-parity prompt signals, not rendered.
   */
  device?: string;
  /** Raw desktop resolution [width, height] — an escape hatch that overrides `device`. */
  resolution?: [number, number];
  /** Sandbox server-side timeout. Consumed on the app-url route. */
  sandboxTimeoutMs?: number;
  /** Use the Codex app-server client mode for headed desktop actor surfaces. Consumed (meta). */
  codexAppServer?: boolean;
}

export interface LabExecution {
  target?: LabExecutionTarget;
  /** Actor session wall-clock budget. Consumed on the app-url route. */
  timeoutMs?: number;
  /** FORWARD-DECLARED. */
  completionTimeoutMs?: number;
  /** FORWARD-DECLARED. */
  concurrency?: number;
  desktop?: LabExecutionDesktop;
}

export type LabScenarioMode = "dry-run" | "live";

export interface LabScenario {
  /** Reference a committed/ignored scenario by id or path. FORWARD-DECLARED (PR #2). */
  ref?: string;
  /** Or inline the scenario body. FORWARD-DECLARED (PR #2). */
  inline?: Record<string, unknown>;
  /** dry-run = contract evidence (no provider spend); live = real run. Consumed. */
  mode?: LabScenarioMode;
}

export interface LabPolicies {
  /**
   * Redact target repo labels in durable artifacts. Consumed on the meta route and on the
   * computer-use clone route (provenance), where it DEFAULTS to true when the clone
   * authenticates via GITHUB_TOKEN (a token-bearing clone is treated as private until
   * declared otherwise).
   */
  redactRepos?: boolean;
  /**
   * Blur+downscale persisted screenshots on the computer-use route. Default FALSE — the common
   * case is watching a sim of your OWN app locally (gitignored .mimetic), where full fidelity is
   * the deliverable. Set true for unowned subjects or bundles meant to be shared as-is. The
   * provider always sees raw frames; this only governs what is persisted. Raw bundles stay
   * local (gitignored, commit-scan-guarded); a redact-on-export step for them is planned.
   */
  redactScreenshots?: boolean;
  /**
   * Allow an app-url subject to point at a non-loopback (public/preview/staging) URL the lab
   * owner declares. Default FALSE (loopback-only). The invariant is "the actor drives a target
   * the owner declared" — setting this IS that declaration (e.g. a Vercel preview of your app).
   */
  allowPublicTargets?: boolean;
}

export interface LabReview {
  /** FORWARD-DECLARED (PR #2). */
  scoring?: string;
  /** FORWARD-DECLARED (PR #2). */
  milestones?: string;
  /** FORWARD-DECLARED (PR #2). */
  vocabulary?: string;
}

export interface LabDefaults {
  open?: boolean;
}

export interface LabConfig {
  schema: typeof LAB_CONFIG_SCHEMA;
  id: string;
  title?: string;
  description?: string;
  subject: LabSubject;
  actors: LabActor[];
  execution?: LabExecution;
  /** FORWARD-DECLARED (PR #2). */
  personas?: Record<string, unknown>[];
  scenario?: LabScenario;
  policies?: LabPolicies;
  review?: LabReview;
  defaults?: LabDefaults;
}

export interface LabConfigParseSuccess {
  ok: true;
  config: LabConfig;
  warnings: string[];
}

export interface LabConfigParseFailure {
  ok: false;
  error: { code: "MIMETIC_LAB_INVALID"; message: string };
}

export type LabConfigParseResult = LabConfigParseSuccess | LabConfigParseFailure;

/**
 * Validate a parsed YAML object into a LabConfig. Pure: the caller owns file IO. Structural
 * validation only. Fields the engine does not yet consume are accepted but reported in
 * `warnings` so `lab inspect` never silently swallows a setting that does nothing.
 */
export function parseLabConfig(raw: unknown): LabConfigParseResult {
  if (!isRecord(raw)) {
    return invalid("Lab manifest must be a YAML object.");
  }
  if (raw.schema !== LAB_CONFIG_SCHEMA) {
    return invalid(`Lab schema must be ${LAB_CONFIG_SCHEMA}.`);
  }

  const id = str(raw.id);
  if (!id || !ID_PATTERN.test(id)) {
    return invalid("Lab id must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).");
  }

  const subjectResult = parseSubject(raw.subject);
  if (!subjectResult.ok) {
    return subjectResult;
  }

  const actorsResult = parseActors(raw.actors);
  if (!actorsResult.ok) {
    return actorsResult;
  }

  const executionResult = parseExecution(raw.execution);
  if (!executionResult.ok) {
    return executionResult;
  }

  const config: LabConfig = {
    schema: LAB_CONFIG_SCHEMA,
    id,
    ...optionalStr("title", raw.title),
    ...optionalStr("description", raw.description),
    subject: subjectResult.value,
    actors: actorsResult.value,
    ...(executionResult.value ? { execution: executionResult.value } : {})
  };

  const personas = parsePersonas(raw.personas);
  if (personas) config.personas = personas;
  const scenario = parseScenario(raw.scenario);
  if (scenario) config.scenario = scenario;
  const policies = parsePolicies(raw.policies);
  if (policies) config.policies = policies;
  const review = parseReview(raw.review);
  if (review) config.review = review;
  const defaults = parseDefaults(raw.defaults);
  if (defaults) config.defaults = defaults;

  // this-repo subjects run locally and dry-run only — there is no live execution target for the
  // host repo (clone/app-url provide that). Reject the mis-configs rather than silently mishandle.
  if (config.subject.source === "this-repo") {
    if (config.execution?.target) {
      return invalid("`execution.target` applies only to clone/app-url subjects; this-repo labs run locally.");
    }
    if (config.scenario?.mode === "live") {
      return invalid("this-repo labs are dry-run only; use a clone or app-url subject for a live run.");
    }
  }

  // Computer-use routes: the actor type is a REAL dispatch key (registry-resolved), and the
  // substrate is a hosted desktop. Fail closed on mis-configs.
  if (config.subject.source === "app-url") {
    if (config.execution?.target !== "e2b-desktop") {
      return invalid("app-url subjects require `execution.target: e2b-desktop` — the computer-use actor drives a hosted desktop browser.");
    }
    const type = config.actors[0]?.type ?? "";
    if (!actorResolvesToComputerUse(type)) {
      return invalid(`actors[0].type must be a registered computer-use actor for app-url subjects (one of: ${registeredComputerUseActors().join(", ")}); got "${type}".`);
    }
    if ((config.actors[0]?.count ?? 1) > 1) {
      return invalid("Multi-lane computer-use fan-out is not supported yet; set actors[0].count to 1.");
    }
    // Loopback by default; an owner may declare a public/preview target via policies.
    if (!config.policies?.allowPublicTargets && !isLoopbackUrl(config.subject.appUrl ?? "")) {
      return invalid("`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) unless `policies.allowPublicTargets: true` is set — set it to drive a deployed/preview URL you own.");
    }
  }

  // clone × e2b-desktop disambiguates on the actor lane: a computer-use actor means the lab
  // clones AND serves the subject in-sandbox, then drives it (the meta route otherwise).
  if (config.subject.source === "clone" && config.execution?.target === "e2b-desktop"
    && actorResolvesToComputerUse(config.actors[0]?.type)) {
    if (!config.subject.serve) {
      return invalid("clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox before the actor drives it.");
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return invalid("computer-use clone labs run a single lane; declare exactly one repo in subject.repos.");
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return invalid(`subject.repos[0] must be an owner/repo slug (got "${repo}").`);
    }
    if ((config.actors[0]?.count ?? 1) > 1) {
      return invalid("Multi-lane computer-use fan-out is not supported yet; set actors[0].count to 1.");
    }
  }

  return { ok: true, config, warnings: forwardDeclaredWarnings(config) };
}

// The slug interpolates into an in-sandbox shell command; the strict shape is load-bearing.
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function actorResolvesToComputerUse(type: string | undefined): boolean {
  if (!type) return false;
  const descriptor = (actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>)[type];
  return Boolean(descriptor?.capabilities.lanes.includes("computer-use"));
}

function registeredComputerUseActors(): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => entry.capabilities.lanes.includes("computer-use"))
    .map((entry) => entry.id);
}

/**
 * True when this config routes to the computer-use backend: an app-url subject, or a clone
 * subject on a hosted desktop whose first actor resolves to a registered computer-use actor.
 * Single source of truth — selectLabBackend and the warning logic both use it.
 */
export function routesToComputerUse(config: LabConfig): boolean {
  if (config.subject.source === "app-url") {
    return true;
  }
  return config.subject.source === "clone"
    && config.execution?.target === "e2b-desktop"
    && actorResolvesToComputerUse(config.actors[0]?.type);
}

// Report fields that are present but not yet consumed by the engine, so a user never trusts a
// setting that silently does nothing. Keeps the schema forward-correct AND honest.
function forwardDeclaredWarnings(config: LabConfig): string[] {
  const inert: string[] = [];
  // The computer-use routes consume the actor prompt fields, execution.timeoutMs,
  // execution.desktop.{resolution,sandboxTimeoutMs}, and (clone) subject.{serve,env,
  // clone.depth}; on every other route those fields are inert.
  const routesToCua = routesToComputerUse(config);
  for (const [index, actor] of config.actors.entries()) {
    if (!routesToCua) {
      if (actor.mission) inert.push(`actors[${index}].mission`);
      if (actor.laneFocus) inert.push(`actors[${index}].laneFocus`);
      if (actor.persona) inert.push(`actors[${index}].persona`);
      if (actor.model) inert.push(`actors[${index}].model`);
    } else {
      // The cua route consumes laneFocus.instruction ONLY; id/label remain inert there.
      if (actor.laneFocus?.id) inert.push(`actors[${index}].laneFocus.id`);
      if (actor.laneFocus?.label) inert.push(`actors[${index}].laneFocus.label`);
    }
  }
  if (config.subject.clone?.depth !== undefined && !routesToCua) inert.push("subject.clone.depth");
  if (config.subject.serve && !routesToCua) inert.push("subject.serve");
  if (config.subject.env && !routesToCua) inert.push("subject.env");
  if (routesToCua) {
    // clone.keep IS consumed on the cua route (honored on FAILURE: the sandbox is left up to
    // debug a failed install/boot; otherwise always killed). clone.fanout is still inert here —
    // the cua route is single-lane until fan-out lands.
    if (config.subject.clone?.fanout !== undefined) inert.push("subject.clone.fanout");
  }
  if (!routesToCua && config.execution?.timeoutMs !== undefined) inert.push("execution.timeoutMs");
  if (config.execution?.completionTimeoutMs !== undefined) inert.push("execution.completionTimeoutMs");
  if (config.execution?.concurrency !== undefined) inert.push("execution.concurrency");
  if (!routesToCua && config.execution?.desktop?.resolution) inert.push("execution.desktop.resolution");
  if (!routesToCua && config.execution?.desktop?.device !== undefined) inert.push("execution.desktop.device");
  if (!routesToCua && config.execution?.desktop?.sandboxTimeoutMs !== undefined) inert.push("execution.desktop.sandboxTimeoutMs");
  // codexAppServer is consumed only on the e2b-desktop (meta) route; flag it when it cannot reach there.
  const routesToDesktop = config.subject.source === "clone" && config.execution?.target === "e2b-desktop";
  if (config.execution?.desktop?.codexAppServer !== undefined && !routesToDesktop) {
    inert.push("execution.desktop.codexAppServer (needs subject.source: clone + execution.target: e2b-desktop)");
  }
  if (config.scenario?.ref) inert.push("scenario.ref");
  if (config.scenario?.inline) inert.push("scenario.inline");
  if (config.review) inert.push("review");
  if (config.personas) inert.push("personas");
  return inert.length === 0
    ? []
    : [`Forward-declared fields are set but not yet consumed by the engine (planned for a later slice): ${inert.join(", ")}.`];
}

function parseSubject(raw: unknown): { ok: true; value: LabSubject } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid("Lab `subject` is required and must be an object.");
  }
  const source = str(raw.source);
  if (source !== "this-repo" && source !== "clone" && source !== "app-url") {
    return invalid("`subject.source` must be one of: this-repo, clone, app-url.");
  }
  const subject: LabSubject = { source };

  if (source !== "clone" && raw.serve !== undefined) {
    return invalid("`subject.serve` applies only to clone subjects (the lab serves the cloned app in-sandbox).");
  }
  if (source !== "clone" && raw.env !== undefined) {
    return invalid("`subject.env` applies only to clone subjects (the served app's environment channel).");
  }

  if (source === "clone") {
    const repos = strList(raw.repos);
    if (!repos || repos.length === 0) {
      return invalid("`subject.repos` must list at least one owner/repo slug when source is clone.");
    }
    subject.repos = repos;
    const clone = parseClone(raw.clone);
    if (clone) {
      subject.clone = clone;
    }
    const serveResult = parseServe(raw.serve);
    if (!serveResult.ok) {
      return serveResult;
    }
    if (serveResult.value) subject.serve = serveResult.value;
    if (raw.env !== undefined) {
      const env = strList(raw.env);
      if (!env || env.length === 0) {
        return invalid("`subject.env` must be a non-empty list of env var NAMES when set.");
      }
      const badName = env.find((name) => !ENV_NAME_PATTERN.test(name));
      if (badName) {
        return invalid(`subject.env entries must be env var NAMES like DATABASE_URL (got "${badName}"); values come from the caller's environment and are never persisted.`);
      }
      subject.env = env;
    }
  }

  if (source === "app-url") {
    const appUrl = str(raw.appUrl);
    if (!appUrl) {
      return invalid("`subject.appUrl` is required when source is app-url.");
    }
    // Shape-only here; the loopback-vs-public-target gate is applied in the cross-validation
    // block below, where policies.allowPublicTargets is available.
    if (!isHttpUrl(appUrl)) {
      return invalid("`subject.appUrl` must be an http(s) URL.");
    }
    subject.appUrl = appUrl;
  }

  return { ok: true, value: subject };
}

// Public-safe stance: a computer-use actor's ENTRY URL is always an app the lab owner runs on
// loopback (inside the sandbox), never an arbitrary public site. (The constraint binds the
// entry point; a navigation watchdog for mid-session escapes is a later slice.) Exported so
// the engine re-enforces the same boundary on configs that arrive through the library API.
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** A well-formed http(s) URL (any host). Shape gate before the loopback/public-target policy. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseServe(raw: unknown): { ok: true; value: LabSubjectServe | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`subject.serve` must be an object ({ install?, build?, start, url, readyTimeoutMs? }).");
  }
  const start = str(raw.start);
  if (!start) {
    return invalid("`subject.serve.start` is required when serve is set (the long-lived command that serves the app).");
  }
  const url = str(raw.url);
  if (!url || !isLoopbackUrl(url)) {
    return invalid("`subject.serve.url` must be a loopback http(s) URL (127.0.0.1 or localhost) — the app is served INSIDE the sandbox.");
  }
  const serve: LabSubjectServe = { start, url };
  const install = str(raw.install);
  if (install) serve.install = install;
  const build = str(raw.build);
  if (build) serve.build = build;
  const readyTimeoutMs = posInt(raw.readyTimeoutMs);
  if (readyTimeoutMs !== undefined) serve.readyTimeoutMs = readyTimeoutMs;
  const installTimeoutMs = posInt(raw.installTimeoutMs);
  if (installTimeoutMs !== undefined) serve.installTimeoutMs = installTimeoutMs;
  const buildTimeoutMs = posInt(raw.buildTimeoutMs);
  if (buildTimeoutMs !== undefined) serve.buildTimeoutMs = buildTimeoutMs;
  return { ok: true, value: serve };
}

function parseClone(raw: unknown): LabSubjectClone | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const clone: LabSubjectClone = {};
  const depth = posInt(raw.depth);
  if (depth !== undefined) clone.depth = depth;
  const fanout = posInt(raw.fanout);
  if (fanout !== undefined) clone.fanout = fanout;
  if (typeof raw.keep === "boolean") clone.keep = raw.keep;
  return Object.keys(clone).length > 0 ? clone : undefined;
}

function parseActors(raw: unknown): { ok: true; value: LabActor[] } | LabConfigParseFailure {
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid("Lab `actors` must be a non-empty array.");
  }
  // Multi-actor fan-out is not wired yet (only actors[0] is consumed). Fail closed rather than
  // silently ignore actors[1..]; multi-actor support lands in a later slice.
  if (raw.length > 1) {
    return invalid("Multiple actors are not supported yet (only the first actor runs); declare a single actor.");
  }
  const actors: LabActor[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return invalid(`actors[${index}] must be an object.`);
    }
    const type = str(entry.type);
    if (!type) {
      return invalid(`actors[${index}].type is required.`);
    }
    const actor: LabActor = { type };
    const count = posInt(entry.count);
    if (count !== undefined) actor.count = count;
    const persona = str(entry.persona);
    if (persona) actor.persona = persona;
    const mission = str(entry.mission);
    if (mission) actor.mission = mission;
    const model = str(entry.model);
    if (model) actor.model = model;
    const laneFocus = parseLaneFocus(entry.laneFocus);
    if (laneFocus) actor.laneFocus = laneFocus;
    actors.push(actor);
  }
  return { ok: true, value: actors };
}

function parseLaneFocus(raw: unknown): LabActorLaneFocus | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const laneFocus: LabActorLaneFocus = {};
  const id = str(raw.id);
  if (id) laneFocus.id = id;
  const label = str(raw.label);
  if (label) laneFocus.label = label;
  const instruction = str(raw.instruction);
  if (instruction) laneFocus.instruction = instruction;
  return Object.keys(laneFocus).length > 0 ? laneFocus : undefined;
}

function parseExecution(raw: unknown): { ok: true; value: LabExecution | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`execution` must be an object.");
  }
  const execution: LabExecution = {};
  if (raw.target !== undefined) {
    const target = str(raw.target);
    if (target !== "local" && target !== "e2b-desktop") {
      return invalid("`execution.target` must be local or e2b-desktop.");
    }
    execution.target = target;
  }
  const timeoutMs = posInt(raw.timeoutMs);
  if (timeoutMs !== undefined) execution.timeoutMs = timeoutMs;
  const completionTimeoutMs = posInt(raw.completionTimeoutMs);
  if (completionTimeoutMs !== undefined) execution.completionTimeoutMs = completionTimeoutMs;
  const concurrency = posInt(raw.concurrency);
  if (concurrency !== undefined) execution.concurrency = concurrency;
  const desktopResult = parseDesktop(raw.desktop);
  if (!desktopResult.ok) {
    return desktopResult;
  }
  if (desktopResult.value) execution.desktop = desktopResult.value;
  return { ok: true, value: Object.keys(execution).length > 0 ? execution : undefined };
}

function parseDesktop(raw: unknown): { ok: true; value: LabExecutionDesktop | undefined } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return { ok: true, value: undefined };
  }
  const desktop: LabExecutionDesktop = {};
  if (raw.device !== undefined) {
    const device = str(raw.device);
    if (!device || !isDevicePresetName(device)) {
      return invalid(`\`execution.desktop.device\` must be one of: ${DEVICE_PRESET_NAMES.join(", ")}.`);
    }
    desktop.device = device;
  }
  if (raw.resolution !== undefined) {
    const resolution = raw.resolution;
    if (!Array.isArray(resolution) || resolution.length !== 2 || !resolution.every((value) => Number.isInteger(value) && (value as number) > 0)) {
      return invalid("`execution.desktop.resolution` must be two positive integers [width, height].");
    }
    desktop.resolution = [resolution[0] as number, resolution[1] as number];
  }
  const sandboxTimeoutMs = posInt(raw.sandboxTimeoutMs);
  if (sandboxTimeoutMs !== undefined) desktop.sandboxTimeoutMs = sandboxTimeoutMs;
  if (typeof raw.codexAppServer === "boolean") desktop.codexAppServer = raw.codexAppServer;
  return { ok: true, value: Object.keys(desktop).length > 0 ? desktop : undefined };
}

function parsePersonas(raw: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const personas = raw.filter(isRecord);
  return personas.length > 0 ? personas : undefined;
}

function parseScenario(raw: unknown): LabScenario | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const scenario: LabScenario = {};
  const ref = str(raw.ref);
  if (ref) scenario.ref = ref;
  if (isRecord(raw.inline)) scenario.inline = raw.inline;
  const mode = str(raw.mode);
  if (mode === "dry-run" || mode === "live") scenario.mode = mode;
  return Object.keys(scenario).length > 0 ? scenario : undefined;
}

function parsePolicies(raw: unknown): LabPolicies | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const policies: LabPolicies = {};
  if (typeof raw.redactRepos === "boolean") policies.redactRepos = raw.redactRepos;
  if (typeof raw.redactScreenshots === "boolean") policies.redactScreenshots = raw.redactScreenshots;
  if (typeof raw.allowPublicTargets === "boolean") policies.allowPublicTargets = raw.allowPublicTargets;
  return Object.keys(policies).length > 0 ? policies : undefined;
}

function parseReview(raw: unknown): LabReview | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const review: LabReview = {};
  const scoring = str(raw.scoring);
  if (scoring) review.scoring = scoring;
  const milestones = str(raw.milestones);
  if (milestones) review.milestones = milestones;
  const vocabulary = str(raw.vocabulary);
  if (vocabulary) review.vocabulary = vocabulary;
  return Object.keys(review).length > 0 ? review : undefined;
}

function parseDefaults(raw: unknown): LabDefaults | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const defaults: LabDefaults = {};
  if (typeof raw.open === "boolean") defaults.open = raw.open;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function invalid(message: string): LabConfigParseFailure {
  return { ok: false, error: { code: "MIMETIC_LAB_INVALID", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStr(key: string, value: unknown): Record<string, string> {
  const parsed = str(value);
  return parsed === undefined ? {} : { [key]: parsed };
}

function strList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function posInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
  }
  return undefined;
}
