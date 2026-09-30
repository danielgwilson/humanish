// The terminal-product lab backend: a real autonomous agent (Codex) studying a CLI/product from
// PUBLIC SURFACES ONLY, running INSIDE an E2B shell with explicit runtime-auth placement, capturing
// its non-interactive exec output (stdin disabled) as a redacted event stream + normalized
// transcript, capped at no-spend, emitting durable terminal/substrate/cost/no-spend/cleanup/
// intervention proof. Mirrors routes/computer-use/lab.ts and routes/scripted-browser/lab.ts.
//
// BOTH ROUTES ARE IMPLEMENTED.
//   - DRY-RUN: a contract-only `humanish.run-bundle.v1`, honestly labeled.
//   - LIVE: the real create -> inject (command-scoped) -> run `codex exec --json` -> capture
//     (scrub+redact at the source) -> score (verdict-nonce marker) -> teardown (proven cleanup)
//     orchestrator on the @e2b/desktop commands.run surface.
//
// THE SAFETY CONTRACT (docs/goals/terminal-product-lane/goal.md) is enforced BY CONSTRUCTION here
// and CHECKED by the verifier (run/verify-actor.ts validateTerminalProductEvidence):
//   1. EXPLICIT KEY PLACEMENT. openai-env (default) injects the raw runtime key command-scoped,
//      NEVER Sandbox.create({envs}). Opt-in openai-egress sends it only in the host-side E2B
//      header transform and passes an inert command placeholder. The proxy is spendable by every
//      sandbox process from creation; this protects the raw key, not provider spending.
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
//   8. PROVEN CLEANUP, BY ID, NEVER ACCOUNT-WIDE. Sandbox.kill(id) in a finally; the cleanup
//      proof is BY EXACT ID: kill(id)'s own found-and-killed boolean, confirmed further by
//      Sandbox.getInfo(id) when the SDK exposes it (a thrown SandboxNotFoundError means gone).
//      humanish NEVER calls Sandbox.list to prove cleanup, so a shared operator key never reaches a
//      sandbox it did not create. A live run that cannot prove teardown fails closed.

import { resolveAutomaticAnalysis } from "../../analysis/automatic-config.js";
import { completeAutomaticAnalysis } from "../../analysis/automatic-completion.js";
import { declaredRuntimeProvenance } from "./runtime.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveCommittedPersona as resolveTerminalPersona } from "../../lab/persona-resolve.js";
import type { ActorPersonaRef } from "../../actors/contract.js";
import { runScope, type RunScope } from "../../run/run.js";
import { planTerminalLab } from "./plan.js";
import {
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
} from "../../lab/persona.js";
import { digestText, redactText, scrubLiterals } from "../../evidence/redaction.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import { prepareSelectedOutputDirectory } from "../../run/selected-output-paths.js";
import { buildRunSource, type RunEvent } from "../../run/bundle.js";
import { buildTerminalProductBundle, renderTerminalReviewMarkdown } from "./bundle.js";
import { defaultMission, makeTerminalRunId, runLiveTerminalSession } from "./session.js";
import {
  type RunLiveTerminalSessionArgs,
  type RunTerminalProductLabOptions,
  TERMINAL_PRODUCT_LAB_SCHEMA,
  type TerminalProductLabResult,
} from "./types.js";

export { resolveCommittedPersona as resolveTerminalPersona } from "../../lab/persona-resolve.js";

/**
 * The run scope gives a direct library caller the same run lifetime the CLI gets: whichever of its
 * fail-closed exits the lab takes, the run it started is closed, and only a run that published its
 * final bundle reaches automatic analysis.
 */
export async function runTerminalProductLab(
  options: RunTerminalProductLabOptions,
): Promise<TerminalProductLabResult> {
  const analysis = resolveAutomaticAnalysis(options.config.review?.analysis);
  const { result, finished } = await runScope((scope) =>
    runTerminalProductLabInScope(options, scope),
  );
  return completeAutomaticAnalysis(
    result,
    finished,
    analysis.ok ? analysis.config : undefined,
    options.automaticAnalysis,
    options.config.review?.analysis === undefined ? "default" : "explicit",
    analysis.ok && analysis.preferLargerOutput === true,
  );
}

async function runTerminalProductLabInScope(
  options: RunTerminalProductLabOptions,
  scope: RunScope,
): Promise<TerminalProductLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const warnings: string[] = [];
  const actorType = config.actors[0]?.type ?? "";

  const failed = (
    code: NonNullable<TerminalProductLabResult["error"]>["code"],
    message: string,
    extras?: { actor?: string; product?: string },
  ): TerminalProductLabResult => ({
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: extras?.actor ?? actorType,
    product: extras?.product ?? config.subject.product?.name ?? "",
    dryRun,
    runId: options.runId ?? "not-created",
    warnings,
    error: { code, message },
  });

  // planTerminalLab makes every configuration refusal, in the order this route always has.
  const planned = planTerminalLab(config, {
    dryRun,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  if (!planned.ok) {
    const { refusal } = planned;
    return failed(
      refusal.code,
      refusal.message,
      refusal.actor === undefined ? undefined : { actor: refusal.actor },
    );
  }
  const { plan } = planned;
  const product = plan.product;

  // LIVE path: the real in-sandbox agent session. A separate orchestrator owns the
  // create -> inject (command-scoped) -> run -> capture -> teardown lifecycle so the dry-run path
  // below stays a pure contract builder. It enforces the safety contract by construction (the
  // keyPlacement-routed command-scoped key, the deny-by-default allowlist, the fail-closed cap,
  // the proven cleanup) and fails closed before any sandbox/key/spend on any precondition miss.
  if (!plan.dryRun) {
    return runLiveTerminalSession({
      options,
      cwd,
      config,
      descriptorId: plan.actor,
      product,
      caps: plan.caps,
      warnings,
      failed,
      scope,
    });
  }

  return runDryTerminalLab({
    options,
    cwd,
    config,
    product,
    actorId: plan.actor,
    warnings,
    failed,
    scope,
  });
}

/**
 * The dry-run path: a contract bundle with the persona and prompt digest bound, published through
 * the run scope with no sandbox, key or spend.
 */
async function runDryTerminalLab(args: {
  options: RunTerminalProductLabOptions;
  cwd: string;
  config: RunTerminalProductLabOptions["config"];
  product: RunLiveTerminalSessionArgs["product"];
  actorId: string;
  warnings: string[];
  failed: RunLiveTerminalSessionArgs["failed"];
  scope: RunScope;
}): Promise<TerminalProductLabResult> {
  const { options, cwd, config, product, actorId, warnings, failed, scope } = args;
  const { dryRun } = options;
  const hooks = options.hooks ?? {};
  const { evidenceMission, physicalCwd, persona } = await prepareDryPersona({
    config,
    product,
    cwd,
    env: hooks.env ?? process.env,
    warnings,
  });

  const started = await scope.startRun({
    cwd: physicalCwd,
    runId: options.runId,
    mintRunId: makeTerminalRunId,
    mode: dryRun ? "dry-run" : "live",
    lab: options.lab,
    renderReview: renderTerminalReviewMarkdown,
    observer: { open: options.open === true, render: hooks.renderObserverFn },
  });
  if (!started.ok) return failed(started.code, started.message, { actor: actorId });
  const { run } = started;
  const { runId, createdAt } = run;
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd: physicalCwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  const bundle = buildTerminalProductBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    actorId,
    createdAt,
    dryRun,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    mission: evidenceMission,
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
      allowGitHubMutation: config.policies?.allowGitHubMutation ?? false,
    },
    runId,
    source,
  });
  bundle.events.push(runtimeDeclaredEvent(config, createdAt));

  const finished = await run.finish(bundle);
  const observer = await finished.renderObserver();
  await validatePreparedRunArtifactPaths(finished.paths);
  const ok = observer.ok;

  return {
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: actorId,
    product: product.name,
    dryRun,
    runId,
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: "HUMANISH_TERMINAL_LAB_FAILED" as const,
            message: observer.error?.message ?? "Observer failed for the terminal-product lab run.",
          },
        }),
  };
}

/**
 * The persona and prompt digest a dry run records: the author mission with known key values
 * scrubbed, and the committed persona's traits and brief.
 */
async function prepareDryPersona(args: {
  config: RunTerminalProductLabOptions["config"];
  product: RunLiveTerminalSessionArgs["product"];
  cwd: string;
  env: Record<string, string | undefined>;
  warnings: string[];
}): Promise<{ evidenceMission: string; physicalCwd: string; persona: ActorPersonaRef }> {
  const { config, product, cwd, env, warnings } = args;
  const mission = config.actors[0]?.mission ?? defaultMission(product.name);
  const knownSecretValues = [env.CODEX_API_KEY, env.OPENAI_API_KEY, env.E2B_API_KEY]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length >= 4);
  const evidenceMission = participantAssignment(
    { mission },
    scrubLiterals(knownSecretValues),
  ).mission;
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
  // The composed prompt = mission + persona + public-surface manifest. Only the AUTHOR mission
  // goes plaintext into evidence (it is public-safe committed lab text); the full composed prompt
  // is recorded as a DIGEST (the safety contract's mission ruling).
  const composedPrompt = composePrompt({
    mission,
    personaLine,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
  });
  const promptDigest = digestText(composedPrompt);
  const persona: ActorPersonaRef = {
    id: personaId,
    traitsApplied,
    promptDigest,
    ...(resolvedPersona.persona
      ? {
          brief: personaBrief(resolvedPersona.persona, scrubLiterals(knownSecretValues)),
        }
      : {}),
  };
  return { evidenceMission, physicalCwd, persona };
}

/** The declared runtime provenance as a dry-run event; nothing is observed without a sandbox. */
function runtimeDeclaredEvent(
  config: RunTerminalProductLabOptions["config"],
  createdAt: string,
): RunEvent {
  return {
    id: "event-terminal-runtime-declared",
    at: createdAt,
    level: "info",
    type: "terminal-lab.runtime.declared",
    message: redactText(
      JSON.stringify(
        declaredRuntimeProvenance({
          ...(config.execution?.runtime?.version === undefined
            ? {}
            : { version: config.execution.runtime.version }),
          ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model }),
          ...(config.actors[0]?.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: config.actors[0].reasoningEffort }),
        }),
      ),
    ),
  };
}

/** Compose the full prompt the agent would run. Bound to evidence by DIGEST only. */
function composePrompt(args: {
  mission: string;
  personaLine: string;
  productName: string;
  publicSurfaces: string[];
}): string {
  return [
    args.personaLine,
    `product: ${args.productName}`,
    `public-surfaces: ${args.publicSurfaces.join(" ")}`,
    `mission: ${args.mission}`,
  ].join("\n");
}
