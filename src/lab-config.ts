// mimetic.lab.v2 — a lab is a COMPOSITION over code primitives, not a hardcoded kind.
//
// The engine binds SUBJECT + ACTORS + EXECUTION + SCENARIO + POLICIES + REVIEW into a run.
// `actors[].type` is resolved against the actor/sim registries at dispatch time, NOT
// enumerated here — new actors extend the lab vocabulary by registering, which is the whole
// point of the refactor (see docs/architecture/actor-contract.md, MEMORY: labs-as-config).
//
// There is deliberately NO v1 compatibility: v1 had zero real users and a closed `kind` enum.
// This is the clean, versioned replacement. Breaking schema changes bump the version honestly.

export const LAB_CONFIG_SCHEMA = "mimetic.lab.v2";

const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Where the run acts: the host repo, a fresh clone, or a running app URL. */
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
  /** `app-url`: an http(s) loopback URL the persona exercises. */
  url?: string;
}

export interface LabActorLaneFocus {
  id?: string;
  label?: string;
  /** Per-lane steer appended to the actor's mission. */
  instruction?: string;
}

export interface LabActor {
  /**
   * Resolved at dispatch against the actor/sim registries (e.g. codex-app-server,
   * codex-exec, claude-agent-sdk, computer-use, browser-persona). Validated there, not here.
   */
  type: string;
  /** How many independent instances of this actor to run. */
  count?: number;
  /** Persona ref (id or path) the actor embodies/targets; inline personas via `personas`. */
  persona?: string;
  laneFocus?: LabActorLaneFocus;
  /** Free-form mission for the actor — replaces the old hardcoded per-kind mission strings. */
  mission?: string;
  /** Optional model override for this actor. */
  model?: string;
}

export type LabExecutionTarget = "local" | "e2b-desktop";

export interface LabExecutionDesktop {
  resolution?: [number, number];
  sandboxTimeoutMs?: number;
  /** Use the Codex app-server client mode for headed desktop actor surfaces. */
  codexAppServer?: boolean;
}

export interface LabExecution {
  target?: LabExecutionTarget;
  timeoutMs?: number;
  completionTimeoutMs?: number;
  /** Max concurrent lanes; defaults to the lane count. */
  concurrency?: number;
  desktop?: LabExecutionDesktop;
}

export type LabScenarioMode = "dry-run" | "live";

export interface LabScenario {
  /** Reference a committed/ignored scenario by id or path. */
  ref?: string;
  /** Or inline the scenario body (mimetic.scenario.v1 shape). */
  inline?: Record<string, unknown>;
  /** dry-run = contract evidence (no provider spend); live = real run. */
  mode?: LabScenarioMode;
}

export type LabApprovalMode = "auto-decline" | "pre-grant-allowlist" | "deny-all";

export interface LabApprovalPolicy {
  mode?: LabApprovalMode;
  /** Allowed commands when mode is pre-grant-allowlist. */
  allow?: string[];
}

export interface LabPolicies {
  /** Redact target repo labels in durable artifacts (always true for private targets). */
  redactRepos?: boolean;
  /** Named policy refs under mimetic/policies (or the ignored plane). */
  redaction?: string;
  network?: string;
  credentials?: string;
  approval?: LabApprovalPolicy;
  /** Structurally guaranteed already, but explicit + enforced in the actor mission tail. */
  noPush?: boolean;
}

export interface LabReview {
  /** Scoring strategy id, resolved against the scoring registry. */
  scoring?: string;
  milestones?: string;
  vocabulary?: string;
}

export interface LabDefaults {
  open?: boolean;
  detach?: boolean;
}

export interface LabConfig {
  schema: typeof LAB_CONFIG_SCHEMA;
  id: string;
  title?: string;
  description?: string;
  subject: LabSubject;
  actors: LabActor[];
  execution?: LabExecution;
  /** Inline personas (mimetic.persona.v1 shape), addressable by id from actors[].persona. */
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
 * validation only — actor/scenario/policy/scoring refs are resolved (and rejected) later by the
 * engine against the live registries, so adding an actor never means editing this parser.
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
    return invalid("Lab id must be a public-safe token (/^[A-Za-z0-9_.-]+$/).");
  }

  const warnings: string[] = [];

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
    ...(executionResult.value ? { execution: executionResult.value } : {}),
    ...(parsePersonas(raw.personas) ? { personas: parsePersonas(raw.personas)! } : {}),
    ...(parseScenario(raw.scenario) ? { scenario: parseScenario(raw.scenario)! } : {}),
    ...(parsePolicies(raw.policies) ? { policies: parsePolicies(raw.policies)! } : {}),
    ...(parseReview(raw.review) ? { review: parseReview(raw.review)! } : {}),
    ...(parseDefaults(raw.defaults) ? { defaults: parseDefaults(raw.defaults)! } : {})
  };

  return { ok: true, config, warnings };
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
    const url = str(raw.url);
    if (!url || !/^https?:\/\//.test(url)) {
      return invalid("`subject.url` must be an http(s) URL when source is app-url.");
    }
    subject.url = url;
  }

  return { ok: true, value: subject };
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
  const desktop = parseDesktop(raw.desktop);
  if (desktop) execution.desktop = desktop;
  return { ok: true, value: Object.keys(execution).length > 0 ? execution : undefined };
}

function parseDesktop(raw: unknown): LabExecutionDesktop | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const desktop: LabExecutionDesktop = {};
  if (Array.isArray(raw.resolution) && raw.resolution.length === 2
    && typeof raw.resolution[0] === "number" && typeof raw.resolution[1] === "number") {
    desktop.resolution = [raw.resolution[0], raw.resolution[1]];
  }
  const sandboxTimeoutMs = posInt(raw.sandboxTimeoutMs);
  if (sandboxTimeoutMs !== undefined) desktop.sandboxTimeoutMs = sandboxTimeoutMs;
  if (typeof raw.codexAppServer === "boolean") desktop.codexAppServer = raw.codexAppServer;
  return Object.keys(desktop).length > 0 ? desktop : undefined;
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
  if (typeof raw.noPush === "boolean") policies.noPush = raw.noPush;
  const redaction = str(raw.redaction);
  if (redaction) policies.redaction = redaction;
  const network = str(raw.network);
  if (network) policies.network = network;
  const credentials = str(raw.credentials);
  if (credentials) policies.credentials = credentials;
  const approval = parseApproval(raw.approval);
  if (approval) policies.approval = approval;
  return Object.keys(policies).length > 0 ? policies : undefined;
}

function parseApproval(raw: unknown): LabApprovalPolicy | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const approval: LabApprovalPolicy = {};
  const mode = str(raw.mode);
  if (mode === "auto-decline" || mode === "pre-grant-allowlist" || mode === "deny-all") {
    approval.mode = mode;
  }
  const allow = strList(raw.allow);
  if (allow) approval.allow = allow;
  return Object.keys(approval).length > 0 ? approval : undefined;
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
  if (typeof raw.detach === "boolean") defaults.detach = raw.detach;
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
