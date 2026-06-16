// The terminal-product lab backend: a real autonomous agent (Codex) studying a CLI/product from
// PUBLIC SURFACES ONLY, running INSIDE an E2B shell with command-scoped runtime auth, capturing
// its non-interactive exec output (stdin disabled) as a redacted event stream + normalized
// transcript, capped at no-spend, emitting durable terminal/substrate/cost/no-spend/cleanup/
// intervention proof. Mirrors cua-actor-lab.ts / scripted-browser-lab.ts.
//
// SLICE 1 SCOPE (honest — read before trusting this module): ONLY the DRY-RUN path is
// implemented. It builds a valid `mimetic.run-bundle.v1` contract bundle, honestly labeled
// contract-only, with the subject declared as a terminal-product whose provenance is UNPINNED
// (the agent drives PUBLIC surfaces, not a clone), the author mission recorded as plaintext
// (public-safe committed lab text) + a digest of the composed prompt, the caps/policies/
// runtime-auth declarations recorded (names only), and EMPTY/placeholder ledgers (substrate
// lifecycle, command log, terminal event stream, interventions, cost) that SLICE 2 fills.
//
// A non-dry-run (live) call returns a structured "not yet implemented in this slice" failure
// (fail-closed, clear code) — it never creates a sandbox, never injects a key, never spends. The
// live create -> inject (command-scoped) -> run `codex exec --json` -> capture -> teardown path,
// the verifier checks, and the credential boundary are SLICE 2. The DI seams SLICE 2 needs are
// declared on TerminalProductLabHooks below; only the dry-run path consumes them today.

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ActorPersonaRef } from "./actor-contract.js";
import { actorRegistry, isTerminalActorDescriptor } from "./actor-registry.js";
import type { LabConfig, LabScenarioCaps } from "./lab-config.js";
import { renderObserver, type ObserverResult } from "./observer.js";
import { digestText, redactText } from "./redaction.js";
import {
  buildRunSource,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunSimulation,
  type RunStream
} from "./run.js";
import { TERMINAL_AGENT_NOT_IMPLEMENTED_CODE } from "./terminal-agent-actor.js";

export const TERMINAL_PRODUCT_LAB_SCHEMA = "mimetic.terminal-lab-result.v1";

/**
 * Library-level hooks: the DI seams SLICE 2 needs to drive the full live path against a fake
 * sandbox + mock CLI at zero spend. DECLARED now so the contract is stable; ONLY the dry-run path
 * (which invokes none of them) is implemented this slice. SLICE 2 consumes loadModule /
 * buildSandbox / runtimeAuthEnv / detachedTimers to create -> inject (command-scoped) -> run ->
 * capture -> teardown without touching a real E2B or a real provider key.
 */
export interface TerminalProductLabHooks {
  /** SLICE 2: lazy-load the E2B module (tests inject a fake). */
  loadModule?: () => Promise<unknown>;
  /** SLICE 2: build/inject a sandbox (tests inject a fake shell sandbox). */
  buildSandbox?: (ctx: { config: LabConfig }) => Promise<unknown>;
  /**
   * SLICE 2: the runtime-auth env the engine injects ONLY into the command-scoped `codex`
   * invocation (NEVER Sandbox.create envs). Tests pass a fake-keyed map; the engine asserts the
   * value never reaches metadata/global env/artifacts (the credential boundary).
   */
  runtimeAuthEnv?: Record<string, string | undefined>;
  /** SLICE 2: injected clock/sleep for the detached exec-stream polling (tests only). */
  detachedTimers?: unknown;
  renderObserverFn?: typeof renderObserver;
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
  /** True when the bundle verified. Dry-run contract bundles are successful EVIDENCE of the
   *  composition; a live call fails closed (not-implemented this slice). */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the session. */
  actor: string;
  /** The studied product name (public-safe). */
  product: string;
  dryRun: boolean;
  runId: string;
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "MIMETIC_TERMINAL_LAB_FAILED"
      | "MIMETIC_TERMINAL_LAB_ACTOR_UNSUPPORTED"
      | "MIMETIC_TERMINAL_LAB_SUBJECT_INVALID"
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

  // LIVE path is SLICE 2. Fail closed with a clear, structured code — never a sandbox, never a
  // key, never spend. The dry-run path below is the only thing implemented this slice.
  if (!dryRun) {
    return failed(
      TERMINAL_AGENT_NOT_IMPLEMENTED_CODE,
      "The live terminal-product backend (E2B shell + command-scoped runtime auth + captured exec stream + cleanup) is implemented in SLICE 2. SLICE 1 produces the dry-run contract bundle only; run with --dry-run (or scenario.mode: dry-run).",
      { actor: descriptor.id }
    );
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

/**
 * Project the terminal-product lab run into a mimetic.run-bundle.v1 (no schema change — a new
 * producer only). SLICE 1: a DRY-RUN contract bundle. The terminal stream is a contract placeholder
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
