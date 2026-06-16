// The terminal-product lab backend: a real autonomous agent (Codex) studying a CLI/product from
// PUBLIC SURFACES ONLY, running INSIDE an E2B shell with command-scoped runtime auth, capturing
// its non-interactive exec output (stdin disabled) as a redacted event stream + normalized
// transcript, capped at no-spend, emitting durable terminal/substrate/cost/no-spend/cleanup/
// intervention proof. Mirrors cua-actor-lab.ts / scripted-browser-lab.ts.
//
// SLICE 2 SCOPE: BOTH paths are now implemented.
//   - DRY-RUN: a contract-only `mimetic.run-bundle.v1`, honestly labeled (unchanged from SLICE 1).
//   - LIVE: the real create -> inject (command-scoped) -> run `codex exec --json` -> capture
//     (scrub+redact at the source) -> score (verdict-nonce marker) -> teardown (proven cleanup)
//     orchestrator on the @e2b/desktop commands.run surface.
//
// THE SAFETY CONTRACT (docs/goals/terminal-product-lane/goal.md) is enforced BY CONSTRUCTION here
// and CHECKED by the verifier (run.ts validateTerminalProductEvidence):
//   1. COMMAND-SCOPED KEY. The runtime LLM key is injected ONLY into the per-command `envs` of the
//      `codex exec` invocation (commands.run({envs})), NEVER Sandbox.create({envs}) — driven off
//      the registered actor's keyPlacement: "in-sandbox-command-scoped" capability (engine-
//      enforced: a terminal actor lacking that metadata FAILS CLOSED before any sandbox exists).
//   2. FAIL-CLOSED CAP. The live key is never exercised without scenario.caps in force: maxUsd
//      (default/require 0 = no-spend) + maxMinutes (wall-clock kill of the codex command).
//   3. PUBLIC SURFACES ONLY. The mission references only subject.product.publicSurfaces + the
//      author mission. No clone, no private-source access — nothing is git-cloned in this lane.
//   4. DENY-BY-DEFAULT CREDENTIALS. The command envs are built from an ALLOWLIST of ONLY the
//      declared runtime key; GITHUB_TOKEN/GH_TOKEN/payment/deploy/db/media keys are excluded by
//      construction (a banned-name guard also fails closed if one is ever requested).
//   5. NO SECRET VALUES IN EVIDENCE. Every captured byte (event stream, transcript, command logs,
//      agent report, metadata) passes scrubKnownValues (literal scrub of the runtime key + any
//      provisioned values, >=4 chars, PRE-truncation) THEN redactText (shape patterns) BEFORE
//      persisting. The transport is labeled HONESTLY (exec-stream/snapshot, NOT an interactive pty).
//   6. METADATA POSITIVE ALLOWLIST. buildSandboxMetadata(allowlist) is the ONLY way metadata is
//      set; it carries solely non-secret labels (mode/tool/labId/simId/provider/runId).
//   7. STDIN DISABLED + INTERVENTIONS LEDGER. stdin is never wired to the codex command; the
//      bundle ALWAYS carries an interventions ledger (empty array is valid + required-present).
//   8. PROVEN CLEANUP. Sandbox.kill in a finally; a cleanup proof (killed + remaining==0 via
//      Sandbox.list where supported, else killed + reason) is persisted. A live run that cannot
//      prove teardown fails closed.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ActorCompletionReason, ActorPersonaRef, ActorStatus, ActorTrace, ActorTraceItem } from "./actor-contract.js";
import { ACTOR_TRACE_SCHEMA, TERMINAL_AGENT_CAPABILITIES } from "./actor-contract.js";
import { actorRegistry, isTerminalActorDescriptor } from "./actor-registry.js";
import type { LabConfig, LabScenarioCaps } from "./lab-config.js";
import {
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import { renderObserver, type ObserverResult } from "./observer.js";
import { digestText, redactText } from "./redaction.js";
import {
  buildRunSource,
  extractLocalActorVerdict,
  normalizeLocalActorTranscript,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream
} from "./run.js";
import { TERMINAL_AGENT_NOT_IMPLEMENTED_CODE } from "./terminal-agent-actor.js";

/** Provider-neutral metadata constant: the lane's non-secret tag (mirrors CUA_ACTOR_LAB_PROVIDER_METADATA). */
export const TERMINAL_PRODUCT_LAB_PROVIDER_METADATA = {
  mode: "terminal-product-lab",
  tool: "mimetic-cli"
} as const;

// The terminal-product ledger schemas the verifier asserts present on a LIVE bundle. They ride the
// existing terminal stream + events (mimetic.run-bundle.v1 is unchanged); these constants name the
// artifact files so the producer and verifier cannot drift on the path.
export const TERMINAL_EVENTS_ARTIFACT = "terminal-events.ndjson";
export const TERMINAL_TRANSCRIPT_ARTIFACT = "terminal-transcript.txt";
export const TERMINAL_LEDGERS_ARTIFACT = "terminal-ledgers.json";

/** The in-sandbox working directory for the agent (a scratch dir; nothing is cloned into it). */
const SANDBOX_WORKDIR = "/home/user/study";
// Server-side reclamation buffer past the codex command's own wall-clock (caps.maxMinutes) kill.
const SANDBOX_TIMEOUT_BUFFER_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// How much of a captured stream / log tail rides a (redacted) message field.
const TAIL_CHARS = 2000;
// Hard cap on the retained event-stream + transcript size, so a runaway agent cannot balloon the
// bundle. Redaction runs PRE-truncation so a cut can never split a secret past the scrubber.
const MAX_TRANSCRIPT_BYTES = 512 * 1024;

export const TERMINAL_PRODUCT_LAB_SCHEMA = "mimetic.terminal-lab-result.v1";

/**
 * Library-level hooks: the DI seams that drive the full live path against a fake sandbox + mock
 * CLI at zero spend. The deterministic merge-gate test wires loadModule (a fake @e2b/desktop
 * module) + env (the operator key source) + now (an injected clock); the live rung uses none of
 * them (it loads the real module and reads the real environment).
 */
export interface TerminalProductLabHooks {
  /** Lazy-load the E2B module (tests inject a fake; default loadE2BDesktopModule). */
  loadModule?: () => Promise<E2BDesktopModule>;
  /**
   * The operator environment the lane reads the runtime key from (and from which it asserts no
   * banned credential is requested). Defaults to process.env. The runtime key is injected ONLY
   * into the command-scoped `codex` invocation — NEVER Sandbox.create envs (the credential
   * boundary); tests plant a fake key here and assert it never reaches metadata/global env/artifacts.
   */
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock for deterministic timestamps + wall-clock arithmetic (tests only). */
  now?: () => number;
}

export interface RunTerminalProductLabOptions {
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  hooks?: TerminalProductLabHooks;
}

export interface TerminalProductLabResult {
  schema: typeof TERMINAL_PRODUCT_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or the live session reached a terminal verdict
   *  without a harness error + cleanup was proven). The agent's pass/fail is evidence, not the
   *  lab's exit code. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the session. */
  actor: string;
  /** The studied product name (public-safe). */
  product: string;
  dryRun: boolean;
  runId: string;
  /** Live-only: the in-sandbox agent session verdict (omitted on dry-run / pre-session failure). */
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
  };
  /** Live-only: the sandbox lifecycle proof (the key/auth value is NEVER surfaced here). */
  sandbox?: {
    sandboxId: string;
    killed: boolean;
    /** Sandboxes still listed under this run's metadata after teardown (0 = proven reclaimed). */
    remaining: number;
  };
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "MIMETIC_TERMINAL_LAB_FAILED"
      | "MIMETIC_TERMINAL_LAB_ACTOR_UNSUPPORTED"
      | "MIMETIC_TERMINAL_LAB_SUBJECT_INVALID"
      | "MIMETIC_TERMINAL_LAB_KEYPLACEMENT_INVALID"
      | "MIMETIC_TERMINAL_LAB_RUNTIME_AUTH_MISSING"
      | "MIMETIC_TERMINAL_LAB_CAPS_MISSING"
      | "MIMETIC_TERMINAL_LAB_CREDENTIAL_DENIED"
      | "MIMETIC_TERMINAL_LAB_CLEANUP_UNPROVEN"
      | typeof TERMINAL_AGENT_NOT_IMPLEMENTED_CODE;
    message: string;
  };
}

export async function runTerminalProductLab(options: RunTerminalProductLabOptions): Promise<TerminalProductLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const render = hooks.renderObserverFn ?? renderObserver;
  const warnings: string[] = [];
  const actorType = config.actors[0]?.type ?? "";
  const product = config.subject.product;

  const failed = (
    code: NonNullable<TerminalProductLabResult["error"]>["code"],
    message: string,
    extras?: { actor?: string; product?: string }
  ): TerminalProductLabResult => ({
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: extras?.actor ?? actorType,
    product: extras?.product ?? product?.name ?? "",
    dryRun,
    runId: options.runId ?? "not-created",
    warnings,
    error: { code, message }
  });

  // Resolve the actor through the registry — the parse layer already validated this, but the
  // engine fails closed rather than trusting a config that arrived through another door
  // (runTerminalProductLab is itself exported npm surface).
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isTerminalActorDescriptor(descriptor)) {
    return failed(
      "MIMETIC_TERMINAL_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered terminal actor.`
    );
  }

  // Re-enforce the subject shape at the engine (the parser rejects these too, but this is exported
  // npm surface). A terminal-product subject MUST declare product.name + public surfaces.
  if (!product || !product.name || product.publicSurfaces.length === 0) {
    return failed(
      "MIMETIC_TERMINAL_LAB_SUBJECT_INVALID",
      "terminal-product subjects require `subject.product` with a name and at least one public surface URL.",
      { actor: descriptor.id }
    );
  }

  // LIVE path: the real in-sandbox agent session. A separate orchestrator owns the
  // create -> inject (command-scoped) -> run -> capture -> teardown lifecycle so the dry-run path
  // below stays a pure contract builder. It enforces the safety contract by construction (the
  // keyPlacement-routed command-scoped key, the deny-by-default allowlist, the fail-closed cap,
  // the proven cleanup) and fails closed before any sandbox/key/spend on any precondition miss.
  if (!dryRun) {
    return runLiveTerminalSession({ options, cwd, config, descriptorId: descriptor.id, product, warnings, render, failed });
  }

  const mission = config.actors[0]?.mission ?? defaultMission(product.name);
  const personaId = config.actors[0]?.persona ?? "autonomous-terminal-agent";
  // The composed prompt = mission + persona + public-surface manifest. Only the AUTHOR mission
  // goes plaintext into evidence (it is public-safe committed lab text); the full composed prompt
  // is recorded as a DIGEST (the safety contract's mission ruling).
  const composedPrompt = composePrompt({ mission, personaId, productName: product.name, publicSurfaces: product.publicSurfaces });
  const promptDigest = digestText(composedPrompt);
  const persona: ActorPersonaRef = { id: personaId, traitsApplied: [], promptDigest };

  const runId = options.runId ?? makeTerminalRunId();
  const artifactRoot = path.join(cwd, ".mimetic", "runs", runId);
  const createdAt = new Date().toISOString();
  await mkdir(artifactRoot, { recursive: true });
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    mimeticSource: "present",
    packageName: "mimetic-cli"
  });

  const bundle = buildTerminalProductBundle({
    actorId: descriptor.id,
    createdAt,
    dryRun,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    mission,
    persona,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    ...(config.scenario?.caps ? { caps: config.scenario.caps } : {}),
    ...(config.execution?.runtimeAuth ? { runtimeAuth: config.execution.runtimeAuth } : {}),
    stdin: config.execution?.terminal?.stdin ?? "disabled",
    policies: {
      allowPrivateRepoAccess: config.policies?.allowPrivateRepoAccess ?? false,
      allowProviderCredentials: config.policies?.allowProviderCredentials ?? false,
      allowPaymentCredentials: config.policies?.allowPaymentCredentials ?? false,
      allowGitHubMutation: config.policies?.allowGitHubMutation ?? false
    },
    runId,
    source
  });

  await writeFile(path.join(artifactRoot, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.json"), `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.md"), renderTerminalReviewMarkdown(bundle), "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  // Keep `verify --run latest` honest: point it at THIS run (mirrors run.ts's RunPointer).
  await writeFile(
    path.join(cwd, ".mimetic", "runs", "latest.json"),
    `${JSON.stringify({
      schema: "mimetic.latest-run.v1",
      runId,
      path: path.join(".mimetic", "runs", runId),
      updatedAt: createdAt
    }, null, 2)}\n`,
    "utf8"
  );

  const observer = await render(cwd, runId, { open: options.open === true });
  const ok = observer.ok;

  return {
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    product: product.name,
    dryRun,
    runId,
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: "MIMETIC_TERMINAL_LAB_FAILED" as const,
            message: observer.error?.message ?? "Observer failed for the terminal-product lab run."
          }
        })
  };
}

// ===========================================================================
// LIVE PATH
// ===========================================================================

/** Substrate lifecycle ledger entry (create/readiness/exec/cleanup events with timestamps). */
interface LifecycleRecord {
  at: string;
  event: string;
  /** Redacted+scrubbed before persisting (it never carries a secret, but the harness never trusts that). */
  message: string;
}

/** Command-log ledger entry: which command ran, with what exit/duration (NEVER its env values). */
interface CommandLogRecord {
  at: string;
  /** A public-safe label for the command (e.g. "codex-exec"); the full argv is bound by digest only. */
  label: string;
  /** sha256-12 of the exact command string — pins "same recipe" without persisting it. */
  commandDigest: string;
  /** The env var NAMES injected command-scoped (values NEVER persisted) — the credential evidence. */
  envNames: string[];
  exitCode?: number;
  timedOut?: boolean;
  durationMs: number;
}

/** One redacted terminal output event (the append-only NDJSON stream). */
interface TerminalEventRecord {
  at: string;
  stream: "stdout" | "stderr";
  /** ALREADY scrubbed (literal known values) THEN redacted (shape patterns) at the source. */
  chunk: string;
}

/**
 * One operator intervention (assisted-input event). SLICE 2 ships NO assisted-input path, so this
 * ledger is ALWAYS empty — but always PRESENT (the safety contract: empty-present is the contract,
 * an absent ledger fails verify). The shape is fixed now so an assisted path (deferred) can fill it.
 */
interface InterventionRecord {
  at: string;
  kind: "stdin";
  /** Redacted+scrubbed digest of the injected input (never the raw bytes). */
  inputDigest: string;
}

/** The persisted terminal-product ledgers artifact (substrate lifecycle + command log + interventions + cleanup). */
interface TerminalLedgers {
  schema: "mimetic.terminal-ledgers.v1";
  lifecycle: LifecycleRecord[];
  commandLog: CommandLogRecord[];
  /** ALWAYS present; ALWAYS empty this slice (no assisted-input path) — the safety contract. */
  interventions: InterventionRecord[];
  cleanup: {
    /** True when Sandbox.kill resolved. */
    killed: boolean;
    /** Sandboxes still listed under this run's metadata after kill (0 = proven reclaimed). */
    remaining: number;
    /** When list is unsupported by the SDK, remaining stays -1 and the reason is recorded honestly. */
    reason: string;
  };
}

/**
 * Build the per-command runtime-auth env from a DENY-BY-DEFAULT ALLOWLIST containing ONLY the
 * declared runtime key (safety contract item 4). The key NAME is derived from the actor's
 * keyPlacement capability + the declared runtimeAuth channel — NOT a hardcoded string the caller
 * can widen. Banned credential names (GitHub/payment/deploy/db/media) are excluded by construction
 * AND guarded: if a banned name is ever requested the lane fails closed. Returns the allowlisted
 * env (values from `env`) and the resolved key name, or a structured failure.
 *
 * Engine-enforced placement (safety contract item 1): the key is only ever returned as a
 * COMMAND-scoped env here; the caller passes it to commands.run({envs}), never Sandbox.create.
 */
function buildCommandScopedRuntimeEnv(args: {
  /** The runtimeAuth channel the lab declared ("openai-env"), or undefined if absent. */
  runtimeAuth: string | undefined;
  /** The operator environment the key value is read from (process.env or a test fake). */
  env: Record<string, string | undefined>;
}):
  | { ok: true; envs: Record<string, string>; keyName: string; keyValue: string }
  | { ok: false; code: "MIMETIC_TERMINAL_LAB_RUNTIME_AUTH_MISSING" | "MIMETIC_TERMINAL_LAB_CREDENTIAL_DENIED"; message: string } {
  // The "openai-env" channel declares OPENAI_API_KEY (preferred) or CODEX_API_KEY as the runtime
  // key. The ALLOWLIST is exactly these names; everything else is denied by construction.
  const ALLOWED_RUNTIME_KEY_NAMES = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;
  // Tripwire (safety contract item 4): if a FUTURE widening of ALLOWED_RUNTIME_KEY_NAMES ever
  // added a clearly-non-runtime credential (a GitHub/payment/deploy/db secret), fail closed. The
  // generic `*_KEY` shape is deliberately NOT a tripwire here — a runtime key legitimately ends in
  // _KEY (OPENAI_API_KEY), so testing it against the generic shape would false-positive on the very
  // key this lane exists to inject. The positive allowlist itself is the real boundary: the command
  // env is built from exactly these names and nothing else (so GITHUB_TOKEN/payment/db keys present
  // in the operator env are never forwarded — proven by the deterministic test).
  if (ALLOWED_RUNTIME_KEY_NAMES.some((name) => isNonRuntimeCredentialName(name))) {
    return {
      ok: false,
      code: "MIMETIC_TERMINAL_LAB_CREDENTIAL_DENIED",
      message: "Internal invariant violated: a runtime-key allowlist entry is a non-runtime credential (GitHub/payment/deploy/db)."
    };
  }
  const keyName = ALLOWED_RUNTIME_KEY_NAMES.find((name) => (args.env[name]?.trim() ?? "").length > 0);
  if (!keyName) {
    return {
      ok: false,
      code: "MIMETIC_TERMINAL_LAB_RUNTIME_AUTH_MISSING",
      message: `Live terminal-product labs declare runtimeAuth "${String(args.runtimeAuth)}" and need ${ALLOWED_RUNTIME_KEY_NAMES.join(" or ")} in the environment (pass via --env-file; the value is injected ONLY into the command-scoped codex invocation and is never persisted).`
    };
  }
  return {
    ok: true,
    // The command-scoped env is the ALLOWLIST: exactly the one runtime key, nothing else. No
    // GITHUB_TOKEN/GH_TOKEN, no payment/deploy/db/media key — excluded by construction.
    envs: { [keyName]: args.env[keyName] as string },
    keyName,
    keyValue: args.env[keyName] as string
  };
}

// Clearly-non-runtime credential NAME shapes. Used as the runtime-key allowlist tripwire (a
// runtime key must never be one of these). Deliberately EXCLUDES the generic `*_KEY` shape: the
// runtime key this lane injects (OPENAI_API_KEY/CODEX_API_KEY) legitimately ends in _KEY, so the
// generic shape would false-positive on it. The positive allowlist — not a denylist — is what
// keeps every OTHER operator-env credential (GitHub/payment/deploy/db/media keys) out of the
// sandbox: the command env is built from exactly the allowlisted runtime key and nothing else.
const NON_RUNTIME_CREDENTIAL_NAME_PATTERNS: RegExp[] = [
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /TOKEN$/i,        // deploy tokens, write tokens
  /SECRET/i,        // *_SECRET, payment secrets
  /PASSWORD/i,
  /DATABASE_URL/i,
  /(^|_)DSN$/i,
  /STRIPE/i,
  /AWS_/i
];

/** True when `name` is a clearly-non-runtime credential (cannot be a runtime-key allowlist entry). */
function isNonRuntimeCredentialName(name: string): boolean {
  return NON_RUNTIME_CREDENTIAL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Build the sandbox metadata from a POSITIVE ALLOWLIST (safety contract item 6). This is the ONLY
 * way metadata is set on the terminal lane — it carries solely non-secret labels and rejects any
 * value that is not a plain short label. A verifier check asserts the persisted metadata has no
 * prompt/token/secret shapes; this builder makes that true by construction.
 */
export function buildSandboxMetadata(allowlist: {
  labId: string;
  simId: string;
  runId: string;
}): Record<string, string> {
  return {
    mode: TERMINAL_PRODUCT_LAB_PROVIDER_METADATA.mode,
    tool: TERMINAL_PRODUCT_LAB_PROVIDER_METADATA.tool,
    provider: "codex",
    labId: allowlist.labId,
    simId: allowlist.simId,
    // The run id is a harness-minted token (terminal-<ts>-<hex>), not user data.
    runId: allowlist.runId
  };
}

interface RunLiveTerminalSessionArgs {
  options: RunTerminalProductLabOptions;
  cwd: string;
  config: LabConfig;
  descriptorId: string;
  product: NonNullable<LabConfig["subject"]["product"]>;
  warnings: string[];
  render: typeof renderObserver;
  failed: (
    code: NonNullable<TerminalProductLabResult["error"]>["code"],
    message: string,
    extras?: { actor?: string; product?: string }
  ) => TerminalProductLabResult;
}

/**
 * The live in-sandbox agent session orchestrator (mirror of runCuaActorLab's E2B branch). Enforces
 * the 8-point safety contract by construction; fails closed before any sandbox/key/spend on any
 * precondition miss. Persists the substrate-lifecycle/command-log/interventions/cleanup ledgers,
 * the redacted terminal event stream + normalized transcript, the agent report, and the
 * provider-neutral actor trace; tears the sandbox down in a finally and proves the teardown.
 */
async function runLiveTerminalSession(args: RunLiveTerminalSessionArgs): Promise<TerminalProductLabResult> {
  const { options, cwd, config, descriptorId, product, warnings, render, failed } = args;
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const now = hooks.now ?? (() => Date.now());
  const nowIso = (): string => new Date(now()).toISOString();

  // --- Safety contract item 1: ENGINE-ENFORCED command-scoped key placement. ---
  // Drive the placement off the registered actor's keyPlacement CAPABILITY, not a code convention.
  // A terminal actor that does not declare in-sandbox-command-scoped placement FAILS CLOSED here,
  // before any sandbox exists — the engine refuses to guess where the key goes.
  const descriptor = actorRegistry[descriptorId as keyof typeof actorRegistry];
  const keyPlacement = descriptor?.capabilities.keyPlacement;
  if (keyPlacement !== "in-sandbox-command-scoped") {
    return failed(
      "MIMETIC_TERMINAL_LAB_KEYPLACEMENT_INVALID",
      `Terminal actor "${descriptorId}" must declare keyPlacement "in-sandbox-command-scoped" for the live lane (got "${String(keyPlacement)}"). The engine routes the runtime key by this capability; without it the lane cannot place the key safely and fails closed.`,
      { actor: descriptorId }
    );
  }

  // --- Safety contract item 2: a fail-closed cap MUST be in force before the live key runs. ---
  const caps = config.scenario?.caps;
  const maxUsd = caps?.maxUsd;
  const maxMinutes = caps?.maxMinutes;
  if (caps === undefined || maxUsd === undefined || maxMinutes === undefined || maxMinutes <= 0) {
    return failed(
      "MIMETIC_TERMINAL_LAB_CAPS_MISSING",
      "A live terminal-product run places a real key inside the sandbox and so REQUIRES a fail-closed cap: scenario.caps with maxUsd (0 = no-spend) and a positive maxMinutes (the codex command's wall-clock kill). The live key is never exercised without a cap in force.",
      { actor: descriptorId }
    );
  }
  // maxUsd:0 means this lane asserts NO product/provider spend. SLICE 2 bounds spend by mechanism
  // (the maxMinutes wall-clock kill + the no-billable-jobs posture); the full ledger is SLICE 3.
  // A non-zero maxUsd is permitted but warned — this slice carries no spend-metering mechanism, so
  // it cannot honor a positive budget and would be claiming a capability it lacks (invariant 6).
  if (maxUsd > 0) {
    warnings.push(`scenario.caps.maxUsd=${maxUsd} declares a non-zero spend budget, but SLICE 2 has no spend-metering mechanism (the full cost ledger is SLICE 3). This run is bounded only by the maxMinutes wall-clock kill and asserts no billable-job spend; treat the spend assertion as maxUsd:0.`);
  }

  // --- Safety contract item 4: deny-by-default credentials; build the command-scoped allowlist. ---
  const runtimeEnv = buildCommandScopedRuntimeEnv({ runtimeAuth: config.execution?.runtimeAuth, env });
  if (!runtimeEnv.ok) {
    return failed(runtimeEnv.code, runtimeEnv.message, { actor: descriptorId });
  }

  // Compose the prompt from PUBLIC surfaces + the author mission ONLY (safety contract item 3).
  // Inject a per-run verdict nonce: the agent echoes MIMETIC_ACTOR_VERDICT=<status>
  // MIMETIC_ACTOR_NONCE=<nonce>; the scorer verifies the nonce so replayed text cannot forge it.
  const mission = config.actors[0]?.mission ?? defaultMission(product.name);
  const personaId = config.actors[0]?.persona ?? "autonomous-terminal-agent";
  const verdictNonce = randomUUID().slice(0, 12);
  const composedPrompt = composeLivePrompt({
    mission,
    personaId,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    verdictNonce
  });
  const promptDigest = digestText(composedPrompt);
  const persona: ActorPersonaRef = { id: personaId, traitsApplied: [], promptDigest };

  // --- Safety contract item 5: literal-scrub EVERY known value, then pattern-redact, at the source. ---
  // The runtime key value (+ any other provisioned value) is scrubbed by LITERAL match before
  // anything persists (a key has no detectable "shape" if it is an arbitrary token); redactText is
  // the second pass for secret-SHAPED content. Applied PRE-truncation so a cut can never split a
  // value past the scrubber.
  const knownSecretValues = [runtimeEnv.keyValue, env.E2B_API_KEY?.trim() ?? ""].filter((v) => v.length >= 4);
  const scrubKnownValues = (text: string): string =>
    knownSecretValues.reduce((current, value) => current.split(value).join("[REDACTED_SECRET]"), text);
  const sanitize = (text: string): string => redactText(scrubKnownValues(text));

  const runId = options.runId ?? makeTerminalRunId();
  const artifactRoot = path.join(cwd, ".mimetic", "runs", runId);
  const createdAt = nowIso();
  await mkdir(artifactRoot, { recursive: true });
  const source = await buildRunSource({ capturedAt: createdAt, cwd, mimeticSource: "present", packageName: "mimetic-cli" });

  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  // The ledgers + capture buffers, mutated through the live lifecycle.
  const lifecycle: LifecycleRecord[] = [];
  const commandLog: CommandLogRecord[] = [];
  const terminalEvents: TerminalEventRecord[] = [];
  const interventions: InterventionRecord[] = []; // ALWAYS empty this slice (no assisted-input path).
  let transcriptBytes = 0;
  let cleanup: TerminalLedgers["cleanup"] = { killed: false, remaining: -1, reason: "teardown not reached" };

  const recordLifecycle = (event: string, message: string): void => {
    lifecycle.push({ at: nowIso(), event, message: sanitize(message) });
  };
  const appendTerminalChunk = (stream: "stdout" | "stderr", raw: string): void => {
    if (transcriptBytes >= MAX_TRANSCRIPT_BYTES) return;
    transcriptBytes += Buffer.byteLength(raw, "utf8");
    // Scrub THEN redact at the SOURCE — raw bytes never leave this function (safety contract item 5).
    terminalEvents.push({ at: nowIso(), stream, chunk: sanitize(raw) });
  };

  let sandbox: E2BDesktopSandbox | undefined;
  let sandboxModule: E2BDesktopModule | undefined;
  let sandboxId: string | undefined;
  let sessionStatus: ActorStatus = "failed";
  let completionReason: ActorCompletionReason = "harness_error";
  let sessionReason = "live terminal-product session did not start";
  let sessionError: string | undefined;
  let timedOut = false;

  recordLifecycle("terminal-lab.run.created", `Created live terminal-product run ${runId} (actor ${descriptorId}, product ${product.name}). Caps: maxUsd=${maxUsd}, maxMinutes=${maxMinutes}. Subject provenance UNPINNED (public surfaces only).`);

  const requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const wallClockMs = maxMinutes * 60_000;
  const sandboxTimeoutMs = wallClockMs + SANDBOX_TIMEOUT_BUFFER_MS;
  const metadata = buildSandboxMetadata({ labId: config.id, simId: "sim-001", runId });

  try {
    sandboxModule = await (hooks.loadModule ?? loadE2BDesktopModule)();
    // SAFETY CONTRACT ITEM 1 (enforced HERE): Sandbox.create carries metadata (positive allowlist)
    // + lifecycle kill-on-timeout, and DELIBERATELY NO `envs` — the runtime key is NEVER passed
    // sandbox-global. It is injected ONLY into the per-command codex `envs` below.
    sandbox = await sandboxModule.Sandbox.create({
      apiKey: e2bApiKey,
      requestTimeoutMs,
      timeoutMs: sandboxTimeoutMs,
      metadata,
      lifecycle: { onTimeout: "kill" }
      // NOTE: no `envs` key — see the credential boundary above. (A sandbox-global key would leak
      // into every process in the sandbox; command-scoped bounds it to the codex invocation.)
    });
    sandboxId = sandbox.sandboxId;
    recordLifecycle("terminal-lab.sandbox.created", `E2B shell sandbox ${sandboxId} created with positive-allowlist metadata and kill-on-timeout; NO sandbox-global env (runtime key is command-scoped).`);

    // Readiness: a tiny in-sandbox probe (no key) confirms the shell answers before the keyed run.
    const ready = await sandbox.commands.run(`mkdir -p ${SANDBOX_WORKDIR} && echo MIMETIC_SHELL_READY`, { requestTimeoutMs });
    recordLifecycle("terminal-lab.sandbox.ready", `Shell readiness probe exit=${ready.exitCode ?? "null"}; workdir ${SANDBOX_WORKDIR} prepared.`);

    // --- The keyed run: `codex exec --json` non-interactively (stdin disabled). ---
    // The runtime key is injected ONLY here, command-scoped (safety contract item 1). stdin is
    // never wired (safety contract item 7) — commands.run takes no stdin channel. The command's
    // wall-clock is bounded by maxMinutes (safety contract item 2): commands.run timeoutMs +
    // an injected-clock guard so a mock/real run that exceeds it is killed and fails closed.
    const codexCommand = buildCodexExecCommand({ workdir: SANDBOX_WORKDIR, prompt: composedPrompt });
    const commandDigest = digestText(codexCommand);
    const startedAt = now();
    recordLifecycle("terminal-lab.exec.started", `Launching codex exec (command-scoped runtime key ${runtimeEnv.keyName}); wall-clock bound ${wallClockMs}ms.`);

    let exitCode: number | undefined;
    let runError: string | undefined;
    try {
      const result = await runWithWallClock(
        sandbox.commands.run(codexCommand, {
          envs: runtimeEnv.envs, // <-- THE command-scoped key channel. The ONLY place the key goes.
          requestTimeoutMs,
          timeoutMs: wallClockMs,
          onStdout: (data: string) => appendTerminalChunk("stdout", data),
          onStderr: (data: string) => appendTerminalChunk("stderr", data)
        }),
        wallClockMs,
        now
      );
      if (result.timedOut) {
        timedOut = true;
      } else {
        exitCode = result.value.exitCode;
        // Some SDK shapes return final stdout/stderr in the result too (not only via callbacks).
        if (result.value.stdout) appendTerminalChunk("stdout", result.value.stdout);
        if (result.value.stderr) appendTerminalChunk("stderr", result.value.stderr);
        if (result.value.error) runError = result.value.error;
      }
    } catch (error) {
      runError = compactError(error);
    }
    const durationMs = Math.max(0, now() - startedAt);

    commandLog.push({
      at: nowIso(),
      label: "codex-exec",
      commandDigest,
      envNames: Object.keys(runtimeEnv.envs), // NAMES only — the credential evidence (item 4).
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(timedOut ? { timedOut: true } : {}),
      durationMs
    });

    // Score by the verdict-nonce marker over the SCRUBBED+REDACTED, NORMALIZED transcript — the
    // exact same logic the local-actor lanes use (extractLocalActorVerdict/normalizeLocalActorTranscript).
    const rawTranscript = terminalEvents.map((e) => e.chunk).join("");
    const normalizedTranscript = normalizeLocalActorTranscript(rawTranscript);
    const markerStatus = extractLocalActorVerdict(normalizedTranscript, verdictNonce);

    if (timedOut) {
      sessionStatus = "timed_out";
      completionReason = "timed_out";
      sessionReason = `codex exec exceeded the maxMinutes wall-clock (${maxMinutes}m); killed and failed closed.`;
      recordLifecycle("terminal-lab.exec.timed_out", sessionReason);
    } else if (runError) {
      sessionStatus = "failed";
      completionReason = "harness_error";
      sessionError = sanitize(runError);
      sessionReason = `codex exec could not run: ${sessionError}`;
      recordLifecycle("terminal-lab.exec.error", sessionReason);
    } else if (markerStatus) {
      sessionStatus = markerStatus;
      completionReason = markerStatus === "passed" ? "goal_satisfied" : markerStatus === "blocked" ? "blocked_approval" : "gave_up";
      sessionReason = `agent reported ${markerStatus} verdict marker (nonce-verified)`;
      recordLifecycle("terminal-lab.exec.completed", `codex exec exit=${exitCode ?? "null"}; ${sessionReason}.`);
    } else {
      // No nonce-verified verdict: the agent did not (credibly) report a terminal status. A run
      // that exited 0 but printed no verified marker is BLOCKED evidence (the failure IS the
      // evidence — still structurally verifiable), not a silent pass.
      sessionStatus = "blocked";
      completionReason = "gave_up";
      sessionReason = `codex exec exit=${exitCode ?? "null"} but no nonce-verified MIMETIC_ACTOR_VERDICT marker was emitted; recorded as blocked (the missing verdict is the evidence).`;
      recordLifecycle("terminal-lab.exec.blocked", sessionReason);
    }
  } catch (error) {
    sessionError = sanitize(compactError(error));
    sessionStatus = "failed";
    completionReason = "harness_error";
    sessionReason = `live terminal-product session failed: ${sessionError}`;
    recordLifecycle("terminal-lab.session.error", sessionReason);
  } finally {
    // --- Safety contract item 8: PROVEN cleanup. Kill in finally; prove remaining==0. ---
    cleanup = await teardownSandbox({
      sandboxModule,
      sandbox,
      metadata,
      requestTimeoutMs,
      sanitize,
      recordLifecycle,
      warnings
    });
  }

  // Build + persist the ledgers, the redacted event stream, the normalized transcript, the agent
  // report, the actor trace, and the run bundle.
  const ledgers: TerminalLedgers = {
    schema: "mimetic.terminal-ledgers.v1",
    lifecycle,
    commandLog,
    interventions, // ALWAYS present, ALWAYS empty (no assisted-input path this slice).
    cleanup
  };
  const normalizedTranscript = normalizeLocalActorTranscript(terminalEvents.map((e) => e.chunk).join(""));

  const trace = buildTerminalActorTrace({
    persona,
    productName: product.name,
    status: sessionStatus,
    completionReason,
    reason: sanitize(sessionReason),
    createdAt,
    completedAt: nowIso(),
    durationMs: commandLog[0]?.durationMs ?? 0,
    terminalEvents,
    commandLog,
    transcriptTail: tailOf(normalizedTranscript)
  });

  await writeFile(
    path.join(artifactRoot, TERMINAL_EVENTS_ARTIFACT),
    `${terminalEvents.map((e) => JSON.stringify(e)).join("\n")}${terminalEvents.length > 0 ? "\n" : ""}`,
    "utf8"
  );
  await writeFile(path.join(artifactRoot, TERMINAL_TRANSCRIPT_ARTIFACT), `${normalizedTranscript}\n`, "utf8");
  await writeFile(path.join(artifactRoot, TERMINAL_LEDGERS_ARTIFACT), `${JSON.stringify(ledgers, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "actor.json"), `${JSON.stringify(trace, null, 2)}\n`, "utf8");

  const bundle = buildLiveTerminalProductBundle({
    actorId: descriptorId,
    createdAt,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    mission,
    persona,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    caps,
    runtimeAuthKeyName: runtimeEnv.keyName,
    policies: {
      allowPrivateRepoAccess: config.policies?.allowPrivateRepoAccess ?? false,
      allowProviderCredentials: config.policies?.allowProviderCredentials ?? false,
      allowPaymentCredentials: config.policies?.allowPaymentCredentials ?? false,
      allowGitHubMutation: config.policies?.allowGitHubMutation ?? false
    },
    runId,
    source,
    trace,
    ledgers,
    ...(sandboxId ? { sandboxId } : {}),
    ...(sessionError ? { sessionError } : {}),
    sessionReason: sanitize(sessionReason)
  });

  await writeFile(path.join(artifactRoot, "run.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.json"), `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactRoot, "review.md"), renderTerminalReviewMarkdown(bundle), "utf8");
  await writeFile(path.join(artifactRoot, "events.ndjson"), `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeFile(
    path.join(cwd, ".mimetic", "runs", "latest.json"),
    `${JSON.stringify({ schema: "mimetic.latest-run.v1", runId, path: path.join(".mimetic", "runs", runId), updatedAt: createdAt }, null, 2)}\n`,
    "utf8"
  );

  const observer = await render(cwd, runId, { open: options.open === true });

  // The lab's exit code: verified evidence AND no harness error AND proven cleanup. A blocked/
  // timed-out agent run is STILL ok-as-evidence at the bundle level (the failure is the evidence),
  // but the LAB result surfaces ok:false on a harness error or unproven teardown (fail-closed).
  const cleanupProven = cleanup.killed && (cleanup.remaining === 0 || cleanup.remaining === -1);
  const ok = observer.ok && completionReason !== "harness_error" && cleanupProven;

  return {
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptorId,
    product: product.name,
    dryRun: false,
    runId,
    session: { status: sessionStatus, completionReason, reason: sanitize(sessionReason) },
    ...(sandboxId
      ? { sandbox: { sandboxId, killed: cleanup.killed, remaining: cleanup.remaining } }
      : {}),
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: (!cleanupProven
              ? "MIMETIC_TERMINAL_LAB_CLEANUP_UNPROVEN"
              : "MIMETIC_TERMINAL_LAB_FAILED") as NonNullable<TerminalProductLabResult["error"]>["code"],
            message: !cleanupProven
              ? `Live terminal-product run could not prove sandbox teardown (killed=${cleanup.killed}, remaining=${cleanup.remaining}): ${cleanup.reason}. A run that cannot prove teardown fails closed.`
              : sessionError ?? observer.error?.message ?? sessionReason
          }
        })
  };
}

/**
 * Tear the sandbox down and PROVE it: kill via Sandbox.kill, then re-list under this run's metadata
 * (where the SDK supports list) and assert remaining==0. When list is unsupported, record killed +
 * an honest reason and remaining=-1 (the server-side kill-on-timeout is the backstop). Never
 * throws — teardown failure is recorded, the caller fails closed on an unproven teardown.
 */
async function teardownSandbox(args: {
  sandboxModule: E2BDesktopModule | undefined;
  sandbox: E2BDesktopSandbox | undefined;
  metadata: Record<string, string>;
  requestTimeoutMs: number;
  sanitize: (text: string) => string;
  recordLifecycle: (event: string, message: string) => void;
  warnings: string[];
}): Promise<TerminalLedgers["cleanup"]> {
  const { sandboxModule, sandbox, metadata, requestTimeoutMs, sanitize, recordLifecycle, warnings } = args;
  if (!sandbox || !sandboxModule) {
    recordLifecycle("terminal-lab.cleanup.skipped", "No sandbox was created; nothing to reclaim.");
    return { killed: false, remaining: 0, reason: "no sandbox created" };
  }
  let killed = false;
  if (typeof sandboxModule.Sandbox.kill === "function") {
    try {
      await sandboxModule.Sandbox.kill(sandbox.sandboxId, { requestTimeoutMs });
      killed = true;
    } catch (error) {
      warnings.push(`Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${sanitize(compactError(error))}`);
    }
  } else {
    return { killed: false, remaining: -1, reason: "installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox" };
  }

  // Re-list under THIS run's metadata to prove reclamation (remaining==0). Where list is
  // unsupported, killed:true + reason is the proof (the goal packet permits this fallback).
  if (typeof sandboxModule.Sandbox.list !== "function") {
    recordLifecycle("terminal-lab.cleanup.killed", `Sandbox ${sandbox.sandboxId} killed; SDK has no list() to re-verify (killed:true is the proof).`);
    return { killed, remaining: -1, reason: "killed; SDK does not expose Sandbox.list to re-verify (killed:true is the proof)" };
  }
  try {
    const paginator = sandboxModule.Sandbox.list({ metadata: { runId: metadata.runId ?? "" }, requestTimeoutMs });
    let remaining = 0;
    let pages = 0;
    // nextItems() advances the paginator's internal cursor; hasNext reflects it after each call.
    while (paginator.hasNext && pages < 10) {
      const items = await paginator.nextItems({ requestTimeoutMs });
      remaining += items.filter((info) => (info.state ?? "running") !== "killed").length;
      pages += 1;
    }
    recordLifecycle("terminal-lab.cleanup.verified", `Sandbox ${sandbox.sandboxId} killed; re-listed ${remaining} remaining under this run's metadata.`);
    return { killed, remaining, reason: remaining === 0 ? "killed; re-list confirms 0 remaining" : `killed; re-list found ${remaining} still present` };
  } catch (error) {
    recordLifecycle("terminal-lab.cleanup.list_error", `Sandbox ${sandbox.sandboxId} killed; re-list failed: ${sanitize(compactError(error))}`);
    return { killed, remaining: -1, reason: `killed; re-list to verify reclamation failed: ${sanitize(compactError(error))}` };
  }
}

/**
 * Race a commands.run promise against the maxMinutes wall-clock (safety contract item 2). The E2B
 * commands.run timeoutMs is the primary kill; this injected-clock guard is the belt-and-suspenders
 * backstop so a mock CLI (which ignores timeoutMs) is still bounded and fails closed in CI.
 */
async function runWithWallClock<T>(
  promise: Promise<T>,
  wallClockMs: number,
  now: () => number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const start = now();
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), wallClockMs);
    timer.unref?.();
  });
  const value = await Promise.race([
    promise.then((v) => ({ timedOut: false as const, value: v })),
    timeout
  ]);
  if (timer) clearTimeout(timer);
  // Guard against a clock that advanced past the budget even if the race resolved on the promise.
  if (!value.timedOut && now() - start >= wallClockMs) {
    return { timedOut: true };
  }
  return value;
}

/** Build the in-sandbox `codex exec` command (non-interactive, JSON, stdin disabled by mechanism). */
function buildCodexExecCommand(args: { workdir: string; prompt: string }): string {
  // The prompt is passed via a heredoc on stdin of a wrapper? NO — stdin is DISABLED (item 7), so
  // the prompt rides as the final positional arg, shell-quoted. codex exec --json runs once and
  // exits (no interactive loop). --skip-git-repo-check: the workdir is a fresh scratch dir.
  const quotedPrompt = `'${args.prompt.replace(/'/g, "'\\''")}'`;
  return `cd ${args.workdir} && codex exec --skip-git-repo-check --json ${quotedPrompt}`;
}

/** Compose the live prompt: PUBLIC surfaces + author mission + the verdict-nonce marker contract. */
function composeLivePrompt(args: {
  mission: string;
  personaId: string;
  productName: string;
  publicSurfaces: string[];
  verdictNonce: string;
}): string {
  return [
    `persona: ${args.personaId}`,
    `product: ${args.productName}`,
    `public-surfaces: ${args.publicSurfaces.join(" ")}`,
    `mission: ${args.mission}`,
    "",
    "Work ONLY from the public surfaces above. Do NOT clone or inspect any private repository.",
    `When finished, print exactly one final machine-readable line in this format: MIMETIC_ACTOR_VERDICT=<status> MIMETIC_ACTOR_NONCE=${args.verdictNonce} where <status> is passed, blocked, or failed.`
  ].join("\n");
}

/** sha256-12 of the exact command/text (the promptDigest convention). */
function tailOf(text: string): string {
  const trimmed = redactText(text).trim();
  return trimmed.length > TAIL_CHARS ? `…${trimmed.slice(-TAIL_CHARS)}` : trimmed || "(no output)";
}

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Project the live terminal session into the provider-neutral mimetic.actor-trace.v1 (lane
 * "terminal", protocol "terminal-exec"). counts.actions/messages drive the no-engagement honesty
 * guard (a real run bumps them; a no-op is caught). No screenshots on this lane.
 */
function buildTerminalActorTrace(args: {
  persona: ActorPersonaRef;
  productName: string;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  createdAt: string;
  completedAt: string;
  durationMs: number;
  terminalEvents: TerminalEventRecord[];
  commandLog: CommandLogRecord[];
  transcriptTail: string;
}): ActorTrace {
  const items: ActorTraceItem[] = [
    ...args.commandLog.map((entry, index): ActorTraceItem => ({
      id: `command-${String(index + 1).padStart(3, "0")}`,
      kind: "command",
      lifecycle: "completed",
      ...(entry.exitCode === undefined ? {} : { status: String(entry.exitCode) }),
      title: `${entry.label} (${entry.envNames.join(",") || "no command-scoped env"})`,
      command: {
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
        outputTail: args.transcriptTail
      }
    })),
    // One message item carrying the (already-redacted) transcript tail so the trace shows the agent
    // narrated SOMETHING — the engagement signal the no-engagement guard reads.
    ...(args.terminalEvents.length > 0
      ? [{ id: "message-001", kind: "message", lifecycle: "completed", title: "agent terminal output", text: args.transcriptTail } as ActorTraceItem]
      : [])
  ];
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "codex",
    protocol: "terminal-exec",
    lane: "terminal",
    persona: args.persona,
    redaction: {
      status: "passed",
      screenshots: "n/a",
      notes: "Terminal exec output captured via commands.run onStdout/onStderr, scrubbed (literal known values) then redacted (shape patterns) AT THE SOURCE before persisting; no screenshots on this lane."
    },
    startedAt: args.createdAt,
    completedAt: args.completedAt,
    durationMs: args.durationMs,
    status: args.status,
    completionReason: args.completionReason,
    reason: args.reason,
    ids: { model: "codex" },
    counts: {
      commands: args.commandLog.length,
      // actions == executed commands; messages == 1 when the agent produced any output. The
      // no-engagement guard (run.ts) reads these: a real run bumps them, a no-op is caught.
      actions: args.commandLog.length,
      messages: args.terminalEvents.length > 0 ? 1 : 0,
      terminalEvents: args.terminalEvents.length
    },
    items,
    capabilities: TERMINAL_AGENT_CAPABILITIES
  };
}

/**
 * Project the terminal-product lab run into a mimetic.run-bundle.v1 (no schema change — a new
 * producer only). DRY-RUN: a contract bundle. The terminal stream is a contract placeholder
 * (stdin disabled, no captured tail — honest: nothing ran), the subject is declared UNPINNED, and
 * the caps/policies/runtime-auth declarations + empty ledgers are recorded so SLICE 2 has a stable
 * shape to fill. Exported for the bundle-builder tests.
 */
export function buildTerminalProductBundle(args: {
  actorId: string;
  createdAt: string;
  dryRun: boolean;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  productName: string;
  publicSurfaces: string[];
  caps?: LabScenarioCaps;
  runtimeAuth?: string;
  stdin: "disabled" | "planned" | "sent";
  policies: {
    allowPrivateRepoAccess: boolean;
    allowProviderCredentials: boolean;
    allowPaymentCredentials: boolean;
    allowGitHubMutation: boolean;
  };
  runId: string;
  source: RunBundle["source"];
}): RunBundle {
  const reason = "Contract bundle only: dry-run declared the terminal-product study contract without creating an E2B sandbox, injecting any key, or spending. The live in-sandbox agent session is SLICE 2.";

  const simulation: RunSimulation = {
    id: "sim-001",
    index: 1,
    personaId: args.persona.id,
    scenarioId: `terminal-${args.labId}`,
    status: "contract_proof_only",
    streamKind: "terminal",
    mode: "cli-sim",
    progress: 0.25,
    currentStep: reason,
    summary: `Contract lane for the terminal agent (${args.actorId}) studying ${args.productName} from public surfaces.`,
    streamIds: ["stream-001"],
    startedAt: args.createdAt,
    updatedAt: args.createdAt
  };

  // The terminal stream is a CONTRACT PLACEHOLDER on the dry-run path: stdin is disabled and no
  // exec output was captured, so the tail is empty and transport stays "snapshot" — NOT "pty"
  // (captured non-interactive exec output is never an interactive PTY; invariant 6 + the PTY
  // ruling). SLICE 2 fills terminal.tail from the redacted exec-stream capture.
  const stream: RunStream = {
    id: "stream-001",
    simId: "sim-001",
    kind: "terminal",
    label: `Terminal agent — ${args.labId}`,
    status: "contract_proof_only",
    transport: "snapshot",
    updatedAt: args.createdAt,
    embed: { kind: "placeholder", title: `Terminal agent (${args.productName})` },
    terminal: {
      title: `${args.actorId} exec (stdin ${args.stdin})`,
      format: "plain",
      stdin: args.stdin,
      tail: ""
    },
    ui: {
      intent: `Watch the terminal agent discover and use ${args.productName} from its public surfaces.`,
      state: reason
    },
    artifacts: [
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "events", path: "events.ndjson", kind: "events" as const }
    ]
  };

  const capsText = describeCaps(args.caps);
  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.run.created",
      message: `Created terminal-product lab run for ${args.labId} (actor ${args.actorId}, product ${args.productName}).`
    },
    {
      id: "event-001-subject",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.subject.declared",
      // Invariant 5: provenance recorded or its absence DECLARED. The agent drives PUBLIC surfaces,
      // not a clone, so the subject provenance is explicitly UNPINNED; evidence binds to the
      // composed-prompt digest. Public surfaces are recorded (they are public by declaration).
      message: `Subject product declared: ${args.productName}; public surfaces: ${args.publicSurfaces.join(", ")}. The lab did not provision/clone the product — subject provenance is UNPINNED (a public-surface study cannot be commit-pinned); evidence binds to the composed-prompt digest ${args.persona.promptDigest}.`,
      simId: "sim-001",
      streamId: "stream-001"
    },
    {
      id: "event-002-credentials",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.credentials.declared",
      // Names-only evidence (invariant 1): the runtime-auth CHANNEL is declared; no value is ever
      // recorded. The deny-by-default policies are recorded so the credential posture is auditable.
      message: `Runtime auth channel: ${args.runtimeAuth ?? "none declared"} (names only; values never persist; command-scoped injection is SLICE 2). Credential policies (deny-by-default): allowPrivateRepoAccess=${args.policies.allowPrivateRepoAccess}, allowProviderCredentials=${args.policies.allowProviderCredentials}, allowPaymentCredentials=${args.policies.allowPaymentCredentials}, allowGitHubMutation=${args.policies.allowGitHubMutation}.`,
      simId: "sim-001",
      streamId: "stream-001"
    },
    {
      id: "event-003-caps",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.caps.declared",
      message: `Spend/job/time caps: ${capsText}. The live key is never exercised without a fail-closed cap in force (SLICE 2); the no-spend proof is derived from a real ledger (SLICE 3).`,
      simId: "sim-001",
      streamId: "stream-001"
    },
    {
      id: "event-004-contract",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.contract.ready",
      message: "Dry-run contract bundle ready; the live in-sandbox agent session, the captured exec stream, and the credential boundary are SLICE 2. Switch scenario.mode to live once SLICE 2 lands.",
      simId: "sim-001",
      streamId: "stream-001"
    }
  ];

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict: "contract_proof_only",
    summary: reason,
    gaps: [
      "Live in-sandbox agent session not yet run (dry-run contract only; SLICE 2).",
      "Captured exec-stream / transcript / substrate / cost / cleanup ledgers are placeholders this slice (SLICE 2/3 fill them)."
    ]
  };

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: 1,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".mimetic", "runs", args.runId),
    source: args.source,
    persona: {
      id: args.persona.id,
      name: `Autonomous terminal agent (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    scenario: {
      id: `terminal-${args.labId}`,
      title: args.labTitle ?? `Terminal-product lab: ${args.labId}`,
      // The author mission is public-safe committed lab text — recorded plaintext as the goal,
      // redacted defensively before persisting (it never carries a secret, but the harness never
      // trusts that). The full composed prompt is bound by digest, not text.
      goal: redactText(args.mission),
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "terminal-lab.run.created",
        message: `Created terminal-product lab run with one in-sandbox agent lane (actor ${args.actorId}, product ${args.productName}).`
      }
    ],
    simulations: [simulation],
    streams: [stream],
    events,
    redaction: {
      status: "passed",
      notes: "Dry-run contract bundle: no sandbox ran, no key was injected, no exec output was captured. The author mission is public-safe committed lab text (redacted defensively); the composed prompt is bound by digest. Live capture (scrubKnownValues then redactText, at the source) is SLICE 2."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates: []
  };
}

/**
 * Build the LIVE terminal-product run bundle (mode "live") from the captured session: the actor
 * trace seam (stream.actor = trace), the substrate-lifecycle events, the terminal stream with the
 * redacted transcript tail, and references to the written evidence artifacts (terminal event
 * stream, transcript, ledgers, actor trace). verifyRun's terminal-product check (gated on
 * mode==="live") enforces the ledgers + proven cleanup + interventions-present over this bundle.
 */
export function buildLiveTerminalProductBundle(args: {
  actorId: string;
  createdAt: string;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  productName: string;
  publicSurfaces: string[];
  caps?: LabScenarioCaps;
  runtimeAuthKeyName: string;
  policies: {
    allowPrivateRepoAccess: boolean;
    allowProviderCredentials: boolean;
    allowPaymentCredentials: boolean;
    allowGitHubMutation: boolean;
  };
  runId: string;
  source: RunBundle["source"];
  trace: ActorTrace;
  ledgers: TerminalLedgers;
  sandboxId?: string;
  sessionError?: string;
  sessionReason: string;
}): RunBundle {
  const simStatus: RunSimulationStatus = args.trace.status === "passed"
    ? "passed"
    : args.trace.status === "blocked"
      ? "blocked"
      : args.trace.status === "timed_out"
        ? "timed_out"
        : "failed";
  const messageItem = args.trace.items.find((item) => item.kind === "message");
  const tail = (messageItem?.text ?? args.trace.reason).slice(0, 2000);

  const simulation: RunSimulation = {
    id: "sim-001",
    index: 1,
    personaId: args.persona.id,
    scenarioId: `terminal-${args.labId}`,
    status: simStatus,
    streamKind: "terminal",
    mode: "cli-sim",
    progress: 1,
    currentStep: args.sessionReason,
    summary: `Terminal agent (${args.actorId}) studied ${args.productName} from public surfaces (${args.trace.status}).`,
    streamIds: ["stream-001"],
    startedAt: args.createdAt,
    updatedAt: args.trace.completedAt
  };

  // transport "snapshot": the persisted tail is a redacted snapshot of the captured exec output,
  // NOT an interactive PTY (stdin disabled). The actor trace seam carries the structured evidence.
  const stream: RunStream = {
    id: "stream-001",
    simId: "sim-001",
    kind: "terminal",
    label: `Terminal agent — ${args.labId}`,
    status: simStatus,
    transport: "snapshot",
    updatedAt: args.trace.completedAt,
    embed: { kind: "placeholder", title: `Terminal agent (${args.productName})` },
    terminal: {
      title: `${args.actorId} exec (stdin disabled)`,
      format: "plain",
      stdin: "disabled",
      tail
    },
    ui: {
      intent: `Watch the terminal agent discover and use ${args.productName} from its public surfaces.`,
      state: args.sessionReason
    },
    actor: args.trace,
    artifacts: [
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "event log", path: "events.ndjson", kind: "events" as const },
      { label: "actor trace", path: "actor.json", kind: "trace" as const },
      { label: "terminal event stream", path: TERMINAL_EVENTS_ARTIFACT, kind: "log" as const },
      { label: "terminal transcript", path: TERMINAL_TRANSCRIPT_ARTIFACT, kind: "log" as const },
      { label: "terminal ledgers", path: TERMINAL_LEDGERS_ARTIFACT, kind: "log" as const }
    ]
  };

  // Substrate-lifecycle ledger -> bundle events (each already sanitized when recorded).
  const lifecycleEvents: RunEvent[] = args.ledgers.lifecycle.map((record, index) => ({
    id: `event-${String(index).padStart(3, "0")}-${record.event}`,
    at: record.at,
    level: record.event.includes("error") || record.event.includes("timed_out") ? "warn" : "info",
    type: record.event,
    message: record.message,
    simId: "sim-001",
    streamId: "stream-001"
  }));

  const verdict: ReviewSummary["verdict"] = args.trace.status === "passed"
    ? "pass"
    : args.trace.status === "blocked"
      ? "blocked"
      : args.trace.status === "timed_out"
        ? "timed_out"
        : "fail";
  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    summary: args.sessionReason,
    gaps: args.trace.status === "passed"
      ? []
      : [`Agent session ended ${args.trace.status}: ${args.sessionReason}`]
  };

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: "live",
    simCount: 1,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".mimetic", "runs", args.runId),
    source: args.source,
    persona: {
      id: args.persona.id,
      name: `Autonomous terminal agent (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    scenario: {
      id: `terminal-${args.labId}`,
      title: args.labTitle ?? `Terminal-product lab: ${args.labId}`,
      goal: redactText(args.mission),
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    lifecycle: args.ledgers.lifecycle.map((record) => ({ at: record.at, event: record.event, message: record.message })),
    simulations: [simulation],
    streams: [stream],
    events: lifecycleEvents,
    redaction: {
      status: "passed",
      notes: `Live terminal-product run: the in-sandbox agent's output was captured via commands.run onStdout/onStderr and scrubbed (literal known values incl. the runtime key) THEN redacted (shape patterns) AT THE SOURCE before persisting. The runtime key (${args.runtimeAuthKeyName}) was injected ONLY into the command-scoped codex invocation, never sandbox-global env or metadata; only its NAME appears in evidence. Subject provenance is UNPINNED (public-surface study).`
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates: []
  };
}

function describeCaps(caps: LabScenarioCaps | undefined): string {
  if (!caps) return "none declared (a live run REQUIRES caps in SLICE 2)";
  const parts: string[] = [];
  if (caps.maxUsd !== undefined) parts.push(`maxUsd=${caps.maxUsd}`);
  if (caps.maxJobs !== undefined) parts.push(`maxJobs=${caps.maxJobs}`);
  if (caps.maxMinutes !== undefined) parts.push(`maxMinutes=${caps.maxMinutes}`);
  return parts.length > 0 ? parts.join(", ") : "empty";
}

/** The default mission when the lab omits one. Public-safe, product-neutral author text. */
function defaultMission(productName: string): string {
  return `You are an autonomous agent. Discover ${productName} from its public surfaces and determine whether it can help with a durable real task. Stay within the declared no-spend caps. Leave feedback if the workflow is confusing.`;
}

/** Compose the full prompt the agent would run. Bound to evidence by DIGEST only. */
function composePrompt(args: { mission: string; personaId: string; productName: string; publicSurfaces: string[] }): string {
  return [
    `persona: ${args.personaId}`,
    `product: ${args.productName}`,
    `public-surfaces: ${args.publicSurfaces.join(" ")}`,
    `mission: ${args.mission}`
  ].join("\n");
}

function renderTerminalReviewMarkdown(bundle: RunBundle): string {
  const subject = bundle.events.find((event) => event.type === "terminal-lab.subject.declared");
  const credentials = bundle.events.find((event) => event.type === "terminal-lab.credentials.declared");
  const caps = bundle.events.find((event) => event.type === "terminal-lab.caps.declared");
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    `- mission: ${bundle.scenario.goal}`,
    ...(subject ? [`- subject: ${subject.message}`] : []),
    ...(credentials ? [`- credentials: ${credentials.message}`] : []),
    ...(caps ? [`- caps: ${caps.message}`] : []),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
}

function makeTerminalRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `terminal-${stamp}-${randomBytes(4).toString("hex")}`;
}
