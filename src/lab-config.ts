// mimetic.lab.v2 — a lab is a COMPOSITION over code primitives, not a hardcoded kind.
//
// HONEST SCOPE (read before trusting field names): the engine today routes by
// subject.source × execution.target and consumes a deliberately small set of fields:
//   subject.source/repos/clone.{fanout,keep}, actors[0].count, execution.target +
//   execution.desktop.codexAppServer, scenario.mode, policies.redactRepos, defaults.open.
// Everything else (actors[].{type,mission,laneFocus,persona,model}, multi-actor fan-out,
// execution timeouts/concurrency/resolution, scenario.ref/inline, review.*, personas[]) is
// FORWARD-DECLARED for the next slice and NOT yet consumed — parseLabConfig emits a warning
// listing any such field that is set, so `lab inspect` shows the truth. `actors[].type` is a
// free-form label today; it is NOT resolved/validated against the actor registry yet.
//
// There is deliberately NO v1 compatibility: v1 had zero real users. Breaking schema changes
// bump the version honestly.

export const LAB_CONFIG_SCHEMA = "mimetic.lab.v2";

// Must start alphanumeric so an id never collides with the path-vs-id resolver heuristic
// (a leading "." or "/" is read as a file path; a leading "-" collides with CLI flags).
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Where the run acts: the host repo, a fresh clone, or a running app at a loopback URL. */
export type LabSubjectSource = "this-repo" | "clone" | "app-url";

export interface LabSubjectClone {
  /** git clone depth; 1 (shallow) by default. */
  depth?: number;
  /** how many independent clone lanes to fan out (one sandbox/desktop each). */
  fanout?: number;
  /** keep the disposable clone for debugging instead of discarding. */
  keep?: boolean;
}

export interface LabSubject {
  source: LabSubjectSource;
  /** `clone`: one or more owner/repo slugs (public or authorized-private). */
  repos?: string[];
  clone?: LabSubjectClone;
  /** `app-url`: a loopback http(s) URL a computer-use actor drives (127.0.0.1/localhost only). */
  appUrl?: string;
}

export interface LabActorLaneFocus {
  id?: string;
  label?: string;
  /** Per-lane steer appended to the actor's mission. FORWARD-DECLARED (PR #2). */
  instruction?: string;
}

export interface LabActor {
  /**
   * A free-form actor label. NOT yet resolved/validated against the actor registry — routing
   * ignores it today (it lands as a dispatch key in the next slice). Built-ins use descriptive
   * labels (e.g. synthetic-persona, mimetic-setup, codex-app-server).
   */
  type: string;
  /** Lane count. Consumed today only for the synthetic backend (actors[0].count → simCount). */
  count?: number;
  /** FORWARD-DECLARED (PR #2). */
  persona?: string;
  /** FORWARD-DECLARED (PR #2). */
  laneFocus?: LabActorLaneFocus;
  /** Free-form mission. FORWARD-DECLARED (PR #2) — not yet threaded into the actor prompt. */
  mission?: string;
  /** FORWARD-DECLARED (PR #2). */
  model?: string;
}

export type LabExecutionTarget = "local" | "e2b-desktop";

export interface LabExecutionDesktop {
  /** FORWARD-DECLARED (PR #2) — the desktop resolution is fixed today. */
  resolution?: [number, number];
  /** FORWARD-DECLARED (PR #2). */
  sandboxTimeoutMs?: number;
  /** Use the Codex app-server client mode for headed desktop actor surfaces. Consumed (meta). */
  codexAppServer?: boolean;
}

export interface LabExecution {
  target?: LabExecutionTarget;
  /** FORWARD-DECLARED (PR #2). */
  timeoutMs?: number;
  /** FORWARD-DECLARED (PR #2). */
  completionTimeoutMs?: number;
  /** FORWARD-DECLARED (PR #2). */
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
  /** Redact target repo labels in durable artifacts (always true for private targets). Consumed. */
  redactRepos?: boolean;
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
      return invalid("`execution.target` applies only to clone subjects; this-repo labs run locally.");
    }
    if (config.scenario?.mode === "live") {
      return invalid("this-repo labs are dry-run only; use a clone subject for a live run.");
    }
  }

  return { ok: true, config, warnings: forwardDeclaredWarnings(config) };
}

// Report fields that are present but not yet consumed by the engine, so a user never trusts a
// setting that silently does nothing. Keeps the schema forward-correct AND honest.
function forwardDeclaredWarnings(config: LabConfig): string[] {
  const inert: string[] = [];
  for (const [index, actor] of config.actors.entries()) {
    if (actor.mission) inert.push(`actors[${index}].mission`);
    if (actor.laneFocus) inert.push(`actors[${index}].laneFocus`);
    if (actor.persona) inert.push(`actors[${index}].persona`);
    if (actor.model) inert.push(`actors[${index}].model`);
  }
  if (config.subject.clone?.depth !== undefined) inert.push("subject.clone.depth");
  if (config.execution?.timeoutMs !== undefined) inert.push("execution.timeoutMs");
  if (config.execution?.completionTimeoutMs !== undefined) inert.push("execution.completionTimeoutMs");
  if (config.execution?.concurrency !== undefined) inert.push("execution.concurrency");
  if (config.execution?.desktop?.resolution) inert.push("execution.desktop.resolution");
  if (config.execution?.desktop?.sandboxTimeoutMs !== undefined) inert.push("execution.desktop.sandboxTimeoutMs");
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
  }

  if (source === "app-url") {
    const appUrl = str(raw.appUrl);
    if (!appUrl) {
      return invalid("`subject.appUrl` is required when source is app-url.");
    }
    if (!isLoopbackUrl(appUrl)) {
      return invalid("`subject.appUrl` must be a loopback http(s) URL (127.0.0.1 or localhost) — public targets are not allowed.");
    }
    subject.appUrl = appUrl;
  }

  return { ok: true, value: subject };
}

// Public-safety: a lab may only drive a local app, never a public site. Loopback hosts only.
function isLoopbackUrl(value: string): boolean {
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
