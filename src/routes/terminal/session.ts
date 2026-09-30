import { randomBytes, randomUUID } from "node:crypto";
import { declaredRuntimeProvenance } from "./runtime.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveCommittedPersona as resolveTerminalPersona } from "../../lab/persona-resolve.js";
import type { ActorPersonaRef } from "../../actors/contract.js";
import {
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
} from "../../lab/persona.js";
import { digestText, redactText, scrubLiterals } from "../../evidence/redaction.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";
import { buildRunSource } from "../../run/bundle.js";
import { renderTerminalReviewMarkdown } from "./bundle.js";
import { buildRuntimeAuth, buildSandboxMetadata } from "./credentials.js";
import type { RunLiveTerminalSessionArgs, TerminalProductLabResult } from "./types.js";
import { createTerminalRecorder } from "./recorder.js";
import { LiveTerminalSandbox, type LiveSandboxInputs } from "./live-sandbox.js";
import { finishLiveTerminalSession } from "./live-finish.js";

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
  const { options, cwd, config, descriptorId, product, warnings, failed, scope } = args;
  const { caps } = args;
  const { maxUsd, maxMinutes } = caps;
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const now = hooks.now ?? (() => Date.now());
  const nowIso = (): string => new Date(now()).toISOString();

  // planTerminalLab refuses a positive maxUsd without a costProbe, so one is present here.
  if (maxUsd > 0) {
    warnings.push(
      `scenario.caps.maxUsd=${maxUsd} is checked after the session against the lines the costProbe measures; lines it leaves null (unmeasured) never trip it. scenario.caps.maxMinutes bounds the run while it runs.`,
    );
  }

  // --- Safety contract item 4: deny-by-default credentials; build the command-scoped allowlist. ---
  const runtimeEnv = buildRuntimeAuth({ runtimeAuth: config.execution?.runtimeAuth, env });
  if (!runtimeEnv.ok) {
    return failed(runtimeEnv.code, runtimeEnv.message, { actor: descriptorId });
  }

  const prepared = await prepareLivePrompt({ config, product, cwd, runtimeEnv, env, warnings });
  const { mission, physicalCwd, persona, composedPrompt, verdictNonce } = prepared;
  const { knownSecretValues, sanitize } = prepared;

  const started = await scope.startRun({
    cwd: physicalCwd,
    runId: options.runId,
    mintRunId: makeTerminalRunId,
    // This entry point is the live terminal route; its dry-run sibling is a separate function.
    mode: "live",
    lab: options.lab,
    renderReview: renderTerminalReviewMarkdown,
    observer: { open: options.open === true, render: hooks.renderObserverFn },
    now,
  });
  if (!started.ok) return failed(started.code, started.message, { actor: descriptorId });
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
  const runtime = declaredRuntimeProvenance({
    ...(config.execution?.runtime?.version === undefined
      ? {}
      : { version: config.execution.runtime.version }),
    ...(config.actors[0]?.model === undefined ? {} : { model: sanitize(config.actors[0].model) }),
    ...(config.actors[0]?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: config.actors[0].reasoningEffort }),
  });

  recorder.recordLifecycle(
    "terminal-lab.run.created",
    `Created live terminal-product run ${runId} (actor ${descriptorId}, product ${product.name}). Caps: maxUsd=${maxUsd}, maxMinutes=${maxMinutes}. Subject provenance UNPINNED (public surfaces only).`,
  );

  const session = new LiveTerminalSandbox({
    config,
    cwd,
    hooks,
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
    metadata: buildSandboxMetadata({ labId: config.id, simId: "sim-001", runId }),
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
    options,
    cwd,
    config,
    descriptorId,
    product,
    caps,
    hooks,
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
  config: RunLiveTerminalSessionArgs["config"];
  product: RunLiveTerminalSessionArgs["product"];
  cwd: string;
  runtimeEnv: LiveSandboxInputs["runtimeEnv"];
  env: Record<string, string | undefined>;
  warnings: string[];
}) {
  const { config, product, cwd, runtimeEnv, env, warnings } = args;
  // Compose the prompt from PUBLIC surfaces + the author mission ONLY (safety contract item 3).
  // Inject a per-run verdict nonce: the agent echoes HUMANISH_ACTOR_VERDICT=<status>
  // HUMANISH_ACTOR_NONCE=<nonce>; the scorer verifies the nonce so replayed text cannot forge it.
  const mission = config.actors[0]?.mission ?? defaultMission(product.name);
  const personaId = config.actors[0]?.persona ?? "autonomous-terminal-agent";
  const physicalCwd = await realpath(cwd);
  // Resolve the committed persona so its traits actually shape the agent prompt (#308); fail-safe to
  // the bare persona id (no traits applied) when no persona file is committed.
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const resolvedPersona = await resolveTerminalPersona(projectRoot, personaId);
  warnings.push(...resolvedPersona.warnings);
  const personaLine = resolvedPersona.persona
    ? renderPersonaPromptSection(resolvedPersona.persona)
    : `persona: ${personaId}`;
  const traitsApplied = resolvedPersona.persona
    ? personaToDirectives(resolvedPersona.persona).traitsApplied
    : [];
  const verdictNonce = randomUUID().slice(0, 12);
  const composedPrompt = composeLivePrompt({
    mission,
    personaLine,
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
  const persona: ActorPersonaRef = {
    id: personaId,
    traitsApplied,
    promptDigest,
    ...(resolvedPersona.persona
      ? { brief: personaBrief(resolvedPersona.persona, scrubKnownValues) }
      : {}),
  };
  return {
    mission,
    physicalCwd,
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
  publicSurfaces: string[];
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
