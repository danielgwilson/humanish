// humanish.lab.v2 — a lab is a COMPOSITION over code primitives, not a hardcoded kind.
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
// execution.desktop.{browser,resolution,sandboxTimeoutMs}, and (clone)
// subject.{serve,env,state,clone.depth}.
// On the scripted-browser route (app-url × local-or-absent, or clone × e2b-desktop, with a
// registered scripted-browser actor), `actors[0].type` is equally load-bearing, and the route
// consumes scenario.ref (REQUIRED there — the committed scenario's browser steps ARE what the
// actor executes), actors[0].{persona,count}, and execution.timeoutMs. On the provisioned
// clone slice it also consumes subject.{repos,serve,env,state,exposure,clone.depth} and
// execution.desktop.template. actors[0].{mission,laneFocus,model} are inert on that route
// because no model runs, and most execution.desktop.* fields remain forward-declared (device
// presets belong to the cua route — scripted surfaces are the driver's own desktop/mobile
// viewports where isMobile/DSF genuinely RENDER via playwright emulation).
// On the other routes those fields remain FORWARD-DECLARED and NOT yet consumed —
// parseLabConfig emits a warning listing any such field that is set, so `lab inspect` shows
// the truth.
//
// NOTE on actors[0].count: it now carries ROUTE-SPECIFIC meanings — synthetic route: simCount;
// scripted-browser route: surface roster {1 = desktop, 2 = desktop + mobile}, default 1 (the
// defaults-table single-lane row governs; count: 2 is the declared override); computer-use
// E2B route: the HOMOGENEOUS fan-out lane count (N identical lanes, each its own E2B desktop),
// capped at 16; the in-process/local-app cua route stays single lane (no E2B to fan out).
//
// NOTE on actors[0].lanes / actors[0].roster (computer-use E2B route, this slice): a
// DIFFERENTIATED fan-out roster — each `{ id?, persona?, device?, instruction?, target? }` becomes one
// independent E2B desktop (per-lane worlds, the default topology). `roster[]` is parser sugar for
// repeated groups and is normalized into `lanes[]` before the engine sees it. `lanes|roster` XOR
// `count` (declare a differentiated roster OR a homogeneous count, never both); `lanes|roster`
// XOR `actors[0].laneFocus` (per-lane `instruction` is the roster's steer); `lanes[].device` XOR
// raw `execution.desktop.resolution`. `execution.concurrency` bounds in-flight lanes (default
// min(laneCount, 3); env HUMANISH_CUA_MAX_CONCURRENCY may only LOWER it — invariant 3). On every
// non-cua route normalized `lanes` are inert (warned). subject.clone.fanout is REJECTED on the cua
// route. `lanes[].target` is app-url × computer-use ONLY: an absolute browser URL this lane opens
// instead of `subject.appUrl`; it is the generic setup-produced-target handoff, not a service
// topology primitive.
//
// There is deliberately NO v1 compatibility: v1 had zero real users. Breaking schema changes
// bump the version honestly.

import { normalizeExtraExcludeEntry } from "./source-archive.js";
import { actorRegistry } from "./actor-registry.js";
import { DEVICE_PRESET_NAMES, isDevicePresetName } from "./device-presets.js";
import type { StopConditionPrimitive, StopWhen, StopWhenRule } from "./stop-conditions.js";

export const LAB_CONFIG_SCHEMA = "humanish.lab.v2";

// Must start alphanumeric so an id never collides with the path-vs-id resolver heuristic
// (a leading "." or "/" is read as a file path; a leading "-" collides with CLI flags).
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Where the run acts: the host repo, a fresh clone, a running app a browser actor drives
 * (`app-url`), an already-running LOCAL dev server driven IN-PROCESS via a custom
 * CuaExecutor with NO clone and NO E2B desktop (`local-app`), or the operator's own local
 * working tree packed and provisioned in-sandbox in place of a clone (`local-tree`).
 * `local-app` routes to the cua backend and is library-assisted: a caller supplies
 * `cuaHooks.buildExecutor` + `buildProvider` (no built-in driver exists yet), and the engine
 * fails closed (HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR) when run without them: a structured
 * error, never a desktop attempt. See docs/architecture/state-driven-executor.md.
 */
export type LabSubjectSource = "this-repo" | "clone" | "app-url" | "local-app" | "terminal-product" | "local-tree";

/**
 * How a subject's WORLD relates across actor lanes. `per-lane-worlds` (the default; absent ==
 * this) is the only fan-out topology the computer-use route ships — N lanes, N independent
 * worlds, isolation + per-lane attribution. `shared-world` (#164) is the DECLARED override: ONE
 * provisioned, mutable service plane that N role SEATS take turns against IN DECLARED ORDER, so
 * their actions interact through shared state. Consumed ONLY on the shared-world route (clone ×
 * e2b-desktop × a computer-use actor); inert/warned everywhere else (invariant 6).
 */
export type LabSubjectTopology = "per-lane-worlds" | "shared-world";

export interface LabSubjectClone {
  /** git clone depth; 1 (shallow) by default. Consumed on the computer-use clone route. */
  depth?: number;
  /** how many independent clone lanes to fan out (one sandbox/desktop each). */
  fanout?: number;
  /** keep the disposable clone for debugging instead of discarding. */
  keep?: boolean;
}

/**
 * `local-tree`: how the operator's own working tree is packed and provisioned in-sandbox in
 * place of a clone. Internal shape (not re-exported from src/index.ts, same as LabSubjectClone).
 */
export interface LabSubjectLocalTree {
  /** extra archive excludes (path prefixes/basenames) added on top of the always-on denylist. */
  exclude?: string[];
  /** keep the disposable sandbox on failure for debugging (mirrors subject.clone.keep). */
  keep?: boolean;
  /** upload size cap override in bytes; default 256 MiB. */
  maxArchiveBytes?: number;
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

/**
 * A shared-world state CHECKPOINT: an author-trusted, READ-ONLY, AGGREGATE/DIGEST probe command
 * (counts, max-timestamps, hashes) run at baseline and after each role's turn. Reuses the
 * seed-step validation shape (name [a-z0-9-] ≤40, unique; command required). Persisted DIGEST-ONLY
 * (only sha256-16(scrub+redact(stdout)) ever lands — never the raw value), same lockdown as the
 * seed surface. Consumed ONLY on the shared-world route (#164); inert/warned elsewhere.
 */
export interface LabSubjectStateCheckpoint {
  /**
   * [a-z0-9-] probe label (must start alphanumeric), <=40 chars, unique across checkpoints;
   * names the detached step (`checkpoint-<snapshot>-<name>`) — load-bearing shape, validated at
   * parse AND re-enforced in the engine.
   */
  name: string;
  /**
   * Author-trusted READ-ONLY shell command (same trust class as serve/seed — the "serve commands
   * are author-trusted" corollary). Its stdout is scrubbed + pattern-redacted, then digested
   * (sha256-16); the raw value never persists.
   */
  command: string;
  /**
   * Optional extra literal values to scrub from this probe's stdout before digesting (author-known
   * values that may appear in the probe output, beyond the harness-provisioned env values which are
   * always scrubbed). Names/values are NEVER persisted — only the digest is.
   */
  redact?: string[];
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
  /**
   * Shared-world state checkpoints (#164): read-only digest probes run at baseline + after each
   * role's turn to produce the harness-clocked interaction timeline. Consumed ONLY on the
   * shared-world route; inert/warned elsewhere (invariant 6). Shape-validated everywhere.
   */
  checkpoint?: LabSubjectStateCheckpoint[];
}

/**
 * `terminal-product`: the product-under-study a terminal agent must discover and use from PUBLIC
 * SURFACES ONLY (the terminal-product route's subject). The subject is NOT provisioned/cloned —
 * the agent drives the declared public surfaces, so provenance is UNPINNED (invariant 5). The
 * concrete product name + surfaces are operator data; committed fixtures use a NEUTRAL mock name.
 */
export interface LabSubjectProduct {
  /** Public-safe product label (shape-validated like a lab id; interpolates into evidence). */
  name: string;
  /**
   * The product's PUBLIC surfaces — the only world the agent sees. Each must be an http(s) URL
   * (e.g. a docs page, an llms.txt, a skill manifest). Validated at parse; recorded in evidence.
   */
  publicSurfaces: string[];
}

export interface LabSubject {
  source: LabSubjectSource;
  /**
   * WORLD topology across actor lanes. Absent == `per-lane-worlds` (the isolation default; every
   * existing lab is byte-stable). `shared-world` is the declared override (#164): one mutable
   * service plane, N role seats taking turns. Consumed ONLY on the shared-world route (clone ×
   * e2b-desktop × a computer-use actor + a roster of ≥2 lanes); inert/warned elsewhere.
   */
  topology?: LabSubjectTopology;
  /**
   * CONCURRENT shared-world route ONLY (#164 phase 2): the author's REQUIRED attestation that the
   * subject behind the internet-reachable `getHost` URL is SYNTHETIC seeded data. The concurrent
   * route exposes the subject on a tokenless public URL for the run's duration, so real/external
   * data must never sit behind it. This is author-trust + a provenance gate (verify also requires
   * `subject.state.provenance == "seeded"`), NOT a no-real-data guarantee. Required when
   * `topology: shared-world` + `execution.concurrency > 1`; inert/warned elsewhere.
   */
  exposure?: "synthetic";
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
  /**
   * `terminal-product` (terminal route): the product the terminal agent discovers + uses from
   * PUBLIC surfaces only. Consumed on the terminal route; rejected on every other source.
   */
  product?: LabSubjectProduct;
  /**
   * `local-tree` (computer-use route): local-tree packs the lab resolution cwd (the project
   * directory humanish runs from) instead of cloning a repo. `exclude` adds extra archive excludes
   * on top of the always-on denylist; `keep` preserves the sandbox on failure for debugging;
   * `maxArchiveBytes` caps the upload. Consumed on the local-tree route; rejected on every other
   * source.
   */
  localTree?: LabSubjectLocalTree;
}

export interface LabActorLaneFocus {
  id?: string;
  label?: string;
  /** Per-lane steer appended to the actor's mission. Consumed on the app-url route. */
  instruction?: string;
}

/**
 * One differentiated fan-out lane on the computer-use E2B route (per-lane worlds). Each lane
 * becomes an independent E2B desktop sandbox with its own persona/device/starting-steer. All
 * fields optional: an omitted persona/device/instruction inherits the actor-level default. `id`
 * defaults to `lane-01`..`lane-NN` and must be a public-safe token (it names per-lane evidence
 * paths). Consumed ONLY on the computer-use E2B route (inert/warned elsewhere).
 */
export interface LabActorLane {
  /** Public-safe lane label (interpolates into per-lane evidence paths). Default lane-NN. */
  id?: string;
  /**
   * App-defined actor type label for grouping simulated users ("operator", "viewer",
   * "maintainer", etc.). This is NOT the execution actor dispatch key (`actors[0].type`);
   * it is adapter-owned taxonomy for roster/readback.
   */
  actorType?: string;
  /** App-defined surface label for grouping lanes that start from different product areas. */
  surface?: string;
  /** App-defined correlation id tying lanes to one shared case/account/work item. */
  caseGroup?: string;
  /** Persona id/label threaded into this lane's actor prompt. Default: actors[0].persona. */
  persona?: string;
  /** Named device preset this lane renders at. XOR raw execution.desktop.resolution. */
  device?: string;
  /** Per-lane steer appended to this lane's mission (the roster's per-lane focus). */
  instruction?: string;
  /**
   * Deterministic lane completion guard. When set, this lane stops as soon as the runtime
   * observation matches any declared rule; actor-level stopWhen is used as the default.
   */
  stopWhen?: StopWhen;
  /**
   * App-url computer-use ONLY: absolute browser URL this lane opens instead of `subject.appUrl`.
   * This is the generic setup-produced-target handoff for crawler/swarm labs: product adapters may
   * start any topology they need, then hand Humanish explicit lane targets. Public/non-loopback
   * targets still require `policies.allowPublicTargets: true`. Inert/rejected on clone, local-app,
   * shared-world, scripted-browser, and terminal routes.
   */
  target?: string;
  /**
   * Shared-world ONLY (#164): this role's per-seat loopback entry route, resolved against
   * `subject.serve.url` and REQUIRED to be same-origin (loopback) with it — the seat opens
   * `serve.url + entry`. Validated at parse AND re-enforced in the engine. Inert/warned on every
   * non-shared-world route (the per-lane-worlds fan-out roster has no per-lane entry).
   */
  entry?: string;
}

/**
 * Compact authoring sugar for repeated lane groups. The parser expands each group into concrete
 * `lanes[]` with deterministic ids (`<group.id>-01`, `<group.id>-02`, ...). The runtime never
 * consumes this shape directly; it always sees ordinary `LabActorLane` entries.
 */
export interface LabActorRosterGroup extends Omit<LabActorLane, "id"> {
  /** Public-safe group id; prefixes generated lane ids. */
  id: string;
  /** Number of lanes to generate for this group. */
  count: number;
}

export interface LabActor {
  /**
   * The actor label. On computer-use (including shared-world), scripted-browser, and
   * terminal-product routes this is a REAL dispatch key resolved against the closed first-party
   * actor registry. On synthetic and meta routes it remains a free-form descriptive label (e.g.
   * synthetic-persona or humanish-setup). The terminal route owns its live lifecycle after using
   * the descriptor for dispatch and capability enforcement.
   */
  type: string;
  /** Lane count — route-specific (see HONEST SCOPE header): synthetic simCount; scripted
   *  surface roster {1 = desktop, 2 = desktop + mobile, default 1}; computer-use E2B route the
   *  HOMOGENEOUS fan-out lane count (cap 16). XOR `lanes`. */
  count?: number;
  /** Computer-use E2B route: a DIFFERENTIATED fan-out roster (per-lane worlds). XOR `count`,
   *  `roster`, and `laneFocus`. Cap 16 lanes. Consumed only on the cua E2B route
   *  (inert/warned elsewhere). */
  lanes?: LabActorLane[];
  /** Persona id/label threaded into the actor prompt. Consumed on the app-url route. */
  persona?: string;
  /** Consumed on the app-url route (laneFocus.instruction appended to the mission). XOR `lanes`. */
  laneFocus?: LabActorLaneFocus;
  /** Free-form mission threaded into the actor prompt. Consumed on the app-url route. */
  mission?: string;
  /** Provider model override. Consumed on the app-url route. */
  model?: string;
  /**
   * Deterministic completion guard used as the default for CUA lanes. Lane-level stopWhen
   * overrides this value.
   */
  stopWhen?: StopWhen;
}

export type LabExecutionTarget = "local" | "e2b-desktop" | "e2b-terminal";

/** Terminal transport: the captured non-interactive exec stream (stdin disabled). NOT an
 *  interactive duplex PTY — labeling captured exec output "pty" would be a claim/mechanism
 *  mismatch (invariant 6 + the goal packet's PTY ruling), so this lane uses "exec-stream". */
export type LabTerminalTransport = "exec-stream";

/** Whether operator stdin reaches the in-sandbox agent. Disabled by default (the run is
 *  autonomous + comparable to an unassisted baseline). "planned" records intent but sends no
 *  input; "sent" is rejected because assisted-input capture and a non-comparable marker do not
 *  ship (the safety contract forbids an assisted run masquerading as green). */
export type LabTerminalStdin = "disabled" | "planned" | "sent";

export interface LabExecutionTerminal {
  /** Transport label. Default and only shipped value is "exec-stream". */
  transport?: LabTerminalTransport;
  /** Operator stdin posture. Default "disabled". */
  stdin?: LabTerminalStdin;
}

/**
 * The runtime-auth channel for the in-sandbox agent (terminal route). "openai-env" declares that
 * OPENAI_API_KEY/CODEX_API_KEY is the runtime key — to be injected ONLY into the command-scoped
 * `codex` invocation (keyPlacement "in-sandbox-command-scoped"), never sandbox-global. The live
 * engine enforces that placement before sandbox creation; dry-run only records names.
 */
export type LabRuntimeAuth = "openai-env";

export type LabDesktopBrowser = "default" | "chrome" | "chromium" | "firefox";

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
  /**
   * Browser family to launch for hosted desktop actor lanes. Absent/default preserves the
   * historical desktop opener behavior. A concrete value means "launch this browser or fail"
   * instead of silently accepting the template's default URL opener.
   */
  browser?: LabDesktopBrowser;
  /** Sandbox server-side timeout. Consumed on the app-url route. */
  sandboxTimeoutMs?: number;
  /**
   * Custom E2B desktop TEMPLATE (image) the run launches on — a non-empty template NAME or ID —
   * instead of the stock `desktop` template. Lets a subject that needs runtimes the stock image
   * lacks (e.g. node/bun/a local Postgres baked into an adopter-maintained image) run as-is. Any
   * string is a valid template name/id (there is no allowlist). Consumed ONLY on the
   * `execution.target: e2b-desktop` computer-use routes (the cua/shared-world/concurrent backends
   * that call `Sandbox.create`); inert/warned on every route that creates no desktop. Threaded to
   * `Sandbox.create(template, opts)`; absent leaves the byte-stable `Sandbox.create(opts)` default.
   * A template name is public-safe (not a secret) and is recorded in the run bundle.
   */
  template?: string;
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
  /** `terminal-product` route: the terminal transport + stdin posture. Consumed on that route. */
  terminal?: LabExecutionTerminal;
  /** `terminal-product` route: the in-sandbox agent's runtime-auth channel. Live runs inject the
   *  key command-scoped; dry-runs record names only. Inert on other routes. */
  runtimeAuth?: LabRuntimeAuth;
}

export type LabScenarioMode = "dry-run" | "live";

/**
 * The blast-radius budget for a route that passes a live key to an in-sandbox command.
 * Per the safety contract, the live key is never exercised without a fail-closed cap in force.
 * All values are non-negative numbers (0 is the no-spend default). Live runs require maxUsd and a
 * positive maxMinutes; maxUsd/maxJobs are enforced against known ledger signals and maxMinutes is
 * enforced as the command wall clock.
 */
export interface LabScenarioCaps {
  /** Max USD the run may spend (provider + product). 0 = no-spend. */
  maxUsd?: number;
  /** Max billable product jobs the agent may trigger. 0 = none. */
  maxJobs?: number;
  /** Max wall-clock minutes for the agent session. */
  maxMinutes?: number;
}

export interface LabScenario {
  /** Reference a committed scenario by id (humanish/scenarios/<ref>.yaml) or path. CONSUMED
   *  (and REQUIRED) on the scripted-browser route; FORWARD-DECLARED elsewhere. */
  ref?: string;
  /** Or inline the scenario body. FORWARD-DECLARED (PR #2). */
  inline?: Record<string, unknown>;
  /** dry-run = contract evidence (no provider spend); live = real run. Consumed. */
  mode?: LabScenarioMode;
  /** Spend/job/time caps. Consumed (recorded in the bundle) on the terminal-product route;
   *  inert (warned) elsewhere. */
  caps?: LabScenarioCaps;
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
   * case is watching a sim of your OWN app locally (gitignored .humanish), where full fidelity is
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
  /**
   * Terminal-product credential-boundary declarations — all DEFAULT FALSE (deny-by-default). The
   * shipped live engine always passes only the runtime LLM key, command-scoped, and records these
   * booleans as evidence. Setting one true records intent but does not create an injection channel
   * or authorize any additional credential in the current route.
   */
  /** Recorded private-repo-access intent. No private-repo provisioning channel ships. */
  allowPrivateRepoAccess?: boolean;
  /** Recorded provider-credential intent. No provider-credential injection channel ships. */
  allowProviderCredentials?: boolean;
  /** Recorded payment-credential intent. No payment-credential injection channel ships. */
  allowPaymentCredentials?: boolean;
  /** Recorded GitHub-mutation intent. No GitHub-token injection channel ships. */
  allowGitHubMutation?: boolean;
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
  error: { code: "HUMANISH_LAB_INVALID"; message: string };
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
  const scenarioResult = parseScenario(raw.scenario);
  if (!scenarioResult.ok) {
    return scenarioResult;
  }
  if (scenarioResult.value) config.scenario = scenarioResult.value;
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
  // it fails closed in runCuaActorLab with HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR.
  if (config.subject.source === "local-app") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "local") {
      return invalid("local-app subjects drive an in-process LOCAL dev server with NO E2B desktop — set `execution.target: local` or omit it (absent means local); `e2b-desktop` is rejected (use an app-url subject for the hosted-desktop route).");
    }
    if (!actorResolvesToComputerUse(type)) {
      return invalid(`actors[0].type must be a registered computer-use actor for local-app subjects (one of: ${registeredComputerUseActors().join(", ")}); the caller's custom executor runs the computer-use loop. Got "${type}".`);
    }
    if (cuaLaneCount(config) > 1) {
      return invalid("Multi-lane fan-out is not supported on the in-process/local-app route — fan-out provisions one independent E2B desktop per lane, which the in-process route deliberately skips; set actors[0].count to 1 and drop actors[0].lanes (use an app-url or clone subject on execution.target: e2b-desktop for fan-out).");
    }
    if (config.actors[0]?.lanes !== undefined) {
      return invalid("`actors[0].lanes` (fan-out roster) is not supported on the in-process/local-app route — it provisions one E2B desktop per lane, which this route skips. Use an app-url or clone subject with execution.target: e2b-desktop.");
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
        return invalid("`policies.redactScreenshots: true` is not implemented on the scripted-browser route yet — screenshots persist raw in gitignored .humanish; a silently ignored redaction policy would be a safety lie, so it is rejected.");
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
      // Multi-lane fan-out is CONSUMED on this route (per-lane worlds; the shared cua-lane
      // cross-validation below enforces lanes/count XOR rules, the 16 cap, and the
      // lane-level target gates, and the allowPublicTargets+N>1 rejection for ambiguous one-target
      // fan-out).
      // Loopback by default; an owner may declare a public/preview target via policies.
      const laneTargets = declaredLaneTargets(config);
      const declaredTargets = [config.subject.appUrl ?? "", ...laneTargets];
      const unsafeTarget = declaredTargets.find((target) => !config.policies?.allowPublicTargets && !isLoopbackUrl(target));
      if (unsafeTarget !== undefined) {
        return invalid("`subject.appUrl` and `actors[0].lanes[].target` must be loopback URLs (127.0.0.1/localhost) unless `policies.allowPublicTargets: true` is set — set it to drive deployed/preview URLs you own.");
      }
    }
  } else if (actorResolvesToScriptedBrowser(config.actors[0]?.type)) {
    if (config.subject.source !== "clone") {
      return invalid("scripted-browser actors require `subject.source: app-url` (a running app at a loopback URL) or `subject.source: clone` with `execution.target: e2b-desktop` (a provisioned synthetic subject).");
    }
    if (config.execution?.target !== "e2b-desktop") {
      return invalid("clone subjects with scripted-browser actors require `execution.target: e2b-desktop` — the lab provisions the clone in E2B, exposes it with getHost, then drives deterministic browser steps.");
    }
    if (!config.subject.serve) {
      return invalid("clone subjects with scripted-browser actors require `subject.serve` (start + url) — the lab serves the app in-sandbox before the scripted browser drives it.");
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return invalid("clone scripted-browser labs require exactly one repo in subject.repos.");
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return invalid(`subject.repos[0] must be an owner/repo slug (got "${repo}").`);
    }
    if (config.subject.topology !== undefined) {
      return invalid("clone scripted-browser labs do not support `subject.topology` yet — this slice provisions one synthetic subject and one deterministic scripted actor roster, not a shared-world run.");
    }
    if (config.subject.clone?.fanout !== undefined || config.subject.clone?.keep === true) {
      return invalid("clone scripted-browser labs do not support `subject.clone.fanout` or `subject.clone.keep` yet — the provisioned subject is always a single disposable E2B sandbox.");
    }
    if (!config.scenario?.ref) {
      return invalid("scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes; there is no built-in fallback on the lab route.");
    }
    if ((config.actors[0]?.count ?? 1) > 2) {
      return invalid("scripted-browser labs support actors[0].count of 1 (desktop surface) or 2 (desktop + mobile); larger fan-out is a later slice.");
    }
    if (config.actors[0]?.lanes !== undefined) {
      return invalid("`actors[0].lanes` is not supported on the scripted-browser route yet — use actors[0].count for the deterministic surface roster.");
    }
    if (config.policies?.redactScreenshots === true) {
      return invalid("`policies.redactScreenshots: true` is not implemented on the scripted-browser route yet — screenshots persist raw in gitignored .humanish; a silently ignored redaction policy would be a safety lie, so it is rejected.");
    }
    if (config.policies?.allowPublicTargets === true) {
      return invalid("`policies.allowPublicTargets` is not supported on the clone scripted-browser route — the only external host is the harness-minted getHost URL for a provisioned synthetic subject.");
    }
    if (config.subject.exposure !== "synthetic") {
      return invalid("clone scripted-browser labs require `subject.exposure: synthetic` — the subject is exposed on an internet-reachable getHost URL for the run, so the author must attest it is synthetic seeded data.");
    }
    if (!config.subject.state?.seed || config.subject.state.seed.length === 0 || (config.subject.state.external?.length ?? 0) > 0) {
      return invalid("clone scripted-browser labs require `subject.state.seed` and do not allow `subject.state.external` — getHost-exposed subjects must be synthetic seeded data, not external/unpinned state.");
    }
    if (!config.subject.serve.start.includes("0.0.0.0")) {
      return invalid("clone scripted-browser labs require `subject.serve.start` to bind all interfaces (e.g. `-H 0.0.0.0` / `--host 0.0.0.0` / `HOST=0.0.0.0`) — getHost only routes to a 0.0.0.0-bound port; the readiness probe stays loopback.");
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
    // Fan-out is CONSUMED here: N lanes each clone the SAME single repo into their own E2B
    // desktop (per-lane worlds). The shared cua-lane cross-validation below enforces the
    // lanes/count rules and the 16 cap; the single-repo rule above is unchanged.
  }

  // local-tree route: packs and uploads the operator's own working tree, then serves it exactly
  // like a computer-use clone subject. There is no smoke/meta/scripted equivalent for a packed
  // working tree in this slice, so e2b-desktop + a computer-use actor are the ONLY combination
  // this source supports. `subject.serve` is already required at parse time (parseSubject); the
  // repos/clone rejection also already happened there (local-tree never carries git slugs).
  if (config.subject.source === "local-tree") {
    if (config.execution?.target !== "e2b-desktop") {
      return invalid("local-tree subjects require `execution.target: e2b-desktop`: the packed working tree is provisioned and served inside a hosted desktop sandbox; there is no local/smoke route for a local-tree subject.");
    }
    if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
      return invalid(`actors[0].type must be a registered computer-use actor for local-tree subjects (one of: ${registeredComputerUseActors().join(", ")}); the actor drives the hosted desktop that serves the packed working tree. Got "${config.actors[0]?.type ?? ""}".`);
    }
  }

  // Shared computer-use fan-out cross-validation (per-lane worlds, the only topology this
  // slice). Runs for every route that resolves to the cua backend (app-url, clone, local-app).
  // The in-process/local-app route already forced a single lane above, so this is a no-op there
  // beyond rejecting the same fields; on the E2B routes it enforces the roster contract.
  if (routesToComputerUse(config)) {
    const reason = cuaLaneValidationReason(config);
    if (reason) {
      return invalid(reason);
    }
  }

  // Shared-world topology cross-validation (#164). Runs whenever shared-world is DECLARED (not just
  // when it routes), so a half-declared shared-world fails closed with a precise reason rather than
  // silently downgrading to a per-lane-worlds cua run. With `execution.concurrency > 1` the
  // concurrent extras (synthetic-subject attestation, 0.0.0.0 serve bind, no clone.keep) also apply.
  if (config.subject.topology === "shared-world") {
    const reason = (config.execution?.concurrency ?? 1) > 1
      ? concurrentSharedWorldValidationReason(config)
      : sharedWorldValidationReason(config);
    if (reason) {
      return invalid(reason);
    }
  }

  // terminal-product route: a real autonomous agent studies a CLI/product from PUBLIC surfaces
  // inside an E2B shell. Fail-closed (invariant 6 — a field that cannot act on this route is an
  // honest parse error): a registered terminal actor only, execution.target e2b-terminal or absent
  // (absent defaults to e2b-terminal — the only honest target for an in-sandbox agent), single
  // lane until fan-out lands.
  if (config.subject.source === "terminal-product") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "e2b-terminal") {
      return invalid("terminal-product subjects run the agent inside an E2B shell — set `execution.target: e2b-terminal` or omit it (absent means e2b-terminal); `local`/`e2b-desktop` are rejected.");
    }
    if (!actorResolvesToTerminal(type)) {
      return invalid(`actors[0].type must be a registered terminal actor for terminal-product subjects (one of: ${registeredTerminalActors().join(", ")}). Got "${type}".`);
    }
    if ((config.actors[0]?.count ?? 1) > 1) {
      return invalid("Multi-lane terminal fan-out is not supported yet; set actors[0].count to 1.");
    }
  } else if (config.execution?.target === "e2b-terminal") {
    // e2b-terminal is the terminal-product substrate ONLY. Any other source declaring it is a
    // mis-config — reject, never silently mishandle (mirrors app-url's e2b-desktop pairing rule).
    return invalid("`execution.target: e2b-terminal` requires `subject.source: terminal-product` with a registered terminal actor.");
  } else if (actorResolvesToTerminal(config.actors[0]?.type)) {
    // A registered terminal actor on a non-terminal-product subject: rejected, never ignored (the
    // terminal agent only studies a declared terminal-product from public surfaces).
    return invalid("terminal actors require `subject.source: terminal-product` (a CLI/product the agent studies from public surfaces); other subjects are not supported on this route.");
  }

  return { ok: true, config, warnings: forwardDeclaredWarnings(config) };
}

// The slug interpolates into an in-sandbox shell command; the strict shape is load-bearing.
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
// A lane id interpolates into per-lane evidence paths (screenshots/<id>/, actors/<id>.json), so
// it must be a public-safe path token, same shape as a lab id.
const LANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const LANE_ID_MAX_CHARS = 40;
const LANE_METADATA_MAX_CHARS = 80;
// Hard cap on fan-out lanes (per the ratified design). No HUMANISH_MAX_LANES escape above this
// until a reference panel demands it — N concurrent paid desktops is real money.
export const MAX_CUA_LANES = 16;

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

/** True when `type` resolves to a registered terminal actor (the "terminal" lane). Exported so
 *  the engine + tests can resolve the dispatch the same way the parser does. */
export function actorResolvesToTerminal(type: string | undefined): boolean {
  if (!type) return false;
  const descriptor = (actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>)[type];
  return Boolean(descriptor?.capabilities.lanes.includes("terminal"));
}

function registeredTerminalActors(): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => entry.capabilities.lanes.includes("terminal"))
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
/**
 * The declared fan-out lane count on the computer-use route: a `lanes[]` roster's length, else
 * a homogeneous `count`, else 1. The single source of truth shared by the parser, the engine,
 * and the pre-flight plan so the lane count is computed ONE way everywhere.
 */
export function cuaLaneCount(config: LabConfig): number {
  const actor = config.actors[0];
  if (actor?.lanes !== undefined) {
    return actor.lanes.length;
  }
  return actor?.count ?? 1;
}

/**
 * Cross-validate the computer-use fan-out declaration (per-lane worlds). Returns the failure
 * message, or null when valid. Enforced at parse AND re-enforced in the engine (runCuaActorLab
 * is itself exported npm surface). Structural lane shape (id/device validity, id uniqueness) is
 * already checked in parseLanes; this is the route-scoped XOR/cap/policy layer.
 */
export function cuaLaneValidationReason(config: LabConfig): string | null {
  const actor = config.actors[0];
  const lanes = actor?.lanes;
  const structuralReason = laneRosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  // clone.fanout is a DECLARED behavior change: rejected on the cua route (was inert-warned).
  // Fan-out is declared via actors[0].count/lanes; subject.clone.fanout never applied here.
  if (config.subject.clone?.fanout !== undefined) {
    return "`subject.clone.fanout` is not used on the computer-use route — declare fan-out with actors[0].count (homogeneous) or actors[0].lanes (a per-lane roster). (clone.fanout drives the OSS smoke/meta routes only.)";
  }
  if (lanes !== undefined) {
    if (actor?.count !== undefined) {
      return "Declare EITHER actors[0].count (a homogeneous lane count) OR actors[0].lanes (a differentiated roster), not both.";
    }
    if (actor?.laneFocus !== undefined) {
      return "actors[0].laneFocus and actors[0].lanes are mutually exclusive — a roster's per-lane `instruction` is the fan-out steer; laneFocus is the single-lane steer.";
    }
    if (config.execution?.desktop?.resolution !== undefined && lanes.some((lane) => lane.device !== undefined)) {
      return "actors[0].lanes[].device and a raw execution.desktop.resolution are mutually exclusive — a per-lane device preset and a single hand-set resolution cannot both govern lane geometry.";
    }
    const targeted = lanes.filter((lane) => lane.target !== undefined);
    if (targeted.length > 0) {
      if (config.subject.source !== "app-url") {
        return "actors[0].lanes[].target is supported only on app-url computer-use labs — clone/shared-world/local-app routes provision or own their entry URL by mechanism.";
      }
      if (lanes.some((lane) => lane.entry !== undefined)) {
        return "actors[0].lanes[].target and actors[0].lanes[].entry are mutually exclusive — target is an app-url fan-out browser URL; entry is a shared-world same-origin seat path.";
      }
      if (targeted.length !== lanes.length) {
        return "When any actors[0].lanes[].target is declared, every lane in the roster must declare target — this keeps the setup-produced target contract explicit and prevents accidental mixed worlds.";
      }
    }
  }
  const laneCount = cuaLaneCount(config);
  if (laneCount > MAX_CUA_LANES) {
    return `Computer-use fan-out is capped at ${MAX_CUA_LANES} lanes (declared ${laneCount}); N concurrent paid desktops is real spend — there is no override above the cap this slice.`;
  }
  // Public targets fan out into N independent worlds driving the SAME public app — that is an
  // ambiguous shared-world-ish shape, not a per-lane target swarm. Permit N>1 public runs only when
  // every roster lane declares its own target, making the adapter-owned topology explicit.
  if (laneCount > 1 && config.policies?.allowPublicTargets === true && declaredLaneTargets(config).length === 0) {
    return "policies.allowPublicTargets cannot be combined with multi-lane fan-out (N>1) — N lanes against one declared public target is the SHARED-WORLD topology (layer 7, #164), not per-lane worlds. Fan out against a loopback/provisioned subject, or run a single public-target lane.";
  }
  return null;
}

/**
 * Engine-level path-token validation for configs supplied directly through the
 * public TypeScript/JavaScript API instead of parseLabConfig.
 */
export function laneRosterStructuralValidationReason(config: LabConfig): string | null {
  const lanes = config.actors[0]?.lanes;
  const seenIds = new Set<string>();
  if (lanes !== undefined) {
    if (!Array.isArray(lanes) || lanes.length === 0) {
      return "actors[0].lanes must be a non-empty array when set.";
    }
    for (const [index, lane] of lanes.entries()) {
      if (!lane || typeof lane !== "object" || Array.isArray(lane)) {
        return `actors[0].lanes[${index}] must be an object.`;
      }
      const id = lane.id;
      if (id === undefined) {
        continue;
      }
      if (typeof id !== "string" || !LANE_ID_PATTERN.test(id) || id.length > LANE_ID_MAX_CHARS) {
        return `actors[0].lanes[${index}].id must be a public-safe path token matching ${LANE_ID_PATTERN} and at most ${LANE_ID_MAX_CHARS} chars.`;
      }
      if (seenIds.has(id)) {
        return `actors[0].lanes ids must be unique (duplicate "${id}").`;
      }
      seenIds.add(id);
    }
  }
  return null;
}

function declaredLaneTargets(config: LabConfig): string[] {
  return (config.actors[0]?.lanes ?? [])
    .map((lane) => lane.target)
    .filter((target): target is string => target !== undefined);
}

/**
 * Cross-validate a `topology: shared-world` declaration (#164). Returns the failure message, or
 * null when valid. Enforced at parse AND re-enforced in the engine (runSharedWorldLab is exported
 * npm surface). The shared-world override REQUIRES: a clone or local-tree source + e2b-desktop
 * target + a computer-use actor + a `subject.serve` block + an `actors[0].lanes` roster of ≥2 roles (the
 * roster IS the role roster — no parallel roles[] field), and every role `entry` must resolve
 * same-origin (loopback) with serve.url. Fail-closed: a half-declared shared-world is rejected,
 * never silently downgraded.
 */
export function sharedWorldValidationReason(config: LabConfig): string | null {
  const structuralReason = laneRosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  if (config.subject.source !== "clone" && config.subject.source !== "local-tree") {
    return "`subject.topology: shared-world` requires `subject.source: clone` or `subject.source: local-tree` - the shared world is ONE provisioned, served, seeded plane (#164).";
  }
  if (config.execution?.target !== "e2b-desktop") {
    return "`subject.topology: shared-world` requires `execution.target: e2b-desktop` — the role seats drive hosted desktop browsers against one in-sandbox app.";
  }
  if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
    return `\`subject.topology: shared-world\` requires a registered computer-use actor (one of: ${registeredComputerUseActors().join(", ")}) — each role seat runs a computer-use session.`;
  }
  const serve = config.subject.serve;
  if (!serve) {
    return "`subject.topology: shared-world` requires `subject.serve` (start + url) — the lab serves ONE shared app in-sandbox that every role drives.";
  }
  const lanes = config.actors[0]?.lanes;
  if (!lanes || lanes.length < 2) {
    return "`subject.topology: shared-world` requires an `actors[0].lanes` roster of at least 2 roles (the roster IS the role roster — declare ≥2 lanes; a single-role shared world proves no interaction).";
  }
  if (!config.subject.state?.checkpoint || config.subject.state.checkpoint.length === 0) {
    return "`subject.topology: shared-world` requires `subject.state.checkpoint` (≥1 read-only digest probe) — the checkpoint timeline IS the interaction-attribution mechanism; without it the run cannot prove role B acted on role A's mutation.";
  }
  for (const lane of lanes) {
    if (lane.entry !== undefined && resolveSeatUrl(serve.url, lane.entry) === null) {
      return `actors[0].lanes role "${lane.id ?? "(unnamed)"}".entry must resolve same-origin (loopback) with subject.serve.url (${serve.url}); got "${lane.entry}".`;
    }
  }
  return null;
}

export function routesToComputerUse(config: LabConfig): boolean {
  // local-app drives the cua loop in-process (a custom executor + a non-vision provider), so it
  // routes to the cua backend exactly like an app-url subject with a computer-use actor.
  if (config.subject.source === "app-url" || config.subject.source === "local-app") {
    return actorResolvesToComputerUse(config.actors[0]?.type);
  }
  // local-tree packs+uploads the working tree, then serves it exactly like a computer-use clone
  // subject: same e2b-desktop + computer-use-actor gate.
  return (config.subject.source === "clone" || config.subject.source === "local-tree")
    && config.execution?.target === "e2b-desktop"
    && actorResolvesToComputerUse(config.actors[0]?.type);
}

/**
 * True when this config routes to the SHARED-WORLD backend (#164): a clone or local-tree subject
 * on a hosted desktop whose first actor resolves to a computer-use actor AND that declares the
 * `shared-world` topology. Mirror of routesToComputerUse; the single source of truth shared by
 * selectLabBackend (which checks it BEFORE the cua route) and the warning logic. The same
 * clone/local-tree × e2b-desktop × computer-use composition WITHOUT `topology: shared-world` stays per-lane-worlds
 * (the cua route) — the topology declaration is the override switch.
 */
export function routesToSharedWorld(config: LabConfig): boolean {
  return (config.subject.source === "clone" || config.subject.source === "local-tree")
    && config.subject.topology === "shared-world"
    && config.execution?.target === "e2b-desktop"
    && actorResolvesToComputerUse(config.actors[0]?.type);
}

/**
 * True when this config routes to the CONCURRENT shared-world backend (#164 phase 2): a shared-world
 * config with `execution.concurrency > 1` (N actor seats driving ONE getHost-exposed plane AT ONCE).
 * `concurrency` absent or 1 stays the sequential PoC (`routesToSharedWorld` → the sequential
 * backend). selectLabBackend checks this BEFORE routesToSharedWorld.
 */
export function routesToConcurrentSharedWorld(config: LabConfig): boolean {
  return routesToSharedWorld(config) && (config.execution?.concurrency ?? 1) > 1;
}

/**
 * Cross-validate a CONCURRENT shared-world declaration (#164 phase 2). Returns the failure message,
 * or null when valid. Includes the base shared-world checks PLUS the concurrent extras: a synthetic
 * subject attestation (FIX-3), a 0.0.0.0 serve bind (FIX-4 — getHost only routes to a port bound on
 * all interfaces), and no `subject.clone.keep`/`subject.localTree.keep` (FIX-9 - either would
 * orphan actor sandboxes). Enforced at parse AND re-enforced in the engine (runConcurrentSharedWorld
 * is exported npm surface).
 */
export function concurrentSharedWorldValidationReason(config: LabConfig): string | null {
  const base = sharedWorldValidationReason(config);
  if (base) {
    return base;
  }
  if ((config.execution?.concurrency ?? 1) <= 1) {
    return "the concurrent shared-world route requires `execution.concurrency > 1` (N concurrent actor seats); concurrency 1 is the sequential PoC.";
  }
  if (config.subject.exposure !== "synthetic") {
    return "the concurrent shared-world route requires `subject.exposure: synthetic` — the subject is exposed on an internet-reachable getHost URL for the run, so the author must attest it is synthetic seeded data (no real/external data behind a getHost URL).";
  }
  const serve = config.subject.serve;
  if (!serve || !serve.start.includes("0.0.0.0")) {
    return "the concurrent shared-world route requires `subject.serve.start` to bind all interfaces (e.g. `-H 0.0.0.0` / `--host 0.0.0.0` / `HOST=0.0.0.0`) — getHost only routes to a 0.0.0.0-bound port; a loopback-only bind 502s. (The readiness probe stays loopback.)";
  }
  if (config.subject.clone?.keep === true || config.subject.localTree?.keep === true) {
    const keepField = config.subject.clone?.keep === true ? "subject.clone.keep" : "subject.localTree.keep";
    return `\`${keepField}\` is not supported on the concurrent shared-world route - it would orphan the N actor sandboxes (reclaimed only by server-timeout, not by id). All N+1 sandboxes are torn down by id.`;
  }
  return null;
}

/**
 * Resolve a shared-world seat's entry URL from `serve.url` + a role's `entry` (relative path or
 * same-origin absolute URL). Returns null when the combination is not a same-origin loopback URL
 * (the load-bearing public-safety boundary — a seat only ever drives the in-sandbox app).
 */
export function resolveSeatUrl(serveUrl: string, entry: string | undefined): string | null {
  if (entry === undefined || entry === "") {
    return isLoopbackUrl(serveUrl) ? serveUrl : null;
  }
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(serveUrl);
    resolved = new URL(entry, serveUrl);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) {
    return null;
  }
  const value = resolved.toString();
  return isLoopbackUrl(value) ? value : null;
}

/**
 * True when this config routes to the scripted-browser backend: an app-url subject whose
 * first actor resolves to a registered scripted-browser actor (execution.target local or
 * absent — the parse layer enforces that pairing). Mirror of routesToComputerUse; the single
 * source of truth for selectLabBackend and the warning logic.
 */
export function routesToScriptedBrowser(config: LabConfig): boolean {
  return routesToLocalScriptedBrowser(config) || routesToProvisionedScriptedBrowser(config);
}

export function routesToLocalScriptedBrowser(config: LabConfig): boolean {
  return config.subject.source === "app-url"
    && actorResolvesToScriptedBrowser(config.actors[0]?.type);
}

export function routesToProvisionedScriptedBrowser(config: LabConfig): boolean {
  return config.subject.source === "clone"
    && config.execution?.target === "e2b-desktop"
    && actorResolvesToScriptedBrowser(config.actors[0]?.type);
}

/**
 * True when this config routes to the terminal-product backend: a terminal-product subject whose
 * first actor resolves to a registered terminal actor (execution.target e2b-terminal or absent —
 * the parse layer enforces that pairing). Mirror of routesToComputerUse/routesToScriptedBrowser;
 * the single source of truth for selectLabBackend and the warning logic.
 */
export function routesToTerminalProduct(config: LabConfig): boolean {
  return config.subject.source === "terminal-product"
    && actorResolvesToTerminal(config.actors[0]?.type);
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
  const routesToTerminal = routesToTerminalProduct(config);
  const routesToShared = routesToSharedWorld(config);
  const routesToConcurrent = routesToConcurrentSharedWorld(config);
  const routesToHostedCuaBrowser = config.execution?.target === "e2b-desktop"
    && routesToCua;
  for (const [index, actor] of config.actors.entries()) {
    // Shared-world ONLY fields on the roster: per-role `entry` is inert anywhere else (invariant 6).
    if (actor.lanes?.some((lane) => lane.entry !== undefined) && !routesToShared) {
      inert.push(`actors[${index}].lanes[].entry (the per-role loopback entry is a shared-world capability; needs subject.topology: shared-world)`);
    }
    if (routesToCua || routesToTerminal) {
      // The cua + terminal routes consume mission/persona/model + laneFocus.instruction (they
      // compose the agent prompt + bundle provenance); laneFocus.id/label remain inert. On the
      // cua E2B route actors[0].lanes is CONSUMED (the fan-out roster).
      if (actor.laneFocus?.id) inert.push(`actors[${index}].laneFocus.id`);
      if (actor.laneFocus?.label) inert.push(`actors[${index}].laneFocus.label`);
      if (routesToTerminal && actor.lanes) inert.push(`actors[${index}].lanes (fan-out is a computer-use route capability; terminal fan-out is a later slice)`);
    } else if (routesToScripted) {
      // persona and count are consumed (trace/bundle provenance; surface roster). The prompt
      // fields can never act here — the scripted actor runs no model.
      if (actor.mission) inert.push(`actors[${index}].mission (the scripted-browser actor runs no model)`);
      if (actor.laneFocus) inert.push(`actors[${index}].laneFocus (the scripted-browser actor runs no model)`);
      if (actor.model) inert.push(`actors[${index}].model (the scripted-browser actor runs no model)`);
      if (actor.lanes) inert.push(`actors[${index}].lanes (the scripted-browser route fans out via actors[0].count, not a lane roster)`);
    } else {
      if (actor.mission) inert.push(`actors[${index}].mission`);
      if (actor.laneFocus) inert.push(`actors[${index}].laneFocus`);
      if (actor.persona) inert.push(`actors[${index}].persona`);
      if (actor.model) inert.push(`actors[${index}].model`);
      if (actor.lanes) inert.push(`actors[${index}].lanes`);
    }
  }
  if (config.subject.clone?.depth !== undefined && !routesToCua && !routesToScripted) inert.push("subject.clone.depth");
  if (config.subject.serve && !routesToCua && !routesToScripted) inert.push("subject.serve");
  if (config.subject.env && !routesToCua && !routesToScripted) inert.push("subject.env");
  if (config.subject.state && !routesToCua && !routesToScripted) inert.push("subject.state");
  // topology + checkpoint act ONLY on the shared-world route (#164); a set-but-unconsumed value
  // (incl. an explicit per-lane-worlds, which the cua route already is by mechanism) warns inert.
  if (config.subject.topology !== undefined && !routesToShared) {
    inert.push("subject.topology (drives behavior only on the shared-world route; needs subject.topology: shared-world + clone × e2b-desktop × a computer-use actor + a ≥2 lane roster)");
  }
  if (config.subject.state?.checkpoint !== undefined && !routesToShared) {
    inert.push("subject.state.checkpoint (the shared-world state-checkpoint probe; needs subject.topology: shared-world)");
  }
  // exposure (the synthetic-subject attestation) acts ONLY on the CONCURRENT shared-world route
  // (the getHost-exposed plane); inert on the sequential shared-world route (loopback) and elsewhere.
  if (config.subject.exposure !== undefined && !routesToConcurrent && !(routesToScripted && config.subject.source === "clone")) {
    inert.push("subject.exposure (the synthetic-subject attestation for a getHost-exposed plane; needs concurrent shared-world or clone × e2b-desktop × scripted-browser)");
  }
  // clone.keep IS consumed on the cua route (honored on FAILURE: the sandbox is left up to debug
  // a failed install/boot; otherwise always killed). clone.fanout is REJECTED on the cua route
  // (a hard parse error above), so it can never reach this warning list there.
  if (!routesToCua && !routesToScripted && !routesToTerminal && config.execution?.timeoutMs !== undefined) inert.push("execution.timeoutMs");
  if (config.execution?.completionTimeoutMs !== undefined) inert.push("execution.completionTimeoutMs");
  // execution.concurrency is CONSUMED on the cua route (it bounds in-flight fan-out lanes);
  // inert (warned) everywhere else.
  if (config.execution?.concurrency !== undefined && !routesToCua) inert.push("execution.concurrency");
  // terminal-product consumes subject.product, scenario.caps, execution.{terminal,runtimeAuth}:
  // dry-run records the contract; live execution enforces caps and command-scoped auth. On every
  // OTHER route they are inert and must warn so a
  // misplaced safety/budget field is never trusted to do something it cannot (invariant 6).
  if (config.subject.product && !routesToTerminal) inert.push("subject.product (needs subject.source: terminal-product + a registered terminal actor)");
  if (config.scenario?.caps && !routesToTerminal) inert.push("scenario.caps (needs subject.source: terminal-product + a registered terminal actor)");
  if (config.execution?.terminal && !routesToTerminal) inert.push("execution.terminal (needs subject.source: terminal-product + a registered terminal actor)");
  if (config.execution?.runtimeAuth !== undefined && !routesToTerminal) inert.push("execution.runtimeAuth (needs subject.source: terminal-product + a registered terminal actor)");
  // execution.desktop.* stays inert on the scripted route by design: device presets belong to
  // the cua desktop; scripted surfaces are the driver's fixed desktop/mobile viewports, where
  // isMobile/DSF genuinely render via playwright emulation.
  if (!routesToCua && config.execution?.desktop?.resolution) inert.push("execution.desktop.resolution");
  if (!routesToCua && config.execution?.desktop?.device !== undefined) inert.push("execution.desktop.device");
  if (!routesToHostedCuaBrowser && config.execution?.desktop?.browser !== undefined) inert.push("execution.desktop.browser");
  if (!routesToCua && config.execution?.desktop?.sandboxTimeoutMs !== undefined) inert.push("execution.desktop.sandboxTimeoutMs");
  // execution.desktop.template (the custom E2B desktop image) is consumed ONLY where a desktop is
  // actually created via Sandbox.create — the e2b-desktop computer-use routes (cua/shared-world/
  // concurrent). It is INERT on every other route (incl. the in-process local-app cua route, which
  // creates no desktop, and the meta route): warn so an unconsumed template is never silently
  // ignored (invariant 6).
  const createsE2BDesktop = (routesToCua || (routesToScripted && config.subject.source === "clone"))
    && config.execution?.target === "e2b-desktop";
  if (config.execution?.desktop?.template !== undefined && !createsE2BDesktop) {
    inert.push("execution.desktop.template (the custom E2B desktop image is consumed only on execution.target: e2b-desktop computer-use routes that create a desktop; needs a computer-use actor on e2b-desktop)");
  }
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
  if (source !== "this-repo" && source !== "clone" && source !== "app-url" && source !== "local-app" && source !== "terminal-product" && source !== "local-tree") {
    return invalid("`subject.source` must be one of: this-repo, clone, app-url, local-app, terminal-product, local-tree.");
  }
  const subject: LabSubject = { source };

  // topology is enum-validated everywhere; its SEMANTICS (shared-world requires clone × e2b-desktop
  // × a ≥2 roster) are enforced in the shared-world cross-validation below, and a set-but-unconsumed
  // topology warns as inert off the shared-world route (invariant 6).
  if (raw.topology !== undefined) {
    const topology = str(raw.topology);
    if (topology !== "per-lane-worlds" && topology !== "shared-world") {
      return invalid("`subject.topology` must be per-lane-worlds (the default) or shared-world.");
    }
    subject.topology = topology;
  }
  // exposure is enum-validated everywhere; it is REQUIRED on the concurrent shared-world route (the
  // getHost synthetic-subject attestation) and warns inert elsewhere.
  if (raw.exposure !== undefined) {
    const exposure = str(raw.exposure);
    if (exposure !== "synthetic") {
      return invalid("`subject.exposure` must be `synthetic` (the author attestation that the getHost-exposed subject is synthetic seeded data).");
    }
    subject.exposure = exposure;
  }

  // `product` is terminal-product-only; reject it elsewhere (invariant 6: a field that cannot act
  // on this route is an honest parse error, not silently dropped).
  if (source !== "terminal-product" && raw.product !== undefined) {
    return invalid("`subject.product` applies only to terminal-product subjects (the CLI/product the terminal agent studies from public surfaces).");
  }
  // appUrl is app-url/local-app-only; a terminal-product subject drives PUBLIC surfaces, not a
  // single loopback app — reject appUrl on it.
  if (source === "terminal-product" && raw.appUrl !== undefined) {
    return invalid("`subject.appUrl` does not apply to terminal-product subjects — declare `subject.product.publicSurfaces` (the agent works from public surfaces, not one loopback app).");
  }

  // serve/env/state are shared between clone (cloned app) and local-tree (packed working
  // tree): both routes serve a subject in-sandbox with the same install/build/start/url +
  // env-name + seed/external/checkpoint shapes.
  if (source !== "clone" && source !== "local-tree" && raw.serve !== undefined) {
    return invalid("`subject.serve` applies only to clone subjects or local-tree subjects (the lab serves the cloned/packed app in-sandbox).");
  }
  if (source !== "clone" && source !== "local-tree" && raw.env !== undefined) {
    return invalid("`subject.env` applies only to clone subjects or local-tree subjects (the served app's environment channel).");
  }
  if (source !== "clone" && source !== "local-tree" && raw.state !== undefined) {
    return invalid("`subject.state` applies only to clone subjects or local-tree subjects (the lab seeds the state it serves).");
  }
  // repos/clone are clone-ONLY (a fresh-clone subject's git inputs). local-tree packs the
  // resolution cwd itself, so it has no repo slug to clone and gets its own precise reasons
  // rather than falling through to the generic clone-only message below.
  if (source === "local-tree" && raw.repos !== undefined) {
    return invalid("`subject.repos` does not apply to local-tree subjects. The local-tree route packs the lab resolution cwd itself; there is no owner/repo slug to clone.");
  }
  if (source === "local-tree" && raw.clone !== undefined) {
    return invalid("`subject.clone` does not apply to local-tree subjects. Declare `subject.localTree` instead (keep/exclude/maxArchiveBytes).");
  }
  // Rejected, never silently dropped, on app-url/local-app/this-repo/terminal-product subjects
  // too (invariant 6: a field that cannot act on this route is an honest parse error).
  if (source !== "clone" && raw.repos !== undefined) {
    return invalid("`subject.repos` applies only to clone subjects (the owner/repo slugs to clone).");
  }
  if (source !== "clone" && raw.clone !== undefined) {
    return invalid("`subject.clone` applies only to clone subjects (clone depth/fanout/keep).");
  }
  // localTree is local-tree-ONLY (pack/upload knobs for the packed working tree).
  if (source !== "local-tree" && raw.localTree !== undefined) {
    return invalid("`subject.localTree` applies only to local-tree subjects (keep/exclude/maxArchiveBytes for packing the working tree).");
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

  if (source === "local-tree") {
    // A local-tree subject exists to be packed and served; there is no other way to boot it, so
    // serve is REQUIRED here (unlike clone, where serve is optional for the smoke/meta routes).
    if (raw.serve === undefined) {
      return invalid("`subject.serve` is required when source is local-tree: a local-tree subject exists to be packed and served, so declare install/build/start/url exactly like the clone route.");
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
      // Semantic validation is shared with the engine (same helper the clone route uses).
      const reason = subjectStateInvalidReason(stateResult.value, subject.env);
      if (reason) {
        return invalid(reason);
      }
      subject.state = stateResult.value;
    }
    const localTreeResult = parseLocalTree(raw.localTree);
    if (!localTreeResult.ok) {
      return localTreeResult;
    }
    if (localTreeResult.value) {
      subject.localTree = localTreeResult.value;
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

  if (source === "terminal-product") {
    const productResult = parseProduct(raw.product);
    if (!productResult.ok) {
      return productResult;
    }
    subject.product = productResult.value;
  }

  return { ok: true, value: subject };
}

// The product name interpolates into evidence labels and the composed prompt; the public-safe
// token shape is the same load-bearing constraint as a lab id.
const PRODUCT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function parseProduct(raw: unknown): { ok: true; value: LabSubjectProduct } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid("`subject.product` is required on terminal-product subjects and must be an object ({ name, publicSurfaces }).");
  }
  const name = str(raw.name);
  if (!name || !PRODUCT_NAME_PATTERN.test(name)) {
    return invalid("`subject.product.name` must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).");
  }
  const publicSurfaces = strList(raw.publicSurfaces);
  if (!publicSurfaces || publicSurfaces.length === 0) {
    return invalid("`subject.product.publicSurfaces` must list at least one public surface URL.");
  }
  const badSurface = publicSurfaces.find((surface) => !isHttpUrl(surface));
  if (badSurface) {
    return invalid(`subject.product.publicSurfaces entries must be http(s) URLs (got "${badSurface}").`);
  }
  return { ok: true, value: { name, publicSurfaces } };
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
  if (raw.checkpoint !== undefined) {
    if (!Array.isArray(raw.checkpoint) || !raw.checkpoint.every(isRecord)) {
      return invalid("`subject.state.checkpoint` must be an array of probe objects ({ name, command, redact? }).");
    }
    state.checkpoint = raw.checkpoint.map((probe) => ({
      name: typeof probe.name === "string" ? probe.name.trim() : "",
      command: typeof probe.command === "string" ? probe.command.trim() : "",
      // Preserve the redact list verbatim (literal secret values may contain commas, so do NOT
      // run it through the comma-splitting strList); subjectStateInvalidReason validates the shape.
      ...(probe.redact === undefined ? {} : { redact: probe.redact as string[] })
    }));
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
  const checkpoint = state.checkpoint;
  if ((seed === undefined || seed.length === 0)
    && (external === undefined || external.length === 0)
    && (checkpoint === undefined || checkpoint.length === 0)) {
    return "`subject.state` must declare seed steps, external env names, and/or checkpoints (an empty state block would be inert).";
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
  if (checkpoint !== undefined) {
    if (!Array.isArray(checkpoint) || checkpoint.length === 0) {
      return "`subject.state.checkpoint` must be a non-empty array of probes when set.";
    }
    const names = new Set<string>();
    for (const [index, probe] of checkpoint.entries()) {
      const name = typeof probe?.name === "string" ? probe.name : "";
      if (!STATE_STEP_NAME_PATTERN.test(name) || name.length > STATE_STEP_NAME_MAX_CHARS) {
        return `subject.state.checkpoint[${index}].name must match ${STATE_STEP_NAME_PATTERN} and be at most ${STATE_STEP_NAME_MAX_CHARS} chars (it names in-sandbox file paths); got "${name}".`;
      }
      if (names.has(name)) {
        return `subject.state.checkpoint names must be unique (duplicate "${name}").`;
      }
      names.add(name);
      if (typeof probe.command !== "string" || probe.command.trim().length === 0) {
        return `subject.state.checkpoint[${index}].command is required (the read-only digest probe command).`;
      }
      if (probe.redact !== undefined) {
        if (!Array.isArray(probe.redact) || !probe.redact.every((value) => typeof value === "string" && value.length > 0)) {
          return `subject.state.checkpoint[${index}].redact must be a list of non-empty literal strings when set.`;
        }
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

/**
 * Structural parse of `subject.localTree`, mirroring parseClone. Unlike parseClone (which
 * silently drops an out-of-range depth/fanout), an invalid exclude/maxArchiveBytes value is
 * REJECTED, never silently dropped: a caller who typed an empty exclude entry or a non-positive
 * maxArchiveBytes almost certainly meant something, and the archive-size cap is a safety knob,
 * not a cosmetic default.
 */
function parseLocalTree(raw: unknown): { ok: true; value: LabSubjectLocalTree | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`subject.localTree` must be an object ({ keep?, exclude?, maxArchiveBytes? }).");
  }
  const localTree: LabSubjectLocalTree = {};
  if (raw.keep !== undefined) {
    if (typeof raw.keep !== "boolean") {
      return invalid("`subject.localTree.keep` must be a boolean (YAML true/false, not a quoted string).");
    }
    localTree.keep = raw.keep;
  }
  if (raw.exclude !== undefined) {
    if (!Array.isArray(raw.exclude) || raw.exclude.some((item) => typeof item !== "string" || item.trim().length === 0)) {
      return invalid("`subject.localTree.exclude` must be a list of non-empty strings (extra archive excludes on top of the always-on denylist).");
    }
    const exclude = strList(raw.exclude);
    if (exclude) {
      // Normalize/validate each entry at parse time so a mis-shaped exclude the
      // author believed in can never silently no-op at packing time: absolute
      // paths and glob syntax are rejected with the packing boundary's own
      // reason; "./prefix" and "prefix/" normalize to the enumeration relPath
      // shape.
      const normalized: string[] = [];
      for (const entry of exclude) {
        try {
          normalized.push(normalizeExtraExcludeEntry(entry));
        } catch (error) {
          return invalid(`\`subject.localTree.exclude\`: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      localTree.exclude = normalized;
    }
  }
  if (raw.maxArchiveBytes !== undefined) {
    const maxArchiveBytes = posInt(raw.maxArchiveBytes);
    if (maxArchiveBytes === undefined) {
      return invalid("`subject.localTree.maxArchiveBytes` must be a positive integer number of bytes when set.");
    }
    localTree.maxArchiveBytes = maxArchiveBytes;
  }
  return { ok: true, value: Object.keys(localTree).length > 0 ? localTree : undefined };
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
    if (entry.lanes !== undefined && entry.roster !== undefined) {
      return invalid(`actors[${index}].lanes and actors[${index}].roster are mutually exclusive — use explicit lanes OR compact roster groups, not both.`);
    }
    if (entry.roster !== undefined && count !== undefined) {
      return invalid(`actors[${index}].roster and actors[${index}].count are mutually exclusive — use compact differentiated groups OR a homogeneous count, not both.`);
    }
    if (entry.roster !== undefined && entry.laneFocus !== undefined) {
      return invalid(`actors[${index}].roster and actors[${index}].laneFocus are mutually exclusive — a roster group's instruction is the per-lane steer.`);
    }
    const lanesResult = entry.roster !== undefined
      ? parseRosterGroups(entry.roster, index)
      : parseLanes(entry.lanes, index);
    if (!lanesResult.ok) {
      return lanesResult;
    }
    if (lanesResult.value) actor.lanes = lanesResult.value;
    const persona = str(entry.persona);
    if (persona) actor.persona = persona;
    const mission = str(entry.mission);
    if (mission) actor.mission = mission;
    const model = str(entry.model);
    if (model) actor.model = model;
    const stopWhenResult = parseStopWhen(entry.stopWhen, `actors[${index}].stopWhen`);
    if (!stopWhenResult.ok) return stopWhenResult;
    if (stopWhenResult.value !== undefined) actor.stopWhen = stopWhenResult.value;
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

/**
 * Parse `actors[index].roster` compact groups into concrete lanes. This is authoring sugar for
 * "N users of M adapter-owned types across S surfaces"; the runtime receives only `lanes[]`.
 */
function parseRosterGroups(raw: unknown, actorIndex: number): { ok: true; value: LabActorLane[] | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid(`actors[${actorIndex}].roster must be a non-empty array of group objects ({ id, count, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }) when set.`);
  }

  const expanded: LabActorLane[] = [];
  const seenGroupIds = new Set<string>();
  for (const [groupIndex, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return invalid(`actors[${actorIndex}].roster[${groupIndex}] must be an object ({ id, count, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }).`);
    }
    const groupId = str(entry.id);
    if (groupId === undefined) {
      return invalid(`actors[${actorIndex}].roster[${groupIndex}].id is required and must be a public-safe token matching ${LANE_ID_PATTERN}.`);
    }
    if (!LANE_ID_PATTERN.test(groupId) || groupId.length > LANE_ID_MAX_CHARS - 3) {
      return invalid(`actors[${actorIndex}].roster[${groupIndex}].id must be a public-safe token matching ${LANE_ID_PATTERN} and at most ${LANE_ID_MAX_CHARS - 3} chars (generated lanes use <id>-NN); got "${groupId}".`);
    }
    if (seenGroupIds.has(groupId)) {
      return invalid(`actors[${actorIndex}].roster group ids must be unique (duplicate "${groupId}").`);
    }
    seenGroupIds.add(groupId);
    const count = posInt(entry.count);
    if (count === undefined) {
      return invalid(`actors[${actorIndex}].roster[${groupIndex}].count is required and must be a positive integer.`);
    }
    const groupLaneInput: Record<string, unknown> = { ...entry };
    delete groupLaneInput.id;
    delete groupLaneInput.count;
    for (let i = 1; i <= count; i += 1) {
      expanded.push({
        ...groupLaneInput,
        id: `${groupId}-${String(i).padStart(2, "0")}`
      });
    }
  }

  return parseLanes(expanded, actorIndex);
}

/**
 * Parse `actors[index].lanes` into a fan-out roster (computer-use E2B route). Structural only:
 * each lane is `{ id?, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }`.
 * Lane ids (when declared) must be public-safe path tokens and unique; lane grouping metadata
 * must be public-safe tokens; a lane device must be a known preset name. The
 * route-scoped cross-validation (lanes XOR count/laneFocus, device XOR raw resolution, cap 16)
 * runs in parseLabConfig where the route is known.
 */
function parseLanes(raw: unknown, actorIndex: number): { ok: true; value: LabActorLane[] | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid(`actors[${actorIndex}].lanes must be a non-empty array of lane objects ({ id?, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }) when set.`);
  }
  const lanes: LabActorLane[] = [];
  const seenIds = new Set<string>();
  for (const [laneIndex, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return invalid(`actors[${actorIndex}].lanes[${laneIndex}] must be an object ({ id?, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }).`);
    }
    const lane: LabActorLane = {};
    const id = str(entry.id);
    if (id !== undefined) {
      if (!LANE_ID_PATTERN.test(id) || id.length > LANE_ID_MAX_CHARS) {
        return invalid(`actors[${actorIndex}].lanes[${laneIndex}].id must be a public-safe token matching ${LANE_ID_PATTERN} and at most ${LANE_ID_MAX_CHARS} chars (it names per-lane evidence paths); got "${id}".`);
      }
      if (seenIds.has(id)) {
        return invalid(`actors[${actorIndex}].lanes ids must be unique (duplicate "${id}").`);
      }
      seenIds.add(id);
      lane.id = id;
    }
    const device = str(entry.device);
    if (device !== undefined) {
      if (!isDevicePresetName(device)) {
        return invalid(`actors[${actorIndex}].lanes[${laneIndex}].device must be one of: ${DEVICE_PRESET_NAMES.join(", ")}.`);
      }
      lane.device = device;
    }
    const persona = str(entry.persona);
    if (persona !== undefined) lane.persona = persona;
    const actorType = parseLaneMetadata(entry.actorType, `actors[${actorIndex}].lanes[${laneIndex}].actorType`);
    if (!actorType.ok) return actorType;
    if (actorType.value !== undefined) lane.actorType = actorType.value;
    const surface = parseLaneMetadata(entry.surface, `actors[${actorIndex}].lanes[${laneIndex}].surface`);
    if (!surface.ok) return surface;
    if (surface.value !== undefined) lane.surface = surface.value;
    const caseGroup = parseLaneMetadata(entry.caseGroup, `actors[${actorIndex}].lanes[${laneIndex}].caseGroup`);
    if (!caseGroup.ok) return caseGroup;
    if (caseGroup.value !== undefined) lane.caseGroup = caseGroup.value;
    const instruction = str(entry.instruction);
    if (instruction !== undefined) lane.instruction = instruction;
    const stopWhenResult = parseStopWhen(entry.stopWhen, `actors[${actorIndex}].lanes[${laneIndex}].stopWhen`);
    if (!stopWhenResult.ok) return stopWhenResult;
    if (stopWhenResult.value !== undefined) lane.stopWhen = stopWhenResult.value;
    const target = str(entry.target);
    if (target !== undefined) {
      if (!isHttpUrl(target)) {
        return invalid(`actors[${actorIndex}].lanes[${laneIndex}].target must be an absolute http(s) URL.`);
      }
      lane.target = target;
    }
    // `entry` is shape-captured here; the same-origin-with-serve.url check needs serve context, so
    // it runs in sharedWorldValidationReason (where the route + serve.url are known).
    const laneEntry = str(entry.entry);
    if (laneEntry !== undefined) lane.entry = laneEntry;
    lanes.push(lane);
  }
  return { ok: true, value: lanes };
}

function parseStopWhen(raw: unknown, field: string): { ok: true; value: StopWhen | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid(`${field} must be an object ({ any: [{ id?, urlIncludes?, urlPathEquals?, textIncludes?, appStatePathEquals? }] }).`);
  }
  if (!Array.isArray(raw.any) || raw.any.length === 0) {
    return invalid(`${field}.any must be a non-empty array of stop condition rules.`);
  }
  const any: StopWhenRule[] = [];
  for (const [index, entry] of raw.any.entries()) {
    if (!isRecord(entry)) {
      return invalid(`${field}.any[${index}] must be an object ({ id?, urlIncludes?, urlPathEquals?, textIncludes?, appStatePathEquals? }).`);
    }
    const rule: StopWhenRule = {};
    const id = str(entry.id);
    if (id !== undefined) {
      if (!LANE_ID_PATTERN.test(id) || id.length > LANE_METADATA_MAX_CHARS) {
        return invalid(`${field}.any[${index}].id must be a public-safe token matching ${LANE_ID_PATTERN} and at most ${LANE_METADATA_MAX_CHARS} chars; got "${id}".`);
      }
      rule.id = id;
    }
    const urlIncludes = str(entry.urlIncludes);
    if (urlIncludes !== undefined) {
      rule.urlIncludes = urlIncludes;
    }
    const urlPathEquals = str(entry.urlPathEquals);
    if (urlPathEquals !== undefined) {
      if (!urlPathEquals.startsWith("/") || urlPathEquals.startsWith("//")) {
        return invalid(`${field}.any[${index}].urlPathEquals must be an absolute URL path starting with one slash.`);
      }
      rule.urlPathEquals = urlPathEquals;
    }
    const textIncludes = str(entry.textIncludes);
    if (textIncludes !== undefined) {
      rule.textIncludes = textIncludes;
    }
    if (entry.appStatePathEquals !== undefined) {
      const parsed = parseStopWhenAppStatePathEquals(entry.appStatePathEquals, `${field}.any[${index}].appStatePathEquals`);
      if (!parsed.ok) return parsed;
      rule.appStatePathEquals = parsed.value;
    }
    if (rule.urlIncludes === undefined && rule.urlPathEquals === undefined && rule.textIncludes === undefined && rule.appStatePathEquals === undefined) {
      return invalid(`${field}.any[${index}] must declare at least one condition: urlIncludes, urlPathEquals, textIncludes, or appStatePathEquals.`);
    }
    any.push(rule);
  }
  return { ok: true, value: { any } };
}

function parseStopWhenAppStatePathEquals(
  raw: unknown,
  field: string
): { ok: true; value: { path: string; equals: StopConditionPrimitive } } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid(`${field} must be an object ({ path, equals }).`);
  }
  const pathValue = str(raw.path);
  if (pathValue === undefined) {
    return invalid(`${field}.path is required and must be a dot-separated public-safe path.`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(pathValue)) {
    return invalid(`${field}.path must contain only letters, digits, underscore, dash, and dot.`);
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "equals")) {
    return invalid(`${field}.equals is required.`);
  }
  const equals = raw.equals;
  if (equals !== null && typeof equals !== "string" && typeof equals !== "number" && typeof equals !== "boolean") {
    return invalid(`${field}.equals must be a string, number, boolean, or null.`);
  }
  return { ok: true, value: { path: pathValue, equals } };
}

function parseLaneMetadata(raw: unknown, field: string): { ok: true; value: string | undefined } | LabConfigParseFailure {
  const value = str(raw);
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!LANE_ID_PATTERN.test(value) || value.length > LANE_METADATA_MAX_CHARS) {
    return invalid(`${field} must be a public-safe token matching ${LANE_ID_PATTERN} and at most ${LANE_METADATA_MAX_CHARS} chars; got "${value}".`);
  }
  return { ok: true, value };
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
    if (target !== "local" && target !== "e2b-desktop" && target !== "e2b-terminal") {
      return invalid("`execution.target` must be local, e2b-desktop, or e2b-terminal.");
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
  const terminalResult = parseTerminal(raw.terminal);
  if (!terminalResult.ok) {
    return terminalResult;
  }
  if (terminalResult.value) execution.terminal = terminalResult.value;
  if (raw.runtimeAuth !== undefined) {
    const runtimeAuth = str(raw.runtimeAuth);
    if (runtimeAuth !== "openai-env") {
      return invalid("`execution.runtimeAuth` must be openai-env (the in-sandbox agent's command-scoped runtime-auth channel).");
    }
    execution.runtimeAuth = runtimeAuth;
  }
  return { ok: true, value: Object.keys(execution).length > 0 ? execution : undefined };
}

function parseTerminal(raw: unknown): { ok: true; value: LabExecutionTerminal | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`execution.terminal` must be an object ({ transport?, stdin? }).");
  }
  const terminal: LabExecutionTerminal = {};
  if (raw.transport !== undefined) {
    const transport = str(raw.transport);
    if (transport !== "exec-stream") {
      // "pty" is deliberately rejected: stdin is disabled, so the capture is a non-interactive
      // exec stream — an interactive-PTY label would overstate the mechanism (invariant 6 + the
      // goal packet's PTY ruling). True duplex PTY does not ship.
      return invalid("`execution.terminal.transport` must be exec-stream — captured non-interactive exec output (stdin disabled) is not an interactive PTY; true duplex PTY transport is not supported.");
    }
    terminal.transport = transport;
  }
  if (raw.stdin !== undefined) {
    const stdin = str(raw.stdin);
    if (stdin !== "disabled" && stdin !== "planned" && stdin !== "sent") {
      return invalid("`execution.terminal.stdin` must be disabled, planned, or sent.");
    }
    if (stdin === "sent") {
      // Assisted input is forbidden until the interventions ledger + comparability flag + verify
      // check exist (safety contract item 7) — shipping it now would let an assisted run pose as
      // autonomous green proof.
      return invalid("`execution.terminal.stdin: sent` (assisted input) is not supported — the current route cannot capture assisted input with a non-comparable marker. stdin is disabled by default.");
    }
    terminal.stdin = stdin;
  }
  return { ok: true, value: Object.keys(terminal).length > 0 ? terminal : undefined };
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
  if (raw.browser !== undefined) {
    const browser = str(raw.browser);
    if (browser !== "default" && browser !== "chrome" && browser !== "chromium" && browser !== "firefox") {
      return invalid("`execution.desktop.browser` must be default, chrome, chromium, or firefox.");
    }
    desktop.browser = browser;
  }
  // A custom E2B desktop template NAME or ID. Trimmed non-empty when present; deliberately NOT
  // allowlisted (any string is a valid template name/id — over-restricting would reject real
  // adopter images). An explicitly-set but blank/whitespace value is a mistake, not a template.
  if (raw.template !== undefined) {
    const template = str(raw.template);
    if (template === undefined) {
      return invalid("`execution.desktop.template` must be a non-empty E2B desktop template NAME or ID when set (any string is accepted; there is no allowlist).");
    }
    desktop.template = template;
  }
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

function parseScenario(raw: unknown): { ok: true; value: LabScenario | undefined } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return { ok: true, value: undefined };
  }
  const scenario: LabScenario = {};
  const ref = str(raw.ref);
  if (ref) scenario.ref = ref;
  if (isRecord(raw.inline)) scenario.inline = raw.inline;
  const mode = str(raw.mode);
  if (mode === "dry-run" || mode === "live") scenario.mode = mode;
  const capsResult = parseCaps(raw.caps);
  if (!capsResult.ok) {
    return capsResult;
  }
  if (capsResult.value) scenario.caps = capsResult.value;
  return { ok: true, value: Object.keys(scenario).length > 0 ? scenario : undefined };
}

/**
 * Parse `scenario.caps`. Returns a parse failure on a malformed value rather than silently
 * dropping a budget declaration (a cap that silently does nothing would be a safety lie —
 * invariant 6). Each cap must be a non-negative finite number.
 */
function parseCaps(raw: unknown): { ok: true; value: LabScenarioCaps | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`scenario.caps` must be an object ({ maxUsd?, maxJobs?, maxMinutes? }).");
  }
  const caps: LabScenarioCaps = {};
  for (const key of ["maxUsd", "maxJobs", "maxMinutes"] as const) {
    if (raw[key] === undefined) continue;
    const value = nonNegNumber(raw[key]);
    if (value === undefined) {
      return invalid(`\`scenario.caps.${key}\` must be a non-negative number.`);
    }
    caps[key] = value;
  }
  return { ok: true, value: Object.keys(caps).length > 0 ? caps : undefined };
}

function parsePolicies(raw: unknown): LabPolicies | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const policies: LabPolicies = {};
  if (typeof raw.redactRepos === "boolean") policies.redactRepos = raw.redactRepos;
  if (typeof raw.redactScreenshots === "boolean") policies.redactScreenshots = raw.redactScreenshots;
  if (typeof raw.allowPublicTargets === "boolean") policies.allowPublicTargets = raw.allowPublicTargets;
  if (typeof raw.allowPrivateRepoAccess === "boolean") policies.allowPrivateRepoAccess = raw.allowPrivateRepoAccess;
  if (typeof raw.allowProviderCredentials === "boolean") policies.allowProviderCredentials = raw.allowProviderCredentials;
  if (typeof raw.allowPaymentCredentials === "boolean") policies.allowPaymentCredentials = raw.allowPaymentCredentials;
  if (typeof raw.allowGitHubMutation === "boolean") policies.allowGitHubMutation = raw.allowGitHubMutation;
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
  return { ok: false, error: { code: "HUMANISH_LAB_INVALID", message } };
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

/** A non-negative finite number (0 allowed — caps default to 0 = no-spend). Accepts a numeric
 *  string too, since YAML scalars can arrive as strings. */
function nonNegNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}
