// mimetic.lab.v2 — a lab is a COMPOSITION over code primitives, not a hardcoded kind.
//
// HONEST SCOPE (read before trusting field names): the engine routes by
// subject.source × execution.target (disambiguated by the actor lane where both axes
// collide) and consumes a deliberately small set of fields:
//   subject.source/repos/appUrl/serve/env/state/clone.{depth,fanout,keep}, actors[0].count,
//   execution.target + execution.desktop.codexAppServer, scenario.mode,
//   policies.redactRepos, defaults.open.
// On the computer-use routes (app-url × e2b-desktop, and clone × e2b-desktop with a
// computer-use actor), `actors[0].type` IS load-bearing: it must resolve to a registered
// computer-use actor, and that descriptor runs the session. Those routes also consume
// actors[0].{mission,persona,laneFocus.instruction,model}, execution.timeoutMs,
// execution.desktop.{resolution,sandboxTimeoutMs}, and (clone)
// subject.{serve,env,state,clone.depth}.
// On the scripted-browser route (app-url × local-or-absent with a registered scripted-browser
// actor), `actors[0].type` is equally load-bearing, and the route consumes scenario.ref
// (REQUIRED there — the committed scenario's browser steps ARE what the actor executes),
// actors[0].{persona,count}, and execution.timeoutMs; actors[0].{mission,laneFocus,model}
// are inert on that route because no model runs, and execution.desktop.* stays forward-declared
// (device presets belong to the cua route — scripted surfaces are the driver's own
// desktop/mobile viewports where isMobile/DSF genuinely RENDER via playwright emulation).
// On the other routes those fields remain FORWARD-DECLARED and NOT yet consumed —
// parseLabConfig emits a warning listing any such field that is set, so `lab inspect` shows
// the truth.
//
// NOTE on actors[0].count: it now carries ROUTE-SPECIFIC meanings — synthetic route: simCount;
// scripted-browser route: surface roster {1 = desktop, 2 = desktop + mobile}, default 1 (the
// defaults-table single-lane row governs; count: 2 is the declared override); computer-use
// routes: must be 1 until fan-out lands. A future fan-out slice owns unifying these.
//
// There is deliberately NO v1 compatibility: v1 had zero real users. Breaking schema changes
// bump the version honestly.

import { actorRegistry } from "./actor-registry.js";
import { DEVICE_PRESET_NAMES, isDevicePresetName } from "./device-presets.js";

export const LAB_CONFIG_SCHEMA = "mimetic.lab.v2";

// Must start alphanumeric so an id never collides with the path-vs-id resolver heuristic
// (a leading "." or "/" is read as a file path; a leading "-" collides with CLI flags).
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Where the run acts: the host repo, a fresh clone, a running app a browser actor drives
 * (`app-url`), or an already-running LOCAL dev server driven IN-PROCESS via a custom
 * CuaExecutor with NO clone and NO E2B desktop (`local-app`). `local-app` routes to the cua
 * backend and is library-assisted: a caller supplies `cuaHooks.buildExecutor` + `buildProvider`
 * (no built-in driver exists yet), and the engine fails closed
 * (MIMETIC_CUA_LAB_LOCAL_APP_NO_EXECUTOR) when run without them — a structured error, never a
 * desktop attempt. See docs/architecture/state-driven-executor.md.
 */
export type LabSubjectSource = "this-repo" | "clone" | "app-url" | "local-app";

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

/** When a state step runs, relative to the serve sequence (clone subjects, computer-use route). */
export type LabStateStepWhen = "before-build" | "before-start" | "after-ready";

export interface LabSubjectStateStep {
  /**
   * [a-z0-9-] step label (must start alphanumeric), <=40 chars, unique across steps; becomes
   * the detached-step name `subject-state-<name>` (interpolates into in-sandbox file paths —
   * the shape is load-bearing, validated at parse AND re-enforced in the engine).
   */
  name: string;
  /**
   * Author-trusted shell command (same trust class as serve.install/build/start — the
   * "serve commands are author-trusted" corollary). Runs detached in the subject directory
   * with an atomic status file, kill-on-timeout, and a capped log tail. Persisted in
   * evidence as a sha256-16 DIGEST only, never as text.
   */
  command: string;
  /**
   * Phase: before-build (after install — for builds that read the DB, e.g. SSG),
   * before-start (after build, before the server launches — migrations, SQL/file fixtures,
   * an in-sandbox `service postgresql start`), after-ready (after the readiness probe —
   * fixtures loaded through the RUNNING app's API). Default: before-start.
   */
  when?: LabStateStepWhen;
  /** Wall-clock budget per step. Default 300000. */
  timeoutMs?: number;
}

/** The subject's STATE story (clone subjects): seeded in-sandbox, or declared external. */
export interface LabSubjectState {
  /** Ordered seed/migration/fixture steps. Order within a phase is declaration order. */
  seed?: LabSubjectStateStep[];
  /**
   * Env var NAMES whose values point at state the lab does NOT control (e.g. a shared dev
   * DB). Must be a subset of subject.env (so the declaration is mechanically backed by a
   * provisioned name, not a vibe). Flips state provenance to "unpinned".
   */
  external?: string[];
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
   *
   * `local-app`: the loopback http(s) URL of an already-running LOCAL dev server the caller's
   * custom CuaExecutor drives in-process (no sandbox, no public-target option — always
   * loopback). Passed to `buildExecutor` so the bridge knows where the app lives.
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
  /**
   * `clone` (computer-use route): the subject's state story — seed/migration/fixture steps
   * executed in-sandbox around the serve sequence, and/or declared external state. Recorded
   * in the run bundle as structured provenance (invariant 5): seeded with command digests,
   * UNPINNED for external state, declared-not-run for dry-run/failed provisioning.
   */
  state?: LabSubjectState;
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
   * registered computer-use actor (e.g. openai-computer-use, paired with e2b-desktop) or a
   * registered scripted-browser actor (e.g. scripted-browser, local execution), and that
   * descriptor runs the session. On other routes it remains a free-form label (built-ins use
   * descriptive labels like synthetic-persona, mimetic-setup, codex-app-server).
   */
  type: string;
  /** Lane count — route-specific (see HONEST SCOPE header): synthetic simCount; scripted
   *  surface roster {1 = desktop, 2 = desktop + mobile, default 1}; computer-use must be 1. */
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
  /** Reference a committed scenario by id (mimetic/scenarios/<ref>.yaml) or path. CONSUMED
   *  (and REQUIRED) on the scripted-browser route; FORWARD-DECLARED elsewhere. */
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
      return invalid("`execution.target` applies only to clone/app-url/local-app subjects; this-repo labs run locally.");
    }
    if (config.scenario?.mode === "live") {
      return invalid("this-repo labs are dry-run only; use a clone or app-url subject for a live run.");
    }
  }

  // local-app route: an already-running LOCAL dev server driven IN-PROCESS via a custom
  // CuaExecutor (no clone, no E2B desktop). Parse-validated fail-closed: a computer-use actor
  // only, execution.target local or absent (NEVER e2b-desktop — the whole point is to skip the
  // desktop), and no public-target policy (it is always loopback; the loopback shape was already
  // enforced in parseSubject). The actual "no buildExecutor hook supplied" case is inherently an
  // engine-time decision (the parser cannot know whether a library caller will pass hooks), so
  // it fails closed in runCuaActorLab with MIMETIC_CUA_LAB_LOCAL_APP_NO_EXECUTOR.
  if (config.subject.source === "local-app") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "local") {
      return invalid("local-app subjects drive an in-process LOCAL dev server with NO E2B desktop — set `execution.target: local` or omit it (absent means local); `e2b-desktop` is rejected (use an app-url subject for the hosted-desktop route).");
    }
    if (!actorResolvesToComputerUse(type)) {
      return invalid(`actors[0].type must be a registered computer-use actor for local-app subjects (one of: ${registeredComputerUseActors().join(", ")}); the caller's custom executor runs the computer-use loop. Got "${type}".`);
    }
    if ((config.actors[0]?.count ?? 1) > 1) {
      return invalid("Multi-lane computer-use fan-out is not supported yet; set actors[0].count to 1.");
    }
    if (config.policies?.allowPublicTargets === true) {
      return invalid("`policies.allowPublicTargets` is not supported on the local-app route — a local-app subject is always a loopback dev server; there is no public target to allow.");
    }
  }

  // app-url routes: the actor type is a REAL dispatch key (registry-resolved). The actor LANE
  // picks the substrate: a scripted-browser actor runs locally against the declared loopback
  // app; a computer-use actor drives a hosted desktop browser. Fail closed on mis-configs.
  if (config.subject.source === "app-url") {
    const type = config.actors[0]?.type ?? "";
    if (actorResolvesToScriptedBrowser(type)) {
      // Scripted-browser route (all fail-closed: invariant 6 — a field that cannot act on
      // this route is rejected, never silently ignored).
      if (config.execution?.target !== undefined && config.execution.target !== "local") {
        return invalid("scripted-browser actors run on the operator's machine — set `execution.target: local` or omit it (absent means local); in-sandbox scripted execution is a later slice.");
      }
      if (!config.scenario?.ref) {
        return invalid("scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes; there is no built-in fallback on the lab route.");
      }
      if ((config.actors[0]?.count ?? 1) > 2) {
        return invalid("scripted-browser labs support actors[0].count of 1 (desktop surface) or 2 (desktop + mobile); larger fan-out is a later slice.");
      }
      if (config.policies?.redactScreenshots === true) {
        return invalid("`policies.redactScreenshots: true` is not implemented on the scripted-browser route yet — screenshots persist raw in gitignored .mimetic; a silently ignored redaction policy would be a safety lie, so it is rejected.");
      }
      if (config.policies?.allowPublicTargets === true) {
        return invalid("`policies.allowPublicTargets` is not supported on the scripted-browser route — the scripted step driver enforces loopback at every navigation; public targets on this route are a later slice.");
      }
      if (!isLoopbackUrl(config.subject.appUrl ?? "")) {
        return invalid("`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) on the scripted-browser route.");
      }
    } else {
      if (config.execution?.target !== "e2b-desktop") {
        return invalid("app-url subjects require `execution.target: e2b-desktop` with a registered computer-use actor (the actor drives a hosted desktop browser), or a registered scripted-browser actor for local execution.");
      }
      if (!actorResolvesToComputerUse(type)) {
        return invalid(`actors[0].type must be a registered computer-use actor for app-url × e2b-desktop labs (one of: ${registeredComputerUseActors().join(", ")}); for local scripted execution use a registered scripted-browser actor (${registeredScriptedBrowserActors().join(", ")}). Got "${type}".`);
      }
      if ((config.actors[0]?.count ?? 1) > 1) {
        return invalid("Multi-lane computer-use fan-out is not supported yet; set actors[0].count to 1.");
      }
      // Loopback by default; an owner may declare a public/preview target via policies.
      if (!config.policies?.allowPublicTargets && !isLoopbackUrl(config.subject.appUrl ?? "")) {
        return invalid("`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) unless `policies.allowPublicTargets: true` is set — set it to drive a deployed/preview URL you own.");
      }
    }
  } else if (actorResolvesToScriptedBrowser(config.actors[0]?.type)) {
    // clone/this-repo × scripted actor: rejected, never ignored (the scripted driver only
    // drives a caller-declared running app).
    return invalid("scripted-browser actors require `subject.source: app-url` (a running app at a loopback URL); clone/this-repo subjects are not supported on this route.");
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

function actorResolvesToScriptedBrowser(type: string | undefined): boolean {
  if (!type) return false;
  const descriptor = (actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>)[type];
  return Boolean(descriptor?.capabilities.lanes.includes("scripted-browser"));
}

function registeredScriptedBrowserActors(): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => entry.capabilities.lanes.includes("scripted-browser"))
    .map((entry) => entry.id);
}

/**
 * True when this config routes to the computer-use backend: an app-url subject whose first
 * actor resolves to a registered computer-use actor, or a clone subject on a hosted desktop
 * whose first actor does. Single source of truth — selectLabBackend and the warning logic
 * both use it. (The app-url branch used to be unconditionally true; it narrowed when the
 * scripted-browser lane arrived. Behavior-preserving for every parse-valid config —
 * selectLabBackend keeps a bare app-url fallback to the cua backend so library-API configs
 * with unknown actors still hit its fail-closed ACTOR_UNSUPPORTED.)
 */
export function routesToComputerUse(config: LabConfig): boolean {
  // local-app drives the cua loop in-process (a custom executor + a non-vision provider), so it
  // routes to the cua backend exactly like an app-url subject with a computer-use actor.
  if (config.subject.source === "app-url" || config.subject.source === "local-app") {
    return actorResolvesToComputerUse(config.actors[0]?.type);
  }
  return config.subject.source === "clone"
    && config.execution?.target === "e2b-desktop"
    && actorResolvesToComputerUse(config.actors[0]?.type);
}

/**
 * True when this config routes to the scripted-browser backend: an app-url subject whose
 * first actor resolves to a registered scripted-browser actor (execution.target local or
 * absent — the parse layer enforces that pairing). Mirror of routesToComputerUse; the single
 * source of truth for selectLabBackend and the warning logic.
 */
export function routesToScriptedBrowser(config: LabConfig): boolean {
  return config.subject.source === "app-url"
    && actorResolvesToScriptedBrowser(config.actors[0]?.type);
}

// Report fields that are present but not yet consumed by the engine, so a user never trusts a
// setting that silently does nothing. Keeps the schema forward-correct AND honest.
function forwardDeclaredWarnings(config: LabConfig): string[] {
  const inert: string[] = [];
  // The computer-use routes consume the actor prompt fields, execution.timeoutMs,
  // execution.desktop.{resolution,sandboxTimeoutMs}, and (clone) subject.{serve,env,state,
  // clone.depth}; the scripted-browser route consumes scenario.ref, actors[0].{persona,count},
  // and execution.timeoutMs (mission/laneFocus/model are inert there: this actor runs no
  // model); on every other route those fields are inert.
  const routesToCua = routesToComputerUse(config);
  const routesToScripted = routesToScriptedBrowser(config);
  for (const [index, actor] of config.actors.entries()) {
    if (routesToCua) {
      // The cua route consumes laneFocus.instruction ONLY; id/label remain inert there.
      if (actor.laneFocus?.id) inert.push(`actors[${index}].laneFocus.id`);
      if (actor.laneFocus?.label) inert.push(`actors[${index}].laneFocus.label`);
    } else if (routesToScripted) {
      // persona and count are consumed (trace/bundle provenance; surface roster). The prompt
      // fields can never act here — the scripted actor runs no model.
      if (actor.mission) inert.push(`actors[${index}].mission (the scripted-browser actor runs no model)`);
      if (actor.laneFocus) inert.push(`actors[${index}].laneFocus (the scripted-browser actor runs no model)`);
      if (actor.model) inert.push(`actors[${index}].model (the scripted-browser actor runs no model)`);
    } else {
      if (actor.mission) inert.push(`actors[${index}].mission`);
      if (actor.laneFocus) inert.push(`actors[${index}].laneFocus`);
      if (actor.persona) inert.push(`actors[${index}].persona`);
      if (actor.model) inert.push(`actors[${index}].model`);
    }
  }
  if (config.subject.clone?.depth !== undefined && !routesToCua) inert.push("subject.clone.depth");
  if (config.subject.serve && !routesToCua) inert.push("subject.serve");
  if (config.subject.env && !routesToCua) inert.push("subject.env");
  if (config.subject.state && !routesToCua) inert.push("subject.state");
  if (routesToCua) {
    // clone.keep IS consumed on the cua route (honored on FAILURE: the sandbox is left up to
    // debug a failed install/boot; otherwise always killed). clone.fanout is still inert here —
    // the cua route is single-lane until fan-out lands.
    if (config.subject.clone?.fanout !== undefined) inert.push("subject.clone.fanout");
  }
  if (!routesToCua && !routesToScripted && config.execution?.timeoutMs !== undefined) inert.push("execution.timeoutMs");
  if (config.execution?.completionTimeoutMs !== undefined) inert.push("execution.completionTimeoutMs");
  if (config.execution?.concurrency !== undefined) inert.push("execution.concurrency");
  // execution.desktop.* stays inert on the scripted route by design: device presets belong to
  // the cua desktop; scripted surfaces are the driver's fixed desktop/mobile viewports, where
  // isMobile/DSF genuinely render via playwright emulation.
  if (!routesToCua && config.execution?.desktop?.resolution) inert.push("execution.desktop.resolution");
  if (!routesToCua && config.execution?.desktop?.device !== undefined) inert.push("execution.desktop.device");
  if (!routesToCua && config.execution?.desktop?.sandboxTimeoutMs !== undefined) inert.push("execution.desktop.sandboxTimeoutMs");
  // codexAppServer is consumed only on the e2b-desktop (meta) route; flag it when it cannot reach there.
  const routesToDesktop = config.subject.source === "clone" && config.execution?.target === "e2b-desktop";
  if (config.execution?.desktop?.codexAppServer !== undefined && !routesToDesktop) {
    inert.push("execution.desktop.codexAppServer (needs subject.source: clone + execution.target: e2b-desktop)");
  }
  // scenario.ref is CONSUMED on the scripted-browser route (required there); forward-declared
  // everywhere else.
  if (config.scenario?.ref && !routesToScripted) inert.push("scenario.ref");
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
  if (source !== "this-repo" && source !== "clone" && source !== "app-url" && source !== "local-app") {
    return invalid("`subject.source` must be one of: this-repo, clone, app-url, local-app.");
  }
  const subject: LabSubject = { source };

  if (source !== "clone" && raw.serve !== undefined) {
    return invalid("`subject.serve` applies only to clone subjects (the lab serves the cloned app in-sandbox).");
  }
  if (source !== "clone" && raw.env !== undefined) {
    return invalid("`subject.env` applies only to clone subjects (the served app's environment channel).");
  }
  if (source !== "clone" && raw.state !== undefined) {
    return invalid("`subject.state` applies only to clone subjects (the lab seeds the state it serves).");
  }
  // repos/clone are clone-only too (a fresh-clone subject's git inputs). Rejected, never
  // silently dropped, on app-url/local-app/this-repo subjects (invariant 6: a field that cannot
  // act on this route is an honest parse error).
  if (source !== "clone" && raw.repos !== undefined) {
    return invalid("`subject.repos` applies only to clone subjects (the owner/repo slugs to clone).");
  }
  if (source !== "clone" && raw.clone !== undefined) {
    return invalid("`subject.clone` applies only to clone subjects (clone depth/fanout/keep).");
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
    const stateResult = parseState(raw.state);
    if (!stateResult.ok) {
      return stateResult;
    }
    if (stateResult.value) {
      // Semantic validation is shared with the engine (runCuaActorLab re-enforces it for
      // configs that arrive through the library API without the parser).
      const reason = subjectStateInvalidReason(stateResult.value, subject.env);
      if (reason) {
        return invalid(reason);
      }
      subject.state = stateResult.value;
    }
  }

  if (source === "app-url" || source === "local-app") {
    const appUrl = str(raw.appUrl);
    if (!appUrl) {
      return invalid(`\`subject.appUrl\` is required when source is ${source}.`);
    }
    // app-url: shape-only here; the loopback-vs-public-target gate is applied in the
    // cross-validation block below, where policies.allowPublicTargets is available.
    // local-app: an in-process local dev server — ALWAYS loopback (no public-target option),
    // so the loopback wall is enforced right here at parse.
    if (source === "local-app") {
      if (!isLoopbackUrl(appUrl)) {
        return invalid("`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) on a local-app subject — it drives an already-running LOCAL dev server in-process; public targets are not supported on this route.");
      }
    } else if (!isHttpUrl(appUrl)) {
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

/**
 * Structural parse of `subject.state` into a candidate LabSubjectState. Deliberately keeps
 * unrecognized `when`/`timeoutMs` values in the candidate (instead of silently dropping
 * them) so subjectStateInvalidReason rejects them — a state declaration that silently does
 * less than it says would violate invariant 6.
 */
function parseState(raw: unknown): { ok: true; value: LabSubjectState | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`subject.state` must be an object ({ seed?, external? }).");
  }
  const state: LabSubjectState = {};
  if (raw.seed !== undefined) {
    if (!Array.isArray(raw.seed) || !raw.seed.every(isRecord)) {
      return invalid("`subject.state.seed` must be an array of step objects ({ name, command, when?, timeoutMs? }).");
    }
    state.seed = raw.seed.map((entry) => ({
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      command: typeof entry.command === "string" ? entry.command.trim() : "",
      ...(entry.when === undefined ? {} : { when: entry.when as LabStateStepWhen }),
      ...(entry.timeoutMs === undefined ? {} : { timeoutMs: (posInt(entry.timeoutMs) ?? entry.timeoutMs) as number })
    }));
  }
  if (raw.external !== undefined) {
    const external = strList(raw.external);
    if (!external) {
      return invalid("`subject.state.external` must be a non-empty list of env var NAMES when set.");
    }
    state.external = external;
  }
  return { ok: true, value: state };
}

// The step name interpolates into in-sandbox script/status/log paths (`subject-state-<name>`);
// the strict shape is load-bearing, exactly like the repo slug.
const STATE_STEP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const STATE_STEP_NAME_MAX_CHARS = 40;
const STATE_STEP_WHENS: readonly LabStateStepWhen[] = ["before-build", "before-start", "after-ready"];

/**
 * Semantic validation for `subject.state`, shared by parseLabConfig and the engine
 * (runCuaActorLab re-enforces it on configs that arrive through the library API). Returns
 * the failure message, or null when the declaration is valid. Reads the candidate
 * defensively — library callers can hand the engine arbitrarily-shaped objects.
 */
export function subjectStateInvalidReason(state: LabSubjectState, env: readonly string[] | undefined): string | null {
  const seed = state.seed;
  const external = state.external;
  if ((seed === undefined || seed.length === 0) && (external === undefined || external.length === 0)) {
    return "`subject.state` must declare seed steps and/or external env names (an empty state block would be inert).";
  }
  if (seed !== undefined) {
    if (!Array.isArray(seed) || seed.length === 0) {
      return "`subject.state.seed` must be a non-empty array of steps when set.";
    }
    const names = new Set<string>();
    for (const [index, step] of seed.entries()) {
      const name = typeof step?.name === "string" ? step.name : "";
      if (!STATE_STEP_NAME_PATTERN.test(name) || name.length > STATE_STEP_NAME_MAX_CHARS) {
        return `subject.state.seed[${index}].name must match ${STATE_STEP_NAME_PATTERN} and be at most ${STATE_STEP_NAME_MAX_CHARS} chars (it names in-sandbox file paths); got "${name}".`;
      }
      if (names.has(name)) {
        return `subject.state.seed step names must be unique (duplicate "${name}").`;
      }
      names.add(name);
      if (typeof step.command !== "string" || step.command.trim().length === 0) {
        return `subject.state.seed[${index}].command is required (the in-sandbox shell command that seeds the state).`;
      }
      if (step.when !== undefined && !STATE_STEP_WHENS.includes(step.when)) {
        return `subject.state.seed[${index}].when must be one of: ${STATE_STEP_WHENS.join(", ")}.`;
      }
      if (step.timeoutMs !== undefined && !(typeof step.timeoutMs === "number" && Number.isSafeInteger(step.timeoutMs) && step.timeoutMs >= 1)) {
        return `subject.state.seed[${index}].timeoutMs must be a positive integer.`;
      }
    }
  }
  if (external !== undefined) {
    if (!Array.isArray(external) || external.length === 0) {
      return "`subject.state.external` must be a non-empty list of env var NAMES when set.";
    }
    for (const name of external) {
      if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
        return "subject.state.external entries must be env var NAMES like DATABASE_URL; values come from the caller's environment and are never persisted.";
      }
      if (!env?.includes(name)) {
        return "subject.state.external names must also be declared in subject.env (the declaration must name a provisioned channel).";
      }
    }
  }
  return null;
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
