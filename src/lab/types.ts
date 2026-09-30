import { type LabAnalysis } from "../analysis/automatic-config.js";
import type { LabTask } from "./tasks.js";
import type { DwellWindow, StopWhen } from "../actors/stop-conditions.js";
import { type ReasoningEffort } from "../actors/reasoning-effort.js";

export const LAB_CONFIG_SCHEMA = "humanish.lab.v2";

// Must start alphanumeric so an id never collides with the path-vs-id resolver heuristic
// (a leading "." or "/" is read as a file path; a leading "-" collides with CLI flags).
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

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
export type LabSubjectSource =
  | "this-repo"
  | "clone"
  | "app-url"
  | "local-app"
  | "terminal-product"
  | "desktop-cli"
  | "local-tree";

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
   * How the product gets onto the machine, run UNKEYED before the participant starts, in the
   * lane's working directory. Consumed on BOTH product routes: `desktop-cli` (a person at a
   * desktop) and `terminal-product` (an agent in a shell).
   *
   * Absent means the participant installs it themselves from the public surfaces, which is a
   * different study — one about the install, not about the tool. Present means the study starts
   * where you want it to start: asking a participant what studies a project contains, in an empty
   * directory, measures the lab rather than the product.
   * Both routes prepare Node/npm when install is absent; product installation remains the
   * participant's task. A missing template runtime must not become a product finding.
   */
  install?: string;
  /**
   * `desktop-cli` ONLY: the directory the participant's terminal opens in. Absent means the home
   * directory. (The terminal-product lane has its own fixed study workdir.)
   *
   * This exists because the first live study failed on it: the participant was asked what studies
   * the project contained, landed in an empty home directory, correctly reported that there was no
   * project, and stopped. The finding was about the lab, not the product. A study of a
   * project-scoped tool has to put the participant IN a project, the same way an app study opens
   * the app rather than a blank tab.
   */
  workdir?: string;
  /**
   * The product's PUBLIC surfaces — the only world the agent sees. Each must be an http(s) URL
   * (e.g. a docs page, an llms.txt, a skill manifest). Validated at parse; recorded in evidence.
   */
  publicSurfaces: string[];
  /**
   * `terminal-product` ONLY: a local file uploaded into the sandbox before `install` runs, and
   * exposed to it as `$HUMANISH_PRODUCT_UPLOAD`. A project-relative path; `..` and absolute paths
   * are refused, because this reads a file off the operator's disk and puts it on a machine an
   * autonomous agent is about to drive.
   *
   * It exists so a study can test a build that is NOT PUBLISHED YET. Installing `@latest` measures
   * the last release, which is exactly the wrong artifact for a pre-release gate — the point is to
   * meet the candidate before anyone else does. Any adopter shipping a CLI wants the same thing.
   */
  upload?: string;
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
  /**
   * EXTERNAL-PUBLIC shared-world route ONLY (#164 phase 2): the author's REQUIRED ownership
   * attestation when a real PUBLIC deployment (`source: app-url` + `topology: shared-world` +
   * `concurrency > 1` + `policies.allowPublicTargets: true`) is used directly as the shared plane.
   * The harness neither provisions nor exposes this target (no getHost, no clone, no seed), so it
   * cannot attest the data is synthetic; instead the operator MUST attest they own/operate it.
   * `owner` is a public-safe operator/repo label; `authorized` must be true. This is author-trust —
   * the harness cannot verify ownership — surfaced honestly in the evidence class. Required on the
   * external-public branch. On a non-`app-url` subject it is REJECTED (parse error); on any OTHER
   * `app-url` config that does not route to external-public shared-world it is IGNORED-WITH-A-WARNING
   * (forwardDeclaredWarnings), never silently consumed — it is meaningless without that plane.
   */
  publicTarget?: { owner: string; authorized: boolean };
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
   * LITERAL, NON-SECRET env values committed alongside the lab — the configuration every real app
   * needs before it will boot: a public base URL, a transport selector, a feature flag. None of that
   * is secret, and routing it through `subject.env` would force an adopter to carry a private env
   * file just to reproduce a public study, which is the opposite of a reproducible lab.
   *
   * These values ARE recorded in evidence, because they are part of how the subject was configured,
   * so a value that looks like a secret or a local path is refused at parse rather than committed to
   * a public repo. Anything genuinely secret belongs in `subject.env`.
   */
  envValues?: Record<string, string>;
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
  /** Named hosted-screen preset for this lane. XOR raw execution.desktop.resolution. */
  device?: string;
  /** Per-lane steer appended to this lane's mission (the roster's per-lane focus). */
  instruction?: string;
  /**
   * Deterministic lane completion guard. When set, this lane stops as soon as the runtime
   * observation matches any declared rule; actor-level stopWhen is used as the default.
   */
  stopWhen?: StopWhen;
  /** A declared observation window for THIS lane (#510); actor-level dwell is the default. */
  dwell?: DwellWindow;
  /**
   * How hard the model is asked to think in THIS lane; actor-level reasoningEffort is the default.
   *
   * The single-run control: same persona, same mission, two efforts, one set of conditions.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * App-url computer-use ONLY: absolute browser URL this lane opens instead of `subject.appUrl`.
   * This is the generic setup-produced-target handoff for crawler/swarm labs: product adapters may
   * start any topology they need, then hand humanish explicit lane targets. Public/non-loopback
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
  /**
   * EXTERNAL-PUBLIC shared-world ONLY (#164 phase 2): marks this lane the DESIGNATED HOST seat — it
   * creates the shared session (e.g. a multiplayer lobby) that the follower seats then join. Exactly
   * ONE lane in the roster may carry `host: true` (validated in externalPublicSharedWorldValidationReason).
   * The orchestrator watches the host seat's observed URL for the shared-session code and threads it
   * into the follower missions at a host-first barrier. Inert/warned on every other route.
   */
  host?: boolean;
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
   * actor registry. On the synthetic route it remains a free-form descriptive label (e.g.
   * synthetic-persona). The terminal route owns its live lifecycle after using
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
  /** Free-form mission threaded into the actor prompt. Consumed on the app-url route. A mission on
   *  its own is a complete, valid lab — `tasks` is additive, never required. */
  mission?: string;
  /**
   * The researcher's protocol: discrete tasks, each with what the participant is asked to do and
   * (optionally) how the researcher measures it. Additive to `mission`, which stays the brief.
   *
   * The two halves belong to different people. `goal` reaches the participant's prompt; `success`
   * never does — a moderator does not read the success criterion aloud, because telling someone how
   * they will be judged changes what they do. See src/lab/tasks.ts.
   * Supported only on the first actor of per-lane CUA routes; other routes fail preflight.
   */
  tasks?: LabTask[];
  /** Provider model override. Consumed on the app-url route. */
  model?: string;
  /** First-party OpenAI CUA only: per-response output limit including reasoning, not a dollar cap. */
  maxOutputTokens?: number;
  /**
   * `local-agent` ONLY: which locally signed-in coding agent is the brain. Absent = codex.
   *
   * A separate field from `model` on purpose. The first cut of this route overloaded `model` to
   * mean BOTH which CLI and which model, which left no way to say "Claude Code, running Opus" —
   * two different choices wearing one name.
   */
  localAgent?: "codex" | "claude";
  /**
   * How hard the model is asked to think, per turn. Lane-level `reasoningEffort` overrides this.
   *
   * Absent means the PROVIDER's default, and absence is recorded as absence: a run that did not
   * declare an effort does not claim one. Support is model-dependent (see src/actors/reasoning-effort.ts),
   * so a level a model does not accept fails on the first turn rather than being downgraded.
   *
   * This is a recruiting decision, not a tuning knob: it changes who the participant IS, the same
   * way a persona prompt does. Two lanes running the same persona and mission at different efforts
   * is therefore a CONTRAST between two participants, not a control for an instrument — a lane that
   * abandons at one level and completes at another has reported on both of them. The obligation it
   * creates is to declare and record, never to hold it constant. See
   * docs/principles/actor-fidelity.md.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Deterministic completion guard used as the default for CUA lanes. Lane-level stopWhen
   * overrides this value.
   */
  stopWhen?: StopWhen;
  /**
   * A declared observation window (#510), the default for every lane; lane-level dwell overrides
   * it. `when` is a stopWhen-shaped condition (absent: the window opens after the first
   * observation); `ms` is the hold, `everyMs` the frame cadence (default 10 s), `then` whether
   * the participant continues afterwards (default) or the session ends. The harness takes no
   * action and requests no model turn during the window.
   */
  dwell?: DwellWindow;
}

type LabExecutionTarget = "local" | "e2b-desktop" | "e2b-terminal";

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
 * The terminal agent's runtime-auth channel. "openai-env" (the default) passes the raw runtime
 * key command-scoped. "openai-egress" keeps it in an E2B outbound header transform for the default
 * OpenAI endpoint and passes an inert placeholder to Codex. The latter still gives every sandbox
 * process a spendable OpenAI proxy capability; it is not a spend cap or an egress restriction.
 */
export type LabRuntimeAuth = "openai-env" | "openai-egress";

export type LabDesktopBrowser = "default" | "chrome" | "chromium" | "firefox";

export interface LabExecutionDesktop {
  /**
   * Named device preset (mobile / small-mobile / narrow-mobile / tablet / desktop / wide) the
   * run renders at. Consumed on the computer-use route; default `desktop` (1440x950). On that
   * route only width/height physically render (the X screen is sized to the preset, so
   * width-based responsive CSS fires) — touch/DPR/UA are sim-parity prompt signals, not rendered.
   */
  device?: string;
  /** Raw hosted screen resolution [width, height] — an escape hatch that overrides `device`. */
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
  /**
   * Mobile fidelity beyond viewport size (#221). With `mobileEmulation: true`, every hosted
   * Chromium computer-use lane ON A MOBILE PRESET (mobile / small-mobile / narrow-mobile) gets
   * CDP device emulation applied to its launch page before the participant arrives; desktop,
   * tablet and wide lanes in the same run are untouched and carry no fidelity block. Applied: the lane's device preset width/height as the CSS viewport, the preset's
   * device pixel ratio (or `deviceScaleFactor`), touch events (`touch`, default true) and a mobile
   * user agent (`userAgent`, default an iPhone Safari string). The bundle records what the page
   * then reported about itself under `desktopGeometry.fidelity`; a browser that cannot be
   * emulated (Firefox) fails the lane closed instead of shipping a desktop run labelled mobile.
   * A held CDP session also applies the overrides to later page targets. Their first observed
   * viewport and touch read-back is recorded separately; missing or different values warn.
   */
  fidelity?: LabDesktopFidelity;
  /** Synthetic media devices behind the browser's own permission prompt (#509). */
  media?: LabDesktopMedia;
  /** Optional retained screen video. Capture is independent of participant media input. */
  recording?: { audio: boolean };
}

/**
 * A participant with a camera (#509): a property of the ENVIRONMENT, like the screen preset and
 * the browser, never support for any conferencing product. `camera.source: synthetic` generates
 * a test pattern in the sandbox with the image's own ffmpeg; a `.y4m` path on the host is
 * uploaded instead on hosted desktops. `microphone.source: speech` enables the participant's
 * own spoken replies and listening through native audio devices. File microphones are unsupported.
 */
export interface LabDesktopMedia {
  camera?: { source: string };
  microphone?: { source: string };
}

export interface LabDesktopFidelity {
  mobileEmulation: boolean;
  /** Emulated devicePixelRatio; default: the device preset's. */
  deviceScaleFactor?: number;
  /** Emulate touch (coarse pointer, touch events); default true. */
  touch?: boolean;
  /** Full user-agent string to present; default: a mobile Safari string. */
  userAgent?: string;
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
  /**
   * Blast-radius budget for the computer-use lane. CONSUMED on the CUA route: `caps.maxUsd`, when
   * set, is a FAIL-CLOSED abort — the session stops the moment its running ESTIMATED spend crosses
   * it (the runaway-retry guard), and a cap on a model src/run/pricing.ts cannot price is REFUSED at
   * preflight rather than run uncapped. It is a PER-LANE cap: enforced inside each lane's loop, so
   * an N-lane fan-out can spend up to N × maxUsd before any lane aborts (the run warns with the
   * true ~N × cap ceiling). `caps.maxTotalUsd` is the shared STUDY budget (#299): one ledger
   * across every lane, the knob a researcher actually reasons with. Absent = UNCAPPED (the
   * historical CUA behavior); maxUsd: 0 still permits a request before reported usage trips it. Inert
   * (warned) on non-CUA routes. Reuses the same LabScenarioCaps shape as the terminal lane's
   * `scenario.caps` (not a fork).
   */
  caps?: LabScenarioCaps;
  /** `terminal-product` route: the terminal transport + stdin posture. Consumed on that route. */
  terminal?: LabExecutionTerminal;
  /** `terminal-product` route: runtime key placement, defaulting to openai-env. openai-egress
   *  uses an external header transform; dry-runs record declarations only. Inert on other routes. */
  runtimeAuth?: LabRuntimeAuth;
  /** Terminal Codex package pin. Omit to resolve latest once, observe it, then execute that version. */
  runtime?: { version: string };
  /**
   * `terminal-product` route: outbound routing allowlist passed to E2B with a deny-all fallback.
   * Domain filtering is a routing control, not strict destination isolation on shared hosting.
   * It does not constrain spending through an allowed runtime provider (#538), including when
   * openai-egress keeps the raw runtime key outside the sandbox.
   *
   * Absent means unrestricted, which is the historical behavior and stays the default, because a
   * wrong host list fails studies in ways that look like product bugs. Opt in per lab.
   *
   * Domain filtering covers HTTP on :80 (Host header) and TLS on :443 (SNI); anything else needs
   * an IP or CIDR. `*.example.com` matches subdomains at any depth and NOT the apex, which needs
   * its own entry.
   */
  egressAllow?: string[];
}

type LabScenarioMode = "dry-run" | "live";

/**
 * The blast-radius budget for a route that passes a live key to an in-sandbox command.
 * Per the safety contract, the live key is never exercised without a fail-closed cap in force.
 * All values are non-negative numbers (0 is the no-spend default). Live runs require maxUsd and a
 * positive maxMinutes; maxUsd/maxJobs are checked after the session against known ledger signals
 * and maxMinutes is enforced as the command wall clock. Codex tokens are unpriced, so a live run
 * refuses a positive maxUsd unless a costProbe measures spend (HUMANISH_TERMINAL_LAB_UNPRICED_CAP).
 */
export interface LabScenarioCaps {
  /** Max USD the run may spend (provider + product). 0 = no-spend. */
  maxUsd?: number;
  /**
   * STUDY-LEVEL model-spend budget (#299), the number a researcher actually reasons with: "this
   * study is N participants, roughly $X" — decided once, up front, where recruiting decisions are
   * made. The computer-use route reads it from `execution.caps.maxTotalUsd` only: every lane's
   * running ESTIMATED model spend feeds one shared ledger, and the moment the run total crosses
   * this, each lane stops at its next turn with an honest `budget_reached` (status `incomplete` —
   * the participant ran out of budget; never `gave_up`, because a study-level stop is not the
   * participant's doing). Estimated MODEL spend only — desktop-minutes ride the cost summary but
   * not this ledger. Independent of the per-lane `maxUsd` backstop; either, both, or neither may
   * be set. A positive `scenario.caps.maxTotalUsd` on a computer-use lab is a parse error; on the
   * terminal route it is inert (warned), since the single agent's maxUsd already caps the run.
   */
  maxTotalUsd?: number;
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
   * Redact target repo labels in durable artifacts. Consumed on the computer-use,
   * scripted-browser and shared-world clone routes (provenance), where it DEFAULTS to true when
   * the clone authenticates via GITHUB_TOKEN (a token-bearing clone is treated as private until
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
   * How the browser's camera/microphone permission is answered (#509). `prompt` (default): the
   * participant meets Chrome's real dialog and answers it, which is where a real person hesitates
   * or refuses. `granted`: the dialog is bypassed (`--use-fake-ui-for-media-stream`, which Chrome
   * marks with an "unsupported command-line flag" banner), for studies about what happens after
   * the gate.
   */
  mediaPermission?: "prompt" | "granted";
  // Terminal-product credential-boundary declarations — all DEFAULT FALSE (deny-by-default). The
  // shipped live engine always passes only the runtime LLM key, command-scoped, and records these
  // booleans as evidence. Setting one true records intent but does not create an injection channel
  // or authorize any additional credential in the current route.
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
  /** Analysis defaults on for eligible live recordings; false disables the separate request. */
  analysis?: LabAnalysis | false;
  /** FORWARD-DECLARED (PR #2). */
  scoring?: string;
  /** FORWARD-DECLARED (PR #2). */
  milestones?: string;
  /** FORWARD-DECLARED (PR #2). */
  vocabulary?: string;
  /**
   * #316 code escape hatch: a repo-relative path to an adopter scorer module (.mjs recommended) that
   * exports any of `{score, deriveFeedback, deriveArtifacts}`. CONSUMED on the scorer-capable routes
   * (terminal / computer-use / shared-world); loaded fail-closed (typed error, pre-spend). The entry
   * is executable code — review a PR that adds one as code, not config.
   */
  scorer?: { ref: string };
}

export interface LabDefaults {
  open?: boolean;
}

/** Off-app comms (email/SMS the persona lives in) the harness provides for the run (#297). */
export interface LabComms {
  email?: LabCommsEmail;
}

export interface LabCommsSmtp {
  /** Fixed in-sandbox loopback SMTP port (default 2525). Known before sandbox create, like `port`. */
  port?: number;
  /** The subject-env var carrying the SMTP host. The harness sets it to 127.0.0.1. */
  hostEnv: string;
  /** The subject-env var carrying the SMTP port. The harness sets it to the port above. */
  portEnv: string;
  /** Optional subject-env vars for a username/password the app insists on sending. The catch accepts
   *  any credentials (it is loopback-only), but many apps refuse to start without the vars set. */
  userEnv?: string;
  passwordEnv?: string;
  /** The value written to `userEnv`/`passwordEnv` when those are declared. Never a real secret. */
  user?: string;
  password?: string;
}

export type LabCommsEmail = LabCommsCaptureEmail | LabCommsReceivingEmail;

export interface LabCommsReceivingEmail {
  kind: "real";
  connection: string;
  /** Additional exact first-hop destinations; automatic remote email assets remain blocked. */
  allowedOrigins?: string[];
  linkOrigin?: string;
  port?: never;
  injectEnv?: never;
  smtp?: never;
  recipients?: never;
  external?: never;
}

interface LabCommsCaptureEmail {
  connection?: never;
  allowedOrigins?: never;
  /** Which implementation backs the inbox (a backend discriminator, distinct from `scenario.mode`):
   *  `fake` (default) is an in-harness in-memory inbox in the Fowler test-double sense — an in-sandbox
   *  catch captures the app's sends. Provider-backed receiving uses the separate
   *  LabCommsReceivingEmail configuration selected by a saved connection. */
  kind: "fake";
  /**
   * The subject-env var the harness sets to the in-sandbox catch's base URL — ADOPTER-NAMED (an app
   * calling Resend's API directly reads `RESEND_API_URL`; an app using the SDK reads `RESEND_BASE_URL`).
   * The value is computed by the harness (a loopback URL), so it is NOT declared in `subject.env`.
   * REQUIRED on the provisioned routes; absent (and meaningless) when `external` is declared,
   * because there the adopter runs the catch and points their own app at it.
   */
  injectEnv?: string;
  /** Fixed in-sandbox loopback port the catch listens on (default 8025). Known before sandbox create. */
  port?: number;
  /**
   * SMTP transport, for the many self-hostable apps that send mail through SMTP rather than a
   * provider's HTTP API. The catch opens a loopback SMTP listener and normalizes what it receives
   * into the same captured-send shape the HTTP path produces, so the inbox surface, the drain, and
   * the evidence artifact are identical either way.
   *
   * `hostEnv` and `portEnv` are ADOPTER-NAMED, exactly like `injectEnv`: the harness sets them to
   * its own loopback and the chosen port. Declare the pair your app actually reads.
   */
  smtp?: LabCommsSmtp;
  /** Optional escape hatch: the exact absolute origin the app-under-test bakes into its email verify
   *  links, when that differs from the serve origin (e.g. an app configured with an absolute
   *  APP_URL/NEXT_PUBLIC_BASE_URL). The harness cannot infer it, so the operator declares it; it is
   *  prepended to the inbox link-origin rewrite so the persona's clicked link resolves to a reachable
   *  host. Omit when the app emits loopback links (the default derivation covers those). */
  linkOrigin?: string;
  /** Each lane's inbox address: the actor is TOLD to sign up with it (the injected inbox
   *  instruction carries it) and the teardown drain matches captured mail against it. Omit the
   *  whole list and the parser fills one deterministic address per lane (`<laneId>@example.test`)
   *  so every seat can do email out of the box (#351). When declared: a `lane` naming a lane that
   *  does not exist is a hard parse error (a mismatch silently disables the funnel for that seat),
   *  zero covered lanes is a hard error, and partial coverage warns with the uncovered lanes. An
   *  entry without `address` is legal but inert for the funnel — it is NOT matched by the drain
   *  and its lane gets no inbox instruction; captured mail to an undeclared address is warned,
   *  never silently dropped. */
  recipients?: LabCommsRecipient[];
  /**
   * ADOPTER-HOSTED ingress (#328). Declaring this says: the operator runs the catch and the inbox
   * themselves, so humanish neither provisions the subject nor injects `injectEnv` — it points the
   * persona at the declared inbox, drains the declared catch over HTTP at teardown, and writes the
   * same digest-only evidence. This is what makes comms work on the app-url / operator-provisioned
   * plane, where humanish holds no sandbox handle to host a catch in and the block was previously
   * warned inert. Run the same implementation with `humanish comms catch`.
   */
  external?: LabCommsExternal;
}

export interface LabCommsExternal {
  /** Where the adopter's app POSTs its email sends, and where humanish reads GET /deliveries. */
  catchBaseUrl: string;
  /** Where the persona opens its inbox. Defaults to catchBaseUrl (one server serves both). */
  inboxBaseUrl?: string;
  /** Env var NAME holding the bearer token for the drain read. The NAME is recorded as evidence;
   *  the value is read at runtime and never persisted (the credential-boundary discipline). */
  authTokenEnv?: string;
}

export interface LabCommsRecipient {
  lane: string;
  /** The literal address the app sends to — what the evidence drain matches. Omit to reserve the lane
   *  for the persona surface's default address (not drain-matched). */
  address?: string;
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
  comms?: LabComms;
}

interface LabConfigParseSuccess {
  ok: true;
  config: LabConfig;
  warnings: string[];
}

export interface LabConfigParseFailure {
  ok: false;
  error: { code: "HUMANISH_LAB_INVALID"; message: string };
}

export type LabConfigParseResult = LabConfigParseSuccess | LabConfigParseFailure;
