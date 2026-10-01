// The terminal-product lab backend: a real autonomous agent (Codex) studying a CLI/product from
// PUBLIC SURFACES ONLY, running INSIDE an E2B shell with explicit runtime-auth placement, capturing
// its non-interactive exec output (stdin disabled) as a redacted event stream + normalized
// transcript, capped at no-spend, emitting durable terminal/substrate/cost/no-spend/cleanup/
// intervention proof. Mirrors routes/computer-use/route.ts and routes/scripted/route.ts.
//
// BOTH ROUTES ARE IMPLEMENTED.
//   - DRY-RUN: a contract-only `humanish.run-bundle.v1`, honestly labeled.
//   - LIVE: the real create -> inject (command-scoped) -> run `codex exec --json` -> capture
//     (scrub+redact at the source) -> score (verdict-nonce marker) -> teardown (proven cleanup)
//     orchestrator on the @e2b/desktop commands.run surface.
//
// THE SAFETY CONTRACT (docs/goals/terminal-product-lane/goal.md) is enforced BY CONSTRUCTION here
// and CHECKED by the verifier (verify/actor.ts validateTerminalProductEvidence):
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
import { resolveCommittedPersona } from "../../lab/persona-resolve.js";
import type { ActorPersonaRef } from "../../actors/contract.js";
import { runScope, type RunScope } from "../../run/run.js";
import { planTerminalLab, type TerminalRefusal } from "./plan.js";
import {
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
} from "../../lab/persona.js";
import { digestText, redactText, scrubLiterals } from "../../evidence/redaction.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";
import { buildRunSource, type RunEvent } from "../../run/bundle.js";
import { judgeExecution, judgeTerminal, OUTCOME_POLICIES, resultOk } from "../../run/judge.js";
import { buildTerminalProductBundle, renderTerminalReviewMarkdown } from "./bundle.js";
import { defaultMission, makeTerminalRunId, runLiveTerminalSession } from "./session.js";
import type { TerminalPlan } from "../../lab/plan-types.js";
import {
  type RunLiveTerminalSessionArgs,
  type RunTerminalProductLabOptions,
  TERMINAL_PRODUCT_LAB_SCHEMA,
  type TerminalProductLabResult,
  type TerminalRunInput,
} from "./types.js";

/**
 * The config-taking entry point. It plans, returns a refusal with the same envelope and analysis
 * record the route has always returned, and otherwise runs the plan.
 */
export async function runTerminalProductLab(
  options: RunTerminalProductLabOptions,
): Promise<TerminalProductLabResult> {
  const { config, dryRun, lab, ...input } = options;
  const planned = planTerminalLab(config, {
    dryRun,
    ...(lab === undefined ? {} : { lab }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
  if (planned.ok) return runTerminalPlan(planned.plan, input);
  return terminalLabRefusal(options, planned.refusal);
}

/** A refused terminal lab's result: the route's envelope, and the analysis record a refusal gets. */
export function terminalLabRefusal(
  options: RunTerminalProductLabOptions,
  refusal: TerminalRefusal,
): Promise<TerminalProductLabResult> {
  const { config, dryRun } = options;
  const refused: TerminalProductLabResult = {
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok: false,
    cwd: path.resolve(options.cwd),
    labId: config.id,
    actor: refusal.actor ?? config.actors[0]?.type ?? "",
    product: config.subject.product?.name ?? "",
    dryRun,
    runId: options.runId ?? "not-created",
    warnings: [],
    error: { code: refusal.code, message: refusal.message },
  };
  // A refusal starts no run, so a declared or default analysis is recorded as skipped.
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  return completeAutomaticAnalysis(
    refused,
    undefined,
    analysis.ok ? analysis.config : undefined,
    options.automaticAnalysis,
    { trigger: config.review?.analysis === undefined ? "default" : "explicit" },
  );
}

/**
 * Run a terminal plan. The run scope gives a direct library caller the same run lifetime the CLI
 * gets: whichever of its fail-closed exits the lab takes, the run it started is closed, and only a
 * run that published its final bundle reaches automatic analysis.
 */
export async function runTerminalPlan(
  plan: TerminalPlan,
  input: TerminalRunInput,
): Promise<TerminalProductLabResult> {
  const { result, finished } = await runScope((scope) =>
    runTerminalPlanInScope(plan, input, scope),
  );
  return completeAutomaticAnalysis(
    result,
    finished,
    plan.analysis?.config,
    input.automaticAnalysis,
    {
      ...(plan.analysis === undefined ? {} : { trigger: plan.analysis.trigger }),
      preferLargerOutput: plan.analysis?.preferLargerOutput === true,
    },
  );
}

async function runTerminalPlanInScope(
  plan: TerminalPlan,
  input: TerminalRunInput,
  scope: RunScope,
): Promise<TerminalProductLabResult> {
  const cwd = path.resolve(input.cwd);
  const warnings: string[] = [];
  const failed = (
    code: NonNullable<TerminalProductLabResult["error"]>["code"],
    message: string,
  ): TerminalProductLabResult => ({
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: plan.labId,
    actor: plan.actor,
    product: plan.product.name,
    dryRun: plan.dryRun,
    runId: input.runId ?? "not-created",
    warnings,
    error: { code, message },
  });

  // LIVE path: the real in-sandbox agent session. A separate orchestrator owns the
  // create -> inject (command-scoped) -> run -> capture -> teardown lifecycle so the dry-run path
  // below stays a pure contract builder. It enforces the safety contract by construction (the
  // keyPlacement-routed command-scoped key, the deny-by-default allowlist, the fail-closed cap,
  // the proven cleanup) and fails closed before any sandbox/key/spend on any precondition miss.
  if (!plan.dryRun) return runLiveTerminalSession({ plan, input, cwd, warnings, failed, scope });
  return runDryTerminalLab({ plan, input, cwd, warnings, failed, scope });
}

/**
 * The dry-run path: a contract bundle with the persona and prompt digest bound, published through
 * the run scope with no sandbox, key or spend.
 */
async function runDryTerminalLab(args: {
  plan: Extract<TerminalPlan, { readonly dryRun: true }>;
  input: TerminalRunInput;
  cwd: string;
  warnings: string[];
  failed: RunLiveTerminalSessionArgs["failed"];
  scope: RunScope;
}): Promise<TerminalProductLabResult> {
  const { plan, input, cwd, warnings, failed, scope } = args;
  const { product } = plan;
  const hooks = input.hooks ?? {};
  const { evidenceMission, physicalCwd, persona } = await prepareDryPersona({
    plan,
    cwd,
    env: hooks.env ?? process.env,
    warnings,
  });

  const started = await scope.startRun({
    cwd: physicalCwd,
    runId: input.runId,
    mintRunId: makeTerminalRunId,
    mode: "dry-run",
    lab: plan.lab,
    renderReview: renderTerminalReviewMarkdown,
    observer: { open: input.open === true, render: hooks.renderObserverFn },
  });
  if (!started.ok) return failed(started.code, started.message);
  const { run } = started;
  const { runId, createdAt } = run;
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd: physicalCwd,
    humanishSource: "present",
    packageName: "humanish",
  });

  const policies = plan.residual.policies;
  const judgment = judgeTerminal({ dryRun: true, participant: undefined });
  const bundle = buildTerminalProductBundle({
    ...(plan.lab === undefined ? {} : { lab: plan.lab }),
    actorId: plan.actor,
    createdAt,
    dryRun: true,
    labId: plan.labId,
    ...(plan.title ? { labTitle: plan.title } : {}),
    mission: evidenceMission,
    persona,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    ...(plan.caps ? { caps: plan.caps } : {}),
    ...(plan.runtime.auth ? { runtimeAuth: plan.runtime.auth } : {}),
    stdin: plan.stdin ?? "disabled",
    policies: {
      allowPrivateRepoAccess: policies?.allowPrivateRepoAccess ?? false,
      allowProviderCredentials: policies?.allowProviderCredentials ?? false,
      allowPaymentCredentials: policies?.allowPaymentCredentials ?? false,
      allowGitHubMutation: policies?.allowGitHubMutation ?? false,
    },
    runId,
    source,
    verdict: judgment.verdict,
  });
  bundle.events.push(runtimeDeclaredEvent(plan.runtime, createdAt));

  const finished = await run.finish(bundle);
  const observer = await finished.renderObserver();
  await validatePreparedRunArtifactPaths(finished.paths);
  const policy = OUTCOME_POLICIES.terminal;
  const execution = judgeExecution(
    observer.ok
      ? []
      : [
          {
            kind: "evidence",
            message: observer.error?.message ?? "Observer failed for the terminal-product lab run.",
          },
        ],
    policy,
  );
  const ok = resultOk({ judgment, execution, scorerFailures: [], policy });
  await finished.recordOutcome({ ok, execution });

  return {
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok,
    cwd,
    labId: plan.labId,
    actor: plan.actor,
    product: product.name,
    dryRun: true,
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
  plan: TerminalPlan;
  cwd: string;
  env: Record<string, string | undefined>;
  warnings: string[];
}): Promise<{ evidenceMission: string; physicalCwd: string; persona: ActorPersonaRef }> {
  const { plan, cwd, env, warnings } = args;
  const { product } = plan;
  const mission = plan.mission ?? defaultMission(product.name);
  const knownSecretValues = [env.CODEX_API_KEY, env.OPENAI_API_KEY, env.E2B_API_KEY]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length >= 4);
  const evidenceMission = participantAssignment(
    { mission },
    scrubLiterals(knownSecretValues),
  ).mission;
  const personaId = plan.personaId ?? "autonomous-terminal-agent";
  const physicalCwd = await realpath(cwd);
  // Resolve the committed persona so its traits actually shape the agent prompt (#308); fail-safe to
  // the bare persona id (no traits applied) when no persona file is committed.
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const resolvedPersona = await resolveCommittedPersona(projectRoot, personaId);
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
function runtimeDeclaredEvent(runtime: TerminalPlan["runtime"], createdAt: string): RunEvent {
  const { version, model, reasoningEffort } = runtime;
  return {
    id: "event-terminal-runtime-declared",
    at: createdAt,
    level: "info",
    type: "terminal-lab.runtime.declared",
    message: redactText(
      JSON.stringify(
        declaredRuntimeProvenance({
          ...(version === undefined ? {} : { version }),
          ...(model === undefined ? {} : { model }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
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
  publicSurfaces: readonly string[];
}): string {
  return [
    args.personaLine,
    `product: ${args.productName}`,
    `public-surfaces: ${args.publicSurfaces.join(" ")}`,
    `mission: ${args.mission}`,
  ].join("\n");
}
