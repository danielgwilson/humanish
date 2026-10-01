// The terminal route's dry run: a contract-only bundle with the persona and prompt digest bound,
// published through the run scope with no sandbox, key or spend. session.ts holds the live path.

import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ActorPersonaRef } from "../../actors/contract.js";
import { digestText, redactText, scrubLiterals } from "../../evidence/redaction.js";
import { participantAssignment } from "../../lab/participant-assignment.js";
import {
  personaBrief,
  personaToDirectives,
  renderPersonaPromptSection,
} from "../../lab/persona.js";
import { resolveCommittedPersona } from "../../lab/persona-resolve.js";
import type { TerminalPlan } from "../../lab/plan-types.js";
import { buildRunSource, type RunEvent } from "../../run/bundle.js";
import { prepareSelectedOutputDirectory } from "../../run/contained-output.js";
import { judgeExecution, judgeTerminal, OUTCOME_POLICIES, resultOk } from "../../run/judge.js";
import { validatePreparedRunArtifactPaths } from "../../run/paths.js";
import type { RunScope } from "../../run/run.js";
import { buildTerminalProductBundle, renderTerminalReviewMarkdown } from "./bundle.js";
import { declaredRuntimeProvenance } from "./runtime.js";
import { defaultMission, makeTerminalRunId } from "./session.js";
import {
  type RunLiveTerminalSessionArgs,
  TERMINAL_PRODUCT_LAB_SCHEMA,
  type TerminalProductLabResult,
  type TerminalRunInput,
} from "./types.js";

/**
 * The dry-run path: a contract bundle with the persona and prompt digest bound, published through
 * the run scope with no sandbox, key or spend.
 */
export async function runDryTerminalLab(args: {
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
