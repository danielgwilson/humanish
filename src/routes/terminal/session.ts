import { randomBytes, randomUUID } from "node:crypto";
import { missingKeys } from "../../lab/requirements.js";
import { declaredRuntimeProvenance } from "./runtime.js";
import { digestText, redactText, scrubLiterals } from "../../evidence/redaction.js";
import { describeMissingKeys } from "../../keys/key-resolution.js";
import { buildRunSource } from "../../run/bundle.js";
import { renderTerminalReviewMarkdown } from "./bundle.js";
import { buildRuntimeAuth, buildSandboxMetadata } from "./credentials.js";
import { resolveTerminalPersona, terminalPersonaRef } from "./persona.js";
import type {
  LiveTerminalAuth,
  LiveTerminalPlan,
  RunLiveTerminalSessionArgs,
  TerminalProductLabErrorCode,
  TerminalProductLabResult,
  TerminalRunInput,
} from "./types.js";
import { createTerminalRecorder } from "./recorder.js";
import { LiveTerminalSandbox } from "./live-sandbox.js";
import { finishLiveTerminalSession } from "./live-finish.js";

/**
 * The checks of this machine a live run makes before its run starts: the runtime key and
 * E2B_API_KEY. They read only the plan and the environment, so the CLI makes them before it loads
 * a declared scorer. Returns the runtime key's command-scoped placement, or the refusal.
 */
export function checkLiveTerminalMachine(
  plan: LiveTerminalPlan,
  input: TerminalRunInput,
  warnings: string[],
):
  | { readonly ok: true; readonly runtimeEnv: LiveTerminalAuth }
  | { readonly ok: false; readonly code: TerminalProductLabErrorCode; readonly message: string } {
  const env = input.env ?? process.env;
  const { maxUsd } = plan.caps;
  // planTerminalLab refuses a positive maxUsd without a costProbe, so one is present here.
  if (maxUsd > 0) {
    warnings.push(
      `scenario.caps.maxUsd=${maxUsd} is checked after the session against the lines the costProbe measures; lines it leaves null (unmeasured) never trip it. scenario.caps.maxMinutes bounds the run while it runs.`,
    );
  }

  // --- Safety contract item 4: deny-by-default credentials; build the command-scoped allowlist. ---
  const runtimeEnv = buildRuntimeAuth({ runtimeAuth: plan.runtime.auth, env });
  if (!runtimeEnv.ok) return runtimeEnv;
  // The sandbox is created with E2B_API_KEY, so a missing key is refused before the run starts.
  // The runtime key above is the plan's `key-one-of`; E2B_API_KEY is its only `key`.
  if (missingKeys(plan.requirements, env).length > 0) {
    return {
      ok: false,
      code: "HUMANISH_TERMINAL_LAB_KEYS_MISSING",
      message: `Live terminal-product labs need E2B_API_KEY in the environment (values are never persisted). ${describeMissingKeys(["E2B_API_KEY"], env)}`,
    };
  }
  return { ok: true, runtimeEnv };
}

/**
 * The live in-sandbox agent session orchestrator (mirror of runCuaActorLab's E2B branch). Enforces
 * the 8-point safety contract by construction; fails closed before any sandbox/key/spend on any
 * precondition miss. Persists the substrate-lifecycle/command-log/interventions/cleanup ledgers,
 * the redacted terminal event stream + normalized transcript, the agent report, and the
 * provider-neutral actor trace; tears the sandbox down in a finally and proves the teardown.
 */
export async function runLiveTerminalSession(
  args: RunLiveTerminalSessionArgs,
): Promise<TerminalProductLabResult> {
  const { plan, input, cwd, warnings, failed, scope, runtimeEnv } = args;
  const { actor, product } = plan;
  const { maxUsd, maxMinutes } = plan.caps;
  const deps = input.deps ?? {};
  const env = input.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const nowIso = (): string => new Date(now()).toISOString();

  const prepared = await prepareLivePrompt({ plan, cwd, runtimeEnv, env, warnings });
  const { mission, physicalCwd, persona, composedPrompt, verdictNonce } = prepared;
  const { knownSecretValues, sanitize } = prepared;

  const started = await scope.startRun({
    cwd: physicalCwd,
    runId: input.runId,
    mintRunId: makeTerminalRunId,
    // This entry point is the live terminal route; its dry-run sibling is a separate function.
    mode: "live",
    lab: plan.lab,
    renderReview: renderTerminalReviewMarkdown,
    observer: { open: input.open === true, render: deps.renderObserver },
    now,
  });
  if (!started.ok) return failed(started.code, started.message);
  const { run } = started;
  const { runId, createdAt, paths: runPaths } = run;
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd: physicalCwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  // The ledgers + capture buffers, mutated through the live lifecycle.
  const recorder = createTerminalRecorder({ nowIso, sanitize, knownSecretValues });
  const { version, model, modelSource, reasoningEffort } = plan.runtime;
  const runtime = declaredRuntimeProvenance({
    ...(version === undefined ? {} : { version }),
    model: sanitize(model),
    modelSource,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });

  recorder.recordLifecycle(
    "terminal-lab.run.created",
    `Created live terminal-product run ${runId} (actor ${actor}, product ${product.name}). Caps: maxUsd=${maxUsd}, maxMinutes=${maxMinutes}. Subject provenance UNPINNED (public surfaces only).`,
  );

  const session = new LiveTerminalSandbox({
    plan,
    cwd,
    deps,
    now,
    nowIso,
    sanitize,
    runtimeEnv,
    runtime,
    composedPrompt,
    verdictNonce,
    maxMinutes,
    e2bApiKey,
    runPaths,
    metadata: buildSandboxMetadata({ labId: plan.labId, simId: "sim-001", runId }),
    warnings,
    recorder,
  });
  try {
    await session.acquire();
    await session.probeReady();
    // Each step fails the session closed and returns false; codex exec runs only after all pass.
    if (
      (await session.bootstrap()) &&
      (await session.verifyRuntimeVersion()) &&
      (await session.prepareProduct())
    ) {
      await session.execCodex();
    }
  } catch (error) {
    session.recordSessionError(error);
  } finally {
    await session.teardown();
  }

  return finishLiveTerminalSession({
    plan,
    input,
    cwd,
    sanitize,
    nowIso,
    knownSecretValues,
    runtimeEnv,
    runtime,
    persona,
    mission,
    run,
    source,
    warnings,
    recorder,
    session,
  });
}

/**
 * Composes the live prompt and the scrubbers: the mission, the committed persona, the verdict
 * nonce, and the literal-scrub of every known secret value.
 */
async function prepareLivePrompt(args: {
  plan: RunLiveTerminalSessionArgs["plan"];
  cwd: string;
  runtimeEnv: LiveTerminalAuth;
  env: Record<string, string | undefined>;
  warnings: string[];
}) {
  const { plan, cwd, runtimeEnv, env, warnings } = args;
  const { product } = plan;
  // Compose the prompt from PUBLIC surfaces + the author mission ONLY (safety contract item 3).
  // Inject a per-run verdict nonce: the agent echoes HUMANISH_ACTOR_VERDICT=<status>
  // HUMANISH_ACTOR_NONCE=<nonce>; the scorer verifies the nonce so replayed text cannot forge it.
  const mission = plan.mission ?? defaultMission(product.name);
  const terminalPersona = await resolveTerminalPersona({ plan, cwd, warnings });
  const verdictNonce = randomUUID().slice(0, 12);
  const composedPrompt = composeLivePrompt({
    mission,
    personaLine: terminalPersona.personaLine,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    verdictNonce,
  });
  const promptDigest = digestText(composedPrompt);

  // --- Safety contract item 5: literal-scrub EVERY known value, then pattern-redact, at the source. ---
  // The runtime key value (+ any other provisioned value) is scrubbed by LITERAL match before
  // anything persists (a key has no detectable "shape" if it is an arbitrary token); redactText is
  // the second pass for secret-SHAPED content. Applied PRE-truncation so a cut can never split a
  // value past the scrubber.
  const knownSecretValues = [runtimeEnv.keyValue, env.E2B_API_KEY?.trim() ?? ""].filter(
    (v) => v.length >= 4,
  );
  const scrubKnownValues = scrubLiterals(knownSecretValues);
  const sanitize = (text: string): string => redactText(scrubKnownValues(text));
  const persona = terminalPersonaRef(terminalPersona, promptDigest, scrubKnownValues);
  return {
    mission,
    physicalCwd: terminalPersona.physicalCwd,
    persona,
    composedPrompt,
    verdictNonce,
    knownSecretValues,
    sanitize,
  };
}

/** Compose the live prompt: PUBLIC surfaces + author mission + the verdict-nonce marker contract. */
function composeLivePrompt(args: {
  mission: string;
  personaLine: string;
  productName: string;
  publicSurfaces: readonly string[];
  verdictNonce: string;
}): string {
  return [
    args.personaLine,
    `product: ${args.productName}`,
    `public-surfaces: ${args.publicSurfaces.join(" ")}`,
    `mission: ${args.mission}`,
    "",
    "Work ONLY from the public surfaces above. Do NOT clone or inspect any private repository.",
    `When finished, print exactly one final machine-readable line in this format: HUMANISH_ACTOR_VERDICT=<status> HUMANISH_ACTOR_NONCE=${args.verdictNonce} where <status> is passed, blocked, or failed.`,
  ].join("\n");
}

/** The default mission when the lab omits one. Public-safe, product-neutral author text. */
export function defaultMission(productName: string): string {
  return `You are an autonomous agent. Discover ${productName} from its public surfaces and determine whether it can help with a durable real task. Stay within the declared no-spend caps. Leave feedback if the workflow is confusing.`;
}

export function makeTerminalRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `terminal-${stamp}-${randomBytes(4).toString("hex")}`;
}
